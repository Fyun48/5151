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

// F3：kind 篩選下推。結構逐行鏡射 floors.js:matchesHousingKind；每個 has(key) 對應
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
  if (q) return outOfEnvelope("q");
  if (!LISTING_SEARCH_SQL_SORTS.includes(sort)) return outOfEnvelope("sort");

  const uid = deps.resolveUserId(userId);
  const voteUid = matchVoteUserId == null ? uid : Number(matchVoteUserId) || 0;
  const settings = settingsOverride || deps.getSettings(uid);
  // F3 逐項補齊（PR-B）：areaMax 已下推（語意見 floors.js:412-415：area 為 NULL 時視為通過）。
  if (
    Number(settings.priceMin) > 0 || Number(settings.priceMax) > 0 ||
    Number(settings.minBuildingFloors) > 0 ||
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
  deps.searchWhere(searchKeys, clauses, params);
  deps.listingVisibilityClauses(clauses, params);
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
