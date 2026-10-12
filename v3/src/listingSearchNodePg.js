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
import { loadDistrictPrefilterIds } from "./listingDistrictPrefilter.js";
import { normalizeListQuery } from "./floors.js";
import { createDecorationDataLoader } from "./repository/decorationData.js";
import { toPostgresSql } from "./sqlDialect.js";
import { listingRequestTime } from "./listingRequestTime.js";
import { runStepsAsync, transformChunks } from "./cooperative.js";
import { withPgReadSnapshot, readPgRows } from "./pgReadSnapshot.js";
import { LIST_CANDIDATE_COLUMNS } from "./listingCandidateRow.js";

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
  //
  // 2026-10-11（效能包）：`relatedOnly` 這條原本把 **100,328 個 endpoint** 當成一個
  // `= ANY(?::bigint[])` 參數送進 SQL（repro 實測該查詢 284ms，其中多數是參數協定與
  // 執行計畫的成本）。改成「先取行政區前綴基底列、再在 Node 端與 endpoint 集合取交集」：
  // 語意逐字相同（同一組基底列、同一組 endpoint、同一個交集），但不再搬 10 萬個 bigint。
  const endpointSet = relatedOnly ? new Set(edges.flat()) : null;
  if (relatedOnly && !endpointSet.size) return [];
  // 2026-10-11（第二刀，prepare）：種子述詞**拆成兩條**查詢，語意逐字不變
  // （`A OR B` ＝ 兩邊各自取列後聯集，兩邊都只回 `post_id`，Node 端也是同一個 Set）。
  //
  // 為什麼要拆：`A OR B` 的形狀讓兩顆索引都用不上（`NOT IN` 不可能是索引條件，planner
  // 只能對整個 OR 做 seq scan）。拆開之後：
  //   A `prefix = ANY(allowed)` 走 `idx_listings_district_prefix_pg`（表達式索引）
  //     repro 實測：全表掃描的一部份 → Bitmap Index Scan 16ms。
  //   B `NOT (prefix = ANY(allKeys))` 走 `idx_listings_unknown_district_prefix_pg`
  //     （把 367 個鍵烘進謂詞的**部分索引**）repro 實測：186ms → 4.5ms。
  //   合計 281ms → 約 20ms（不含來回）。索引由
  //   `v3/migrations/004_member_listing_stats_indexes.sql` 建立（Owner 套在正式庫）。
  //
  // 沒有索引時這條路徑**不會變慢**（同一組述詞、同樣兩次掃描；repro 實測與原本的
  // 單一 OR 掃描相當），所以程式與遷移可以分開部署。
  const districtSeeds = await exec(
    `SELECT post_id FROM listings WHERE ${prefix} = ANY(?::text[])`,
    [allowed], {batch:true},
  );
  const unknownPrefixSeeds = await exec(
    `SELECT post_id FROM listings WHERE NOT (${prefix} = ANY(?::text[]))`,
    [allKeys], {batch:true},
  );
  const seedRows = [...districtSeeds, ...unknownPrefixSeeds];
  const seeds = await runStepsAsync(transformChunks(seedRows, rows => rows
    .map(row => Number(row.post_id))
    .filter(id => Boolean(id) && (!endpointSet || endpointSet.has(id)))));

  // (3) 只在「含種子的連通分量」內取全部 id（＝原本 recursive UNION 的遞移閉包語意）。
  //
  // ⚠️ astra6 2026-09-25 §3.2：原版 union-find 沒有 path compression／union-by-size，
  // 在鏈狀輸入下每次 find 都要走完整條鏈（他實測：1,000 節點 → 999,000 次 parent 走訪）。
  // 這裡補上 path compression ＋ union-by-size（迭代版，避免長鏈遞迴爆堆疊）。
  //
  // 2026-10-11（效能包）：repro 實測這一整段在正式站的資料量（74,363 條邊、100,328 個節點）
  // 約 300–450ms，全部是 **Map／物件配置**的成本（Map<number,number> 的 get/set 在 V8 很貴）。
  // 改成「邊壓成 Float64Array ＋ 節點用緊湊索引 ＋ parent/size 用 Int32Array」，
  // 語意（連通分量 ∪ 種子所在的那些分量）逐字不變 —— 見
  // `v3/test/member-district-closure-parity.test.js` 對舊版實作的逐筆比對。
  const edgeCount = edges.length;
  // ⚠️ 邊表**不可以**用 Int32Array：repro 實測 `post_id` 已經超過 2^31-1（例：2,507,462,476），
  // Int32Array 會靜默截斷成負數，閉包結果就會多出一堆不存在的 id（實測 onlyNew=6,362）。
  // 用 Float64Array：post_id 是安全整數（< 2^53），可精確表示。
  // （`parent`／`size` 用的是 0..n-1 的緊湊索引，仍在 Int32 範圍內。）
  const ea = new Float64Array(edgeCount);
  const eb = new Float64Array(edgeCount);
  const nodeIndex = new Map();
  // 先配節點索引：0..n-1 為「有邊的節點」；沒有邊的節點不可能被邊走到，不佔索引。
  for (let i = 0; i < edgeCount; i += 1) {
    const a = edges[i][0];
    const b = edges[i][1];
    if (!nodeIndex.has(a)) nodeIndex.set(a, nodeIndex.size);
    if (!nodeIndex.has(b)) nodeIndex.set(b, nodeIndex.size);
    ea[i] = a;
    eb[i] = b;
  }
  const n = nodeIndex.size;
  const parent = new Int32Array(n);
  const size = new Int32Array(n);
  for (let i = 0; i < n; i += 1) { parent[i] = i; size[i] = 1; }
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // path compression：把路徑上所有節點直接接到 root
    let cur = x;
    while (parent[cur] !== root) { const next = parent[cur]; parent[cur] = root; cur = next; }
    return root;
  };
  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    // union-by-size：小的接到大的，避免鏈化
    if (size[ra] < size[rb]) { const t = ra; ra = rb; rb = t; }
    parent[rb] = ra;
    size[ra] += size[rb];
  };
  for (let i = 0; i < edgeCount; i += 1) union(nodeIndex.get(ea[i]), nodeIndex.get(eb[i]));
  const seedRoots = new Set();
  const ids = new Set();
  await runStepsAsync((function* () {
    let visited = 0;
    for (const id of seeds) {
      const idx = nodeIndex.get(id);
      // 沒有索引＝沒有邊＝不屬於任何分量，只可能是種子本身（不會再被邊走到）。
      if (idx !== undefined) seedRoots.add(find(idx));
      ids.add(id);
      if (++visited % 256 === 0) yield;
    }
  })());
  // 舊版對每條邊跑兩次 `find(a)`／`find(b)`，結果是同一組；邊是無向的，掃一次即可。
  // （74k 次整數運算，不需要讓出事件迴圈；先前版本也沒有在這一段 yield。）
  for (let i = 0; i < edgeCount; i += 1) {
    if (seedRoots.has(find(nodeIndex.get(ea[i])))) { ids.add(ea[i]); ids.add(eb[i]); }
  }
  return [...ids];
}

export async function searchListingsNodePg(args = {}, opts = {}) {
  args = { ...args, ...listingRequestTime(args.asOf ?? args.context?.asOf) };
  return withPgReadSnapshot(opts.pgDriver, pgDriver => searchListingsNodePgInner(args, {...opts, pgDriver}));
}

/**
 * 候選列的順序契約：`post_id` 遞增（見 searchListingsNodePgInner 的「明確候選順序」註解）。
 *
 * astra6 2026-09-25 §5.5 之後這段順序一直是由 **SQL 的 `ORDER BY post_id`** 提供；但 PG 的
 * `work_mem`（正式庫預設 4MB）放不下 17 萬筆排序鍵時會退化成 external merge，把整組資料
 * 溢寫到磁碟：正式庫實測 `temp 118,968 kB`／該段 8,239ms；隔離量測庫同一個查詢 EXPLAIN
 * `read=125,422 → 95,548`、`temp=4,096kB → 0`（去掉 ORDER BY）。
 *
 * Node 端排序同一份 post_id 陣列完全不落地（17 萬個整數約 1.4MB），而且 **順序逐筆相同**
 * ——兩邊都是 post_id 遞增，所以「同一份資料＋同一組 args＋同一個 asOf ⇒ 同一個結果」的
 * 契約不變。`v3/test/member-candidate-order-parity.test.js` 逐筆比對 SQL 排序與 Node 排序。
 */
export function orderCandidateRowsByPostId(rows, columnIndex) {
  if (!Array.isArray(rows) || rows.length < 2) return rows || [];
  const key = Number.isInteger(columnIndex) && columnIndex >= 0
    ? (row) => Number(Array.isArray(row) ? row[columnIndex] : row?.post_id)
    : (row) => Number(row?.post_id);
  return rows.slice().sort((a, b) => (key(a) || 0) - (key(b) || 0));
}

/** `candidateColumns`（逗號分隔）裡 post_id 的位置：arrayRows 模式要靠它取排序鍵。 */
function postIdColumnIndex(candidateColumns) {
  const index = String(candidateColumns || "").split(",").map((part) => part.trim()).indexOf("post_id");
  return index >= 0 ? index : undefined;
}

export async function loadSearchCandidateRows(pgDriver, {candidateColumns, built, reusableCandidates = null}) {
  if (!Array.isArray(reusableCandidates)) {
    const wide = await readPgRows(pgDriver, toPostgresSql(`SELECT ${candidateColumns} FROM listings ${built.where}`), built.params, {arrayRows:true});
    return orderCandidateRowsByPostId(wide, postIdColumnIndex(candidateColumns));
  }
  // The list and counters have different scopes. Read the exact list IDs first;
  // reuse only matching raw rows and fetch every missing ID in this snapshot.
  // 這裡同樣不帶 ORDER BY（見 orderCandidateRowsByPostId）：先取 id 集合、最後再排一次。
  const selected = await orderCandidateRowsByPostId(
    await readPgRows(pgDriver, toPostgresSql(`SELECT post_id FROM listings ${built.where}`), built.params));
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

/**
 * 本請求的「list 範圍」整段準備：行政區名稱 → 投影預篩 → 關係閉包 → builder。
 *
 * 為什麼要抽成公開函式（2026-10-11 第二刀・A 方案）：`computeListingPage` 必須在**掃描之前**
 * 同時拿到 list 與 stats 兩份 WHERE，才能用同一趟掃描
 * `(stats_where) OR (list_where)` ＋ `in_list_scope` 旗標，取代
 * 「stats 掃一次寬候選 → list 再下一次 id-only」的兩趟。
 * 抽出來之後語意完全不變：`searchListingsNodePgInner` 沒有拿到 `scope` 時呼叫的是同一支。
 */
export async function prepareListScope(exec, args = {}, { settings = null, context = null, uid = 0, voteUid = null } = {}) {
  if (!context?.isolation) throw new Error("prepareListScope requires the PG request context（isolation）");
  const userId = Number(uid) || 0;
  const vote = voteUid == null ? userId : Number(voteUid) || 0;
  const { filter, kind, sources } = normalizeListQuery(args.filter, args.kind, args.sources);
  // 行政區名稱（單一來源：與 builder 的 districtSet 同一支解析函式）。
  const districtNames = resolveListDistrictNames({ districts: args.districts, settings, uid: userId });
  // 投影預篩（裁決 §4.1 P1）：用 idx_proj_district 先取 id 集合，取代 `split_part(source_key…)`
  // 的 seq scan。取不到（投影滯後／缺列／關閉）時是 null ⇒ builder 沿用原本表達式。
  const districtPrefilter = filter === "watched"
    ? null
    : await loadDistrictPrefilterIds(exec, { districtNames });
  const built = buildListListingsClauses({
    filter, kind, sources, q: args.q, searchKeys: args.searchKeys,
    districts: args.districts, settings, uid: userId, voteUid: vote,
    context,
    // B3b：filter=watched 不使用行政區子句；其餘先在 PG 算好 closure，再以 id 集合進 builder。
    districtProjectedIds: districtPrefilter ? districtPrefilter.postIds : null,
    districtRelatedIds: filter === "watched" ? null : await districtClosureIds(exec, {
      districtNames,
      userId: vote,
      relatedOnly: true,
    }),
    // astra 2026-09-25 §2.1：明確表示「這裡沒有 SQLite 可讀」——隔離子句必須來自 context，
    // 缺 context.isolation 時 builder 會直接拋錯，不得靜默降級或偷讀 SQLite。
  }, { sqliteDb: null });
  return { filter, kind, sources, districtNames, districtPrefilter, built };
}

async function searchListingsNodePgInner(args = {}, { pgDriver, deps = {}, decorationLoader = null, requestContext = null, reusableCandidates = null, scope = null, candidates = null } = {}) {
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
  // A 方案：呼叫端（`computeListingPage`）已經在**同一趟掃描**裡算好 list 範圍與候選列時，
  // 這裡直接沿用（`scope.built` 逐字等於本函式自己會建出來的那一份），不再自己建、也不再掃。
  const prepared = scope || await prepareListScope(exec, args, { settings, context, uid, voteUid });
  // `prepared.filter/kind/sources` 與上面 `normalizeListQuery(args.filter, args.kind, args.sources)`
  // 是同一支函式、同一組輸入 ⇒ 逐字相同（`prepareListScope` 也用它）。這裡只取 `built`，
  // 並在帶著外部 scope 時斷言三者一致，避免兩份 builder 參數靜默漂移。
  if (scope) {
    // `sources` 是陣列（`parseListingSources`）⇒ 逐值比對，不能用 `!==`。
    if (scope.filter !== filter || scope.kind !== kind
      || JSON.stringify(scope.sources) !== JSON.stringify(sources)) {
      throw new Error("searchListingsNodePg: 外部 list scope 的 filter/kind/sources 與 args 不一致");
    }
  }
  const { built } = prepared;
  markStage("prepare_ms");
  // 取「全部」候選：不在這裡 LIMIT，否則 totalMatched 會被候選上限截斷。
  // astra §5.5（B4）：明確候選順序。Node 後處理（同戶角色、配對）會依輸入列順序走訪，
  // 沒有 ORDER BY 時順序由 PG 掃描計畫決定 ⇒ 不可重現。以 post_id 排序固定輸入，
  // 使「同一份資料＋同一組 args＋同一個 asOf」得到同一個結果。
  const raw = Array.isArray(candidates)
    ? orderCandidateRowsByPostId(candidates, postIdColumnIndex(candidateColumns))
    : await loadSearchCandidateRows(pgDriver, {candidateColumns, built, reusableCandidates});
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
      foldGroups: true, flagUserId: uid, requestContext: context, candidatePhase: true,
    }),
  ]);
  markStage("preload_ms");

  const rows = await buildListListingsRowsAsync(raw, {
    filter, kind, sources, sort, uid, voteUid, settings,
    districtSet: built.districtSet, provider, flagMap, markStage,
    now: context.now, requireProvider: true,
    candidateShape: candidateColumns === LIST_CANDIDATE_COLUMNS,
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
