// B3（astra6 決策文件 §3）：PG-fed Node 搜尋路徑。
//
// 存在的理由：`sql_pg`（SQL-first）只服務**已證明等價**的查詢；其餘查詢不得回退 SQLite
// ——在 PG 模式下那是另一個資料來源、內容可能落後，而且會讓「PG 失效就不回 SQLite」的保證形同虛設。
//
// 本模組讓那些查詢改走「候選、個人旗標、裝飾資料**全部來自 PG**」的 Node 管線，
// 且後處理與 SQLite Node 路徑**共用同一份函式**（buildListListingsRowsAsync／paginate…／decorate…）。
//
// 不變式（依 astra6 §3）：
//   1. 不得先 LIMIT 再過濾；`totalMatched` 必須由完整候選集合決定。
//   2. provider 缺資料時不得 fallback 到 SQLite（寧可讓呼叫端 503）。
//   3. PG 失敗一律往外拋，由呼叫端回 503 與既有穩定錯誤碼。
import {
  buildListListingsClauses,
  buildListListingsRowsAsync,
  buildListRequestContextFromPg,
  decorateListListingsPage,
  paginateListListingsRowsAsync,
  preloadDecorationProviderAsync,
  resolveListDistrictNames,
} from "./db.js";
import { districtKeyLists, districtKeyPrefixExpression } from "./listDistrictSql.js";
import { normalizeListQuery } from "./floors.js";
import { createDecorationDataLoader } from "./repository/decorationData.js";
import { toPostgresSql } from "./sqlDialect.js";
import { listingRequestTime } from "./listingRequestTime.js";
import { runStepsAsync, transformChunks } from "./cooperative.js";
import { withPgReadSnapshot, readPgRows } from "./pgReadSnapshot.js";

export const NODE_PG_QUERY_VERSION = 2;

/** 呼叫端可用它決定「能不能跑 PG＋Node」（不能就跑 503，而不是偷讀 SQLite）。 */
export function canRunNodePg({ pgDriver, deps } = {}) {
  return Boolean(pgDriver && typeof pgDriver.query === "function" && deps?.candidateColumns);
}

/**
 * B3b：在 PG 端算出行政區候選的「關係 closure」，回傳 id 陣列（或 null＝不需要過濾）。
 *
 * 為什麼不用 CTE：Node 路徑原本的 recursive CTE 有**多個 recursive 分支**，PostgreSQL 只允許一個
 * （`recursive reference to query "district_related" must not appear within its non-recursive term`）。
 * 這裡改成在 Node 端做 BFS 展開：每步用 PG 原生查詢取「配對雙向鄰居＋個人同屋源群組」，
 * 直到沒有新 id。集合語意與原本的 `UNION` 遞移閉包相同，且完全沒有 dialect 風險。
 */
export async function districtClosureIds(exec, { districtNames = [], userId = 0, relatedOnly = false } = {}) {
  const { allowed, allKeys } = districtKeyLists(districtNames);
  if (!allowed.length || allowed.length === allKeys.length) return null;
  const prefix = districtKeyPrefixExpression("pg");
  const marks = (n) => Array.from({ length: n }, () => "?").join(",");

  // (2) 關係邊：配對雙向（無向圖）＋（選用）該使用者的同屋源群組。
  //     不把 id 清單當 SQL 參數（closure 可達數萬筆，會撐爆參數協定）；改在 Node 端算連通分量。
  const edges = [];
  // Typed PG bigint: the two ranges preserve NULL/zero/negative semantics and
  // let the existing match-peer index avoid scanning every unrelated listing.
  const linked = await exec("SELECT post_id, match_post_id FROM listings WHERE match_post_id > 0 OR match_post_id < 0", [], {batch:true});
  for (const row of linked) {
    const a = Number(row.post_id) || 0;
    const b = Number(row.match_post_id) || 0;
    if (a && b) edges.push([a, b]);
  }
  if (userId > 0) {
    const members = await exec("SELECT post_id, group_key FROM user_same_house_members WHERE user_id = ?", [userId], {batch:true});
    const byGroup = new Map();
    for (const row of members) {
      const key = String(row.group_key || "");
      if (!key) continue;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(Number(row.post_id) || 0);
    }
    for (const list of byGroup.values()) {
      for (let i = 1; i < list.length; i += 1) edges.push([list[0], list[i]]);   // 群組＝完全圖（以第一筆為代表連出）
    }
  }

  // The page keeps direct district matches in SQL. Only relation endpoints
  // need a Node closure: unrelated district IDs must not make a round trip to
  // Node and back as a large array parameter. The legacy full-ID contract is
  // retained for direct callers; the page explicitly opts into relatedOnly.
  const endpoints = relatedOnly ? [...new Set(edges.flat())] : null;
  if (relatedOnly && !endpoints.length) return [];
  const seedRows = await exec(
    `SELECT post_id FROM listings WHERE ${relatedOnly ? "post_id = ANY(?::bigint[]) AND " : ""}(${prefix} IN (${marks(allowed.length)}) OR ${prefix} NOT IN (${marks(allKeys.length)}))`,
    [...(relatedOnly ? [endpoints] : []), ...allowed, ...allKeys], {batch:true},
  );
  const seeds = await runStepsAsync(transformChunks(seedRows, rows => rows.map(row => Number(row.post_id)).filter(Boolean)));

  // (3) 只在「含種子的連通分量」內取全部 id（＝原本 recursive UNION 的遞移閉包語意）。
  //
  // ⚠️ astra6 2026-09-25 §3.2：原版 union-find 沒有 path compression／union-by-size，
  // 在鏈狀輸入下每次 find 都要走完整條鏈（他實測：1,000 節點 → 999,000 次 parent 走訪）。
  // 這裡補上 path compression ＋ union-by-size（迭代版，避免長鏈遞迴爆堆疊）。
  const parent = new Map();
  const size = new Map();
  const find = (x) => {
    let root = parent.get(x) ?? x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root);
    // path compression：把路徑上所有節點直接接到 root
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur) ?? cur;
      parent.set(cur, root);
      if (next === cur) break;
      cur = next;
    }
    parent.set(x, root);
    return root;
  };
  const union = (a, b) => {
    if (!parent.has(a)) { parent.set(a, a); size.set(a, 1); }
    if (!parent.has(b)) { parent.set(b, b); size.set(b, 1); }
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    // union-by-size：小的接到大的，避免鏈化
    if ((size.get(ra) || 1) < (size.get(rb) || 1)) { const t = ra; ra = rb; rb = t; }
    parent.set(rb, ra);
    size.set(ra, (size.get(ra) || 1) + (size.get(rb) || 1));
  };
  for (const [a, b] of edges) union(a, b);
  const seedRoots = new Set();
  const ids = new Set();
  await runStepsAsync((function* () {
    let visited = 0;
    for (const id of seeds) {
      seedRoots.add(parent.has(id) ? find(id) : id); ids.add(id);
      if (++visited % 256 === 0) yield;
    }
  })());
  for (const [a, b] of edges) {
    if (seedRoots.has(find(a))) { ids.add(a); ids.add(b); }
    if (seedRoots.has(find(b))) { ids.add(a); ids.add(b); }
  }
  return [...ids];
}

export async function searchListingsNodePg(args = {}, opts = {}) {
  args = { ...args, ...listingRequestTime(args.asOf ?? args.context?.asOf) };
  return withPgReadSnapshot(opts.pgDriver, pgDriver => searchListingsNodePgInner(args, {...opts, pgDriver}));
}

export async function loadSearchCandidateRows(pgDriver, {candidateColumns, built, reusableCandidates = null}) {
  if (!Array.isArray(reusableCandidates)) {
    return readPgRows(pgDriver, toPostgresSql(`SELECT ${candidateColumns} FROM listings ${built.where} ORDER BY post_id`), built.params, {arrayRows:true});
  }
  // The list and counters have different scopes. Read the exact list IDs first;
  // reuse only matching raw rows and fetch every missing ID in this snapshot.
  const selected = await readPgRows(pgDriver, toPostgresSql(`SELECT post_id FROM listings ${built.where} ORDER BY post_id`), built.params);
  const byId = new Map();
  await runStepsAsync((function* () {
    let visited = 0;
    for (const row of reusableCandidates) {
      byId.set(Number(row.post_id), row);
      if (++visited % 256 === 0) yield;
    }
  })());
  const missing = await runStepsAsync(transformChunks(selected,
    rows => rows.map(row => Number(row.post_id)).filter(id => !byId.has(id))));
  if (missing.length) {
    const fetched = await readPgRows(pgDriver,
      `SELECT ${candidateColumns} FROM listings WHERE post_id = ANY($1::bigint[])`, [missing], {arrayRows:true});
    for (const row of fetched) byId.set(Number(row.post_id), row);
  }
  return runStepsAsync(transformChunks(selected, rows => rows.map(({post_id}) => {
    const row = byId.get(Number(post_id));
    if (!row) throw new Error('PG candidate missing from the request snapshot');
    return row;
  })));
}

async function searchListingsNodePgInner(args = {}, { pgDriver, deps = {}, decorationLoader = null, requestContext = null, reusableCandidates = null } = {}) {
  if (!pgDriver || typeof pgDriver.query !== "function") {
    throw new Error("searchListingsNodePg requires pgDriver");
  }
  const candidateColumns = deps.candidateColumns;
  if (!candidateColumns) {
    throw new Error("searchListingsNodePg requires deps.candidateColumns（用 listingSearchBuildContext()）");
  }

  const exec = (sql, params = [], {batch = false} = {}) => batch
    ? readPgRows(pgDriver, toPostgresSql(sql), params)
    : pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
  // Identity is explicit here; resolveUserId(undefined) consults SQLite.
  const uid = Number(args.userId) || 0;
  const voteUid = args.matchVoteUserId == null ? uid : Number(args.matchVoteUserId) || 0;
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

  // astra §5.5（B4）：request context 由 PG 建立一次（crawlSources／isolation／searchKeys／**asOf**）。
  const context = requestContext || await buildListRequestContextFromPg(exec, { asOf: args.asOf, resolvedSearchKeys: args.searchKeys });
  const settings = args.settings || context.settingsForUser(uid);
  queryDetails.asOf = context.asOf;
  // 可選資料的降級清單（缺表時為非空）——放進 queryDetails 讓它可被量測與告警，不得靜默 ✗。
  queryDetails.contextDegraded = context.degraded || [];
  const built = buildListListingsClauses({
    filter, kind, sources, q: args.q, searchKeys: args.searchKeys,
    districts: args.districts, settings, uid, voteUid,
    context,
    // B3b：filter=watched 不使用行政區子句；其餘先在 PG 算好 closure，再以 id 集合進 builder。
    districtRelatedIds: filter === "watched" ? null : await districtClosureIds(exec, {
      districtNames: resolveListDistrictNames({ districts: args.districts, settings, uid }),
      userId: voteUid,
      relatedOnly: true,
    }),
    // astra 2026-09-25 §2.1：明確表示「這裡沒有 SQLite 可讀」——隔離子句必須來自 context，
    // 缺 context.isolation 時 builder 會直接拋錯，不得靜默降級或偷讀 SQLite。
  }, { sqliteDb: null });
  markStage("prepare_ms");
  // 取「全部」候選：不在這裡 LIMIT，否則 totalMatched 會被候選上限截斷。
  // astra §5.5（B4）：明確候選順序。Node 後處理（同戶角色、配對）會依輸入列順序走訪，
  // 沒有 ORDER BY 時順序由 PG 掃描計畫決定 ⇒ 不可重現。以 post_id 排序固定輸入，
  // 使「同一份資料＋同一組 args＋同一個 asOf」得到同一個結果。
  const raw = await loadSearchCandidateRows(pgDriver, {candidateColumns, built, reusableCandidates});
  markStage("sql_ms");
  queryDetails.candidates = raw.length;
  queryDetails.engine = "node_pg";

  const loader = decorationLoader || createDecorationDataLoader({ exec, driver: "postgres" });
  const [flagMap, provider] = await Promise.all([
    // astra6 §2.2：清單狀態 flags 用**觀看者 uid**（SQLite 參考管線同位置為 loadFlagMap(db, uid)）。
    loader.personalFlagMap(uid),
    // 候選階段：只載入候選篩選／關係判定必需的部分（peers: false ⇒ 略過頁面專用的
    // peers 2-hop 與 groupMembers；astra6 §3 preload 分層）。
    preloadDecorationProviderAsync({
      exec, loader, rows: raw, settings, userId: uid, matchVoteUserId: voteUid, sameHouse, peers: false,
      flagUserId: uid, requestContext: context,
    }),
  ]);
  markStage("preload_ms");

  const rows = await buildListListingsRowsAsync(raw, {
    filter, kind, sources, sort, uid, voteUid, settings,
    districtSet: built.districtSet, provider, flagMap, markStage,
    now: context.now, requireProvider: true,
  });

  const paged = await paginateListListingsRowsAsync(rows, { sort, filter, settings, limit: args.limit, offset: args.offset, now: context.now });
  markStage("sort_ms");
  const fullRows = paged.page.length
    ? await exec(`SELECT * FROM listings WHERE post_id IN (${paged.page.map(() => "?").join(", ")})`, paged.pageIds)
    : [];
  // 頁面層：peers／groupMembers 的唯一消費者 loadSameHousePeers() 只在裝飾路徑被呼叫
  // （db.js:3443，於 decorateListingLite 內）⇒ 只對「這一頁」載入（astra6 §3）。
  // 沿用同一個 loader，重疊 id 由 loader 的 memo 吸收，避免重複查詢。
  const pageProvider = paged.page.length
    ? await preloadDecorationProviderAsync({
      exec, loader, rows: paged.page, settings, userId: uid, matchVoteUserId: voteUid, sameHouse,
      flagUserId: uid, requestContext: context,
    })
    : provider;
  markStage("preload_page_ms");
  const listings = decorateListListingsPage(paged.page, fullRows, {
    settings, uid, voteUid, sameHouse,
    // astra6 §0.2：PG 路徑必須一路帶著 provider，缺了就會 fallback 到 SQLite 裝飾來源 ⇒ 直接拋錯。
    provider: pageProvider, requireProvider: true,
  });
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
