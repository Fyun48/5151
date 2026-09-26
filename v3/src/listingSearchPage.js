import { buildListRequestContextFromPg } from './db.js';
import { resolveDbDriver } from './dbDriver.js';
import { sharedPgDriver } from './pgSharedDriver.js';
import { toPostgresSql } from './sqlDialect.js';
import { withPgReadSnapshot } from './pgReadSnapshot.js';
import { listingRequestTime } from './listingRequestTime.js';
import { searchListingsAsync, ListingSearchUnavailableError, isListingSearchUnavailable } from './listingSearchAsync.js';
import { listingStatsAsync, loadPgListingStatsInputs } from './listingStatsAsync.js';

// The page and its counters share one clock, connection, settings and snapshot.
// This is also the benchmark entry: all DB/Node work and the public envelope.
export async function loadListingPage(input = {}, options = {}) {
  const driver = options.driver || resolveDbDriver();
  const args = {...input, ...listingRequestTime(input.asOf)};
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
