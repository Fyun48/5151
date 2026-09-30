// 抓取來源連續失敗狀態的 **live PG** 驗證（2026-09-30，第九十二批）。
//
// 離線測試用的是記憶體 SQLite＋注入式 exec，證明不了兩件事：
//
//   1. `crawlScheduleV1` 的讀-改-寫在**真 PG** 上是「先鎖再寫」的交易
//      （`SELECT … FOR UPDATE`），而且只加 `sourceStreaks`、不會把 `counter`／`attempts`／
//      `completed` 蓋掉——正式站那份狀態裡有近 3000 筆 attempts，蓋掉等於排程公平性重來。
//   2. **島嶼自己解析驅動**的那條路（第九十批的教訓：離線測試幾乎都注入 `exec`／`pgDriver`，
//      於是 `pgDriver.query is not a function` 這種缺陷只在正式站出現）。
//      這一支刻意**不注入**任何 driver：只設 `DB_DRIVER=postgres` ＋ `PG_URL`，
//      讓 `recordCrawlSourceRoundAsync()`／`readCrawlSourceStreaksAsync()`／`crawlSourceHealthAsync()`
//      自己走 `sharedPgDriver()`。
//
// ⚠️ 安全設計照抄 `system-crawl-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向正式影子庫），
// 只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
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
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫一律拒絕）`
    : false;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-crawl-streaks-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;
if (RAW) {
  // 島嶼自己解析驅動走的就是這兩個環境變數（不是注入）。
  process.env.DB_DRIVER = "postgres";
  process.env.PG_URL = RAW;
}

test("live PG：來源連續失敗狀態落在 crawlScheduleV1，且不蓋掉排程游標", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { recordCrawlSourceRoundAsync, readCrawlSourceStreaksAsync } = await import("../src/crawlScheduleAsync.js");
  const { crawlSourceHealthAsync } = await import("../src/adminOverviewAsync.js");
  const { sqliteHandle } = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  const KEY = "crawlScheduleV1";
  const SOURCES_KEY = "crawlSources";
  const saved = (await query("SELECT value FROM settings WHERE key = $1", [KEY]))[0]?.value ?? null;
  const savedSources = (await query("SELECT value FROM settings WHERE key = $1", [SOURCES_KEY]))[0]?.value ?? null;
  t.after(async () => {
    try {
      if (saved == null) await query("DELETE FROM settings WHERE key = $1", [KEY]);
      else await query("UPDATE settings SET value = $1 WHERE key = $2", [saved, KEY]);
      if (savedSources == null) await query("DELETE FROM settings WHERE key = $1", [SOURCES_KEY]);
      else await query("UPDATE settings SET value = $1 WHERE key = $2", [savedSources, SOURCES_KEY]);
    } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
  });
  // 這一支只碰 settings；先確認本行程的 SQLite 也只是拋棄式目錄（雙保險）。
  assert.equal(sqliteHandle().prepare("SELECT COUNT(*) AS n FROM settings").get().n >= 0, true);

  const at = new Date().toISOString();
  // 排程游標先種一份：證明島嶼的讀-改-寫不會把別人的欄位洗掉。
  const seed = { counter: 42, attempts: { "1|2|0|0": 42 }, completed: { "1|2|0|0": { cover: {}, at } } };
  await query(
    "INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [KEY, JSON.stringify(seed)],
  );

  // 正式站的形狀：591 一直成功（房源持續落地），5168 一直失敗。
  const rounds = [
    { source: "591", covered: 6, total: 6, error: "" },
    { source: "houseprice", covered: 0, total: 6, error: "5168 第 1 頁 [FETCH_FAILED]：timeout" },
  ];
  for (let round = 1; round <= 3; round += 1) {
    // ⚠️ 不傳 options：讓島嶼自己解析驅動（這正是第九十批漏掉的那條路）。
    const applied = await recordCrawlSourceRoundAsync({ rounds, at });
    assert.equal(applied.streaks["591"].fails, 0, "成功的來源不得累積");
    assert.equal(applied.streaks.houseprice.fails, round, `第 ${round} 輪的連續失敗數`);
    if (round < 3) assert.deepEqual(applied.tolerated, [], `第 ${round} 輪還沒到門檻，仍要阻擋`);
    else assert.deepEqual(applied.toleratedNow, ["houseprice"], "第 3 輪才放行（且只警告一次）");
  }

  const stored = JSON.parse((await query("SELECT value FROM settings WHERE key = $1", [KEY]))[0].value);
  assert.equal(stored.counter, 42, "排程游標不能被蓋掉");
  assert.deepEqual(stored.attempts, seed.attempts, "attempts 不能被蓋掉");
  assert.deepEqual(stored.completed, seed.completed, "completed 不能被蓋掉");
  assert.equal(stored.sourceStreaks.houseprice.fails, 3, "狀態要真的寫進 PG 的 settings");
  assert.match(stored.sourceStreaks.houseprice.lastError, /timeout/);
  const back = await readCrawlSourceStreaksAsync();
  assert.deepEqual(back.tolerated, ["houseprice"]);

  // 後台那條鏈路（同樣不注入）：來源健康度要看得出「連續失敗 3 輪（已放行完成紀錄）」。
  // ⚠️ 先把 houseprice **打開**再驗：CI 的拋棄式 PG 是全新資料庫（沒有 `crawlSources` 鍵
  // ⇒ 走預設值，只有 591／自行刊登開啟），而 `sourceHealthFromRow()` 對未啟用的來源一律回
  // 「已關閉」（那是刻意的優先序）。第一版沒開，CI 的 PG job 就紅在 `'已關閉'` 上。
  await query(
    "INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [SOURCES_KEY, JSON.stringify([
      { id: "591", label: "591 租屋", stub: false, enabled: true },
      { id: "houseprice", label: "5168 租屋", stub: false, enabled: true },
    ])],
  );
  const health = await crawlSourceHealthAsync();
  const hp = health.find((row) => row.id === "houseprice");
  assert.ok(hp, "來源清單要有 houseprice");
  assert.equal(hp.consecutiveFailures, 3);
  assert.equal(hp.tolerated, true);
  assert.match(hp.statusLabel, /已放行完成紀錄/);
  assert.equal(health.find((row) => row.id === "591").consecutiveFailures, 0);

  // 恢復成功 ⇒ 立刻歸零、退出容忍名單（照舊從嚴）。
  const recovered = await recordCrawlSourceRoundAsync({ rounds: [{ source: "houseprice", covered: 6, total: 6, error: "" }], at });
  assert.equal(recovered.streaks.houseprice.fails, 0);
  assert.deepEqual(recovered.tolerated, []);
  assert.deepEqual(recovered.recovered, ["houseprice"]);
});
