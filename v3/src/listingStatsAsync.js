// Asynchronous listing-stats hot path (PostgreSQL cutover blocker).
//
// `/api/listings` used to answer its counters with the synchronous SQLite `stats()`. With
// DB_DRIVER=postgres the page came from PostgreSQL while the counters came from SQLite, so the
// page listed an item and the counters said zero
// (v3/evidence/pg-rw-drill-20260921/README.md, gap 1 - the last blocker named by
// v3/POSTGRES_SWITCH_PLAN.md section 2.6).
//
// Driver behaviour:
//   • sqlite (today's production default) - `stats()` exactly as before.
//   • postgres - repository/listingStats.js reads the inputs from PostgreSQL, the decoration
//     provider is preloaded through repository/decorationData.js (route cache for
//     `missingRoute`), and the pure pipeline db.js also uses for SQLite
//     (`buildListingStatsRows` + `summarizeListingStats`) produces the counters. The numbers
//     therefore describe the store the list itself reads.
//
// One safety valve remains: any failure (a missing table, a connection drop) falls back to the
// SQLite counters instead of failing the page - and records why in `diagnostics`.
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

export async function listingStatsAsync(
  { searchKeys, userId, settings, diagnostics } = {},
  options = {},
) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return stats(searchKeys, userId, settings, diagnostics);

  try {
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    const exec = options.exec
      || ((sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows));
    const deps = options.deps || listingStatsBuildContext();
    const repository = options.repository
      || createListingStatsRepository({ driver: "postgres", pgDriver, exec, deps });
    const inputs = await repository.loadInputs({ searchKeys, userId, settings, diagnostics });
    const provider = options.decorationProvider || (await preloadDecorationProviderAsync({
      exec,
      rows: inputs.rows,
      settings: inputs.settings,
      userId: inputs.uid,
      matchVoteUserId: inputs.uid,
      sameHouse: false,
    }));
    const profileRows = buildListingStatsRows({
      rows: inputs.rows,
      flagMap: provider.personalFlags(),
      uid: inputs.uid,
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
  } catch (error) {
    // Never fail the page because a counter could not be read from PostgreSQL.
    if (options.strict) throw error;
    if (diagnostics) diagnostics.sqlite_fallback = String(error?.message || error);
    return stats(searchKeys, userId, settings, diagnostics);
  }
}

