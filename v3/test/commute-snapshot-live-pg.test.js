// 通勤快照的 **live PG** 驗證（2026-09-29，第七十六批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **PG 才有的刊登讀得到**：同步版在 PG 模式下會回 `null`（地圖卡片沒有通勤資訊），
//      PG 版要在真 PG 上把列讀出來並算出通勤欄位。
//   2. **預載的裝飾資料真的從 PG 來**：`route_cache` 的路線公里數、`user_same_house_members`
//      的個人同戶、`user_listing_flags` 的觀看旗標，都要在真 PG 上被 `preloadDecorationProviderAsync`
//      讀到（離線夾具是把磁碟的列複製過去才對得起來的）。
//   3. **`= ANY($n::bigint[])` 的陣列綁定在真 PG 上跑得動**（夾具是把它展開成 `IN (?,…)` 才跑得起來）。
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-commute-live-"));
process.env.DATA_DIR = dataDir;

test("live PG：PG 才有的刊登要算得出通勤欄位（同步版只看得到本機、會回 null）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const { makeRouteKey } = await import("../src/route.js");
  const settingsAsync = await import("../src/settingsAsync.js");
  const commuteAsync = await import("../src/listingCommuteAsync.js");
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

  const POST = 769901;
  const WORK = { workLat: 25.0375, workLng: 121.5637 };
  const HOME = { lat: 25.0131, lng: 121.4627 };
  const ROUTE_KEY = makeRouteKey(HOME.lat, HOME.lng, WORK.workLat, WORK.workLng, "scooter", "to_work");
  const RETURN_KEY = makeRouteKey(WORK.workLat, WORK.workLng, HOME.lat, HOME.lng, "scooter", "from_work");
  let uid = 0;

  t.after(async () => {
    try { await query("DELETE FROM listings WHERE post_id = $1", [POST]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM route_cache WHERE route_key = ANY($1::text[])", [[ROUTE_KEY, RETURN_KEY]]); } catch { /* 盡力而為 */ }
    if (uid) {
      try { await query("DELETE FROM user_settings WHERE user_id = $1", [uid]); } catch { /* 盡力而為 */ }
      try { await query("DELETE FROM user_listing_flags WHERE user_id = $1", [uid]); } catch { /* 盡力而為 */ }
      try { await query("DELETE FROM user_same_house_members WHERE user_id = $1", [uid]); } catch { /* 盡力而為 */ }
      try { await query("DELETE FROM users WHERE id = $1", [uid]); } catch { /* 盡力而為 */ }
    }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  await syncSequence("users");
  uid = Number((await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'通勤快照測試','member','free',$2) RETURNING id",
    [`livetest-commute-${Date.now()}@example.test`, "2026-01-01T00:00:00.000Z"],
  ))[0].id);
  assert.ok(uid, "要有測試帳號");

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 會員設定（工作點與通勤上限）走 PG 的設定島嶼
  await settingsAsync.saveSettingsAsync(
    { ...WORK, workAddress: "台北市信義區市府路1號", commuteKm: 15, commuteMode: "scooter" }, uid, opts,
  );
  const settings = await settingsAsync.getSettingsAsync(uid, opts);
  assert.equal(Number(settings.commuteKm), 15, "前提：設定要真的落在 PG");
  assert.equal(Number(settings.workLat), WORK.workLat);

  // 這一筆刊登**只存在 PG**（本機沒有）——這就是同步版的地圖卡片會空白的原因
  await query(
    `INSERT INTO listings(post_id, title, url, source, source_key, address, address_norm, area_name, layout, floor_name,
       lat, lng, geo_source, location_class, price, price_num, offline, hidden, first_seen_at, last_seen_at)
     VALUES ($1,'通勤快照測試','https://example.test/live-commute','591','591|live76',$2,$2,'文化路','3房2廳','5F',
       $3,$4,'geocode','address',25000,25000,0,0,$5,$5)`,
    [POST, "新北市板橋區文化路1段1號", HOME.lat, HOME.lng, "2026-09-29T00:00:00.000Z"],
  );
  await query(
    `INSERT INTO route_cache(route_key, distances, min_km, min_m, updated_at) VALUES ($1,$2,$3,$4,$5)`,
    [ROUTE_KEY, JSON.stringify([8.4]), 8.4, 26, "2026-09-29T00:00:00.000Z"],
  );
  await query(
    `INSERT INTO route_cache(route_key, distances, min_km, min_m, updated_at) VALUES ($1,$2,$3,$4,$5)`,
    [RETURN_KEY, JSON.stringify([8.9]), 8.9, 28, "2026-09-29T00:00:00.000Z"],
  );
  await query("INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden) VALUES ($1,$2,1,1,0)", [uid, POST]);

  // 同步版（讀本機）：這筆刊登在本機不存在 ⇒ null（正是被修掉的行為）
  assert.equal(dbMod.listingCommutePatch(POST, uid), null, "前提：同步版讀本機 ⇒ PG 才有的刊登看不到");

  // PG 版：讀得到，而且通勤欄位是從 PG 的 route_cache 算出來的
  const patches = await commuteAsync.listingCommutePatchesAsync([POST, 769999], uid, { ...opts, settings });
  assert.equal(patches.length, 1, "PG 才有的刊登要讀得到（查不到的那筆被濾掉）");
  const patch = patches[0];
  assert.equal(Number(patch.post_id), POST);
  assert.equal(patch.commute_km, 8.4, "去程公里數要從 PG 的 route_cache 算出來");
  assert.equal(patch.commute_return_km, 8.9, "回程公里數要從 PG 的 route_cache 算出來");
  assert.equal(patch.commute_state, "done", "有路線就要是 done（不是 wait_geo）");
  assert.deepEqual(patch.commute_routes, [8.4]);
  assert.equal(Number(patch.lat), HOME.lat);
  assert.match(String(patch.fingerprint || ""), /scooter/, "fingerprint 要帶上通勤模式");

  // 沒有注入 exec（正式路徑：`pgDriver.query()`）也要一樣
  const viaDriver = await commuteAsync.listingCommutePatchAsync(POST, uid, { driver: "postgres", pgDriver, strict: true, settings });
  assert.deepEqual(viaDriver, patch, "注入 exec 與純 pgDriver 兩條路徑的結果必須相同");

  // 個人同戶群組：PG 上的 `user_same_house_members` 也要被預載 provider 讀到（不影響通勤欄位，
  // 但會決定 `personal_only` 之類的同戶狀態；這裡至少確認整條裝飾沒有因為讀不到而爆掉）。
  await query(
    `INSERT INTO user_same_house_members(user_id, post_id, group_key, system_agrees, created_at) VALUES ($1,$2,'g76live',1,$3)`,
    [uid, POST, "2026-09-29T00:00:00.000Z"],
  );
  const again = await commuteAsync.listingCommutePatchAsync(POST, uid, { ...opts, settings });
  assert.deepEqual(again, patch, "同戶資料進來之後，通勤 patch 不應該改變（sameHouse: false 與同步版一致）");
});
