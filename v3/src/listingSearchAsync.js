// Asynchronous listings hot path (PostgreSQL hot path).
//
// `/api/listings` used to run a synchronous chain of SQLite fast paths. With PostgreSQL in
// the picture the same call has to be awaited, so the handler goes through this module:
//
//   listed = await searchListingsAsync(args, options)
//
// Driver behaviour:
//   • sqlite (today's production default) - the exact same chain as before
//     (listListingsSqlFirst || listListingsCommuteSqlFirst ||
//      listListingsFitSqlFirst || listListings). Awaited, so the handler and the drivers
//     agree on the contract, but the returned object is identical.
//   • postgres - the SQL-first page query runs on PostgreSQL, then the decoration inputs are
//     preloaded through repository/decorationData.js and the SAME pure decorators the SQLite
//     path uses run over the rows (db.js `preloadDecorationProviderAsync` +
//     `decorateRowsWithProvider`). The response is therefore fully decorated.
//
// Two safety valves remain: a page outside the SQL-first envelope, or a decoration failure
// (a missing table, a connection drop), falls back to the SQLite chain rather than serving a
// half-decorated page. `allowUndecorated` (PG_LISTINGS_UNDECORATED=1) returns the raw page
// and is meant for migration diagnostics only.
import {
  decorateRowsWithProvider,
  listListings,
  listListingsCommuteSqlFirst,
  listListingsFitSqlFirst,
  listListingsSqlFirst,
  listingSearchBuildContext,
  preloadDecorationProviderAsync,
} from "./db.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { createListingsRepository } from "./repository/listings.js";

// One pool for the process: the list path must not open a new pool per request.
let sharedPgDriver = null;
async function resolveSharedPgDriver() {
  if (!sharedPgDriver) {
    const { createPostgresDriver } = await import("./dbDriverPostgres.js");
    sharedPgDriver = await createPostgresDriver({});
  }
  return sharedPgDriver;
}

// The pre-existing chain, unchanged and shared by both drivers as the fallback.
export function searchListingsSqlite(args = {}) {
  return (
    listListingsSqlFirst(args) ||
    listListingsCommuteSqlFirst(args) ||
    listListingsFitSqlFirst(args) ||
    listListings(args)
  );
}

function pageResult(page, listings, extra = {}) {
  return {
    listings,
    totalMatched: page.totalMatched,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
    nextCursor: page.nextCursor,
    queryVersion: page.queryVersion,
    queryDetails: {
      sql_first: true,
      cursor: page.useCursor,
      driver: "postgres",
      ...extra,
    },
  };
}

export async function searchListingsAsync(args = {}, options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return searchListingsSqlite(args);

  try {
    const pgDriver = options.pgDriver || (await resolveSharedPgDriver());
    const repository = options.repository || createListingsRepository({
      driver: "postgres",
      pgDriver,
      schema: options.schema || "",
      deps: options.deps || listingSearchBuildContext(),
    });
    const page = await repository.searchPage(args);
    // Outside the SQL-first envelope the PostgreSQL path would need the Node candidate
    // scan, which is still SQLite-bound - use the same fallback.
    if (!page) return searchListingsSqlite(args);

    const rows = options.hydrate === false ? [] : await repository.hydrate(page.ids);
    if (options.allowUndecorated) {
      return pageResult(page, rows, {
        hydrated: options.hydrate === false ? "ids_only" : "raw",
        decoration: "skipped",
      });
    }

    const userId = Number(args.userId) || 0;
    const matchVoteUserId = args.matchVoteUserId == null ? userId : Number(args.matchVoteUserId) || 0;
    const sameHouse = args.sameHouse !== false;
    const settings = args.settings || null;
    const exec = options.exec
      || ((sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows));
    const provider = options.decorationProvider
      || (await preloadDecorationProviderAsync({ exec, rows, settings, userId, matchVoteUserId, sameHouse }));
    const listings = decorateRowsWithProvider(rows, {
      settings,
      userId,
      provider,
      sameHouse,
      matchVoteUserId,
    });
    return pageResult(page, listings, { hydrated: "decorated", decoration: "full" });
  } catch (error) {
    // Never serve a half-decorated page: a preload/decoration failure falls back to the
    // synchronous SQLite chain instead.
    if (options.strict) throw error;
    return searchListingsSqlite(args);
  }
}
