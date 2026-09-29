// 路線快取／路線工作 ＋ 全會員通勤設定 ＋ 推播送出的 PG 島嶼 parity
// （2026-09-29，第七十七批）。
//
// 涵蓋的路由：`POST /api/settings`、`POST /api/listings/:id/flags`、`POST /api/commute/focus`
// ——三條的卡點集完全相同，共同鏈是 `queueGeoBackfill()` → `backfillListingRoutes()` 這條
// **背景補路線 worker**。它原本用同步的 `setCachedRoute()`／`getRouteJob()`／`upsertRouteJob()`
// 寫入，PG 模式下寫的是**節點本機 SQLite**：
//
//   - 剛算好的通勤路線寫進本機、卡片卻從 PG 讀 ⇒ **不論補幾輪，通勤欄位永遠算不出來**
//     （同一筆反覆重算，沒有錯誤訊息）；
//   - `route_jobs` 的狀態留在本機 ⇒ 另一台節點看到舊狀態、重複抓同一個路段。
//
// 這一包釘住五件事：
//   1. `route_cache`／`route_jobs` 的落地**逐欄位相同**（含 `route_key` 的算法與尖峰時段欄位）。
//   2. `markRouteJob()`／`finishRouteAttempt()` 的 `attempts` 與重試決策（純函式）在兩個 driver 一致。
//   3. `commuteRushEnabled()` 讀的是**站台層級設定的那一個 store**（PG 模式讀本機等於亂開／沒開）。
//   4. `collectCommuteSettings()`／`settingsForGeoBackfill()` 要**看得到 PG 才有的會員**。
//   5. 推播訂閱要讀 PG（本機沒有訂閱不代表會員沒有訂閱）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-routecache77-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } });

const dbMod = await import("../src/db.js");
const cacheAsync = await import("../src/routeCacheAsync.js");
const settingsAsync = await import("../src/settingsAsync.js");
const pushAsync = await import("../src/webPushAsync.js");
const { routeRetryDecision, COMMUTE_STATES } = await import("../src/commuteState.js");
const { makeRouteKey } = await import("../src/route.js");

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const diskPath = () => path.join(dataDir, "v3.db");
const UID = 770001;
const UID2 = 770002;
const ROW = { post_id: 770901, workLat: 25.0375, workLng: 121.5637, commuteMode: "scooter" };
const KEY = "770901|to_work|distance|scooter|25.0375,121.5637";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\bAUTOINCREMENT\b/i, "syntax error at or near \"AUTOINCREMENT\""],
];
const TABLES = ["users", "settings", "user_settings", "route_cache", "route_jobs", "push_subscriptions"];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(rows[0].sql);
  }
  disk.close();
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    try {
      return mem.prepare(sql).all(...params);
    } catch (error) {
      throw new Error(`夾具無法執行這句 SQL：${error.message}\n${sql}`);
    }
  };
  exec.raw = mem;
  return exec;
}

function seedUser(h, id, { settings = {} } = {}) {
  h.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
    .run(id, `cache${id}@example.test`, `會員${id}`, "2026-01-01T00:00:00.000Z");
  for (const [key, value] of Object.entries(settings)) {
    h.prepare(
      `INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    ).run(id, key, JSON.stringify(value));
  }
}
const clearWorld = (h) => {
  for (const t of ["route_cache", "route_jobs", "push_subscriptions"]) h.prepare(`DELETE FROM ${t}`).run();
  h.prepare("DELETE FROM user_settings WHERE user_id IN (?,?)").run(UID, UID2);
};
const routeRow = (h, key) => h.prepare("SELECT * FROM route_cache WHERE route_key = ?").get(key) || null;
const jobRow = (h, key) => h.prepare("SELECT * FROM route_jobs WHERE job_key = ?").get(key) || null;
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 兩個 store 種同一份起點（同步基準在本機、PG 版在替身）。 */
function worlds(seed) {
  const disk = handle();
  const exec = pgFixture();
  clearWorld(disk);
  clearWorld(exec.raw);
  if (seed) { seed(disk); seed(exec.raw); }
  return [disk, exec];
}
const commutish = { commuteKm: 15, workLat: 25.0375, workLng: 121.5637, commuteMode: "scooter", workAddress: "台北市信義區市府路1號" };
// PG 才有的那一份（本機沒有這個會員）用可辨識的地址當標記。
const PG_ONLY_ADDRESS = "PG-ONLY-ADDRESS";

test("route_cache：PG 版落地與同步版逐欄位相同（含尖峰時段與 route_key）", async () => {
  const [disk, exec] = worlds();
  const args = [25.0131, 121.4627, 25.0375, 121.5637, [8.4, 9.1]];
  // ⚠️ 鍵的格式是應用自己的（`route.js:makeRouteKey`）——不要手寫，否則測的是我的猜測。
  const syncKey = makeRouteKey(25.0131, 121.4627, 25.0375, 121.5637, "scooter", "to_work");
  dbMod.setCachedRoute(...args, { rushAm: 26, rushPm: 31 }, "scooter", "to_work");
  const syncRow = routeRow(disk, syncKey);
  assert.ok(syncRow, "前提：同步版寫得進去（鍵是應用自己算的）");
  const result = await cacheAsync.setCachedRouteAsync(...args, { rushAm: 26, rushPm: 31 }, "scooter", "to_work", { ...PG, exec });
  assert.equal(result.ok, true);
  const asyncRow = routeRow(exec.raw, result.route_key);
  assert.equal(result.route_key, syncKey, "route_key 必須與同步版相同（否則兩個 driver 各寫一列）");
  assert.deepEqual(
    { ...plain(asyncRow), updated_at: null, rush_updated_at: null },
    { ...plain(syncRow), updated_at: null, rush_updated_at: null },
    "route_cache 的欄位必須逐欄位相同",
  );
  assert.equal(Number(asyncRow.min_km), 8.4, "min_km 要是清單最小值");
  assert.equal(Number(asyncRow.rush_am_min), 26);
  assert.equal(Number(asyncRow.rush_pm_min), 31);

  // 沒有尖峰資料時：不寫尖峰欄位（與同步版的第二句 SQL 相同）
  const noRush = await cacheAsync.setCachedRouteAsync(25.02, 121.5, 25.0375, 121.5637, [3.3], null, "scooter", "to_work", { ...PG, exec });
  dbMod.setCachedRoute(25.02, 121.5, 25.0375, 121.5637, [3.3], null, "scooter", "to_work");
  assert.deepEqual(
    { ...plain(routeRow(exec.raw, noRush.route_key)), updated_at: null },
    { ...plain(routeRow(disk, noRush.route_key)), updated_at: null },
    "沒有尖峰資料時的落地也要相同（`updated_at` 是各自的寫入時間，不比）",
  );

  // 空清單：兩個 driver 都不寫（同步版 early return）
  const before = exec.raw.prepare("SELECT COUNT(*) AS n FROM route_cache").get().n;
  assert.equal((await cacheAsync.setCachedRouteAsync(1, 2, 3, 4, [], null, "scooter", "to_work", { ...PG, exec })).ok, false);
  assert.equal(exec.raw.prepare("SELECT COUNT(*) AS n FROM route_cache").get().n, before, "空清單不得寫入");
});

test("route_jobs：upsert 的更新語意與 attempts 都與同步版相同", async () => {
  const [disk, exec] = worlds();
  const opts = { ...PG, exec };
  // 首次寫入：沒有既有列 ⇒ attempts 0（與同步版相同）
  const first = await cacheAsync.upsertRouteJobAsync({ ...ROW, direction: "to_work", kind: "distance", job_state: COMMUTE_STATES.WAIT_ROUTE }, opts);
  dbMod.upsertRouteJob({ ...ROW, direction: "to_work", kind: "distance", job_state: COMMUTE_STATES.WAIT_ROUTE });
  assert.equal(first.job_key, KEY, "job_key 的算法必須與同步版相同（含通勤模式與座標）");
  assert.deepEqual(
    { ...plain(first), updated_at: null },
    { ...plain(jobRow(disk, KEY)), updated_at: null },
    "第一次 upsert 的落地必須相同",
  );

  // 第二次：ON CONFLICT 只更新狀態欄位（不得把 attempts 或座標清掉）
  const second = await cacheAsync.upsertRouteJobAsync({ ...ROW, direction: "to_work", kind: "distance", job_state: COMMUTE_STATES.DONE, attempts: 3, fail_reason: "" }, opts);
  assert.equal(Number(second.attempts), 3);
  assert.equal(second.job_state, COMMUTE_STATES.DONE);
  assert.equal(Number(second.post_id), ROW.post_id);
  assert.ok(Number.isFinite(Number(second.work_lat)), "work_lat 必須留著");

  const read = await cacheAsync.getRouteJobAsync(KEY, opts);
  assert.deepEqual(plain(read), plain(jobRow(exec.raw, KEY)), "回讀那一列");
  assert.equal(await cacheAsync.getRouteJobAsync("", opts), null, "空鍵回 null（與同步版相同）");
  assert.equal(await cacheAsync.getRouteJobAsync("no-such-key", opts), null);

  // markRouteJob：沿用既有 attempts，只換狀態
  exec.raw.prepare("UPDATE route_jobs SET attempts = 2 WHERE job_key = ?").run(KEY);
  await cacheAsync.markRouteJobAsync(ROW, "to_work", "distance", { job_state: COMMUTE_STATES.COMPUTING }, opts);
  assert.equal(Number(jobRow(exec.raw, KEY).attempts), 2, "markRouteJob 不得把 attempts 歸零");
  assert.equal(jobRow(exec.raw, KEY).job_state, COMMUTE_STATES.COMPUTING);

  // finishRouteAttempt：attempts +1 且決策用共用的純函式
  const finished = await cacheAsync.finishRouteAttemptAsync(ROW, "to_work", "distance", "busy", opts);
  const expected = routeRetryDecision("busy", 3);
  assert.equal(Number(finished.attempts), 3, "attempts 要 +1");
  assert.equal(finished.job_state, expected.job_state, "重試決策必須與共用純函式一致");
  assert.equal(String(finished.fail_reason || ""), String(expected.fail_reason || ""));
});

test("寫入是 fail-closed：PG 失敗時 strict 要往上丟，fallback: open 才回退", async () => {
  const [, exec] = worlds();
  const boom = async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); };
  await assert.rejects(
    () => cacheAsync.setCachedRouteAsync(1, 2, 3, 4, [5], null, "scooter", "to_work", { ...PG, exec: boom }),
    /ECONNREFUSED/, "寫入失敗不得靜默改寫本機",
  );
  await assert.rejects(
    () => cacheAsync.upsertRouteJobAsync({ ...ROW, direction: "to_work", kind: "distance" }, { ...PG, exec: boom }),
    /ECONNREFUSED/,
  );
  // 非 strict（預設 closed）：**寫入**仍要 fail-closed，讀取才 fail-open。
  const loose = { driver: "postgres", exec: boom };
  await assert.rejects(
    () => cacheAsync.setCachedRouteAsync(1, 2, 3, 4, [5], null, "scooter", "to_work", loose),
    /ECONNREFUSED/, "預設模式下寫入也不得回退本機",
  );
  await assert.rejects(
    () => cacheAsync.upsertRouteJobAsync({ ...ROW, direction: "to_work", kind: "distance" }, loose),
    /ECONNREFUSED/,
  );
  assert.equal(await cacheAsync.getRouteJobAsync(KEY, loose), null, "讀取失敗時回退本機（這裡本機沒有那一列）");
  const looseKey = makeRouteKey(1, 2, 3, 4, "scooter", "to_work");
  assert.equal(routeRow(handle(), looseKey), null, "前提：本機還沒有那一列");
  await cacheAsync.setCachedRouteAsync(1, 2, 3, 4, [5], null, "scooter", "to_work", { driver: "postgres", exec: boom, fallback: "open" });
  assert.ok(routeRow(handle(), looseKey), "fallback: open 時才寫本機");
  void exec;
});

test("commuteRushEnabled：PG 模式讀 PG 的站台設定（本機的值不算）", async () => {
  const [, exec] = worlds((h) => {
    // 本機說「開」、PG 說「關」——同步版在 PG 模式下會用本機那一份（這就是病灶）
    h.prepare("INSERT INTO settings(key, value) VALUES ('commuteRushEnabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(false));
  });
  assert.equal(dbMod.commuteRushEnabled(), false);
  assert.equal(await settingsAsync.commuteRushEnabledAsync({ ...PG, exec }), false);
  exec.raw.prepare("UPDATE settings SET value = ? WHERE key = 'commuteRushEnabled'").run(JSON.stringify(true));
  assert.equal(await settingsAsync.commuteRushEnabledAsync({ ...PG, exec }), true, "PG 說開就是開");
  assert.equal(dbMod.commuteRushEnabled(), false, "本機那一份不該被拿來當答案");
  exec.raw.prepare("DELETE FROM settings WHERE key = 'commuteRushEnabled'").run();
  assert.equal(await settingsAsync.commuteRushEnabledAsync({ ...PG, exec }), false, "沒有設定時與同步版的預設相同");
  // sqlite 模式：走同步版
  assert.equal(await settingsAsync.commuteRushEnabledAsync({ driver: "sqlite", exec }), false);
});

test("全會員通勤設定：PG 才有的會員必須進清單，settingsForGeoBackfill 也要看得到", async () => {
  // ⚠️ 這一條**不能**用對稱的 `worlds()`：兩個 store 的會員本來就必須不一樣
  // （UID2 是「別的節點建立的會員」）。
  const disk = handle();
  const exec = pgFixture();
  clearWorld(disk);
  clearWorld(exec.raw);
  // UID **不需要**補地理資料（`commuteKm: 0`）⇒ `settingsForGeoBackfill()` 應該挑到 UID2。
  seedUser(disk, UID, { settings: { commuteKm: 0, workAddress: commutish.workAddress } });
  seedUser(exec.raw, UID, { settings: { commuteKm: 0, workAddress: commutish.workAddress } });
  seedUser(exec.raw, UID2, { settings: { ...commutish, workAddress: PG_ONLY_ADDRESS } });
  const opts = { ...PG, exec };
  const list = await settingsAsync.collectCommuteSettingsAsync(opts);
  const addresses = list.map((row) => String(row.workAddress || ""));
  assert.ok(addresses.includes(commutish.workAddress), "PG 的會員要在清單裡");
  assert.ok(addresses.includes(PG_ONLY_ADDRESS), "PG 才有的會員也必須在清單裡（同步版看不到）");
  assert.ok(list.length >= 3, "尾巴要固定補站台設定與示範補丁（與同步版同一個形狀）");
  assert.equal(
    dbMod.collectCommuteSettings().some((row) => String(row.workAddress || "") === PG_ONLY_ADDRESS),
    false,
    "前提：同步版看不到 PG 才有的會員（它讀本機）",
  );

  const picked = await settingsAsync.settingsForGeoBackfillAsync(null, opts);
  assert.equal(String(picked.workAddress || ""), PG_ONLY_ADDRESS, "挑到的必須是 PG 那一份（本機沒有這個會員）");
});

test("推播送出：讀的是 PG 的訂閱（本機沒有不等於沒訂閱）", async () => {
  // `push_subscriptions` 有 FK → users，夾具要先有那個帳號。
  const [, exec] = worlds((h) => seedUser(h, UID));
  const opts = { ...PG, exec };
  const noSubs = await pushAsync.sendUserWebPushAsync(UID, { title: "t", body: "b" }, opts);
  assert.equal(noSubs.skipped, "no-sub", "兩邊都沒有訂閱時回 no-sub");

  // 訂閱**只在 PG**（會員在另一台節點按了允許通知）
  exec.raw.prepare(
    "INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, created_at, last_seen_at) VALUES (?,?,?,?,?,?)",
  ).run(UID, "https://push.example.test/pg-only", "p256", "auth", "2026-09-29T00:00:00.000Z", "2026-09-29T00:00:00.000Z");
  const result = await pushAsync.sendUserWebPushAsync(UID, { title: "t", body: "b" }, opts);
  assert.notEqual(result.skipped, "no-sub", "PG 有訂閱就不能回 no-sub（同步版會漏掉這一筆）");
  assert.equal(typeof result.sent, "number");
  assert.equal(await pushAsync.listPushSubscriptionsAsync(UID, opts).then((rows) => rows.length), 1, "PG 讀得到那一筆訂閱");

  // sqlite 模式：走同步版（本機沒有訂閱）
  assert.equal((await pushAsync.sendUserWebPushAsync(UID, { title: "t" }, { driver: "sqlite", exec })).skipped, "no-sub");
});

test("worker 接線：補路線 worker 不得再用同步的 route_cache／route_jobs／推播", () => {
  const watcher = readFileSync(path.join(SRC, "watcher.js"), "utf8");
  for (const banned of ["setCachedRoute(", "getRouteJob(", "upsertRouteJob(", "sendUserWebPush(", "commuteRushEnabled()"]) {
    assert.ok(!watcher.includes(banned), `watcher.js 不得再用同步的 ${banned}`);
  }
  // 這一條是 `resolveListingRoute()` 的非尖峰寫入：少了它，補路線等於白跑（突變會活下來）。
  assert.ok(
    watcher.includes('await setCachedRouteAsync(lat, lng, workLat, workLng, distances, null, mode, "to_work", options);'),
    "resolveListingRoute 必須把算好的路線寫進路線快取",
  );
  for (const expected of [
    "await setCachedRouteAsync(",
    "await markRouteJobAsync(",
    "await finishRouteAttemptAsync(",
    "await commuteRushEnabledAsync(options)",
    "await sendUserWebPushAsync(userId, pushPayloadFromEvents(push), options)",
    "await bindNotifyJobSnapshotsFor(options)",
    "await settingsForGeoBackfillAsync(resolved)",
  ]) {
    const hay = expected.includes("settingsForGeoBackfillAsync")
      ? readFileSync(path.join(SRC, "server.js"), "utf8")
      : watcher;
    assert.ok(hay.includes(expected), `必須接上 ${expected}`);
  }
  // 推播／統計的廣播路徑：不得再用同步的 stats()（它會把 countWatched／loadFlagMap／
  // ensureUser／getUserById／listUserIds／getActiveSearchProfile／sqlExcludeFixtureRows
  // 整條鏈拉回卡點清單，而且推給瀏覽器的是本機統計）
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  for (const fn of ["async function broadcastWatch(result)", "async function broadcastNotify(events)"]) {
    const start = server.indexOf(fn);
    assert.ok(start > 0, `找得到 ${fn}`);
    const body = server.slice(start, server.indexOf("\n}", start));
    assert.ok(!/\bstats\(/.test(body), `${fn} 不得再用同步的 stats()`);
    assert.ok(body.includes("await safeStats("), `${fn} 必須用 safeStats()`);
  }
  // 三條路由：不得再用同步的 stats()／settingsForGeoBackfill()
  for (const route of ['app.post("/api/settings"', 'app.post("/api/listings/:id/flags"', 'app.post("/api/commute/focus"']) {
    const start = server.indexOf(route);
    assert.ok(start > 0, `找得到 ${route}`);
    const body = server.slice(start, server.indexOf("\n});", start));
    assert.ok(!/\bstats\(/.test(body), `${route} 不得再用同步的 stats()`);
    assert.ok(!body.includes("settingsForGeoBackfill("), `${route} 不得再用同步的 settingsForGeoBackfill()`);
  }
});
