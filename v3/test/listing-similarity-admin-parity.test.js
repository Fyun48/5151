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

// PostgreSQL exec 的離線替身：$n → ?，SELECT 回列，其餘當寫入。
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
