// Async listing dispatcher. SQLite keeps its existing search adapters;
// PostgreSQL uses node_pg and fails with SEARCH_UNAVAILABLE. The SQL experiment
// lives in listingSearchSqlPgDiagnostic.js and is not selectable here.
import {
  listListings,
  listListingsCommuteSqlFirst,
  listListingsFitSqlFirst,
  listListingsSqlFirst,
  listingSearchBuildContext,
} from "./db.js";
import { searchListingsNodePg } from "./listingSearchNodePg.js";
import { resolveDbDriver } from "./dbDriver.js";
import { listingRequestTime } from "./listingRequestTime.js";

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

// SQLite-only dispatcher; PostgreSQL never invokes this chain.
export function searchListingsSqlite(args = {}) {
  args = { ...args, ...listingRequestTime(args.asOf ?? args.context?.asOf) };
  return (
    listListingsSqlFirst(args) ||
    listListingsCommuteSqlFirst(args) ||
    listListingsFitSqlFirst(args) ||
    listListings(args)
  );
}

// PostgreSQL always uses the shared Node pipeline with a single PG snapshot.
export async function searchListingsAsync(args = {}, options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return searchListingsSqlite(args);

  try {
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    // 一律走 PG-fed Node：不先跑 SQL-first（省掉一次註定要丟棄的查詢；也不建立 repository）。
    // ✗ 窄欄位實驗已撤回（astra 2026-09-25 裁決 §2.1）：`listingEffectiveUpdatedAt()` 需要
    // `first_seen_at`（refresh_time 是相對時間或缺絕對時間時 ✓）⇒ 窄清單會改變 `newest` 排序
    //（反例：寬 [2,1] vs 窄 [1,2] ✓，且分頁前排序錯了 hydration 救不回 ✓）。
    // 審計工具保留（`test/listing-search-*-read-audit.test.js` ✓）；要再縮欄位必須先有**完整 parity**
    //（寬版與優化版的總數／順序／角色／卡片狀態完全相同 ✓），不能只憑動態讀取紀錄 ✓。
    return await searchListingsNodePg(args, {
      pgDriver,
      deps: options.deps || listingSearchBuildContext(),
      decorationLoader: options.decorationLoader,
      requestContext: options.requestContext,
      reusableCandidates: options.reusableCandidates,
    });
  } catch (error) {
    // F2／astra6 §5：PostgreSQL 失敗時**不回退 SQLite**，且**移除正式可達的換庫能力** ✗。
    // 診斷／測試要比較 SQLite adapter 時，直接呼叫 searchListingsSqlite()，不要讓正式錯誤處理保留這個選項。
    if (isListingSearchUnavailable(error)) throw error;
    throw new ListingSearchUnavailableError(error);
  }
}
