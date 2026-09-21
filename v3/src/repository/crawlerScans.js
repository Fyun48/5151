// The background loops' "what needs work" scans (PostgreSQL side).
//
// db.js's listingsNeeding* functions are synchronous SQLite queries. With the lists, the detail
// reads, the crawler reads and the loop writes already driver-aware, these scans are the last
// piece that made a loop idle in DB_DRIVER=postgres mode: it would look for work in an empty
// SQLite store and do nothing. The statement text and the JS post-filter come from the dependency
// bundle db.js publishes as crawlerReadsBuildContext(), so both drivers scan identically.
export async function selectAliveCheckCandidates(exec, { deps, excludeIds = [], limit = 20 } = {}) {
  const context = deps || {};
  const { sql, params } = context.aliveCheckScanQuery();
  const rows = await exec(sql, params);
  return context.pickAliveCheckRows(rows, { excludeIds, limit });
}

export async function selectOfflineRecheckCandidates(exec, { deps, limit = 8 } = {}) {
  const context = deps || {};
  const { sql, params } = context.offlineRecheckScanQuery({ limit });
  return exec(sql, params);
}

