// Offline comparison only. No production handler imports this module.
import { decorateRowsWithProvider, listingSearchBuildContext, preloadDecorationProviderAsync } from "./db.js";
import { toPostgresSql } from "./sqlDialect.js";
import { createListingsRepository } from "./repository/listings.js";
import { sharedPgDriver } from "./pgSharedDriver.js";

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

/**
 * 診斷／對照專用：舊的 SQL-first（`sql_pg`）路徑。
 *
 * astra 2026-09-25 §5.6：這個 dispatcher **不得**由正式 handler、環境變數或 `options.engine` 切入；
 * 只有測試 helper／診斷腳本可以直接 import。**不支援的案例一律回報 unsupported** ✗ ——
 * 不得偷偷改跑 Node 之後把成績標成 SQL。
 */
export async function searchListingsSqlPgDiagnostic(args = {}, options = {}) {
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  const repository = options.repository || createListingsRepository({
    driver: "postgres",
    pgDriver,
    schema: options.schema || "",
    deps: options.deps || listingSearchBuildContext(),
  });
  const page = await repository.searchPage(args);
  if (!page) return { unsupported: true, reason: "sql-first envelope 不支援此查詢" };

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
}
