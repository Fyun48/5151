// Shared SQL-first search statement builder (PostgreSQL hot path).
//
// The SQLite fast paths in db.js and the PostgreSQL listings repository both
// call this module, so the two drivers execute the SAME statement text: parity
// is a property of the code, not of a hand-maintained second copy. Driver
// differences (`?` vs `$n`, IFNULL vs COALESCE) are handled at execution time by
// sqlDialect.js.
//
// Caller-injected dependencies keep this module free of the db.js singleton:
//   resolveUserId / getSettings / searchWhere / listingVisibilityClauses /
//   appendDistrictCandidates / appendPriceCeilingCandidates /
//   memberRegionDistrictNames
// db.js exports them bundled as `listingSearchBuildContext()`.
import {
  commercialCategories,
  effectiveAppearanceCategories,
  elevatorRequired,
  kindsToQuery,
} from "./housingQuery.js";

export const LISTING_SEARCH_SQL_SORTS = ["newest", "price_asc", "price_desc"];

// Display filters mirrored from passesDisplayFilters() (whole-floor / low-floor
// / rooftop / parking). These are precomputed in the projection with the SAME
// helpers, so the SQL-first envelope can honor them instead of rejecting the
// default user settings (excludeLowFloors/excludeRooftop default to true).
export function sqlDisplayFilter(settings = {}) {
  const clauses = [];
  if (settings.excludeLowFloors !== false) clauses.push("p.low_floor = 0");
  if (settings.excludeRooftop !== false) clauses.push("p.rooftop = 0");
  if (settings.hasParking === true) clauses.push("p.parking = 1");
  return clauses.length ? `AND ${clauses.join(" AND ")}` : "";
}

const REQUIRED_DEPS = [
  "resolveUserId",
  "getSettings",
  "searchWhere",
  "listingVisibilityClauses",
  "appendDistrictCandidates",
  "appendPriceCeilingCandidates",
  "memberRegionDistrictNames",
];

export function assertListingSearchDeps(deps = {}) {
  for (const name of REQUIRED_DEPS) {
    if (typeof deps[name] !== "function") {
      throw new Error(`buildListingSearchSql requires deps.${name}`);
    }
  }
  return true;
}

function outOfEnvelope(reason) {
  return { ok: false, reason };
}

// F3：q（關鍵字）下推。逐行鏡射 db.js 的四個比對（title／address／post_id／watch_note），
// 但**包上 lower()**：實測原始 LIKE 在兩邊不同（SQLite 對 ASCII 不分大小寫、PG 分大小寫，
// 6 案中 4 案不一致），改用 lower(x) LIKE lower(?) 後 6 案全部一致（含 CJK 與重音字）。
// 2026-10-10（#694 加速包）：`CAST(post_id AS TEXT) LIKE` 無索引使整個 OR 被迫 Seq Scan
// （evidence/sqlite-exit/perf-index-findings.md §3.1）。純數字 q 改走 `post_id = ?` 精確命中
// （不再 LIKE）；否則只走 title/address（訪客 uid=0 無 watch_note，會員 uid>0 保留 watch_note）。
function appendQueryClauses(query, uid, clauses, params) {
  if (!query) return;
  const trimmed = String(query).trim();
  const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (Number.isSafeInteger(numeric)) {
    clauses.push("post_id = ?");
    params.push(numeric);
    return;
  }
  const like = `%${query}%`;
  const terms = ["lower(title) LIKE lower(?)", "lower(address) LIKE lower(?)"];
  if (Number(uid) > 0) {
    terms.push(`lower(IFNULL((
      SELECT watch_note FROM user_listing_flags f
      WHERE f.post_id = listings.post_id AND f.user_id = ?
    ), '')) LIKE lower(?)`);
  }
  clauses.push(`(${terms.join(" OR ")})`);
  params.push(like, like);
  if (Number(uid) > 0) params.push(uid, like);
}

// kind_keys LIKE '%,key,%'（kind_keys 由 listingKindKeys() 用同一支 listingMatchesKindKey 產生）。
// 等價性證據：v3/scripts/kind-parity-probe.mjs（14 種查詢 × 2,000 列真實資料，mismatch=0）。
function appendKindClauses(kindArg, clauses, params) {
  const like = "p.kind_keys LIKE ?";
  const param = (key) => `%,${key},%`;
  const has = (key) => {
    clauses.push(like);
    params.push(param(key));
  };
  const anyOf = (keys) => {
    clauses.push(`(${keys.map(() => like).join(" OR ")})`);
    for (const key of keys) params.push(param(key));
  };
  const q = kindsToQuery(kindArg);
  if (q.rentalMode === "any" && !q.categories.length && !q.elevatorManual && !q.legacyRental) return;
  if (q.rentalMode === "whole") has("whole");
  if (q.rentalMode === "suite_shared") has("suite_shared");
  if (q.rentalMode === "legacy" && q.legacyRental) has(q.legacyRental);
  const appearance = effectiveAppearanceCategories(q);
  if (appearance.length) anyOf(appearance);
  const commercial = commercialCategories(q);
  if (commercial.length) anyOf(commercial);
  if (elevatorRequired(q)) has("elevator");
}

// Returns `{ ok: false }` when the inputs fall outside the exact-equivalence
// envelope (the caller then uses the Node path, exactly as before).
export function buildListingSearchSql(args = {}, deps = {}) {
  assertListingSearchDeps(deps);
  const {
    filter = "all",
    kind = "",
    sources = "",
    q = "",
    sort = "newest",
    searchKeys,
    districts = [],
    userId,
    settings: settingsOverride,
    matchVoteUserId,
  } = args;

  const allowAllDistricts = args.allowAllDistricts === true;

  if (filter !== "all") return outOfEnvelope("filter");
  // F3 逐項補齊（PR-B）：sources 已在呼叫端經 authorizedListingSources() 驗證與授權
  //（server.js:3759），所以這裡只做集合比對，不會繞過權限。
  const sourceKeys = (Array.isArray(args.sources) ? args.sources : String(args.sources || "").split(/[,|]/))
    .map((item) => String(item || "").trim()).filter(Boolean);
  // ⚠️ 2026-09-24 隔離實測（生產資料、每個案例全新連線）：以下能力雖然「語意等價」，但在現行
  // 查詢結構下會讓 plan 崩掉、count 查詢需 **30,0xx ms** 並被逾時中止：
  //   kind（已關）／sources／areaMax／wholeFloorOnly；baseline 只要 989ms、q 只要 878ms。
  // F2 已移除回退 ⇒ 若維持開啟，會員帶這些設定或晶片的搜尋會變成 503。
  // 因此全部關回外框外，改走 PG-fed Node 路徑（正確、約 1.3 秒）。
  // 待 B6 提供可索引的表達（投影布林欄位／索引）後，再以「等價性 ＋ 效能」兩項一起驗收才開放。
  if (sourceKeys.length) return outOfEnvelope("sources");
  if (kind) return outOfEnvelope("kind");
  if (!LISTING_SEARCH_SQL_SORTS.includes(sort)) return outOfEnvelope("sort");

  const uid = deps.resolveUserId(userId);
  const voteUid = matchVoteUserId == null ? uid : Number(matchVoteUserId) || 0;
  const settings = settingsOverride || deps.getSettings(uid);
  // F3 逐項補齊（PR-B）：areaMax 已下推（語意見 floors.js:412-415：area 為 NULL 時視為通過）。
  // ⚠️ 2026-09-24 隔離實測：areaMax／wholeFloorOnly 在現行查詢結構下 count 需 30,0xx ms（逾時）；
  //   與 kind／sources 一起關回外框外（改走 PG-fed Node）。見上方註解。
  if (
    Number(settings.priceMin) > 0 || Number(settings.priceMax) > 0 ||
    Number(settings.minBuildingFloors) > 0 ||
    Number(settings.areaMax) > 0 ||
    settings.wholeFloorOnly === true ||
    (settings.excludeKeywords || []).length || (settings.excludeAgents || []).length ||
    (settings.excludeAgentIds || []).length || (settings.excludeBoxes || []).length ||
    Number(settings.commuteKm) > 0
  ) {
    return outOfEnvelope("settings");
  }
  const areaMax = Number(settings.areaMax);

  const requestedDistricts = (Array.isArray(districts) ? districts : String(districts || "").split(","))
    .map((name) => String(name || "").trim()).filter(Boolean);
  // Members always search inside their saved regions, so an empty district list expands to
  // memberRegionDistrictNames(). The public/guest surface has no saved regions: an empty list
  // means "all districts", exactly like the Node path (it only applies the district set when
  // the visitor actually picked districts).
  const districtNames = requestedDistricts.length
    ? requestedDistricts
    : (allowAllDistricts ? [] : deps.memberRegionDistrictNames(settings));
  if (!districtNames.length && !allowAllDistricts) return outOfEnvelope("districts");

  const clauses = [];
  const params = [];
  // ✓ B4（裁決 §6.2／§4）：SQL-first 入口必須與 PG 共用**同一個時間戳** ✓
  //（`deps.visibilityContext` 由 `listingSearchBuildContext({ asOf })` 提供 ✓；
  //  未提供時為 null ⇒ `stamp = new Date()` ＝**現況** ✓ ⇒ 既有行為不變 ✓）。
  const visibilityContext = deps.visibilityContext || null;
  deps.searchWhere(searchKeys, clauses, params, visibilityContext);
  deps.listingVisibilityClauses(clauses, params, visibilityContext);
  deps.appendDistrictCandidates(districtNames, clauses, params);
  deps.appendPriceCeilingCandidates(settings, clauses, params);
  if (sourceKeys.length) {
    clauses.push(`p.source IN (${sourceKeys.map(() => "?").join(", ")})`);
    params.push(...sourceKeys);
  }
  if (Number.isFinite(areaMax) && areaMax > 0) {
    // Node 等價（floors.js:412-415）：area 為 NULL 不排除，只有明確大於上限才排除。
    clauses.push("(p.area IS NULL OR p.area <= ?)");
    params.push(areaMax);
  }
  appendKindClauses(kind, clauses, params);
  // wholeFloorOnly 下推。語意依據 db.js:6480 / db.js:7183：
  //   passesDisplayFilters(row, settings, { skipWholeFloor: Boolean(kind) })
  // 只要 kind 有值，Node 就跳過整層過濾（kind 晶片已表達偏好），所以這裡必須用完全一樣的
  // 判斷（Boolean(kind)，不做 trim），否則有選 kind 時會多濾掉 Node 會保留的列。
  // 投影的 displayFilter 只含 low_floor／rooftop，不含整層，所以不會重複套用。
  if (settings.wholeFloorOnly === true && !Boolean(kind)) {
    clauses.push("p.kind_keys LIKE ?");
    params.push("%,whole,%");
  }
  appendQueryClauses(q, uid, clauses, params);
  // filter === "all": confirmed-offline / dup / hidden / watched are excluded.
  clauses.push("NOT (IFNULL(offline, 0) = 1 AND IFNULL(offline_confirmed, 0) = 1)");
  clauses.push("(IFNULL(match_verdict, '') != 'yes')");
  clauses.push(`NOT EXISTS (
    SELECT 1 FROM user_listing_flags f
    WHERE f.post_id = listings.post_id AND f.user_id = ? AND f.hidden = 1
  )`);
  params.push(uid);
  clauses.push(`IFNULL((
    SELECT watched FROM user_listing_flags f
    WHERE f.post_id = listings.post_id AND f.user_id = ?
  ), 0) = 0`);
  params.push(uid);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const cost = settings.priceMaxIncludesExtras === true ? "p.total_monthly_cost" : "p.rent";
  const orderBy =
    sort === "newest" ? "p.updated_at DESC, p.post_id ASC"
      : sort === "price_desc"
        ? `CASE WHEN ${cost} > 0 THEN 0 ELSE 1 END ASC, ${cost} DESC, p.updated_at DESC, p.post_id ASC`
        : `CASE WHEN ${cost} > 0 THEN ${cost} ELSE 9223372036854775807 END ASC, p.updated_at DESC, p.post_id ASC`;

  const districtWhere = districtNames.length
    ? `p.district IN (${districtNames.map(() => "?").join(",")})`
    : "";
  const districtSql = districtWhere ? `AND ${districtWhere}` : "";
  const displayFilter = sqlDisplayFilter(settings);

  // Cursor/keyset pagination. The cursor encodes the full sort key of the last
  // row; DESC columns are negated so one row-value `>` comparison matches the
  // ORDER BY across the ASC/DESC mix.
  const MAX_BIGINT = 9223372036854775807;
  const rowCost = (row) => (settings.priceMaxIncludesExtras === true ? Number(row.total_monthly_cost) : Number(row.rent));
  const sortCostExpr = `CASE WHEN ${cost} > 0 THEN ${cost} ELSE ${MAX_BIGINT} END`;
  const costGroupExpr = `CASE WHEN ${cost} > 0 THEN 0 ELSE 1 END`;
  let tupleExpr = "";
  let cursorOf = null;
  if (sort === "newest") {
    tupleExpr = "(-p.updated_at, p.post_id)";
    cursorOf = (row) => ({ updatedAt: Number(row.updated_at), postId: Number(row.post_id) });
  } else if (sort === "price_asc") {
    tupleExpr = `(${sortCostExpr}, -p.updated_at, p.post_id)`;
    cursorOf = (row) => ({
      sortCost: rowCost(row) > 0 ? rowCost(row) : MAX_BIGINT,
      updatedAt: Number(row.updated_at),
      postId: Number(row.post_id),
    });
  } else { // price_desc
    tupleExpr = `(${costGroupExpr}, -${cost}, -p.updated_at, p.post_id)`;
    cursorOf = (row) => ({
      costGroup: rowCost(row) > 0 ? 0 : 1,
      cost: rowCost(row),
      updatedAt: Number(row.updated_at),
      postId: Number(row.post_id),
    });
  }

  const cursorParamsFor = (cursor) => {
    if (cursor == null) return null;
    if (sort === "newest") return [-Number(cursor.updatedAt), Number(cursor.postId)];
    if (sort === "price_asc") return [Number(cursor.sortCost), -Number(cursor.updatedAt), Number(cursor.postId)];
    return [Number(cursor.costGroup), -Number(cursor.cost), -Number(cursor.updatedAt), Number(cursor.postId)];
  };

  const countQuery = {
    sql: `SELECT COUNT(*) AS n FROM listing_search_projection p
    WHERE p.post_id IN (SELECT post_id FROM listings ${where})
    ${districtSql}
    ${displayFilter}`,
    params: [...params, ...districtNames],
  };

  // Page plan: cursor mode ignores offset (keyset), offset mode ignores the
  // cursor — exactly the behaviour of the existing SQLite fast path.
  const pageQuery = ({ limit = 500, offset = 0, cursor = null } = {}) => {
    const cursorParams = cursorParamsFor(cursor);
    const useCursor = cursorParams != null;
    const pageSize = Math.max(1, Math.min(Number(limit) || 500, 500));
    const start = Math.max(0, Number(offset) || 0);
    const cursorWhere = useCursor ? `AND ${tupleExpr} > (${cursorParams.map(() => "?").join(", ")})` : "";
    const pageParams = useCursor
      ? [...params, ...districtNames, ...cursorParams, pageSize]
      : [...params, ...districtNames, pageSize, start];
    const sql = `SELECT p.post_id, p.updated_at, p.rent, p.total_monthly_cost FROM listing_search_projection p
    WHERE p.post_id IN (SELECT post_id FROM listings ${where})
    ${districtSql}
    ${displayFilter}
    ${cursorWhere}
    ORDER BY ${orderBy}
    LIMIT ?${useCursor ? "" : " OFFSET ?"}`;
    return { sql, params: pageParams, pageSize, start, useCursor };
  };

  return {
    ok: true,
    sort,
    uid,
    voteUid,
    settings,
    districtNames,
    params,
    where,
    cost,
    orderBy,
    districtWhere,
    displayFilter,
    cursorOf,
    countQuery,
    pageQuery,
  };
}

// Guest / public surface (`GET /api/public/listings`). Same statement text and same envelope as
// the member path — the only differences mirror listPublicListings() in db.js:
//   • no logged-in user: the personal flag clauses run with uid 0, which matches no
//     user_listing_flags row (the Node path loads an empty flag map for guests),
//   • an empty district list means "all districts" (guests have no saved regions),
//   • the guest straight-line commute filter is JS-only (it needs the visitor's lat/lng per
//     row), so a query that sets guestCommuteKm with a work point stays out of envelope and
//     falls back to the Node path.
// Returns `{ ok: false }` outside the envelope, exactly like buildListingSearchSql().
export function buildPublicListingSearchSql(args = {}, deps = {}) {
  assertListingSearchDeps(deps);
  const { filter = "all", kind = "", sources = "", q = "", sort = "newest", settings = {} } = args;

  if (filter !== "all") return outOfEnvelope("filter");
  if (kind || sources || q) return outOfEnvelope("kind_or_sources_or_q");
  if (!LISTING_SEARCH_SQL_SORTS.includes(sort)) return outOfEnvelope("sort");

  const guestKm = Number(settings.guestCommuteKm) || 0;
  const guestWorkLat = Number(settings.guestWorkLat);
  const guestWorkLng = Number(settings.guestWorkLng);
  if (guestKm > 0 && Number.isFinite(guestWorkLat) && Number.isFinite(guestWorkLng)) {
    return outOfEnvelope("guest_commute");
  }

  return buildListingSearchSql(
    { ...args, settings, userId: 0, matchVoteUserId: 0, allowAllDistricts: true },
    deps,
  );
}

// 訪客（公開列表）SQL-first 折疊查詢產生器。
//
// 在既有 `buildListingSearchSql` 的基礎上補三個缺口，讓它與 Node 公開路徑逐位元一致：
//   1. searchKeys=[]：訪客路徑 `searchWhere([])`（原先是 searchWhere(undefined) → 展開 28 鍵，
//      少算 2,265 筆）。
//   2. `COALESCE(hidden,0) != 1`：`listingMatchesListFilter("all")` 的 hidden 分支。
//   3. 同屋源次卡（affiliate）折疊：用 fold_role CTE（window function 的 first-incident-edge，
//      見 docs/same-house-fold-spec.md §4）在 SQL 內算 role，再排除 affiliate。
//
// 額外依賴（呼叫端注入）：args.enabledSources（enabled crawl source ids，text[]）、
// args.now（與 Node 路徑同一個 asOf 的時間戳，bigint ms）。
// 回傳與 buildListingSearchSql 同形（ok/countQuery/pageQuery/cursorOf/sort/…）。
export function buildPublicListingsFoldSql(args = {}, deps = {}) {
  assertListingSearchDeps(deps);
  const { filter = "all", kind = "", sources = "", q = "", sort = "newest", settings = {}, districts = [], districtIds = null } = args;
  const enabledSources = Array.isArray(args.enabledSources) ? args.enabledSources : [];
  const now = Number(args.now) || Date.now();

  if (filter !== "all") return outOfEnvelope("filter");
  if (sources) return outOfEnvelope("sources");
  if (!LISTING_SEARCH_SQL_SORTS.includes(sort)) return outOfEnvelope("sort");

  const guestKm = Number(settings.guestCommuteKm) || 0;
  const guestWorkLat = Number(settings.guestWorkLat);
  const guestWorkLng = Number(settings.guestWorkLng);
  if (guestKm > 0 && Number.isFinite(guestWorkLat) && Number.isFinite(guestWorkLng)) {
    return outOfEnvelope("guest_commute");
  }

  // 這些 settings 尚未在 SQL 內鏡射（Node 路徑才有），維持外框外回退 Node。
  if (
    Number(settings.minBuildingFloors) > 0 ||
    (settings.excludeKeywords || []).length || (settings.excludeAgents || []).length ||
    (settings.excludeAgentIds || []).length || (settings.excludeBoxes || []).length ||
    Number(settings.commuteKm) > 0
  ) {
    return outOfEnvelope("settings");
  }

  const clauses = [];
  const params = [];
  const projectionClauses = [];
  const projectionParams = [];

  // 訪客 searchKeys = []（與 buildPublicListingsClauses 的 searchWhere([], …) 一致）。
  deps.searchWhere([], clauses, params, deps.visibilityContext || null);
  deps.listingVisibilityClauses(clauses, params, deps.visibilityContext || null);
  // 行政區：與 buildPublicListingsClauses 一致——用 districtClosureIds 的閉包（post_id = ANY），
  // 而不是 appendDistrictCandidates 的 source_key 前綴。
  if (Array.isArray(districtIds) && districtIds.length) {
    clauses.push("post_id = ANY(?::bigint[])");
    params.push(districtIds);
  }
  // priceMin/priceMax：精確鏡射 passesPriceFilter（用投影 rent/total_monthly_cost），
  // 在「候選層」過濾（applyListingFilter 先於折疊），不是保守的 appendPriceCeilingCandidates。
  const priceMin = Number(settings.priceMin) || 0;
  const priceMax = Number(settings.priceMax) || 0;
  if (priceMin > 0 || priceMax > 0) {
    const includeExtras = settings.priceMaxIncludesExtras === true;
    const costExpr = includeExtras ? "p.total_monthly_cost" : "p.rent";
    const conds = [];
    if (priceMin > 0) { conds.push(`${costExpr} >= ?`); params.push(priceMin); }
    if (priceMax > 0) { conds.push(`${costExpr} <= ?`); params.push(priceMax); }
    clauses.push(`post_id IN (SELECT post_id FROM listing_search_projection p WHERE (${costExpr} <= 0 OR (${conds.join(" AND ")})))`);
  }
  // areaMax：精確鏡射 passesAttributeFilters（area 為 null 不排除），候選層。
  const areaMax = Number(settings.areaMax);
  if (Number.isFinite(areaMax) && areaMax > 0) {
    clauses.push("post_id IN (SELECT post_id FROM listing_search_projection p WHERE (p.area IS NULL OR p.area <= ?))");
    params.push(areaMax);
  }

  // 投影層（p.*）子句：kind／wholeFloor（passesDisplayFilters ／ matchesHousingKind，折疊之後）。
  appendKindClauses(kind, projectionClauses, projectionParams);
  if (settings.wholeFloorOnly === true && !Boolean(kind)) {
    projectionClauses.push("p.kind_keys LIKE ?");
    projectionParams.push("%,whole,%");
  }

  appendQueryClauses(q, 0, clauses, params);

  // filter === "all"：confirmed-offline / dup / hidden 排除（watched 訪客恆 0，不需子句）。
  clauses.push("NOT (IFNULL(offline, 0) = 1 AND IFNULL(offline_confirmed, 0) = 1)");
  clauses.push("(IFNULL(match_verdict, '') != 'yes')");
  clauses.push("COALESCE(hidden, 0) != 1");

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  // fold_role CTE：在候選集（post-where）上算 role。enabledSources/now 是額外參數，
  // 其 `?` 出現在 cand 的 where 之後，故 params 順序為 [...candidate, enabledSources, now]。
  const foldParams = [enabledSources, now];
  const foldCte = foldRoleCte(where);

  const cost = settings.priceMaxIncludesExtras === true ? "p.total_monthly_cost" : "p.rent";
  const orderBy =
    sort === "newest" ? "p.updated_at DESC, p.post_id ASC"
      : sort === "price_desc"
        ? `CASE WHEN ${cost} > 0 THEN 0 ELSE 1 END ASC, ${cost} DESC, p.updated_at DESC, p.post_id ASC`
        : `CASE WHEN ${cost} > 0 THEN ${cost} ELSE 9223372036854775807 END ASC, p.updated_at DESC, p.post_id ASC`;

  const districtWhere = districts.length
    ? `p.district IN (${districts.map(() => "?").join(",")})`
    : "";
  const districtSql = districtWhere ? `AND ${districtWhere}` : "";
  const displayFilter = sqlDisplayFilter(settings);
  const projectionFilter = projectionClauses.length ? `AND ${projectionClauses.join(" AND ")}` : "";

  const affiliateExclusion = `(f.role IS DISTINCT FROM 'affiliate' OR (f.role = 'affiliate' AND f.primary_offline = 1 AND f.offline <> 1))`;

  const countQuery = {
    sql: `${foldCte}
SELECT COUNT(*) AS n FROM listing_search_projection p
JOIN fold_role f ON f.post_id = p.post_id
WHERE ${affiliateExclusion}
${districtSql}
${displayFilter}
${projectionFilter}`,
    params: [...params, ...foldParams, ...districts, ...projectionParams],
  };

  // 全量排序查詢（parity 用，不設 LIMIT）：回傳排序後的 post_id 序列。
  const fullQuery = {
    sql: `${foldCte}
SELECT p.post_id FROM listing_search_projection p
JOIN fold_role f ON f.post_id = p.post_id
WHERE ${affiliateExclusion}
${districtSql}
${displayFilter}
${projectionFilter}
ORDER BY ${orderBy}`,
    params: [...params, ...foldParams, ...districts, ...projectionParams],
  };

  const MAX_BIGINT = 9223372036854775807;
  const rowCost = (row) => (settings.priceMaxIncludesExtras === true ? Number(row.total_monthly_cost) : Number(row.rent));
  const sortCostExpr = `CASE WHEN ${cost} > 0 THEN ${cost} ELSE ${MAX_BIGINT} END`;
  const costGroupExpr = `CASE WHEN ${cost} > 0 THEN 0 ELSE 1 END`;
  let tupleExpr = "";
  let cursorOf = null;
  if (sort === "newest") {
    tupleExpr = "(-p.updated_at, p.post_id)";
    cursorOf = (row) => ({ updatedAt: Number(row.updated_at), postId: Number(row.post_id) });
  } else if (sort === "price_asc") {
    tupleExpr = `(${sortCostExpr}, -p.updated_at, p.post_id)`;
    cursorOf = (row) => ({ sortCost: rowCost(row) > 0 ? rowCost(row) : MAX_BIGINT, updatedAt: Number(row.updated_at), postId: Number(row.post_id) });
  } else {
    tupleExpr = `(${costGroupExpr}, -${cost}, -p.updated_at, p.post_id)`;
    cursorOf = (row) => ({ costGroup: rowCost(row) > 0 ? 0 : 1, cost: rowCost(row), updatedAt: Number(row.updated_at), postId: Number(row.post_id) });
  }
  const cursorParamsFor = (cursor) => {
    if (cursor == null) return null;
    if (sort === "newest") return [-Number(cursor.updatedAt), Number(cursor.postId)];
    if (sort === "price_asc") return [Number(cursor.sortCost), -Number(cursor.updatedAt), Number(cursor.postId)];
    return [Number(cursor.costGroup), -Number(cursor.cost), -Number(cursor.updatedAt), Number(cursor.postId)];
  };

  const pageQuery = ({ limit = 500, offset = 0, cursor = null } = {}) => {
    const cursorParams = cursorParamsFor(cursor);
    const useCursor = cursorParams != null;
    const pageSize = Math.max(1, Math.min(Number(limit) || 500, 500));
    const start = Math.max(0, Number(offset) || 0);
    const cursorWhere = useCursor ? `AND ${tupleExpr} > (${cursorParams.map(() => "?").join(", ")})` : "";
    const pageParams = useCursor
      ? [...params, ...foldParams, ...districts, ...projectionParams, ...cursorParams, pageSize]
      : [...params, ...foldParams, ...districts, ...projectionParams, pageSize, start];
    const sql = `${foldCte}
SELECT p.post_id, p.updated_at, p.rent, p.total_monthly_cost FROM listing_search_projection p
JOIN fold_role f ON f.post_id = p.post_id
WHERE ${affiliateExclusion}
${districtSql}
${displayFilter}
${projectionFilter}
${cursorWhere}
ORDER BY ${orderBy}
LIMIT ?${useCursor ? "" : " OFFSET ?"}`;
    return { sql, params: pageParams, pageSize, start, useCursor };
  };

  // 單趟折疊（2026-10-10 #694 加速包）：fold_role 已標 MATERIALIZED（見 foldRoleCte），
  // 再物化「折疊後 + 投影層過濾」的 matched；count 用 scalar subquery 讀 matched、分頁也讀
  // 同一個 matched ⇒ 折疊只執行一次，count 與分頁共用同一份物化結果（不靠 planner 運氣）。
  // total_count 重複出現在每列；頁內無列（offset 越過結尾）時回傳 0 列 ⇒ total 視為 0。
  const pageWithCountQuery = ({ limit = 500, offset = 0, cursor = null } = {}) => {
    const cursorParams = cursorParamsFor(cursor);
    const useCursor = cursorParams != null;
    const pageSize = Math.max(1, Math.min(Number(limit) || 500, 500));
    const start = Math.max(0, Number(offset) || 0);
    const matchedSql = `${foldCte},
matched AS MATERIALIZED (
  SELECT p.post_id, p.updated_at, p.rent, p.total_monthly_cost
  FROM listing_search_projection p
  JOIN fold_role f ON f.post_id = p.post_id
  WHERE ${affiliateExclusion}
  ${districtSql}
  ${displayFilter}
  ${projectionFilter}
)`;
    // 外層查詢作用在 materialized 的 matched 上（欄位別名 p. → m.）。
    const mOrderBy = orderBy.replace(/p\./g, "m.");
    const mTupleExpr = useCursor ? tupleExpr.replace(/p\./g, "m.") : "";
    const mCursorWhere = useCursor ? `AND ${mTupleExpr} > (${cursorParams.map(() => "?").join(", ")})` : "";
    const pageParams = useCursor
      ? [...params, ...foldParams, ...districts, ...projectionParams, ...cursorParams, pageSize]
      : [...params, ...foldParams, ...districts, ...projectionParams, pageSize, start];
    const sql = `${matchedSql}
SELECT m.post_id, m.updated_at, m.rent, m.total_monthly_cost, (SELECT COUNT(*) FROM matched) AS total_count
FROM matched m
WHERE 1=1 ${mCursorWhere}
ORDER BY ${mOrderBy}
LIMIT ?${useCursor ? "" : " OFFSET ?"}`;
    return { sql, params: pageParams, pageSize, start, useCursor };
  };

  return {
    ok: true,
    sort,
    settings,
    params,
    where,
    foldCte,
    cost,
    orderBy,
    districtWhere,
    displayFilter,
    projectionFilter,
    cursorOf,
    countQuery,
    fullQuery,
    pageQuery,
    pageWithCountQuery,
  };
}

// fold_role CTE：對候選集（cand，其 where 由呼叫端以 `?` 佔位、參數在前面）算 role。
// enabledSources 與 now 各佔一個 `?`（出現在 display CTE），順序排在候選參數之後。
//
// 與讀取端 attachSameHouseRoles（db.js）的三道「不對稱跳過」逐條對應，**不可移除任一**（
// 合成列 fixture `v3/scripts/fold-shape-fixtures.mjs` 對四種邊形各一條斷言，repro 100%＋
// 正式庫唯讀 100% 才算過）：
//   1. 對端 verdict='no' 跳過：`eff` 的 `COALESCE(d.match_verdict,'') <> 'no'`（d=對端）。
//   2. 兩側 display-ready：`eff` 的 `s.display_ready AND d.display_ready`；display_ready 的
//      定義＝`source=ANY(enabled) AND (非 houseprice OR listing_prep.display_ready=1)`，與
//      housepriceNotDisplayReady 的 `decorationSourceEnabled + listingIsDisplayable` 等價。
//   3. 只有入邊（dst 不在候選集）不算：`inc` 的 `dst IN (SELECT post_id FROM cand)`，對應
//      Node 的 `assignRole(byId.get(mid))` 只標記「在同一個 list 裡」的對端。
export function foldRoleCte(candWhere) {
  return `WITH cand AS (
    SELECT post_id, source, source_id, url, last_seen_at, offline, match_post_id, match_verdict,
           fold_rent_num, fold_refresh_kind, fold_refresh_rel_ms, fold_refresh_abs_ms
    FROM listings ${candWhere}
  ),
  extras AS (
    SELECT l.post_id, l.source, l.source_id, l.url, l.last_seen_at, l.offline, l.match_post_id, l.match_verdict,
           l.fold_rent_num, l.fold_refresh_kind, l.fold_refresh_rel_ms, l.fold_refresh_abs_ms
    FROM listings l
    WHERE l.post_id IN (SELECT match_post_id FROM cand WHERE match_post_id IS NOT NULL AND match_post_id > 0 AND COALESCE(match_verdict, '') <> 'no')
      AND l.post_id NOT IN (SELECT post_id FROM cand)
  ),
  display AS (
    SELECT u.*,
      (u.source = ANY(?::text[]) AND (u.source <> 'houseprice' OR COALESCE(p.display_ready, 0) = 1)) AS display_ready,
      (CASE WHEN u.fold_refresh_kind = 1 THEN ?::bigint - u.fold_refresh_rel_ms ELSE u.fold_refresh_abs_ms END) AS refresh_ms,
      (u.source || ':' || COALESCE(NULLIF(u.source_id, ''), NULLIF(u.url, ''), NULLIF(u.post_id, 0)::text, '') || ':' || u.post_id::text) AS tie_key
    FROM (SELECT * FROM cand UNION ALL SELECT * FROM extras) u
    LEFT JOIN listing_prep p ON p.post_id = u.post_id
  ),
  edges AS (
    SELECT d.post_id AS src, d.match_post_id AS dst
    FROM display d
    WHERE d.match_post_id IS NOT NULL AND d.match_post_id > 0 AND COALESCE(d.match_verdict, '') <> 'no'
      AND d.post_id IN (SELECT post_id FROM cand)
  ),
  eff AS (
    SELECT e.src, e.dst
    FROM edges e JOIN display s ON s.post_id = e.src JOIN display d ON d.post_id = e.dst
    WHERE s.display_ready AND d.display_ready AND COALESCE(d.match_verdict, '') <> 'no'
  ),
  inc AS (
    SELECT src AS x, src AS ord, src, dst FROM eff
    UNION ALL
    SELECT dst AS x, src AS ord, src, dst FROM eff WHERE dst IN (SELECT post_id FROM cand)
  ),
  rk AS (
    SELECT x, src, dst, row_number() OVER (PARTITION BY x ORDER BY ord ASC, dst ASC) AS rn FROM inc
  ),
  fe AS (SELECT x, src, dst FROM rk WHERE rn = 1),
  winner AS (
    SELECT fe.x,
      CASE
        WHEN a.fold_rent_num IS NOT NULL AND b.fold_rent_num IS NULL THEN a.post_id
        WHEN b.fold_rent_num IS NOT NULL AND a.fold_rent_num IS NULL THEN b.post_id
        WHEN a.fold_rent_num IS NOT NULL AND b.fold_rent_num IS NOT NULL AND a.fold_rent_num <> b.fold_rent_num
          THEN CASE WHEN a.fold_rent_num < b.fold_rent_num THEN a.post_id ELSE b.post_id END
        WHEN a.refresh_ms <> b.refresh_ms
          THEN CASE WHEN a.refresh_ms > b.refresh_ms THEN a.post_id ELSE b.post_id END
        WHEN COALESCE(b.last_seen_at, '') <> COALESCE(a.last_seen_at, '')
          THEN CASE WHEN COALESCE(b.last_seen_at, '') < COALESCE(a.last_seen_at, '') THEN a.post_id ELSE b.post_id END
        WHEN a.tie_key <> b.tie_key
          THEN CASE WHEN a.tie_key < b.tie_key THEN a.post_id ELSE b.post_id END
        ELSE CASE WHEN a.post_id <= b.post_id THEN a.post_id ELSE b.post_id END
      END AS winner_id,
      a.offline AS a_offline, b.offline AS b_offline,
      fe.src AS src, fe.dst AS dst
    FROM fe
    JOIN display a ON a.post_id = fe.src
    JOIN display b ON b.post_id = fe.dst
  ),
  role AS (
    SELECT w.x AS post_id,
      CASE WHEN w.winner_id = w.x THEN 'primary' ELSE 'affiliate' END AS role,
      CASE WHEN w.winner_id = w.src THEN w.a_offline ELSE w.b_offline END AS primary_offline,
      d.offline AS offline
    FROM winner w
    JOIN display d ON d.post_id = w.x
  ),
  fold_role AS MATERIALIZED (
    SELECT c.post_id, r.role, r.primary_offline, c.offline AS offline
    FROM cand c
    LEFT JOIN role r ON r.post_id = c.post_id
  )`;
}
