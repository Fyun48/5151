import { buildListRequestContextFromPg } from './db.js';
import { resolveDbDriver } from './dbDriver.js';
import { sharedPgDriver } from './pgSharedDriver.js';
import { toPostgresSql } from './sqlDialect.js';
import { withPgReadSnapshot } from './pgReadSnapshot.js';
import { listingRequestTime } from './listingRequestTime.js';
import { searchListingsAsync, ListingSearchUnavailableError, isListingSearchUnavailable } from './listingSearchAsync.js';
import { listingStatsAsync, loadPgListingStatsInputs } from './listingStatsAsync.js';
import { loadMemberListingPage, memberListingCacheEnabled } from './memberListingCachePg.js';

// The page and its counters share one clock, connection, settings and snapshot.
// This is also the benchmark entry: all DB/Node work and the public envelope.
export async function loadListingPage(input = {}, options = {}) {
  const driver = options.driver || resolveDbDriver();
  const args = {...input, ...listingRequestTime(input.asOf)};
  // 版本化快取（memberListingCachePg.js）：**預設關閉**（`MEMBER_LISTING_CACHE=1` 才開），
  // 而且只在 postgres driver 上生效。沒開閘／非 PG 時走的是同一條 computeListingPage，
  // 回傳值與加這一層之前逐字相同。
  if (driver !== 'postgres' || !memberListingCacheEnabled()) {
    return computeListingPage(args, driver, options);
  }
  const pgDriver = options.pgDriver || await sharedPgDriverOrUnavailable();
  return loadMemberListingPage({
    pgDriver,
    args,
    load: () => computeListingPage(args, driver, {...options, pgDriver}),
    // 呼叫端**明確**傳進來的 asOf 會改變結果 ⇒ 進 key；`listingRequestTime()` 自動產生的
    // 那一個時鐘不進（每個請求都不同，進去等於永遠不命中）。
    deps: { explicitAsOf: input.asOf ?? null },
  });
}

// 取共用 pool。失敗要維持原本的契約（穩定的 SEARCH_UNAVAILABLE），
// 不能因為搬到快取層之前就讓原始錯誤直接漏出去。
async function sharedPgDriverOrUnavailable() {
  try {
    return await sharedPgDriver();
  } catch (error) {
    if (isListingSearchUnavailable(error)) throw error;
    throw new ListingSearchUnavailableError(error);
  }
}

// 沒有快取時的那條路（＝這支模組原本的內容，逐字保留）。
async function computeListingPage(args = {}, driver = 'sqlite', options = {}) {
  const started = performance.now();
  const run = async (pgDriver = null) => {
    const requestContext = driver === 'postgres'
      ? await buildListRequestContextFromPg((sql,params=[])=>pgDriver.query(toPostgresSql(sql),params).then(r=>r.rows),{asOf:args.asOf,resolvedSearchKeys:args.searchKeys})
      : null;
    const common = {driver, pgDriver, requestContext};
    const statsDetails={};
    const statsArgs={searchKeys:args.searchKeys,userId:args.userId,
      settings:args.settings,asOf:args.asOf,diagnostics:statsDetails};
    let statsPrepareMs=0;
    if(driver==='postgres') {
      const before=performance.now();
      common.preloadedStatsInputs=await loadPgListingStatsInputs(statsArgs,common);
      common.reusableCandidates=common.preloadedStatsInputs.rows;
      statsPrepareMs=performance.now()-before;
      statsDetails.inputs_ms=Math.round(statsPrepareMs);
    }
    const listed = await searchListingsAsync(args, common);
    const queryMs = performance.now()-started-statsPrepareMs;
    const statsStarted=performance.now();
    const stats=await listingStatsAsync(statsArgs,common);
    return {
      stats:{...stats,matched:listed.totalMatched},listings:listed.listings,
      hasMore:listed.hasMore===true,nextOffset:listed.nextOffset||0,
      nextCursor:listed.nextCursor||null,queryVersion:listed.queryVersion||2,
      timing:{query_ms:queryMs,stats_ms:statsPrepareMs+performance.now()-statsStarted,total_ms:performance.now()-started,
        dataset:listed.totalMatched,stages:listed.queryDetails,stats_stages:statsDetails},
    };
  };
  if(driver!=='postgres') return run();
  try {
    const pgDriver=options.pgDriver || await sharedPgDriver();
    return await withPgReadSnapshot(pgDriver,run);
  } catch(error) {
    if(isListingSearchUnavailable(error)) throw error;
    throw new ListingSearchUnavailableError(error);
  }
}
