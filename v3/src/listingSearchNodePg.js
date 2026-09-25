// B3（astra6 決策文件 §3）：PG-fed Node 搜尋路徑。
//
// 存在的理由：`sql_pg`（SQL-first）只服務**已證明等價**的查詢；其餘查詢不得回退 SQLite
// ——在 PG 模式下那是另一個資料來源、內容可能落後，而且會讓「PG 失效就不回 SQLite」的保證形同虛設。
//
// 本模組讓那些查詢改走「候選、個人旗標、裝飾資料**全部來自 PG**」的 Node 管線，
// 且後處理與 SQLite Node 路徑**共用同一份函式**（buildListListingsRows／paginate…／decorate…）。
//
// 不變式（依 astra6 §3）：
//   1. 不得先 LIMIT 再過濾；`totalMatched` 必須由完整候選集合決定。
//   2. provider 缺資料時不得 fallback 到 SQLite（寧可讓呼叫端 503）。
//   3. PG 失敗一律往外拋，由呼叫端回 503 與既有穩定錯誤碼。
import {
  buildListListingsClauses,
  buildListListingsRows,
  decorateListListingsPage,
  paginateListListingsRows,
  preloadDecorationProviderAsync,
} from "./db.js";
import { normalizeListQuery } from "./floors.js";
import { createDecorationDataLoader } from "./repository/decorationData.js";
import { toPostgresSql } from "./sqlDialect.js";

export const NODE_PG_QUERY_VERSION = 2;

/** 呼叫端可用它決定「能不能跑 PG＋Node」（不能就跑 503，而不是偷讀 SQLite）。 */
export function canRunNodePg({ pgDriver, deps } = {}) {
  return Boolean(pgDriver && typeof pgDriver.query === "function" && deps?.candidateColumns);
}

export async function searchListingsNodePg(args = {}, { pgDriver, deps = {}, decorationLoader = null } = {}) {
  if (!pgDriver || typeof pgDriver.query !== "function") {
    throw new Error("searchListingsNodePg requires pgDriver");
  }
  const candidateColumns = deps.candidateColumns;
  if (!candidateColumns) {
    throw new Error("searchListingsNodePg requires deps.candidateColumns（用 listingSearchBuildContext()）");
  }

  const exec = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
  const uid = deps.resolveUserId ? deps.resolveUserId(args.userId) : Number(args.userId) || 0;
  const voteUid = args.matchVoteUserId == null ? uid : Number(args.matchVoteUserId) || 0;
  const settings = args.settings || (deps.getSettings ? deps.getSettings(uid) : {});
  const sameHouse = args.sameHouse !== false;
  const { filter, kind, sources } = normalizeListQuery(args.filter, args.kind, args.sources);
  const sort = args.sort || "price_asc";

  const queryDetails = {};
  let stageStarted = performance.now();
  const markStage = (name) => {
    const now = performance.now();
    queryDetails[name] = Math.round(now - stageStarted);
    stageStarted = now;
  };

  const built = buildListListingsClauses({
    filter, kind, sources, q: args.q, searchKeys: args.searchKeys,
    districts: args.districts, settings, uid, voteUid,
  });
  markStage("prepare_ms");
  // 取「全部」候選：不在這裡 LIMIT，否則 totalMatched 會被候選上限截斷。
  const raw = await exec(`SELECT ${candidateColumns} FROM listings ${built.where}`, built.params);
  markStage("sql_ms");
  queryDetails.candidates = raw.length;
  queryDetails.engine = "node_pg";

  const loader = decorationLoader || createDecorationDataLoader({ exec, driver: "postgres" });
  const [flagMap, provider] = await Promise.all([
    loader.personalFlagMap(voteUid),
    preloadDecorationProviderAsync({ exec, rows: raw, settings, userId: uid, matchVoteUserId: voteUid, sameHouse }),
  ]);
  markStage("preload_ms");

  const rows = buildListListingsRows(raw, {
    filter, kind, sources, sort, uid, voteUid, settings,
    districtSet: built.districtSet, provider, flagMap, markStage,
  });

  const paged = paginateListListingsRows(rows, { sort, filter, settings, limit: args.limit, offset: args.offset });
  markStage("sort_ms");
  const fullRows = paged.page.length
    ? await exec(`SELECT * FROM listings WHERE post_id IN (${paged.page.map(() => "?").join(", ")})`, paged.pageIds)
    : [];
  const listings = decorateListListingsPage(paged.page, fullRows, { settings, uid, voteUid, sameHouse });
  markStage("hydrate_ms");

  return {
    listings,
    totalMatched: paged.totalMatched,
    hasMore: paged.hasMore,
    nextOffset: paged.nextOffset,
    queryVersion: NODE_PG_QUERY_VERSION,
    queryDetails,
  };
}
