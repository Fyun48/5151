// 補抓 worker 的兩個「PG 模式下會靜默失效」的環節：**live PG** 驗證（2026-09-29 第六十六批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了這一包真正的重點：
//
//   1. **擁有權判斷讀的是 PostgreSQL，不是本機 handle**。`jobStillOwnsRun(conn, job)`（同步版）
//      在 PG 模式下讀本機 SQLite——那裡**根本沒有這一列** ⇒ 一律回 false ⇒ 每個 job 都被當成
//      superseded／stale，補抓永遠不會完成。這一檔刻意在本機不放任何 job 列，只放 PG 的列。
//   2. **prep 列真的寫進 PG**：`listing_prep.display_ready` 是站上「要不要展示」的閘門；
//      寫進本機 SQLite 等於房源永遠不展示。這裡比對「PG 落地列」與「SQLite 落地列」逐欄相同。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向 `5151_shadow`
// 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
// `listing_enrich_jobs`／`listing_prep` 是共用表，所以只碰自己那兩個鍵。
//
// ⚠️ 這一檔必須**序列**執行（`v3/scripts/run-pg-integration.sh` 的預設 `--test-concurrency=1`）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const TEST_POST = 880901;
const TEST_JOB = 880902;
const NOW = "2026-09-29T00:00:00.000Z";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-enrichworker-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

test("live PG：擁有權判斷讀 PG（本機沒有那一列也不得判成失去擁有權）與 prep 落地", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const enrichAsync = await import("../src/listingEnrichQueueAsync.js");
  const enrichSync = await import("../src/listingEnrichQueue.js");
  const prepMod = await import("../src/listingPrep.js");
  const { sqliteHandle } = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");
  const db = sqliteHandle();

  const cleanup = async () => {
    await query("DELETE FROM listing_enrich_jobs WHERE id = $1", [TEST_JOB]);
    await query("DELETE FROM listing_prep WHERE post_id = $1", [TEST_POST]);
    db.prepare("DELETE FROM listing_prep WHERE post_id = ?").run(TEST_POST);
    db.prepare("DELETE FROM listing_enrich_jobs WHERE id = ?").run(TEST_JOB);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });
  await cleanup();

  const options = { driver: "postgres", pgDriver, strict: true };
  const facade = enrichAsync.listingEnrichQueueFacade(db, options);

  // ---- 1) 擁有權判斷：列在 PG（本機沒有），而且在 PG 推進 request_seq 之後就失去擁有權 ----
  await query(
    "INSERT INTO listing_enrich_jobs(id, post_id, source, status, run_seq, request_seq, created_at) VALUES ($1, $2, 'houseprice', 'running', 1, 1, $3)",
    [TEST_JOB, TEST_POST, NOW],
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM listing_enrich_jobs WHERE id = ?").get(TEST_JOB).n, 0,
    "前置條件：本機**沒有**這一列（PG 模式的實況）");
  const job = { id: TEST_JOB, post_id: TEST_POST, run_seq: 1, request_seq: 1 };
  assert.equal(await facade.ownsRun(db, job), true,
    "擁有權必須問 PG（本機查不到不等於沒有擁有權；同步版在這裡會回 false ⇒ 補抓永遠不完成）");
  await query("UPDATE listing_enrich_jobs SET request_seq = 2 WHERE id = $1", [TEST_JOB]);
  assert.equal(await facade.ownsRun(db, job), false, "PG 上被別人推進 request_seq ⇒ 真的失去擁有權");

  // ---- 2) prep 列：PG 與 SQLite 兩條 driver 的落地值逐欄相同 ----
  const listing = {
    post_id: TEST_POST, source: "houseprice", source_id: "live-1", url: "https://example.test/live-1",
    title: "live 測試", price: "20000", price_num: 20000, address: "台北市士林區天玉街9巷3號",
    floor_name: "4/4", kind_name: "整層住家", tags: '["冰箱"]', lat: 25.11, lng: 121.52,
    geo_source: "houseprice", has_natural_gas: 1, furnish_items: '["冰箱"]',
  };
  const evalResult = prepMod.evaluateHpPrep(listing, { fetched: true, detailRecognized: true, facilityBlock: true });
  await facade.upsertPrep(db, { postId: TEST_POST, listing, evalResult });
  const pgRow = (await query("SELECT * FROM listing_prep WHERE post_id = $1", [TEST_POST]))[0];
  assert.ok(pgRow, "prep 列必須落在 PG（站上的 display_ready 閘門讀的是它）");
  assert.equal(Number(pgRow.display_ready), Number(evalResult.displayReady) ? 1 : 0);
  assert.equal(pgRow.source, "houseprice");

  db.prepare("DELETE FROM listing_prep WHERE post_id = ?").run(TEST_POST);
  enrichSync.upsertListingPrep(db, TEST_POST, listing, evalResult);
  const liteRow = db.prepare("SELECT * FROM listing_prep WHERE post_id = ?").get(TEST_POST);
  const stripTimes = (row) => {
    const { checked_at, ready_at, ...rest } = row;
    return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));
  };
  assert.deepEqual(stripTimes(pgRow), stripTimes(liteRow), "兩個 driver 的 prep 落地列必須逐欄相同");
});
