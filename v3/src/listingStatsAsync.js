// PostgreSQL counters use PG settings and a read snapshot. Missing dependencies
// fail with SEARCH_UNAVAILABLE; SQLite is only used in explicit SQLite mode.
import {
  buildListingStatsRows,
  listingStatsBuildContext,
  preloadDecorationProviderAsync,
  stats,
  summarizeListingStats,
} from "./db.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { createListingStatsRepository } from "./repository/listingStats.js";

// One pool for the process, shared with the list path and the write path.
import { sharedPgDriver } from "./pgSharedDriver.js";
import { withPgReadSnapshot } from "./pgReadSnapshot.js";
import { ListingSearchUnavailableError, isListingSearchUnavailable } from "./listingSearchAsync.js";

export async function listingStatsAsync(
  { searchKeys, userId, settings, diagnostics, asOf = null } = {},
  options = {},
) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return stats(searchKeys, userId, settings, diagnostics);

  try {
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    return await withPgReadSnapshot(pgDriver, async snapshotDriver => {
      const exec = options.exec
        || ((sql, params = []) => snapshotDriver.query(toPostgresSql(sql), params).then((res) => res.rows));
      const deps = options.deps || listingStatsBuildContext();
      const repository = options.repository
        || createListingStatsRepository({ driver: "postgres", pgDriver, exec, deps });
      const inputs = await repository.loadInputs({ searchKeys, userId, settings, diagnostics, asOf, requestContext: options.requestContext });
      const provider = options.decorationProvider || (await preloadDecorationProviderAsync({
        exec,
        rows: inputs.rows,
        settings: inputs.settings,
        userId: inputs.uid,
        matchVoteUserId: inputs.uid,
        sameHouse: false,
        requestContext: inputs.requestContext,
      }));
      const profileRows = buildListingStatsRows({
        rows: inputs.rows,
        flagMap: provider.personalFlags(),
        userId: inputs.uid,
        settings: inputs.settings,
        provider,
      });
      return summarizeListingStats({
        profileRows,
        settings: inputs.settings,
        statusCounts: inputs.statusCounts,
        watchedTotal: inputs.watchedTotal,
        failedRouteJobs: inputs.failedRouteJobs,
        dbTotal: inputs.dbTotal,
        provider,
      });
    });
  } catch (error) {
    if (isListingSearchUnavailable(error)) throw error;
    throw new ListingSearchUnavailableError(error);
  }
}
