// PostgreSQL counters use PG settings and a read snapshot. Missing dependencies
// fail with SEARCH_UNAVAILABLE; SQLite is only used in explicit SQLite mode.
import {
  buildListingStatsRowsAsync,
  listingStatsBuildContext,
  preloadedDecorationProvider,
  stats,
  summarizeListingStatsAsync,
} from "./db.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { createListingStatsRepository } from "./repository/listingStats.js";
import { createDecorationDataLoader } from "./repository/decorationData.js";
import { isTrustedGeoSource } from "./location.js";
import { hasWorkPoint } from "./geo.js";
import { makeRouteKey } from "./route.js";

// One pool for the process, shared with the list path and the write path.
import { sharedPgDriver } from "./pgSharedDriver.js";
import { withPgReadSnapshot, readPgRows } from "./pgReadSnapshot.js";
import { ListingSearchUnavailableError, isListingSearchUnavailable } from "./listingSearchAsync.js";

const statsExecutor = driver => (sql, params = [], { batch = false, arrayRows = false } = {}) => batch
  ? readPgRows(driver, toPostgresSql(sql), params, {arrayRows})
  : driver.query(toPostgresSql(sql), params).then(res => res.rows);

// The caller owns the snapshot. loadListingPage uses these same raw rows for
// ID-based list hydration and then for counters, without changing either scope.
export async function loadPgListingStatsInputs(args = {}, options = {}) {
  const exec = options.exec || statsExecutor(options.pgDriver);
  const repository = options.repository || createListingStatsRepository({
    driver: "postgres", pgDriver: options.pgDriver, exec,
    deps: options.deps || listingStatsBuildContext(),
  });
  return repository.loadInputs({...args, requestContext:options.requestContext});
}

// Counters consume personal flags and routes. They do not decorate cards or
// compare house groups, so loading candidate extras/peers/MRT for them is wasteful.
async function statsProvider(exec, inputs) {
  const {settings, rows, requestContext} = inputs;
  const keys = [];
  if (Number(settings.commuteKm) > 0 && hasWorkPoint(settings)) {
    for (const row of rows) {
      if (!isTrustedGeoSource(row.geo_source) || !Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lng))) continue;
      keys.push(makeRouteKey(row.lat,row.lng,settings.workLat,settings.workLng,settings.commuteMode,"to_work"));
      keys.push(makeRouteKey(settings.workLat,settings.workLng,row.lat,row.lng,settings.commuteMode,"from_work"));
    }
  }
  const loader = createDecorationDataLoader({exec,driver:"postgres"});
  return preloadedDecorationProvider({userId:inputs.uid,personalFlags:inputs.flagMap,
    routeCache:await loader.routeCacheMap(keys),crawlSources:requestContext.crawlSources,
    systemCrawl:requestContext.systemCrawl,now:requestContext.now});
}

export async function listingStatsAsync(
  { searchKeys, userId, settings, diagnostics, asOf = null } = {},
  options = {},
) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return stats(searchKeys, userId, settings, diagnostics);

  try {
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    return await withPgReadSnapshot(pgDriver, async snapshotDriver => {
      const exec = options.exec || statsExecutor(snapshotDriver);
      let stageStarted = performance.now();
      const markStage = name => {
        const now = performance.now();
        if (diagnostics) diagnostics[name] = Math.round(now - stageStarted);
        stageStarted = now;
      };
      const inputs = options.preloadedStatsInputs || await loadPgListingStatsInputs(
        {searchKeys, userId, settings, diagnostics, asOf},
        {...options, pgDriver:snapshotDriver, exec},
      );
      markStage(options.preloadedStatsInputs ? "reuse_inputs_ms" : "inputs_ms");
      const provider = options.decorationProvider || await statsProvider(exec, inputs);
      markStage("provider_ms");
      const profileRows = await buildListingStatsRowsAsync({
        rows: inputs.rows,
        flagMap: provider.personalFlags(),
        userId: inputs.uid,
        settings: inputs.settings,
        provider,
      });
      markStage("profile_ms");
      const result = await summarizeListingStatsAsync({
        profileRows,
        settings: inputs.settings,
        statusCounts: inputs.statusCounts,
        watchedTotal: inputs.watchedTotal,
        failedRouteJobs: inputs.failedRouteJobs,
        dbTotal: inputs.dbTotal,
        provider,
      });
      markStage("count_ms");
      return result;
    });
  } catch (error) {
    if (isListingSearchUnavailable(error)) throw error;
    throw new ListingSearchUnavailableError(error);
  }
}
