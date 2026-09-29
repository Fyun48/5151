// geo_cache（地理編碼快取）的 driver-aware 入口（PG 島嶼，2026-09-29 第六十四批）。
//
// 涵蓋的路由（三條的 SQLite 卡點都只有這一組）：
//   GET  /api/public/listings   → `resolveGuestWorkPoint()`（訪客的上班地址距離篩選）
//   POST /api/exclude-region    → `boxFromRoadDescription()`（路名查快取／寫快取）
//   POST /api/profiles          → `persistSettings()`（`POST /api/settings` 也走同一支）
//
// 為什麼要搬：`geo_cache` 是**跨節點共用**的快取。PG 模式下讀寫本機 SQLite ⇒ 同一條路名
// A 節點剛查到的座標，B 節點要再花一次外部 geocoding（配額與延遲都是真的成本），而
// `POST /api/exclude-region` 的「路名 → 方位框」正是連續好幾個路名查詢。
//
// 設計與其他島嶼相同：推導留在 `geoQueue.js` 的**純函式**（`addressVersion`／`inferGeoQuality`／
// `geoCacheRow`），這裡只換「跑語句的人」。SQLite 分支延遲 `await import("./db.js")` 呼叫同步版。
//
// ⚠️ `geo.js` 的 `lookup` 以前是**同步**呼叫（`lookup?.(address)`）：直接塞 async 版本會拿到
// Promise 當真相值（永遠 truthy、`lat`/`lng` 是 `undefined`）。所以本批一併把
// `geocodeAddressUnshared()` 與 `boxFromRoadDescription()` 改成 `await`——同步函式仍然相容
// （crawler 的 `watcher.js` 照舊傳本機的 `getCachedGeo`）。
//
// 快取的政策：讀取 fail-open（回舊資料勝過整個站 500）；寫入與同步版一致地**往上丟**
// ——同步版的 SQLite upsert 失敗也是直接往外丟，這裡不改語意（`withFallback` 的 write 預設 fail-closed）。
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { sqliteHandle } from "./db.js";
import { ensurePgSchema } from "./pgSchema.js";
import { GEO_CACHE_EXTRA_COLUMNS, addressVersion, ensureGeoCacheSchema, geoCacheRow } from "./geoQueue.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const syncDb = () => import("./db.js");

// 注入式 `exec` 的形狀正規化（`settingsAsync.js`／`geoCacheAsync` 同一個坑）：本模組的 PG runner
// 一律吃**裸陣列**，呼叫端可能照 `crmOutboxAsync` 的慣例傳 `{ rows, rowCount }`。
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

// SQLite 的說法（離線夾具）與 PG 的 SQLSTATE 都要涵蓋：`no such column: x`（SELECT）與
// `table t has no column named x`（INSERT）在 PG 上都是 42703。
const MISSING_RELATION = /(no such column|no such table|has no column named|does not exist)/i;
const isMissingRelation = (error) =>
  error?.code === "42703" || error?.code === "42P01" || MISSING_RELATION.test(String(error?.message || ""));

// 讀取預設 fail-open、寫入預設 fail-closed（與其他島嶼同一政策）。
async function withFallback(options, { read = false }, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    return await runPostgres();
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: !read })) throw error;
    return runSqlite();
  }
}

// ---- SQL（逐字沿用 db.js:8486-8538 的同步版；只保留 `?` 佔位，PG 端由 toPostgresSql 轉 `$n`）----

// 三層與同步版一一對應：完整欄位 → 舊庫（沒有 city／district／cache_kind／provider）→ 只有座標。
export const GEO_CACHE_SELECT_SQL = `SELECT lat, lng, quality, geo_source, address_used, address_version, location_class, city, district, cache_kind, provider, updated_at
       FROM geo_cache WHERE address = ?`;
export const GEO_CACHE_SELECT_LEGACY_SQL = `SELECT lat, lng, quality, geo_source, address_used, address_version, updated_at
       FROM geo_cache WHERE address = ?`;
export const GEO_CACHE_SELECT_MINIMAL_SQL = "SELECT lat, lng FROM geo_cache WHERE address = ?";
export const GEO_CACHE_UPSERT_SQL = `INSERT INTO geo_cache(address, lat, lng, updated_at, quality, geo_source, address_used, address_version, location_class, city, district, cache_kind, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         lat = excluded.lat,
         lng = excluded.lng,
         updated_at = excluded.updated_at,
         quality = excluded.quality,
         geo_source = excluded.geo_source,
         address_used = excluded.address_used,
         address_version = excluded.address_version,
         location_class = excluded.location_class,
         city = excluded.city,
         district = excluded.district,
         cache_kind = excluded.cache_kind,
         provider = excluded.provider`;
export const GEO_CACHE_UPSERT_MINIMAL_SQL = `INSERT INTO geo_cache(address, lat, lng, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, updated_at = excluded.updated_at`;

// ---- 建表（每個 driver 一次）----

const schemaReady = new WeakMap();

/**
 * PG 的 `geo_cache` 一定要有那九個額外的欄位：`ensurePgSchema()` 只做
 * `CREATE TABLE IF NOT EXISTS` ＋ 索引，**不會**替既有的表補欄位（`data_revision` 的零欄表
 * 教訓見 `pgSchema.js:123-135`）。所以順序是：
 *   1. `ensureGeoCacheSchema(sqliteHandle())`：來源（SQLite）先補齊，鏡射才不會少欄位
 *   2. `ensurePgSchema(..., { tables: ["geo_cache"], indexes: false })`：建表（PK 一起）
 *   3. `ADD COLUMN IF NOT EXISTS`：PG 那張表若是舊形狀（只有四個欄位）也要補齊
 */
export async function ensureGeoCacheOnce(pgDriver) {
  if (!pgDriver) return null;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = (async () => {
    const sqlite = sqliteHandle();
    ensureGeoCacheSchema(sqlite);
    await ensurePgSchema(pgDriver, sqlite, { tables: ["geo_cache"], indexes: false });
    for (const column of GEO_CACHE_EXTRA_COLUMNS) {
      await pgDriver.exec(`ALTER TABLE geo_cache ADD COLUMN IF NOT EXISTS ${column} TEXT NOT NULL DEFAULT ''`);
    }
    return true;
  })();
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
  return ready;
}

async function withGeoExec(options, fn) {
  if (options.exec) {
    const injected = async (sql, params = []) => rowsOf(await options.exec(sql, params));
    return fn(injected);
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  await ensureGeoCacheOnce(pgDriver);
  const exec = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
  return fn(exec);
}

// ---- 讀取 ----

/** `db.js:8486 getCachedGeo()` 的 PG 版：三層欄位 fallback 與同步版逐層對應。 */
export async function getCachedGeoAsync(address, options = {}) {
  if (!isPg(options)) return (await syncDb()).getCachedGeo(address);
  const key = addressVersion(address);
  if (!key) return null;
  return withFallback(options, { read: true }, () => withGeoExec(options, async (exec) => {
    for (const sql of [GEO_CACHE_SELECT_SQL, GEO_CACHE_SELECT_LEGACY_SQL, GEO_CACHE_SELECT_MINIMAL_SQL]) {
      try {
        const rows = rowsOf(await exec(sql, [key]));
        return rows[0] || null;
      } catch (error) {
        // 只有「這張表沒有那個欄位」才往下一層；連線或語法錯誤要往上丟
        //（strict 模式才不會把真正的失敗吞成「快取沒有這一筆」⇒ 白花一次外部查詢）。
        if (!isMissingRelation(error)) throw error;
      }
    }
    return null;
  }), async () => (await syncDb()).getCachedGeo(address));
}

// ---- 寫入 ----

/** `db.js:8504 setCachedGeo()` 的 PG 版：落地值逐欄來自同一個純函式 `geoCacheRow()`。 */
export async function setCachedGeoAsync(address, lat, lng, meta = {}, options = {}) {
  if (!isPg(options)) return (await syncDb()).setCachedGeo(address, lat, lng, meta);
  const row = geoCacheRow(address, lat, lng, meta, options.now || new Date());
  if (!row) return undefined; // 與同步版同義：沒有可用的鍵或座標不是有限數 ⇒ 不落地
  return withFallback(options, {}, async () => withGeoExec(options, async (exec) => {
    try {
      await exec(GEO_CACHE_UPSERT_SQL, [
        row.address, row.lat, row.lng, row.updated_at, row.quality, row.geo_source, row.address_used,
        row.address_version, row.location_class, row.city, row.district, row.cache_kind, row.provider,
      ]);
    } catch (error) {
      // 舊形狀的表（少了那九個欄位）也要能寫：與同步版的 catch 分支同義。
      if (!isMissingRelation(error)) throw error;
      await exec(GEO_CACHE_UPSERT_MINIMAL_SQL, [row.address, row.lat, row.lng, row.updated_at]);
    }
    return undefined;
  }), async () => (await syncDb()).setCachedGeo(address, lat, lng, meta));
}

/** 給 `geo.js` 的 `lookup` 用的綁定版（`geocodeAddress` 只會傳一個參數）。 */
export function geoLookupAsync(options = {}) {
  return (address) => getCachedGeoAsync(address, options);
}
