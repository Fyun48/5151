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
import { searchListingsNodePg } from "./listingSearchNodePg.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { createListingsRepository } from "./repository/listings.js";

// One pool for the process, shared with the write path (see pgSharedDriver.js).
import { sharedPgDriver } from "./pgSharedDriver.js";

// F2：PostgreSQL 失效時的穩定錯誤碼。呼叫端（server.js）據此回 503，而不是回退 SQLite
// ——回退會讓「清單看到的資料」與「PG 的真相」無聲分裂，且讓故障無法被看見。
export const SEARCH_UNAVAILABLE_CODE = "SEARCH_UNAVAILABLE";

export class ListingSearchUnavailableError extends Error {
  constructor(cause) {
    super(`listing search unavailable on the postgres driver: ${String(cause?.message || cause || "").slice(0, 200)}`);
    this.name = "ListingSearchUnavailableError";
    this.code = SEARCH_UNAVAILABLE_CODE;
    this.cause = cause;
  }
}

export function isListingSearchUnavailable(error) {
  return error?.code === SEARCH_UNAVAILABLE_CODE || error?.name === "ListingSearchUnavailableError";
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

// B2/B3（astra6 §5）：搜尋引擎選擇。
//
// **正式入口一律 `node_pg`**（PG-fed Node，與參考管線共用後處理；Owner 2026-09-24 決定正確性優先）。
//
// `sql_pg`（SQL-first）**不得由正式請求選到** ✗：baseline／q 都已量到約 40% 的 total 差異，
// 且四個能力因效能關閉 ⇒ 沒有一個可正常上線的剩餘能力。
// 因此這裡**不讀環境變數**（避免正式部署誤用未達 gate 的引擎），
// 只有明確傳 `options.engine = "sql_pg"` 的診斷／測試／benchmark 路徑才能使用。
export function searchEngine(options = {}) {
  return options.engine === "sql_pg" ? "sql_pg" : "node_pg";
}

export async function searchListingsAsync(args = {}, options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return searchListingsSqlite(args);

  try {
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    // 正確性優先（Owner 2026-09-24）：預設走 PG-fed Node，且**不先跑 SQL-first**
    // （省掉一次註定要丟棄的查詢；也不建立 repository）。要回到 SQL-first 需明確設 PG_SEARCH_ENGINE=sql_pg。
    if (searchEngine(options) === "node_pg") {
      return await searchListingsNodePg(args, {
        pgDriver,
        deps: options.deps || listingSearchBuildContext(),
        decorationLoader: options.decorationLoader,
      });
    }
    const repository = options.repository || createListingsRepository({
      driver: "postgres",
      pgDriver,
      schema: options.schema || "",
      deps: options.deps || listingSearchBuildContext(),
    });
    const page = await repository.searchPage(args);
    // B2/B3（astra6 §3）：外框外的查詢**不再回退 SQLite** —— 那會在下層換掉資料來源
    // （PG 模式下讀到的是另一個、可能落後的資料庫），也讓「PG 失效不回 SQLite」形同虛設。
    // 改走 PG-fed Node 管線：候選／個人旗標／裝飾全部來自 PG，後處理與 SQLite Node 路徑共用同一份函式。
    if (!page || searchEngine(options) === "node_pg") {
      return await searchListingsNodePg(args, {
        pgDriver,
        deps: options.deps || listingSearchBuildContext(),
        decorationLoader: options.decorationLoader,
      });
    }

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
    // F2／astra6 §5：PostgreSQL 失敗時**不回退 SQLite**，且**移除正式可達的換庫能力** ✗。
    // 診斷／測試要比較 SQLite adapter 時，直接呼叫 searchListingsSqlite()，不要讓正式錯誤處理保留這個選項。
    if (isListingSearchUnavailable(error)) throw error;
    throw new ListingSearchUnavailableError(error);
  }
}
