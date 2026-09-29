// 路線快取（`route_cache`）與路線工作（`route_jobs`）的 driver-aware 入口
// （PG 島嶼，2026-09-29，第七十七批）。
//
// 為什麼要：`backfillListingRoutes()`（watcher.js，`queueGeoBackfill` 的核心）用**同步**的
// `setCachedRoute()`／`getRouteJob()`／`upsertRouteJob()` 寫入。PG 模式下那三個函式寫的是
// **節點本機 SQLite** ⇒
//
//   - 剛算好的通勤路線寫進本機，而卡片是從 PG 讀的 ⇒ **不論補幾輪，地圖上的通勤欄位永遠算不出來**
//     （同一筆會被反覆重算，是無聲的資源浪費，也不會有人看到錯誤）；
//   - `route_jobs` 的狀態（computing／done／retry）也留在本機 ⇒ 另一台節點看到的是舊狀態，
//     重複抓取同一個路段。
//
// 語句與參數組裝都放在 db.js（`ROUTE_CACHE_UPSERT_SQL`／`ROUTE_JOB_UPSERT_SQL`／
// `routeCacheUpsert()`／`routeJobUpsertParams()`），兩個 driver 只換「跑語句的人」。
import { resolveDbDriver } from "./dbDriver.js";
import {
  ROUTE_JOB_SELECT_SQL,
  ROUTE_JOB_UPSERT_SQL,
  getRouteJob as getRouteJobSync,
  routeCacheUpsert,
  routeJobKeyFor,
  routeJobUpsertParams,
  setCachedRoute as setCachedRouteSync,
  upsertRouteJob as upsertRouteJobSync,
} from "./db.js";
import { routeRetryDecision } from "./commuteState.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { toPostgresSql } from "./sqlDialect.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

async function run(options, runPostgres, runSqlite, { write = false } = {}) {
  if (!isPg(options)) return runSqlite();
  try {
    return await runPostgres();
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

async function pgExec(options = {}) {
  if (options.exec) {
    const injected = options.exec;
    return async (sql, params = []) => rowsOf(await injected(sql, params));
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

/** `db.js:setCachedRoute()` 的 PG 版（寫入路線公里數，含尖峰時段欄位）。 */
export async function setCachedRouteAsync(fromLat, fromLng, toLat, toLng, distances, rush = null, mode = "scooter", direction = "to_work", options = {}) {
  const plan = routeCacheUpsert(fromLat, fromLng, toLat, toLng, distances, rush, mode, direction);
  if (!plan) return { ok: false, skipped: "no-distances" };
  return run(options, async () => {
    const exec = await pgExec(options);
    await exec(plan.sql, plan.params);
    return { ok: true, route_key: plan.key };
  }, () => {
    setCachedRouteSync(fromLat, fromLng, toLat, toLng, distances, rush, mode, direction);
    return { ok: true, route_key: plan.key };
  }, { write: true });
}

/** `db.js:getRouteJob()` 的 PG 版。 */
export async function getRouteJobAsync(jobKey, options = {}) {
  const key = String(jobKey || "");
  if (!key) return null;
  return run(options, async () => {
    const exec = await pgExec(options);
    return rowsOf(await exec(ROUTE_JOB_SELECT_SQL, [key]))[0] || null;
  }, () => getRouteJobSync(key));
}

/** `db.js:upsertRouteJob()` 的 PG 版（回寫後回讀那一列，與同步版同一個契約）。 */
export async function upsertRouteJobAsync(partial = {}, options = {}) {
  const { jobKey, params } = routeJobUpsertParams(partial);
  return run(options, async () => {
    const exec = await pgExec(options);
    await exec(ROUTE_JOB_UPSERT_SQL, params);
    return rowsOf(await exec(ROUTE_JOB_SELECT_SQL, [jobKey]))[0] || null;
  }, () => upsertRouteJobSync(partial), { write: true });
}

// watcher.js:markRouteJob() 的 driver-aware 版（先讀既有 attempts 再寫新狀態）。
export async function markRouteJobAsync(row, direction, kind, patch, options = {}) {
  const key = routeJobKeyFor(row, direction, kind);
  const prev = await getRouteJobAsync(key, options);
  return upsertRouteJobAsync({
    post_id: row.post_id,
    direction,
    kind,
    commuteMode: row.commuteMode,
    workLat: row.workLat,
    workLng: row.workLng,
    job_key: key || undefined,
    attempts: Number(prev?.attempts) || 0,
    ...patch,
  }, options);
}

// watcher.js:finishRouteAttempt() 的 driver-aware 版：重試決策是純函式（`routeRetryDecision`），
// 兩個 driver 共用。
export async function finishRouteAttemptAsync(row, direction, kind, reason, options = {}) {
  const key = routeJobKeyFor(row, direction, kind);
  const prev = await getRouteJobAsync(key, options);
  const attempts = (Number(prev?.attempts) || 0) + 1;
  const decision = routeRetryDecision(reason, attempts);
  return upsertRouteJobAsync({
    post_id: row.post_id,
    direction,
    kind,
    commuteMode: row.commuteMode,
    workLat: row.workLat,
    workLng: row.workLng,
    job_key: key || undefined,
    attempts,
    ...decision,
  }, options);
}
