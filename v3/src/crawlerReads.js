// Driver-aware reads for the crawler / worker loops.
//
// The crawler's cycle is "read the row I am about to update -> classify -> persist". With
// DB_DRIVER=postgres the persist already goes to PostgreSQL (db.js persistListing), but the read
// still came from the synchronous SQLite handle - so the crawler would not see the rows it just
// wrote and every crawl would look like a brand-new listing (duplicate events, broken change
// detection). This module gives those reads one async entry point, so a caller never has to
// branch on DB_DRIVER:
//
//   • sqlite   -> the existing synchronous db.js functions, wrapped in a promise
//   • postgres -> listingDetailAsync.getListingAsync() + repository/listingReads.js
//
// Fail-open: a PostgreSQL failure falls back to the SQLite read (a crawler cycle must not die
// because one row could not be fetched).
import {
  findBySourceKey as findBySourceKeySync,
  listMatchCandidates,
  listingSearchBuildContext,
  crawlerReadsBuildContext,
  listingsNeeding591Geo,
  listingsNeedingAddressEnrich,
  listingsNeedingAddressGeo,
  listingsNeedingAliveCheck,
  listingsNeedingFeeDetail,
  listingsNeedingMrt,
  listingsNeedingOfflineRecheck,
  listingsNeedingRoute,
  listingsNeedingSourceKit,
} from "./db.js";
import { getListingAsync } from "./listingDetailAsync.js";
import { findBySourceKey as findBySourceKeyRepo, listMatchCandidates as listMatchCandidatesRepo } from "./repository/listingReads.js";
import {
  select591GeoCandidates,
  selectAddressEnrichCandidates,
  selectAddressGeoCandidates,
  selectAliveCheckCandidates,
  selectFeeDetailCandidates,
  selectMrtCandidates,
  selectOfflineRecheckCandidates,
  selectRouteCandidates,
  selectSourceKitCandidates,
} from "./repository/crawlerScans.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sharedPgDriver } from "./pgSharedDriver.js";

// One executor convention for this module (same shape the other async paths use).
async function postgresExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// One dispatch shape for every scan in this module: sqlite -> the synchronous db.js function,
// postgres -> repository/crawlerScans.js, and a PostgreSQL failure falls back to the SQLite scan
// (a loop must not stop finding work because one read failed).
async function scan(options, runPostgres, runSqlite) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  try {
    const exec = await postgresExec(options);
    const deps = options.deps || crawlerReadsBuildContext();
    return await runPostgres(exec, deps);
  } catch (error) {
    if (options.strict) throw error;
    return runSqlite();
  }
}

// db.js listingForWatch(): the crawler's per-listing read (getListing with sameHouse:false).
export function listingForWatchAsync(postId, userId, options = {}) {
  return getListingAsync(postId, userId, { sameHouse: false, ...options });
}

// db.js findBySourceKey(): the same source fingerprint under a different post_id, used by
// classify() when the row itself is not in the store yet.
export async function watchSiblings(sourceKey, excludePostId, options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return findBySourceKeySync(sourceKey, excludePostId);
  try {
    const exec = await postgresExec(options);
    return await findBySourceKeyRepo(exec, { sourceKey, excludePostId });
  } catch (error) {
    if (options.strict) throw error;
    return findBySourceKeySync(sourceKey, excludePostId);
  }
}

// db.js listingsNeedingAliveCheck(): the listings the offline sweep should probe next.
export function needingAliveCheckAsync({ excludeIds = [], limit = 20 } = {}, options = {}) {
  return scan(
    options,
    (exec, deps) => selectAliveCheckCandidates(exec, { deps, excludeIds, limit }),
    () => listingsNeedingAliveCheck({ excludeIds, limit }),
  );
}

// db.js listingsNeedingOfflineRecheck(): the pending-offline listings due for another look.
export function needingOfflineRecheckAsync({ limit = 8 } = {}, options = {}) {
  return scan(
    options,
    (exec, deps) => selectOfflineRecheckCandidates(exec, { deps, limit }),
    () => listingsNeedingOfflineRecheck({ limit }),
  );
}

// db.js listingsNeedingFeeDetail(): the 591 detail backfill's work list (fee/contact/coords/kit).
export function needingFeeDetailAsync({ limit = 12 } = {}, options = {}) {
  return scan(
    options,
    (exec, deps) => selectFeeDetailCandidates(exec, { deps, limit }),
    () => listingsNeedingFeeDetail(limit),
  );
}

// db.js listingsNeedingSourceKit(): the external sources whose kit columns are still missing.
export function needingSourceKitAsync({ limit = 8 } = {}, options = {}) {
  return scan(
    options,
    (exec, deps) => selectSourceKitCandidates(exec, { deps, limit }),
    () => listingsNeedingSourceKit(limit),
  );
}

// db.js listingsNeeding591Geo(): the 591 listings still without a trusted pin.
export function needing591GeoAsync({ limit = 20 } = {}, options = {}) {
  return scan(
    options,
    (exec, deps) => select591GeoCandidates(exec, { deps, limit }),
    () => listingsNeeding591Geo(limit),
  );
}

// db.js listingsNeedingAddressGeo(): the address-only geocode backlog.
export function needingAddressGeoAsync({ limit = 20 } = {}, options = {}) {
  return scan(
    options,
    (exec, deps) => selectAddressGeoCandidates(exec, { deps, limit }),
    () => listingsNeedingAddressGeo(limit),
  );
}

// db.js listingsNeedingAddressEnrich(): the coarse addresses worth re-fetching from the source.
export function needingAddressEnrichAsync({ limit = 12 } = {}, options = {}) {
  return scan(
    options,
    (exec, deps) => selectAddressEnrichCandidates(exec, { deps, limit }),
    () => listingsNeedingAddressEnrich(limit),
  );
}

// db.js listingsNeedingMrt(): the trusted coordinates whose MRT cache entry is missing.
export function needingMrtAsync({ limit = 20 } = {}, options = {}) {
  return scan(
    options,
    (exec, deps) => selectMrtCandidates(exec, { deps, limit }),
    () => listingsNeedingMrt(limit),
  );
}

// db.js listingsNeedingRoute(): the commute backlog. It is the one resumable scan, so the
// PostgreSQL side keeps its own keyset cursor here - the synchronous twin keeps
// listingsNeedingRoute.lastCursor. Only one driver is live at a time, so the two never mix.
export async function needingRouteAsync({ limit = 40, priorityIds = [], cursor } = {}, options = {}) {
  const scanNow = options.now;
  const sqliteOptions = { priorityIds };
  if (cursor !== undefined) sqliteOptions.cursor = cursor;
  if (scanNow !== undefined) sqliteOptions.now = scanNow;
  const runSqlite = () => listingsNeedingRoute(limit, sqliteOptions);
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  const nextCursor = Number(cursor ?? needingRouteAsync.lastCursor) || 0;
  try {
    const exec = await postgresExec(options);
    const deps = options.deps || crawlerReadsBuildContext();
    const result = await selectRouteCandidates(exec, {
      deps,
      limit,
      priorityIds,
      cursor: nextCursor,
      now: scanNow,
    });
    needingRouteAsync.lastCursor = result.cursor;
    return result.rows;
  } catch (error) {
    if (options.strict) throw error;
    return runSqlite();
  }
}
needingRouteAsync.lastCursor = 0;

// Exposed for tests/diagnostics: the dependency bundle the PostgreSQL reads need.
export function crawlerReadsContext() {
  return listingSearchBuildContext();
}

// db.js listMatchCandidates(): the same-house candidates for the classify step. Same driver
// dispatch (and fail-open) as the other two reads.
export async function matchCandidatesAsync(excludePostId, incoming = null, options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return listMatchCandidates(excludePostId, incoming);
  try {
    const exec = await postgresExec(options);
    const deps = options.deps || crawlerReadsBuildContext();
    return await listMatchCandidatesRepo(exec, { deps, excludePostId, incoming });
  } catch (error) {
    if (options.strict) throw error;
    return listMatchCandidates(excludePostId, incoming);
  }
}

