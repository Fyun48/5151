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
import { findBySourceKey as findBySourceKeySync, listingSearchBuildContext } from "./db.js";
import { getListingAsync } from "./listingDetailAsync.js";
import { findBySourceKey as findBySourceKeyRepo } from "./repository/listingReads.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sharedPgDriver } from "./pgSharedDriver.js";

// One executor convention for this module (same shape the other async paths use).
async function postgresExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
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

// Exposed for tests/diagnostics: the dependency bundle the PostgreSQL reads need.
export function crawlerReadsContext() {
  return listingSearchBuildContext();
}

