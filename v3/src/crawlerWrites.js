// Driver-aware listing state WRITES for the crawler / worker loops (the read half is
// crawlerReads.js).
//
// The background loops now read their work from the same store the site reads, but their results
// still went through the synchronous SQLite helpers in db.js - so in DB_DRIVER=postgres mode a
// listing that went offline, a probe that found it alive again, or an invalidated route cache
// never reached PostgreSQL. This module gives those writes one async entry point; the SQLite
// driver delegates to the existing db.js functions, so production behaviour is unchanged.
import {
  invalidateListingLocation as invalidateListingLocationSync,
  markListingAlive as markListingAliveSync,
  markListingOffline as markListingOfflineSync,
  restoreListingOnline as restoreListingOnlineSync,
  touchListingChecked as touchListingCheckedSync,
} from "./db.js";
import {
  clearRouteJobs as clearRouteJobsRepo,
  markListingAlive as markListingAliveRepo,
  markListingOffline as markListingOfflineRepo,
  restoreListingOnline as restoreListingOnlineRepo,
  touchListingChecked as touchListingCheckedRepo,
} from "./repository/listingState.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sharedPgDriver } from "./pgSharedDriver.js";

async function postgresExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

async function write(options, runPostgres, runSqlite) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  try {
    const exec = await postgresExec(options);
    return await runPostgres(exec);
  } catch (error) {
    if (options.strict) throw error;
    return runSqlite();
  }
}

export function markListingOfflineAsync(postId, options = {}) {
  return write(options, (exec) => markListingOfflineRepo(exec, postId), () => markListingOfflineSync(postId));
}

export function restoreListingOnlineAsync(postId, options = {}) {
  return write(options, (exec) => restoreListingOnlineRepo(exec, postId), () => restoreListingOnlineSync(postId));
}

export function markListingAliveAsync(postId, options = {}) {
  return write(
    options,
    (exec) => markListingAliveRepo(exec, postId, { wasOffline: options.wasOffline === true }),
    () => markListingAliveSync(postId),
  );
}

export function touchListingCheckedAsync(postId, options = {}) {
  return write(options, (exec) => touchListingCheckedRepo(exec, postId), () => touchListingCheckedSync(postId));
}

// db.js invalidateListingLocation(): the route_jobs rows plus (SQLite only) the in-process memo -
// the SQLite branch goes through the original function so the memo is cleared there too.
export function invalidateListingLocationAsync(postId, options = {}) {
  const id = Number(postId) || 0;
  return write(
    options,
    (exec) => clearRouteJobsRepo(exec, id),
    () => {
      invalidateListingLocationSync({ post_id: id }, { post_id: id });
      return { postId: id, cleared: true };
    },
  );
}

