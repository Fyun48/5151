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
  markSourceKitRetry as markSourceKitRetrySync,
  restoreListingOnline as restoreListingOnlineSync,
  setCachedMrt as setCachedMrtSync,
  setCommunityCache as setCommunityCacheSync,
  setListingDetail as setListingDetailSync,
  touchListingChecked as touchListingCheckedSync,
  persistHpListingFields as persistHpListingFieldsSync,
  listingFieldsBuildContext,
} from "./db.js";
import * as crawlerProgressRepo from "./repository/crawlerProgress.js";
import { getListingAsync } from "./listingDetailAsync.js";
import { upsertListingPrepAsync as upsertListingPrepRepo } from "./listingEnrichQueue.js";
import {
  clearRouteJobs as clearRouteJobsRepo,
  markListingAlive as markListingAliveRepo,
  markListingOffline as markListingOfflineRepo,
  restoreListingOnline as restoreListingOnlineRepo,
  touchListingChecked as touchListingCheckedRepo,
} from "./repository/listingState.js";
import {
  persistHpListingFields as persistHpListingFieldsRepo,
  setCachedMrt as setCachedMrtRepo,
  setCommunityCache as setCommunityCacheRepo,
  setListingDetail as setListingDetailRepo,
} from "./repository/listingFields.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { enqueueListingEventAsync } from "./notifyEnqueueAsync.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";

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
    /* 寫入 fail-closed：不落回本機 SQLite（見 sqliteFallback.js）。 */
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
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

// db.js setListingDetail(): the 591 detail (fees, contact, coords, community, kit columns) the
// detail backfill loop applies. The PostgreSQL side reads the row it is about to patch from the
// same store (getListingAsync), so the "which field wins" decision sees what the site sees.
export async function setListingDetailAsync(postId, input = {}, options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return setListingDetailSync(postId, input);
  try {
    const exec = await postgresExec(options);
    const deps = options.deps || listingFieldsBuildContext();
    const listing = options.listing || await loadListingForWrite(postId, options);
    if (!listing) return null;
    const result = await setListingDetailRepo(exec, { deps, listing, input });
    // The fee change db.js enqueues inline on SQLite; PostgreSQL goes through the driver-aware
    // entry point so the event lands in the queue the site reads (POSTGRES_SWITCH_PLAN ③).
    if (result && result.feeChange) {
      const saved = await loadListingForWrite(postId, options);
      if (saved) {
        await enqueueListingEventAsync(saved, {
          type: "fee_update",
          detail: result.feeChange.detail,
          created_at: result.feeChange.created_at,
        }, options);
      }
    }
    return result;
  } catch (error) {
    if (options.strict) throw error;
    return setListingDetailSync(postId, input);
  }
}

// db.js persistHpListingFields(): the 5168 enrich worker's field patch.
export async function persistHpListingFieldsAsync(postId, next, options = {}) {
  const { locationChanged = false, previous = null, ...driverOptions } = options || {};
  const driver = driverOptions.driver || resolveDbDriver();
  if (driver !== "postgres") return persistHpListingFieldsSync(postId, next, { locationChanged, previous });
  try {
    const exec = await postgresExec(driverOptions);
    const deps = driverOptions.deps || listingFieldsBuildContext();
    const listing = driverOptions.listing || await loadListingForWrite(postId, driverOptions);
    if (!listing) return null;
    const result = await persistHpListingFieldsRepo(exec, { deps, listing, next, locationChanged });
    return { ...result, postId: Number(postId) || 0 };
  } catch (error) {
    if (driverOptions.strict) throw error;
    return persistHpListingFieldsSync(postId, next, { locationChanged, previous });
  }
}

// db.js setCachedMrt(): the MRT access cache (decoration reads it per row).
export function setCachedMrtAsync(lat, lng, access, options = {}) {
  return write(
    options,
    (exec) => setCachedMrtRepo(exec, { deps: options.deps || listingFieldsBuildContext(), lat, lng, access }),
    () => setCachedMrtSync(lat, lng, access),
  );
}

// db.js setCommunityCache(): the community pin cache (the 591 geo scan reads it back).
export function setCommunityCacheAsync(community, options = {}) {
  return write(
    options,
    (exec) => setCommunityCacheRepo(exec, { deps: options.deps || listingFieldsBuildContext(), community }),
    () => setCommunityCacheSync(community),
  );
}

// listingEnrichQueue.upsertListingPrep(): the 5168 prep row the site's display_ready gate reads.
export function upsertListingPrepAsync(postId, listing, evalResult, options = {}) {
  return write(
    options,
    (exec) => upsertListingPrepRepo(exec, { postId, listing, evalResult }),
    () => null,
  );
}

// db.js markSourceKitRetry(): source-kit 抓取失敗後的重試排程。
// 原本只寫呼叫端那台節點的 SQLite，所以 A 排定的重試 B 看不到 → 同一筆房源在另一台被當成
// 從未重試而重複排、或永遠不重試。時間計算沿用 db.js 的 max(60s, delayMs)。
export function markSourceKitRetryAsync(postId, { error = "", delayMs = 15 * 60 * 1000 } = {}, options = {}) {
  const next = new Date(Date.now() + Math.max(60_000, Number(delayMs) || 0)).toISOString();
  return write(
    options,
    async (exec) => {
      await exec(crawlerProgressRepo.MARK_SOURCE_KIT_RETRY_SQL, [
        String(error || "").slice(0, 200),
        next,
        postId,
      ]);
      return true;
    },
    () => markSourceKitRetrySync(postId, { error, delayMs }),
  );
}

// The row the field planners patch, read through the driver-aware detail loader (same decorated
// shape getListing() gives the SQLite functions). `sameHouse: false` is the crawler seam's read
// (watcher's listingForWatch), and the planners only look at the row's own columns anyway.
async function loadListingForWrite(postId, options = {}) {
  return getListingAsync(postId, undefined, {
    driver: "postgres",
    pgDriver: options.pgDriver,
    sameHouse: false,
    strict: options.strict === true,
  });
}

