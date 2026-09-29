// 路線快取／路線工作 ＋ 全會員通勤設定 ＋ 推播送出的 **live PG** 驗證
// （2026-09-29，第七十七批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **worker 寫進 PG 的路線，卡片路徑真的讀得到**（這一條就是病灶本身：同步版寫本機、
//      卡片讀 PG ⇒ 通勤欄位永遠算不出來）。所以這裡用「寫入島嶼 ＋ 讀取島嶼」端到端驗一次。
//   2. **`= ANY`／`ON CONFLICT(route_key)` 在真 PG 上跑得動**（`ON CONFLICT` 要有唯一鍵）。
//   3. **站台設定（`commuteRushEnabled`）與全會員設定讀的是 PG 那一份**（不是節點本機）。
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-routecache-live-"));
process.env.DATA_DIR = dataDir;

test("live PG：worker 寫的路線要讓卡片路徑算得出通勤欄位（同步版是寫本機）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const { makeRouteKey } = await import("../src/route.js");
  const cacheAsync = await import("../src/routeCacheAsync.js");
  const settingsAsync = await import("../src/settingsAsync.js");
  const commuteAsync = await import("../src/listingCommuteAsync.js");
  const pushAsync = await import("../src/webPushAsync.js");
  const { COMMUTE_STATES } = await import("../src/commuteState.js");
  const dbMod = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  const syncSequence = async (table) => {
    const pk = (await query(
      `SELECT a.attname AS column FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [table],
    ))[0]?.column;
    await query(`SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT COALESCE(MAX("${pk}"),0) FROM ${table}), 1))`, [table, pk]);
  };

  const POST = 779901;
  const WORK = { workLat: 25.0375, workLng: 121.5637 };
  const HOME = { lat: 25.0131, lng: 121.4627 };
  const JOB = { post_id: POST, workLat: WORK.workLat, workLng: WORK.workLng, commuteMode: "scooter" };
  const JOB_KEY = dbMod.routeJobKeyFor(JOB, "to_work", "distance");
  const ROUTE_KEY = makeRouteKey(HOME.lat, HOME.lng, WORK.workLat, WORK.workLng, "scooter", "to_work");
  let uid = 0;

  t.after(async () => {
    try { await query("DELETE FROM listings WHERE post_id = $1", [POST]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM route_cache WHERE route_key = $1", [ROUTE_KEY]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM route_jobs WHERE job_key = $1", [JOB_KEY]); } catch { /* 盡力而為 */ }
    if (uid) {
      try { await query("DELETE FROM user_settings WHERE user_id = $1", [uid]); } catch { /* 盡力而為 */ }
      try { await query("DELETE FROM push_subscriptions WHERE user_id = $1", [uid]); } catch { /* 盡力而為 */ }
      try { await query("DELETE FROM users WHERE id = $1", [uid]); } catch { /* 盡力而為 */ }
    }
    try { await query("DELETE FROM settings WHERE key = 'commuteRushEnabled'"); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  await syncSequence("users");
  uid = Number((await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'路線快取測試','member','free',$2) RETURNING id",
    [`livetest-routecache-${Date.now()}@example.test`, "2026-01-01T00:00:00.000Z"],
  ))[0].id);
  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 會員設定（工作點）＋ 一筆「PG 才有的刊登」
  await settingsAsync.saveSettingsAsync(
    { ...WORK, workAddress: "台北市信義區市府路1號", commuteKm: 15, commuteMode: "scooter" }, uid, opts,
  );
  await query(
    `INSERT INTO listings(post_id, title, url, source, source_key, address, address_norm, area_name, layout, floor_name,
       lat, lng, geo_source, location_class, price, price_num, offline, hidden, first_seen_at, last_seen_at)
     VALUES ($1,'路線快取測試','https://example.test/live-routecache','591','591|live77',$2,$2,'文化路','3房2廳','5F',
       $3,$4,'geocode','address',25000,25000,0,0,$5,$5)`,
    [POST, "新北市板橋區文化路1段1號", HOME.lat, HOME.lng, "2026-09-29T00:00:00.000Z"],
  );

  // 1) 站台設定：PG 說開就是開（本機那一份不算）
  await query("INSERT INTO settings(key, value) VALUES ('commuteRushEnabled', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'");
  assert.equal(await settingsAsync.commuteRushEnabledAsync(opts), true, "PG 的站台設定要是唯一依據");

  // 2) worker 寫路線（PG）→ 卡片路徑（PG）算得出通勤欄位
  const written = await cacheAsync.setCachedRouteAsync(HOME.lat, HOME.lng, WORK.workLat, WORK.workLng, [8.4], null, "scooter", "to_work", opts);
  assert.equal(written.ok, true);
  assert.equal(written.route_key, ROUTE_KEY);
  const cacheRow = (await query("SELECT distances, min_km FROM route_cache WHERE route_key = $1", [ROUTE_KEY]))[0];
  assert.ok(cacheRow, "路線必須落在 PG 的 route_cache");
  assert.equal(Number(cacheRow.min_km), 8.4);
  const settings = await settingsAsync.getSettingsAsync(uid, opts);
  const patches = await commuteAsync.listingCommutePatchesAsync([POST], uid, { ...opts, settings });
  assert.equal(patches.length, 1, "PG 才有的刊登要讀得到");
  assert.equal(patches[0].commute_km, 8.4, "卡片路徑必須讀到 worker 剛寫進 PG 的路線");
  assert.equal(patches[0].commute_state, "done");

  // 3) route_jobs：upsert → 回讀 → markRouteJob 保留 attempts → finishRouteAttempt +1
  const job1 = await cacheAsync.upsertRouteJobAsync({ ...JOB, direction: "to_work", kind: "distance", job_state: COMMUTE_STATES.WAIT_ROUTE }, opts);
  assert.equal(job1.job_key, JOB_KEY);
  assert.equal(Number(job1.attempts), 0);
  await query("UPDATE route_jobs SET attempts = 2 WHERE job_key = $1", [JOB_KEY]);
  await cacheAsync.markRouteJobAsync(JOB, "to_work", "distance", { job_state: COMMUTE_STATES.COMPUTING }, opts);
  const computing = await cacheAsync.getRouteJobAsync(JOB_KEY, opts);
  assert.equal(Number(computing.attempts), 2, "markRouteJob 不得把 attempts 歸零");
  assert.equal(computing.job_state, COMMUTE_STATES.COMPUTING);
  const finished = await cacheAsync.finishRouteAttemptAsync(JOB, "to_work", "distance", "busy", opts);
  assert.equal(Number(finished.attempts), 3, "attempts 要 +1");

  // 4) 全會員通勤設定：要看得到 PG 的會員，而且 `settingsForGeoBackfillAsync` 挑得到需要補的人
  const list = await settingsAsync.collectCommuteSettingsAsync(opts);
  assert.ok(
    list.some((row) => Number(row.commuteKm) === 15 && Number(row.workLat) === WORK.workLat),
    "PG 的會員設定必須在清單裡",
  );
  const picked = await settingsAsync.settingsForGeoBackfillAsync(settings, opts);
  assert.equal(Number(picked.commuteKm), 15, "呼叫端給的設定本身就滿足條件時要直接回它");

  // 5) 推播：PG 有訂閱就不能回 no-sub（同步版只看本機）
  await query(
    `INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, created_at, last_seen_at)
     VALUES ($1,$2,'p256','auth',$3,$3) ON CONFLICT (endpoint) DO NOTHING`,
    [uid, `https://push.example.test/live77-${uid}`, "2026-09-29T00:00:00.000Z"],
  );
  const push = await pushAsync.sendUserWebPushAsync(uid, { title: "t", body: "b" }, opts);
  assert.notEqual(push.skipped, "no-sub", "PG 有訂閱時不得回 no-sub");
  assert.equal((await pushAsync.listPushSubscriptionsAsync(uid, opts)).length, 1);
});
