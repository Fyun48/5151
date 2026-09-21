// Hot-path write adapters (PostgreSQL hot path, write side).
//
// The list path READS `user_listing_flags` / `route_cache` / `route_jobs` through
// repository/decorationData.js. Their WRITES still lived inside db.js and personalFlags.js bound
// to a synchronous node:sqlite handle. Reading on PostgreSQL while writing on SQLite would let the
// two stores diverge, so this module re-states those statements against an injected executor: the
// same SQL text runs on either driver (the PostgreSQL executor translates `?` -> `$n` and the
// SQLite-only functions through sqlDialect).
//
// The statement text is copied verbatim from the SQLite implementations (same columns, same
// conflict targets, same CASE expressions). test/write-path-parity.test.js asserts that the same
// payload produces identical rows on both drivers.
import { toPostgresSql } from "../sqlDialect.js";

export const WRITE_PATH_SQL = {
  // personalFlags.js setUserListingFlags()
  upsertPersonalFlags: `INSERT INTO user_listing_flags (
       user_id, post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, post_id) DO UPDATE SET
       viewed = excluded.viewed,
       watched = excluded.watched,
       hidden = excluded.hidden,
       watch_note = excluded.watch_note,
       viewed_at = CASE
         WHEN excluded.viewed = 1 THEN COALESCE(user_listing_flags.viewed_at, excluded.viewed_at)
         ELSE user_listing_flags.viewed_at
       END,
       watched_at = CASE
         WHEN excluded.watched = 1 AND IFNULL(user_listing_flags.watched, 0) = 0 THEN excluded.watched_at
         WHEN excluded.watched = 1 THEN COALESCE(user_listing_flags.watched_at, excluded.watched_at)
         ELSE user_listing_flags.watched_at
       END,
       hidden_at = CASE
         WHEN excluded.hidden = 1 THEN COALESCE(user_listing_flags.hidden_at, excluded.hidden_at)
         ELSE user_listing_flags.hidden_at
       END`,
  // db.js setCachedRoute() - the rush-aware and the plain variant
  upsertRouteCacheWithRush: `INSERT INTO route_cache(route_key, distances, min_km, min_m, updated_at, rush_am_min, rush_pm_min, rush_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(route_key) DO UPDATE SET
         distances = excluded.distances,
         min_km = excluded.min_km,
         min_m = excluded.min_m,
         updated_at = excluded.updated_at,
         rush_am_min = excluded.rush_am_min,
         rush_pm_min = excluded.rush_pm_min,
         rush_updated_at = excluded.rush_updated_at`,
  upsertRouteCache: `INSERT INTO route_cache(route_key, distances, min_km, min_m, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(route_key) DO UPDATE SET
         distances = excluded.distances,
         min_km = excluded.min_km,
         min_m = excluded.min_m,
         updated_at = excluded.updated_at`,
  // db.js upsertRouteJob()
  upsertRouteJob: `INSERT INTO route_jobs(job_key, post_id, direction, kind, commute_mode, work_lat, work_lng, job_state, fail_reason, attempts, next_retry_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_key) DO UPDATE SET
       job_state = excluded.job_state,
       fail_reason = excluded.fail_reason,
       attempts = excluded.attempts,
       next_retry_at = excluded.next_retry_at,
       updated_at = excluded.updated_at,
       work_lat = excluded.work_lat,
       work_lng = excluded.work_lng`,
};

function createExecutor({ driver, sqliteDb, pgDriver }) {
  if (driver === "postgres") {
    if (!pgDriver) throw new Error("createWritePath(postgres) requires pgDriver");
    return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params);
  }
  if (!sqliteDb) throw new Error("createWritePath(sqlite) requires sqliteDb");
  return (sql, params = []) => sqliteDb.prepare(sql).run(...params);
}

const int = (value) => (Number(value) ? 1 : 0);
const text = (value) => (value == null ? null : String(value));
// Number(null) is 0, so "not provided" must be detected before the numeric coercion - otherwise a
// missing minimum would be stored as 0 and distance ordering would silently break.
const provided = (value) => value != null && value !== "";
const finite = (value) => (provided(value) && Number.isFinite(Number(value)) ? Number(value) : null);

export function createWritePath({ driver = "sqlite", sqliteDb = null, pgDriver = null } = {}) {
  const exec = createExecutor({ driver, sqliteDb, pgDriver });
  return {
    driver,
    // Mirrors personalFlags.setUserListingFlags(): the caller decides the stamped values.
    async upsertPersonalFlags({
      userId,
      postId,
      viewed = 0,
      watched = 0,
      hidden = 0,
      watchNote = "",
      viewedAt = null,
      watchedAt = null,
      hiddenAt = null,
    } = {}) {
      await exec(WRITE_PATH_SQL.upsertPersonalFlags, [
        Number(userId) || 0,
        Number(postId) || 0,
        int(viewed),
        int(watched),
        int(hidden),
        String(watchNote || ""),
        text(viewedAt),
        text(watchedAt),
        text(hiddenAt),
      ]);
    },
    // Mirrors db.js setCachedRoute(): distances is stored as JSON text, min_m falls back to the
    // smallest distance when the caller has no measured minimum.
    async upsertRouteCache({ routeKey, distances = [], minKm = null, minM = null, rush = null, updatedAt = null } = {}) {
      const key = String(routeKey || "");
      if (!key) throw new Error("upsertRouteCache requires routeKey");
      const list = (Array.isArray(distances) ? distances : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!list.length) return;
      const stamp = updatedAt || new Date().toISOString();
      const min = provided(minKm) && Number.isFinite(Number(minKm)) ? Number(minKm) : Math.min(...list);
      const metres = provided(minM) && Number.isFinite(Number(minM)) ? Number(minM) : Math.round(min * 1000);
      const am = finite(rush?.am ?? rush?.rushAm);
      const pm = finite(rush?.pm ?? rush?.rushPm);
      if (am != null && pm != null) {
        await exec(WRITE_PATH_SQL.upsertRouteCacheWithRush, [key, JSON.stringify(list), min, metres, stamp, am, pm, stamp]);
        return;
      }
      await exec(WRITE_PATH_SQL.upsertRouteCache, [key, JSON.stringify(list), min, metres, stamp]);
    },
    // Mirrors db.js upsertRouteJob().
    async upsertRouteJob({
      jobKey,
      postId = 0,
      direction = "to_work",
      kind = "distance",
      commuteMode = "scooter",
      workLat = null,
      workLng = null,
      jobState = "wait_route",
      failReason = "",
      attempts = 0,
      nextRetryAt = "",
      updatedAt = null,
    } = {}) {
      const key = String(jobKey || "");
      if (!key) throw new Error("upsertRouteJob requires jobKey");
      await exec(WRITE_PATH_SQL.upsertRouteJob, [
        key,
        Number(postId) || 0,
        String(direction || "to_work"),
        String(kind || "distance"),
        String(commuteMode || "scooter"),
        finite(workLat),
        finite(workLng),
        String(jobState || "wait_route"),
        String(failReason || ""),
        Number(attempts) || 0,
        String(nextRetryAt || ""),
        updatedAt || new Date().toISOString(),
      ]);
    },
  };
}
