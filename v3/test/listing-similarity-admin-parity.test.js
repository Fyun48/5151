// ④ 第一段 parity：審核 UI／設定在兩個 driver 上必須給出同一份答案。
//
// listingSimilarity.js 的語句只跑 SQLite → `DB_DRIVER=postgres` 時會「寫 PostgreSQL、後台讀本機
// v3.db」。listingSimilarityAsync.js 讓那幾條路徑在 PostgreSQL 上跑同一份語句文字；這條測試把兩邊
// 的輸出釘在一起。離線那段的 PostgreSQL exec 是「$n 還原成 ? 再跑同一個 SQLite fixture」，
// 所以真正的 SQL 文字與組裝都被跑到（作法同 notify-enqueue-parity.test.js）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { ensurePgSchema } from "../src/pgSchema.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-similarity-admin-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const app = await import("../src/db.js");
const sim = await import("../src/listingSimilarity.js");
const simAsync = await import("../src/listingSimilarityAsync.js");

const db = app.sqliteHandle();
sim.ensureListingSimilaritySchema(db);

const STAMP = "2026-09-23T00:00:00.000Z";
const A = 970101;
const B = 970102;
const INSIGHT = 970103;

// 一筆待審建議、一筆洞察；listings 故意不種 → title 走 `#id` fallback（兩邊一致）。
db.prepare(`INSERT OR REPLACE INTO listing_similarity_suggestion
    (id, listing_a, listing_b, evidence_json, review_state, created_at)
    VALUES (1, ?, ?, ?, 'pending', ?)`)
  .run(A, B, JSON.stringify({ hamming: 3, match_level: "medium", veto: [], blocked_by_veto: [] }), STAMP);
db.prepare(`INSERT OR REPLACE INTO listing_crawl_insight
    (id, post_id, source_text_hash, hints_json, apply_state, created_at)
    VALUES (1, ?, 'hash-1', ?, 'applied_empty', ?)`)
  .run(INSIGHT, JSON.stringify({ floor: "7F" }), STAMP);

// ---- 第二段（佇列寫入）parity：draft，尚未跑過 ----
// 跑法：cd /tmp/5151-sim && node --test v3/test/listing-similarity-admin-parity.test.js
// 這一條不需要真的算圖：直接餵 recorded = { post_id, phash, algo_version } 給
// suggestFromNewHashAsync（真實呼叫端就是這樣把錄好的指紋傳進來的），
// 斷言用「兩邊 driver 的輸出（去掉 id）完全相同」→ 對 veto／LLM 分支的實際走向不敏感。
test("第二段：suggestFromNewHashAsync 兩個 driver 寫出等價的建議", async () => {
  const PHASH = "ffffffffffffffff"; // 16 hex；下列兩筆同值 → hamming 0
  const PEER = 970104;
  const seed = (id) =>
    db
      .prepare(`INSERT OR REPLACE INTO listing_image_phash
          (post_id, image_url, image_key, algo_version, phash, computed_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, `https://example.test/${id}.jpg`, `k${id}`, sim.PACK7_PHASH_BASELINE, PHASH, STAMP);
  seed(A);
  seed(PEER);

  const listing = { post_id: A, title: "A 物件", cover: `https://example.test/${A}.jpg` };
  const recorded = { post_id: A, phash: PHASH, algo_version: sim.PACK7_PHASH_BASELINE };
  const dropIds = (value) => JSON.stringify(value).replace(/"id":\d+,?/g, "");

  db.prepare("DELETE FROM listing_similarity_suggestion").run();
  const viaSqlite = await simAsync.suggestFromNewHashAsync(listing, recorded, { driver: "sqlite" });

  db.prepare("DELETE FROM listing_similarity_suggestion").run();
  const viaPg = await simAsync.suggestFromNewHashAsync(listing, recorded, pgOptions);

  assert.ok(Array.isArray(viaSqlite) && Array.isArray(viaPg), "兩邊都應回陣列");
  assert.equal(dropIds(viaPg), dropIds(viaSqlite), "PG 路徑的建議內容要與 sqlite 路徑相同");

  const stored = db.prepare("SELECT listing_a, listing_b, review_state FROM listing_similarity_suggestion").all();
  assert.equal(stored.length, viaPg.length, "回傳幾筆就要真的寫進 store 幾筆");
  for (const row of stored) {
    assert.ok(row.listing_a === A || row.listing_b === A, "每筆建議都要含新指紋那筆物件");
    assert.equal(row.review_state, "pending", "新建議一律 pending");
  }
});

test("第二段：recordCrawlInsightAsync 把洞察列寫進 PG（provider 以 llmInsight 注入）", async () => {
  const HOST = 970105;
  const listing = { post_id: HOST, title: "有車位 3 房", floor_name: "" };

  db.prepare("DELETE FROM listing_crawl_insight").run();
  // extractCrawlInsight() 是 provider 島 → 離線用 options.llmInsight 注入（見 listingSimilarity.js）。
  const viaPg = await simAsync.recordCrawlInsightAsync(listing, {
    ...pgOptions,
    llmInsight: { floor: "7F", confidence: 0.9 },
  });
  if (viaPg === null) {
    assert.fail("回 null → extractCrawlInsight 的注入鍵名／形狀要再確認一次（交接文件有記）");
  }
  assert.equal(viaPg.post_id, HOST, "回傳列要是剛寫進去那筆");
  const rows = db.prepare("SELECT post_id, apply_state FROM listing_crawl_insight").all();
  assert.equal(rows.length, 1, "應寫入 1 筆洞察");
  assert.equal(rows[0].post_id, HOST);
  assert.ok(
    ["hint_only", "applied_empty", "skipped"].includes(rows[0].apply_state),
    "apply_state 必為三態之一（PG 端的 CHECK 也一樣）",
  );
});

test("第二段：enqueueListingSimilarityAsync 在功能關閉時明確回 disabled、不誤寫", async () => {
  await simAsync.savePhashSettingsAsync({ enabled: false }, pgOptions);
  const out = await simAsync.enqueueListingSimilarityAsync(
    { post_id: A, cover: "https://example.test/x.jpg" },
    pgOptions,
  );
  assert.deepEqual(Object.keys(out).sort(), ["insight", "phash", "skipped", "suggestions"]);
  assert.equal(out.phash, null, "關閉時不該算指紋");
  assert.deepEqual(out.suggestions, [], "關閉時不該建建議");
  assert.equal(out.insight, null, "fixture 沒有啟用洞察 provider");
  assert.equal(out.skipped, "disabled", "要明確回 disabled（＝正式站現況）");
});

function pgShimOn(handle) {
  return async (sql, params = []) => {
    const text = String(sql).replace(/\$(\d+)/g, "?");
    const statement = handle.prepare(text);
    try {
      return statement.all(...params);
    } catch {
      statement.run(...params);
      return [];
    }
  };
}
const pgOptions = { driver: "postgres", exec: pgShimOn(db), strict: true };

test("sqlite 模式：async 入口與原本的同步函式輸出完全相同", async () => {
  assert.deepEqual(await simAsync.getSimilarityAdminAsync({ driver: "sqlite" }), sim.getSimilarityAdmin(db));
  assert.deepEqual(
    await simAsync.listSimilaritySuggestionsAsync({ review_state: "all", limit: 10 }, { driver: "sqlite" }),
    sim.listSimilaritySuggestions(db, { review_state: "all", limit: 10 }),
  );
  assert.deepEqual(await simAsync.listRecentInsightsAsync(10, { driver: "sqlite" }), sim.listRecentInsights(db, 10));
  assert.equal(await simAsync.isPhashEnabledAsync({ driver: "sqlite" }), sim.isPhashEnabled(db));
  assert.equal(await simAsync.isInsightApplyEnabledAsync({ driver: "sqlite" }), sim.isInsightApplyEnabled(db));
});

test("postgres 路徑（離線 exec）給出與 sqlite 相同的 admin payload", async () => {
  const viaPg = await simAsync.getSimilarityAdminAsync(pgOptions);
  assert.deepEqual(viaPg, sim.getSimilarityAdmin(db));
  assert.equal(viaPg.baseline, sim.PACK7_PHASH_BASELINE);
  assert.equal(viaPg.suggestions.length, 1);
  assert.equal(viaPg.suggestions[0].listing_a, A);
  assert.equal(viaPg.suggestions[0].hamming, 3);
  assert.equal(viaPg.insights.length, 1);
  assert.equal(viaPg.insights[0].apply_state_label, "只補空白欄");
});

test("postgres 路徑：設定讀寫與 shouldEnqueueSimilarity 與 sqlite 相同", async () => {
  assert.equal(await simAsync.shouldEnqueueSimilarityAsync(pgOptions), false);
  assert.deepEqual(await simAsync.savePhashSettingsAsync({ enabled: true }, pgOptions),
    { phash_enabled: true, insight_apply_enabled: false });
  assert.equal(sim.isPhashEnabled(db), true); // 寫入真的落在同一個 store
  assert.equal(await simAsync.shouldEnqueueSimilarityAsync(pgOptions), true);
  assert.deepEqual(
    await simAsync.savePhashSettingsAsync({ phash_enabled: false, insight_apply_enabled: true }, pgOptions),
    { phash_enabled: false, insight_apply_enabled: true },
  );
  await simAsync.savePhashSettingsAsync({ insight_apply_enabled: false }, pgOptions);
});

test("postgres 路徑：reviewSimilarity 的驗證與回傳與 sqlite 相同", async () => {
  await assert.rejects(() => simAsync.reviewSimilarityAsync(1, { review_state: "pending" }, 1, pgOptions), /review_state/);
  await assert.rejects(() => simAsync.reviewSimilarityAsync(999, { review_state: "accepted" }, 1, pgOptions), /找不到這筆建議/);
  const viaPg = await simAsync.reviewSimilarityAsync(1, { review_state: "accepted", now: new Date(STAMP) }, 42, pgOptions);
  const viaSqlite = sim.reviewSimilarity(db, 1, { review_state: "rejected", now: new Date(STAMP) }, 42);
  assert.equal(viaPg.review_state, "accepted");
  assert.equal(viaPg.reviewed_at, STAMP);
  assert.equal(viaSqlite.review_state_label, "已駁回");
  assert.deepEqual(Object.keys(viaPg).sort(), Object.keys(viaSqlite).sort());
});

const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const skip = PG_TEST_URL ? false : "PG_TEST_URL is not set (live similarity/insight admin)";

// 真表、真 $n：同一組斷言再對 shadow PostgreSQL 跑一次（PG_TEST_URL 沒設就 skip）。
test("live shadow PostgreSQL：同一組 admin 斷言", { skip }, async () => {
  const pgDriver = await createPostgresDriver({ connectionString: PG_TEST_URL });
  const { SIMILARITY_TABLES } = simAsync.listingSimilarityAdminContext();
  await ensurePgSchema(pgDriver, db, { tables: SIMILARITY_TABLES, indexes: false });
  const live = { driver: "postgres", pgDriver, strict: true };
  await simAsync.savePhashSettingsAsync({ enabled: true, insight_apply_enabled: true }, live);
  assert.deepEqual(await simAsync.savePhashSettingsAsync({}, live),
    { phash_enabled: true, insight_apply_enabled: true });
  const admin = await simAsync.getSimilarityAdminAsync(live);
  assert.equal(admin.baseline, sim.PACK7_PHASH_BASELINE);
  assert.equal(admin.phash_enabled, true);
  assert.equal(admin.insight_apply_enabled, true);
  assert.equal(admin.legal, simAsync.SIMILARITY_LEGAL);
  await simAsync.savePhashSettingsAsync({ enabled: false, insight_apply_enabled: false }, live);
  await pgDriver.close();
});
