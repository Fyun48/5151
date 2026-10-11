// The background loops' "what needs work" scans (PostgreSQL side).
//
// db.js's listingsNeeding* functions are synchronous SQLite queries. With the lists, the detail
// reads, the crawler reads and the loop writes already driver-aware, these scans are the last
// piece that made a loop idle in DB_DRIVER=postgres mode: it would look for work in an empty
// SQLite store and do nothing. The statement text and the JS post-filter come from the dependency
// bundle db.js publishes as crawlerReadsBuildContext(), so both drivers scan identically.
export async function selectAliveCheckCandidates(exec, { deps, excludeIds = [], limit = 20, now = new Date(), visibleDays = 7 } = {}) {
  const context = deps || {};
  const { sql, params } = context.aliveCheckScanQuery({ now, visibleDays });
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

// listingsNeeding591Geo(): 條件下推＋有界批次。舊版把整張 `listings`（正式庫每次約 16 萬列）送回
// Node，才由 `pick591GeoRows()` 挑出 20 筆，而且 `community_cache` 是**整張撈回 Node** 再判；現在
// 述詞（含 `community_cache` 的 `NOT EXISTS` 反連接）與 ORDER BY 全部由 db.js 的
// `geo591RotationQuery()` 產生，PG 端沿主鍵索引掃到 `limit` 筆就停，回傳列數 = 批次大小。
//
// `cursor` 由呼叫端持有（`crawlerReads.needing591GeoAsync()` 的參數 → `watcher.backfillListingCoords()`）：
// 一般呼叫傳 `{ limit }` 時游標是 0，與 SQLite 的 `listingsNeeding591Geo()` 逐列相同；帶游標呼叫時
// 只回傳 `post_id > cursor` 的下一批，掃到結尾自然回傳空陣列，呼叫端把游標歸零重新循環。
export async function select591GeoCandidates(exec, { deps, limit = 20, cursor = 0 } = {}) {
  const context = deps || {};
  const cap = Math.max(1, Number(limit) || 20);
  const { sql, params } = context.geo591RotationQuery({ limit: cap, cursor, dialect: "postgres" });
  const rows = await exec(sql, params);
  // ⚠️ 這裡**不要**再套一次 `pick591GeoRows()`：PG 端沒有 community_cache 的內容（那正是被下推掉的
  // 讀取），拿 `hasCommunity: () => true` 去餵它會把 `needsCommunity` 那一半全部當成「已經有快取」
  // 而濾掉——看起來像安全網，實際上是把「要補社區」的列整批吃掉。述詞的正確性由
  // `geo591-bounded-batch.test.js` 的逐批等價測試釘住（SQLite／PG 各跑一次），這裡只做形狀轉換。
  return rows.map((row) => ({ post_id: row.post_id }));
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
//
// SQLite 退場 P1：`plan` 可以由呼叫端算好傳進來（`crawlerReads.js:needingRouteAsync()` 在 PG 模式
// 用 `db.js:routeScanPlanAsync()`，jobs／wantRush 來自 PG）。沒傳時沿用 `context.routeScanPlan()`
// （原本的 bundle 路徑，sqlite 語意不變）——因為那個預設值會同步讀本機 SQLite，PG 的呼叫端
// 一定要傳，不能靠這裡回退。
export async function selectRouteCandidates(exec, { deps, plan: providedPlan, limit = 40, priorityIds = [], cursor = 0, now } = {}) {
  const context = deps || {};
  const plan = providedPlan || context.routeScanPlan({ limit, priorityIds, cursor, now: now ?? Date.now() });
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

