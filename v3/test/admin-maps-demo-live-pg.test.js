// 後台地圖開關 ＋ 訪客示範的 **live PG** 驗證（2026-09-29，第七十八批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **開關真的落在 PG 的 `settings`**（後台按一下，另一台節點也看得到）。
//   2. **示範的來源會員掃描看得到 PG 才有的會員**（同步版只掃本機 ⇒ 示範頁是空的／舊的）。
//   3. **示範清單與統計在真 PG 上跑得完**（走的是訪客列表頁同一條管線）。
//
// ⚠️ 安全設計照抄 `member-consents-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
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

const DISTRICT_KEY = "1-2"; // 台北市大同區（`regions.js` 的 districtKey 格式）
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-mapsdemo-live-"));
process.env.DATA_DIR = dataDir;

test("live PG：後台開關與訪客示範都讀寫 PG（本機不算）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const adminAsync = await import("../src/adminSettingsAsync.js");
  const demo = await import("../src/demo.js");
  const usersAsync = await import("../src/usersAsync.js");
  const settingsAsync = await import("../src/settingsAsync.js");
  const { searchPublicListingsAsync } = await import("../src/publicListingSearchAsync.js");
  const { listingStatsAsync } = await import("../src/listingStatsAsync.js");
  const dbMod = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  const pk = (await query(
    `SELECT a.attname AS column FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'users'::regclass AND i.indisprimary`,
  ))[0]?.column;
  await query(`SELECT setval(pg_get_serial_sequence('users', $1), GREATEST((SELECT COALESCE(MAX("${pk}"),0) FROM users), 1))`, [pk]);

  const MARK = `livetest-demo-${Date.now()}`;
  let uid = 0;
  t.after(async () => {
    if (uid) {
      try { await query("DELETE FROM user_settings WHERE user_id = $1", [uid]); } catch { /* 盡力而為 */ }
      try { await query("DELETE FROM users WHERE id = $1", [uid]); } catch { /* 盡力而為 */ }
    }
    try { await query("DELETE FROM settings WHERE key IN ('googleDirectionsEnabled','commuteRushEnabled')"); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  uid = Number((await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'示範測試','member','free',$2) RETURNING id",
    [`${MARK}@example.test`, "2026-01-01T00:00:00.000Z"],
  ))[0].id);
  // ⚠️ 形狀要對：`listingStatsAsync`／`settingsAsync`／`usersAsync` 這些島嶼的注入式 exec
  // 吃的是**純陣列**（`{rows, rowCount}` 是另一種慣例，只有部分島嶼在邊界正規化）。
  const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 1) 後台開關：寫 PG、讀 PG；本機那一份不被碰
  const before = await query("SELECT key, value FROM settings WHERE key = 'commuteRushEnabled'");
  await adminAsync.saveAdminMapsSettingsAsync({ googleEnabled: true, enabled: true }, opts);
  const rows = await query("SELECT key, value FROM settings WHERE key IN ('googleDirectionsEnabled','commuteRushEnabled') ORDER BY key");
  const byKey = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
  assert.equal(byKey.commuteRushEnabled, true, "尖峰開關要落在 PG");
  assert.equal(byKey.googleDirectionsEnabled, true, "Google 開關要落在 PG");
  const settings = await adminAsync.getAdminMapsSettingsAsync(opts);
  assert.equal(settings.enabled, true, "讀回來的狀態要反映 PG");
  t.after(async () => {
    // 還原原本的站台設定（這支測試會改動共用列）
    const original = before[0]?.value;
    if (original === undefined) await query("DELETE FROM settings WHERE key = 'commuteRushEnabled'").catch(() => {});
    else await query("UPDATE settings SET value = $1 WHERE key = 'commuteRushEnabled'", [original]).catch(() => {});
    await query("DELETE FROM settings WHERE key = 'googleDirectionsEnabled'").catch(() => {});
  });

  // 2) 會員清單：PG 才有的會員要看得到（同步版只看本機）
  const ids = await usersAsync.listUserIdsAsync(opts);
  assert.ok(ids.includes(uid), "PG 版要列得出這個會員");
  assert.equal(dbMod.listUserIds().includes(uid), false, "前提：本機沒有這個會員");

  // 3) 訪客示範：來源會員與清單、統計都走 PG
  // ⚠️ 行政區鍵是 `<region>-<section>`（`regions.js:districtKey`）；餵 "taipei" 會被正規化掉。
  await settingsAsync.saveSettingsAsync({ watchDistricts: [DISTRICT_KEY], commuteKm: 12 }, uid, opts);
  // ⚠️ 這是一個**共用**的隔離庫（repro）⇒ 會員清單交給「只回這個 uid」的注入版，挑選才確定；
  // 設定仍然從 PG 讀（本機沒有這個會員），所以「示範設定來自 PG」這件事照樣被驗到。
  // 「PG 的會員清單看得到他」由上面的 `listUserIdsAsync` 斷言單獨守住。
  const state = await demo.buildDemoStateAsync({
    listUserIdsAsync: async () => [uid],
    getSettingsAsync: (id, o) => settingsAsync.getSettingsAsync(id, o),
    defaultUserIdAsync: (o) => usersAsync.defaultUserIdAsync(o),
    listListingsAsync: (input, o) => searchPublicListingsAsync(input, o),
    statsAsync: (input, o) => listingStatsAsync(input, o),
    options: opts,
  });
  assert.equal(state.guest, true);
  assert.ok(Array.isArray(state.listings), "要有 listings 陣列");
  assert.ok(Array.isArray(state.cities) && state.cities.length > 0, "要有 cities");
  assert.equal(state.settings.workAddress, demo.DEMO_WORK_ADDRESS, "示範一律蓋上固定的公司地址");
  assert.equal(Number(state.settings.commuteKm), demo.DEMO_COMMUTE_KM);
  assert.equal(typeof state.stats.matched, "number", "stats.matched 要是數字");
  assert.equal(state.stats.shown, state.listings.length, "shown 要用實際回傳的筆數");
  // 來源會員必須是「PG 上那個有追蹤行政區的會員」之一：示範設定的行政區要與 PG 讀到的一致
  assert.ok(state.settings.watchDistricts.includes(DISTRICT_KEY), "示範設定的追蹤行政區要來自 PG 的會員設定");
});
