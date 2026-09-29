// geo_cache（地理編碼快取）PG 分支的 **live PG** 驗證（2026-09-29 第六十四批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事——而它們正好都是這一包最容易出錯的地方：
//
//   1. **`ensureGeoCacheOnce()` 的 DDL 是 PG 專屬語法**：`ALTER TABLE … ADD COLUMN IF NOT EXISTS`
//      在 SQLite 不存在（SQLite 只能 try/catch 硬打），所以只有真 PG 能證明它跑得起來，
//      而且真的把九個欄位補上（離線測試只驗「有沒有把這些語句送出去」）。
//   2. **`ON CONFLICT(address)` 的衝突目標**：`geo_cache` 的主鍵是 `address`（SQLite
//      `TEXT PRIMARY KEY` 鏡射過來）。少了那個唯一性，upsert 在真 PG 上會是 `42P10`
//      ——離線夾具是 SQLite 在驗，兩邊的約束形成方式不同。
//   3. **`?` → `$n` 的參數順序**：這一條的 INSERT 有 13 個參數，寫錯順序在夾具上完全看不出來。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向 `5151_shadow`
// 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
// `geo_cache` 是共用表（repro 上有近三百列真實資料），所以這一檔**只碰自己那一列**。
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

// 真實可解析的臺灣地址（`addressVersion()` 會用門牌鍵），但門牌號碼是專屬的 ⇒ 不會撞到既有列。
const ADDRESS = "臺北市士林區芝玉路一段847號";
const META = {
  quality: "house",
  geo_source: "live-probe",
  address_used: ADDRESS,
  location_class: "address",
  city: "臺北市",
  district: "士林區",
  provider: "live-probe",
};
const EXTRA_COLUMNS = ["quality", "geo_source", "address_used", "address_version", "location_class",
  "city", "district", "cache_kind", "provider"];

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-geocache-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

test("live PG：ensureGeoCacheOnce 的 DDL、upsert 與跨 driver 逐欄一致", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const cacheAsync = await import("../src/geoCacheAsync.js");
  const syncDb = await import("../src/db.js");
  const { addressVersion } = await import("../src/geoQueue.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  const key = addressVersion(ADDRESS);
  assert.ok(key, "前置條件：這個地址必須能被 addressVersion() 正規化");
  // 只清自己那一列：`geo_cache` 是共用表，其他列一律不准動。
  const cleanup = () => query("DELETE FROM geo_cache WHERE address = $1", [key]);
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });
  await cleanup();

  // ---- 1) 建表 ＋ 補欄位（PG 專屬 DDL 只有真 PG 能證明）----
  await cacheAsync.ensureGeoCacheOnce(pgDriver);
  const columns = (await query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'geo_cache'")).map((r) => r.column_name);
  for (const column of ["address", "lat", "lng", "updated_at", ...EXTRA_COLUMNS]) {
    assert.ok(columns.includes(column), `geo_cache 必須有 ${column} 欄位（實際：${columns.join(",")}）`);
  }
  const pk = (await query(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'geo_cache'::regclass AND contype = 'p'"))[0];
  assert.match(String(pk?.def || ""), /PRIMARY KEY \(address\)/,
    "upsert 的衝突目標要靠 address 的主鍵，少了它就是 42P10");

  // ---- 2) 寫入（13 個參數的 upsert）＋ 讀回 ----
  await cacheAsync.setCachedGeoAsync(ADDRESS, 25.10456, 121.52345, META, { driver: "postgres", pgDriver });
  const hit = await cacheAsync.getCachedGeoAsync(ADDRESS, { driver: "postgres", pgDriver });
  assert.ok(hit, "寫進去的列必須讀得回來");
  assert.equal(Number(hit.lat), 25.10456, "lat 必須落在對的欄位（13 個參數的順序錯就會露出來）");
  assert.equal(Number(hit.lng), 121.52345);
  assert.equal(hit.quality, "house");
  assert.equal(hit.cache_kind, "house", "location_class=address ⇒ cache_kind=house");
  assert.equal(hit.geo_source, "live-probe");
  assert.equal(hit.address_used, ADDRESS);
  assert.equal(hit.address_version, key);
  assert.equal(hit.city, "臺北市");
  assert.equal(hit.district, "士林區");
  assert.equal(hit.provider, "live-probe");
  assert.ok(Date.parse(hit.updated_at) > Date.now() - 60_000, `updated_at 應該是剛剛：${hit.updated_at}`);

  // ---- 3) 與同步版（SQLite）逐欄相同：同一個 meta、同一個純函式 ----
  syncDb.setCachedGeo(ADDRESS, 25.10456, 121.52345, META);
  const lite = syncDb.getCachedGeo(ADDRESS);
  const pick = (row) => {
    const { updated_at, ...rest } = row;
    return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typeof v === "number" ? Number(v) : v]));
  };
  assert.deepEqual(pick(hit), pick(lite), "PG 與 SQLite 落地的欄位必須逐欄相同");

  // ---- 4) upsert 是就地更新（同一列、不是多一列）----
  await cacheAsync.setCachedGeoAsync(ADDRESS, 25.2, 121.6, META, { driver: "postgres", pgDriver });
  const rows = await query("SELECT lat, lng FROM geo_cache WHERE address = $1", [key]);
  assert.equal(rows.length, 1, "同一個鍵只能有一列");
  assert.equal(Number(rows[0].lat), 25.2, "第二次寫入必須覆蓋座標");

  // ---- 5) 沒有的鍵回 null（不是 undefined、也不是拋錯）----
  assert.strictEqual(await cacheAsync.getCachedGeoAsync("臺北市士林區芝玉路一段848號", { driver: "postgres", pgDriver }), null);
});
