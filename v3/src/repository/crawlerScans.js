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

// listingsNeedingFeeDetail(): the needy page first, then - only with leftover budget - the oldest
// stale contact rows. The stale statement's LIMIT is derived from the needy count, so the limit
// comes from the same helper the SQLite function uses.
export async function selectFeeDetailCandidates(exec, { deps, limit = 12 } = {}) {
  const context = deps || {};
  const needyQuery = context.feeDetailScanQuery({ limit });
  const needy = await exec(needyQuery.sql, needyQuery.params);
  const staleLimit = context.feeDetailStaleQueryLimit(needy.length, { limit });
  if (!staleLimit) return context.pickFeeDetailRows(needy, [], { limit });
  const staleQuery = context.feeDetailStaleScanQuery({
    staleBefore: context.feeDetailStaleBefore(),
    limit: staleLimit,
  });
  const stale = await exec(staleQuery.sql, staleQuery.params);
  return context.pickFeeDetailRows(needy, stale, { limit });
}

// listingsNeedingSourceKit(): one page per source, the legacy statement when the wide one is not
// available, then one dedupe/cap pass over the concatenated pages (source order preserved).
export async function selectSourceKitCandidates(exec, { deps, limit = 8 } = {}) {
  const context = deps || {};
  const perSource = context.sourceKitPerSourceLimit(limit);
  const now = new Date().toISOString();
  const collected = [];
  for (const source of context.sourceKitSources()) {
    let rows = [];
    try {
      const query = context.sourceKitScanQuery({ source, now, limit: perSource });
      rows = await exec(query.sql, query.params);
    } catch {
      const query = context.sourceKitLegacyScanQuery({ source, limit: perSource });
      rows = await exec(query.sql, query.params);
    }
    collected.push(...rows);
  }
  return context.pickSourceKitRows(collected, { limit });
}

// listingsNeeding591Geo(): the community-cache membership test becomes one extra read of
// community_cache instead of one query per candidate.
export async function select591GeoCandidates(exec, { deps, limit = 20 } = {}) {
  const context = deps || {};
  const { sql, params } = context.geo591ScanQuery();
  const rows = await exec(sql, params);
  const cacheQuery = context.communityCacheIdsQuery();
  const cached = await exec(cacheQuery.sql, cacheQuery.params);
  const communityIds = new Set((cached || []).map((row) => Number(row.community_id)));
  return context.pick591GeoRows(rows, {
    limit,
    hasCommunity: (communityId) => communityIds.has(Number(communityId)),
  });
}

export async function selectAddressGeoCandidates(exec, { deps, limit = 20 } = {}) {
  const context = deps || {};
  const { sql, params } = context.addressGeoScanQuery();
  return context.pickAddressGeoRows(await exec(sql, params), { limit });
}

export async function selectAddressEnrichCandidates(exec, { deps, limit = 12 } = {}) {
  const context = deps || {};
  const { sql, params } = context.addressEnrichScanQuery();
  return context.pickAddressEnrichRows(await exec(sql, params), { limit });
}

// listingsNeedingMrt(): the cached-coordinate test is one extra read of mrt_cache's geo_key set.
export async function selectMrtCandidates(exec, { deps, limit = 20 } = {}) {
  const context = deps || {};
  const { sql, params } = context.mrtScanQuery();
  const rows = await exec(sql, params);
  const cacheQuery = context.mrtCacheKeysQuery();
  const cached = await exec(cacheQuery.sql, cacheQuery.params);
  const keys = new Set((cached || []).map((row) => String(row.geo_key || "")));
  return context.pickMrtRows(rows, {
    limit,
    hasMrt: (lat, lng) => keys.has(context.mrtKeyFor(lat, lng)),
  });
}

// listingsNeedingRoute(): the only scan whose decision needs two more tables, so every candidate
// page is answered from one route_jobs read and one route_cache read, both handed to the shared
// routeRowNeed(). Returns { rows, cursor }: the caller owns the keyset cursor, because resuming a
// full scan is the point of the page loop.
export async function selectRouteCandidates(exec, { deps, limit = 40, priorityIds = [], cursor = 0, now } = {}) {
  const context = deps || {};
  const plan = context.routeScanPlan({ limit, priorityIds, cursor, now: now ?? Date.now() });
  if (!plan.jobs.length) return { rows: [], cursor: 0 };
  const out = [];
  const seen = new Set();

  const consume = async (rows) => {
    if (!rows.length) return false;
    const jobKeys = [];
    const cacheKeys = [];
    for (const row of rows) {
      for (const job of plan.jobs) {
        jobKeys.push(...context.routeRowJobKeys(row, job));
        cacheKeys.push(...context.routeRowCacheKeys(row, job));
      }
    }
    const jobsQuery = context.routeJobsQuery({ jobKeys });
    const jobRows = jobsQuery.sql ? await exec(jobsQuery.sql, jobsQuery.params) : [];
    const jobMap = new Map((jobRows || []).map((row) => [String(row.job_key), row]));
    const cacheQuery = context.routeCacheQuery({ keys: cacheKeys });
    const cacheRows = cacheQuery.sql ? await exec(cacheQuery.sql, cacheQuery.params) : [];
    const cacheMap = new Map(
      (cacheRows || []).map((row) => [String(row.route_key), context.parseRouteCacheRow(row)]),
    );
    const jobFor = (jobKey) => jobMap.get(String(jobKey)) || null;
    const cacheFor = (fromLat, fromLng, toLat, toLng, mode, direction) => (
      cacheMap.get(context.makeRouteKey(fromLat, fromLng, toLat, toLng, mode, direction)) ?? null
    );
    for (const row of rows) {
      for (const job of plan.jobs) {
        const key = `${row.post_id}|${job.workLat}|${job.workLng}|${job.commuteMode}`;
        if (seen.has(key)) continue;
        const need = context.routeRowNeed(row, job, {
          wantRush: plan.wantRush,
          now: plan.now,
          jobFor,
          cacheFor,
        });
        if (!need) continue;
        seen.add(key);
        out.push(need);
        if (out.length >= plan.cap) return true;
      }
    }
    return false;
  };

  if (plan.priorityIds.length) {
    const query = context.routePriorityScanQuery({ postIds: plan.priorityIds });
    const rows = await exec(query.sql, query.params);
    const order = new Map(plan.priorityIds.map((id, index) => [id, index]));
    rows.sort((a, b) => (order.get(Number(a.post_id)) ?? 1e9) - (order.get(Number(b.post_id)) ?? 1e9));
    if (await consume(rows)) return { rows: out, cursor: plan.cursor };
  }

  const watchedQuery = context.routeWatchedScanQuery({ limit: Math.max(plan.cap, 40) });
  if (await consume(await exec(watchedQuery.sql, watchedQuery.params))) {
    return { rows: out, cursor: plan.cursor };
  }

  let scanCursor = plan.cursor;
  let scanned = 0;
  while (out.length < plan.cap && scanned < plan.maxPages) {
    const pageQuery = context.routePageScanQuery({ cursor: scanCursor, limit: plan.pageSize });
    const rows = await exec(pageQuery.sql, pageQuery.params);
    if (!rows.length) {
      scanCursor = 0;
      break;
    }
    scanCursor = Number(rows[rows.length - 1].post_id) || scanCursor;
    scanned += 1;
    if (await consume(rows)) return { rows: out, cursor: scanCursor };
    if (rows.length < plan.pageSize) {
      scanCursor = 0;
      break;
    }
  }
  return { rows: out, cursor: scanCursor };
}

