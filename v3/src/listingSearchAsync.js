// Asynchronous listings hot path (PostgreSQL hot path).
//
// `/api/listings` used to run a synchronous chain of SQLite fast paths. With
// PostgreSQL in the picture the same call has to be awaited, so the handler now
// goes through this module:
//
//   resolveListed = await searchListingsAsync(args)
//
// Driver behaviour:
//   • sqlite (today's production default) — the exact same chain as before
//     (listListingsSqlFirst || listListingsCommuteSqlFirst ||
//      listListingsFitSqlFirst || listListings). Awaited, so the handler and
//     the drivers agree on the contract, but the returned object is identical.
//   • postgres — the SQL-first page query runs on PostgreSQL through the listings
//     repository. Decoration (flags overlay, same-house peers, per-user commute
//     labels) is still executed by the SQLite-shaped helpers, so the PostgreSQL
//     rows are returned RAW and the caller must opt in explicitly with
//     `allowUndecorated` (PG_LISTINGS_UNDECORATED=1). Without the opt-in the
//     PostgreSQL driver falls back to the SQLite chain, so a stray DB_DRIVER
//     flip cannot silently degrade the public listing response.
import {
  listListings,
  listListingsCommuteSqlFirst,
  listListingsFitSqlFirst,
  listListingsSqlFirst,
  listingSearchBuildContext,
} from "./db.js";
import { resolveDbDriver } from "./dbDriver.js";
import { createListingsRepository } from "./repository/listings.js";

// The pre-existing chain, unchanged and shared by both drivers as the fallback.
export function searchListingsSqlite(args = {}) {
  return (
    listListingsSqlFirst(args) ||
    listListingsCommuteSqlFirst(args) ||
    listListingsFitSqlFirst(args) ||
    listListings(args)
  );
}

export async function searchListingsAsync(args = {}, options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return searchListingsSqlite(args);
  if (!options.allowUndecorated) return searchListingsSqlite(args);

  const repository =
    options.repository ||
    createListingsRepository({
      driver: "postgres",
      pgDriver: options.pgDriver,
      schema: options.schema || "",
      deps: options.deps || listingSearchBuildContext(),
    });

  const page = await repository.searchPage(args);
  // Outside the SQL-first envelope the PostgreSQL path would need the Node
  // candidate scan, which is still SQLite-bound — use the same fallback.
  if (!page) return searchListingsSqlite(args);

  const rows = options.hydrate === false ? [] : await repository.hydrate(page.ids);
  return {
    listings: rows,
    totalMatched: page.totalMatched,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
    nextCursor: page.nextCursor,
    queryVersion: page.queryVersion,
    queryDetails: {
      sql_first: true,
      cursor: page.useCursor,
      driver: "postgres",
      hydrated: options.hydrate === false ? "ids_only" : "raw",
      decoration: "pending",
    },
  };
}
