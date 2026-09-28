// 系統爬蟲設定／目錄快照／後台搜尋的 **live PG** 驗證（2026-09-28，第四十四批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **`settings` 的 upsert 在真 PG 上真的可用**（`ON CONFLICT(key)` 靠的是鏡射過去的
//      主鍵；`settings(key TEXT PRIMARY KEY)` 是單欄主鍵，沒有 identity 的顧慮）。
//   2. **五個系統爬蟲鍵逐鍵讀寫**在真 PG 上是同一個值（`systemCrawlFromRows()` 吃的是
//      `{key, value}` 列，PG 版是逐鍵查出來的，形狀要對）。
//   3. **後台搜尋的 `COALESCE(address, '')`** 在真 PG 上真的能跑（`address` 是 NULL 的列）。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
// `5151_shadow` 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
import { test } from "node:test";
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

const OLD = "2026-01-01T00:00:00.000Z";
const TOKEN = "livetest-syscrawl";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-syscrawl-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：系統爬蟲設定逐鍵來回、目錄快照落地、後台搜尋的 COALESCE 生效", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const contentAsync = await import("../src/siteContentAsync.js");
  const adminAsync = await import("../src/adminOverviewAsync.js");
  const dbMod = await import("../src/db.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  // 這幾個鍵是**站台層級**的共用狀態：先記下原值，收尾還原（別的 live 測試會讀它）。
  const KEYS = ["systemWatchDistricts", "systemCrawlIntervalMinutes", "systemOfflineConfirmDays", "systemShowMrt", "systemShowListRefreshBar", "siteCatalogStats"];
  const saved = new Map();
  for (const key of KEYS) {
    saved.set(key, (await query("SELECT value FROM settings WHERE key = $1", [key]))[0]?.value ?? null);
  }
  const syncSequence = async (table, column = "id") => {
    await query(
      `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT COALESCE(MAX(${column}),0) FROM ${table}), 1))`,
      [table, column],
    );
  };
  const cleanup = async () => {
    for (const [key, value] of saved) {
      if (value == null) await query("DELETE FROM settings WHERE key = $1", [key]);
      else await query("UPDATE settings SET value = $1 WHERE key = $2", [value, key]);
    }
    await query("DELETE FROM listings WHERE source_key LIKE $1", [`${TOKEN}-%`]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  await cleanup();
  await syncSequence("listings", "post_id");

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 一筆在監看區、一筆不在、一筆沒有地址（測 COALESCE）
  for (const [sourceKey, title, address, source] of [
    [`${TOKEN}-1-5`, `${TOKEN} 大安區刊登`, "台北市大安區某路", "591"],
    [`${TOKEN}-1-7`, `${TOKEN} 信義區刊登`, "台北市信義區某路", "self"],
    [`${TOKEN}-1-5b`, `${TOKEN} 沒有地址`, null, "591"],
  ]) {
    await query(
      `INSERT INTO listings(source_key, title, url, source, address, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [sourceKey, title, `https://example.com/${sourceKey}`, source, address, OLD],
    );
  }

  // 1) 寫入（partial patch）→ 讀回：五個鍵都要在 PG 上、而且只有給的鍵被改
  const before = await contentAsync.getSystemCrawlAsync(opts);
  const saved1 = await contentAsync.saveSystemCrawlAsync(
    { watchDistricts: ["1-5"], intervalMinutes: 42, showMrt: false },
    opts,
  );
  assert.deepEqual(saved1.watchDistricts, ["1-5"]);
  assert.equal(saved1.intervalMinutes, 42);
  assert.equal(saved1.showMrt, false);
  assert.equal(saved1.showListRefreshBar, before.showListRefreshBar, "沒給的鍵不得被洗掉");
  for (const [key, expected] of [["systemWatchDistricts", ["1-5"]], ["systemCrawlIntervalMinutes", 42], ["systemShowMrt", false]]) {
    assert.equal((await query("SELECT value FROM settings WHERE key = $1", [key]))[0]?.value, JSON.stringify(expected), `${key} 必須真的寫進 PG`);
  }
  // 讀回時逐鍵組出來的形狀要與同步版一致
  assert.deepEqual(
    JSON.parse(JSON.stringify(await contentAsync.getSystemCrawlAsync(opts))),
    JSON.parse(JSON.stringify(dbMod.systemCrawlFromRows(
      (await query("SELECT key, value FROM settings WHERE key LIKE 'system%'" )).map((r) => ({ key: r.key, value: r.value })),
    ))),
    "PG 版逐鍵讀出來的結果必須等於用同一批列組出來的結果",
  );

  // 2) 目錄快照：真的寫進 PG，而且只算監看區裡的刊登
  const snapshot = await contentAsync.refreshSiteCatalogStatsAsync(opts);
  assert.ok(snapshot.total >= 2, `監看區至少要包含剛種的兩筆（實際 total=${snapshot.total}）`);
  assert.equal(
    (await query("SELECT value FROM settings WHERE key = 'siteCatalogStats'"))[0]?.value,
    JSON.stringify(snapshot),
    "PG 上必須有同一份快照",
  );

  // 3) 後台搜尋：PG 上真的有結果，而且 `address` 是 NULL 的那一筆不會讓查詢爆掉
  const hits = await adminAsync.searchAdminListingsAsync(`${TOKEN} 大安`, 20, opts);
  assert.equal(hits.length, 1, `關鍵字查詢必須找得到（實際 ${JSON.stringify(hits)}）`);
  assert.equal(hits[0].title, `${TOKEN} 大安區刊登`);
  const noAddress = await adminAsync.searchAdminListingsAsync(`${TOKEN} 沒有地址`, 20, opts);
  assert.equal(noAddress.length, 1, "COALESCE(address, '') 必須讓 NULL 位址的列也能被搜到（不丟錯）");
  const byId = await adminAsync.searchAdminListingsAsync(String(hits[0].post_id), 20, opts);
  assert.equal(byId[0]?.post_id, hits[0].post_id, "用 post_id 查也要相同");
});
