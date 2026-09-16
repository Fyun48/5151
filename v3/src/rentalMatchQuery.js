/** Owner matching query layer（PR B）。
 * keyset/chunk 掃完整 hard-gated 候選，禁止固定 LIMIT 截斷正確性。
 */

import { lookupDistrict, normalizeWatchDistricts } from "./regions.js";
import {
  expireOpenPosts,
  publicWishRoomView,
  rebuildDemandMatchDistricts,
  ensureDemandMatchDistrictSchema,
} from "./demand.js";
import { isRentalCatalogV2Enabled, isWishOwnerMatchingEnabled } from "./rentalMarketplaceFlags.js";
import { defaultCatalog, normalizeCatalog } from "./rentalCatalog.js";
import {
  expireOpenSelfListings,
  getSelfRow,
} from "./selfListings.js";
import {
  AGGREGATE_PRIVACY_THRESHOLD,
  AGGREGATE_SCAN_CHUNK,
  applyMatchCursor,
  budgetBandId,
  BUDGET_BANDS,
  clampLimit,
  compareMatchRank,
  decodeMatchCursor,
  defaultMatchRulesPublic,
  evaluateMatch,
  isListingMatchable,
  layoutBucket,
  listingMatchSnapshot,
  MATCH_CACHE_TTL_MS,
  MATCH_CANDIDATE_CHUNK,
  MATCHABLE_WISH_LIFECYCLES,
  matchingConditions,
  normalizeAggregateFilters,
  OWNER_INTERNAL_SCORE_KEYS,
  ownerSafeWishCard,
  suppressSmallGroups,
  wishMatchSnapshot,
} from "./rentalMatch.js";

let catalogCache = defaultCatalog();
let flagsCache = {};
const matchCache = new Map();

const ELIGIBLE_LIFE_SQL = "COALESCE(NULLIF(lifecycle, ''), 'active') IN ('active', 'needs_confirmation')";

export function setRentalMatchHydrate(catalog, flags) {
  catalogCache = catalog ? normalizeCatalog(catalog) : defaultCatalog();
  flagsCache = flags || {};
}

export function currentMatchCatalog() {
  return catalogCache || defaultCatalog();
}

export function currentMatchFlags() {
  return flagsCache;
}

export function ensureRentalMatchIndexes(db) {
  ensureDemandMatchDistrictSchema(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_demand_match_open
      ON demand_posts(status, lifecycle, rent_max, id)
      WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_demand_match_lifecycle
      ON demand_posts(lifecycle, status, id);
    CREATE INDEX IF NOT EXISTS idx_demand_match_eligible
      ON demand_posts(rent_max, id)
      WHERE status = 'open'
        AND COALESCE(NULLIF(lifecycle, ''), 'active') IN ('active', 'needs_confirmation');
    CREATE INDEX IF NOT EXISTS idx_listings_self_owner_open
      ON listings(listed_by_user_id, self_status, post_id)
      WHERE COALESCE(source, '591') = 'self';
  `);
  try {
    const indexed = db.prepare("SELECT COUNT(DISTINCT wish_id) AS n FROM demand_match_districts").get()?.n || 0;
    const open = db.prepare("SELECT COUNT(*) AS n FROM demand_posts WHERE status = 'open'").get()?.n || 0;
    if (open && indexed === 0) rebuildDemandMatchDistricts(db);
  } catch { /* isolated tests */ }
}

function httpError(message, status = 400, code = "") {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function assertMatchingEnabled() {
  if (!isWishOwnerMatchingEnabled(flagsCache)) {
    throw httpError("屋主配對尚未開放", 404, "owner_matching_disabled");
  }
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function wishGeneration(db) {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n, MAX(COALESCE(updated_at, published_at, created_at)) AS u
       FROM demand_posts WHERE status = 'open'`,
    ).get();
    return `${Number(row?.n) || 0}:${row?.u || ""}`;
  } catch {
    return "0:";
  }
}

function cacheKey(listing, extra = "", generation = "") {
  const catalog = currentMatchCatalog();
  return [
    listing.id || listing.post_id,
    listing.status,
    listing.rent,
    (listing.districts || []).join(","),
    listing.updated_at || "",
    catalog.version || 0,
    (catalog.conditions || []).length,
    generation,
    extra,
  ].join("|");
}

function readCache(key) {
  const hit = matchCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    matchCache.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(key, value) {
  matchCache.set(key, { value, expires: Date.now() + MATCH_CACHE_TTL_MS });
  if (matchCache.size > 200) {
    const first = matchCache.keys().next().value;
    matchCache.delete(first);
  }
  return value;
}

export function clearRentalMatchCache() {
  matchCache.clear();
}

export function loadOwnedMatchListing(db, postId, userId, now = new Date()) {
  assertMatchingEnabled();
  expireOpenSelfListings(db, now);
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則站內刊登", 404, "listing_not_found");
  if (Number(row.listed_by_user_id) !== Number(userId)) {
    throw httpError("找不到這則站內刊登", 404, "listing_not_found");
  }
  const listing = listingMatchSnapshot(row, { catalog: currentMatchCatalog() });
  if (!isListingMatchable(listing, now)) {
    throw httpError("這則刊登目前不能配對", 409, "listing_not_matchable");
  }
  return { row, listing };
}

const CANDIDATE_COLUMNS = `
  p.id, p.user_id, p.districts, p.city, p.rent_min, p.rent_max, p.layout, p.housing_type,
  p.ping_min, p.must_have, p.nice_to_have, p.avoid, p.condition_choices,
  p.status, p.lifecycle, p.public_token, p.updated_at, p.published_at, p.created_at,
  p.last_confirmed_at, p.last_active_at, p.move_in_date, p.lease_duration, p.includes_management, p.mrt_walk
`;

function candidateSql(listing, { afterId = 0, limit = MATCH_CANDIDATE_CHUNK } = {}) {
  const districts = listing.districts || [];
  const rent = Number(listing.rent) || 0;
  const params = [];
  let sql;
  if (districts.length) {
    const marks = districts.map(() => "?").join(",");
    sql = `
      SELECT ${CANDIDATE_COLUMNS}
      FROM (
        SELECT DISTINCT wish_id
        FROM demand_match_districts
        WHERE district IN (${marks}) AND wish_id > ?
      ) d
      JOIN demand_posts p ON p.id = d.wish_id
      WHERE p.status = 'open'
        AND ${ELIGIBLE_LIFE_SQL.replaceAll("lifecycle", "p.lifecycle")}
        AND p.id > ?
    `;
    params.push(...districts, afterId, afterId);
  } else {
    sql = `
      SELECT ${CANDIDATE_COLUMNS}
      FROM demand_posts p
      WHERE p.status = 'open'
        AND ${ELIGIBLE_LIFE_SQL.replaceAll("lifecycle", "p.lifecycle")}
        AND p.id > ?
    `;
    params.push(afterId);
  }
  if (rent > 0) {
    sql += " AND (p.rent_max = 0 OR p.rent_max >= ?)";
    params.push(rent);
  }
  sql += " ORDER BY p.id ASC LIMIT ?";
  params.push(limit);
  return { sql, params };
}

export function explainMatchCandidatePlan(db, listing) {
  ensureRentalMatchIndexes(db);
  const { sql, params } = candidateSql(listing, { afterId: 0, limit: MATCH_CANDIDATE_CHUNK });
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
}

function queryAllCandidateWishes(db, listing) {
  ensureRentalMatchIndexes(db);
  const rows = [];
  let afterId = 0;
  while (true) {
    const { sql, params } = candidateSql(listing, { afterId, limit: MATCH_CANDIDATE_CHUNK });
    const chunk = db.prepare(sql).all(...params);
    if (!chunk.length) break;
    rows.push(...chunk);
    afterId = Number(chunk[chunk.length - 1].id) || afterId;
    if (chunk.length < MATCH_CANDIDATE_CHUNK) break;
  }
  return rows;
}

function preloadActivityByUser(db, rows, now) {
  const ids = [...new Set(rows.map((row) => Number(row.user_id)).filter(Boolean))];
  const logins = new Map();
  const flags = new Map();
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    try {
      for (const user of db.prepare(`SELECT id, last_login_at FROM users WHERE id IN (${marks})`).all(...ids)) {
        if (user.last_login_at) logins.set(Number(user.id), user.last_login_at);
      }
    } catch { /* last_login_at may be absent */ }
    try {
      for (const flag of db.prepare(`
        SELECT user_id, MAX(viewed_at) AS viewed_at, MAX(watched_at) AS watched_at
        FROM user_listing_flags WHERE user_id IN (${marks})
        GROUP BY user_id
      `).all(...ids)) {
        flags.set(Number(flag.user_id), flag);
      }
    } catch { /* flags table may be absent */ }
  }
  const map = new Map();
  for (const row of rows) {
    const uid = Number(row.user_id);
    const flag = flags.get(uid) || {};
    map.set(uid, {
      last_confirmed_at: row.last_confirmed_at,
      wish_edited_at: row.updated_at,
      last_login_at: logins.get(uid) || "",
      listing_viewed_at: flag.viewed_at || "",
      watched_at: flag.watched_at || "",
      now,
    });
  }
  return map;
}

function decoratePublicWish(row) {
  const districts = normalizeWatchDistricts(parseJsonArray(row.districts));
  const labels = districts.map((key) => {
    const info = lookupDistrict(key);
    return info ? `${info.city}${info.name}` : key;
  });
  const catalog = currentMatchCatalog();
  const condMap = new Map((catalog.conditions || []).map((item) => [item.id, item.label]));
  const must = parseJsonArray(row.must_have);
  const avoid = parseJsonArray(row.avoid);
  const housingLabels = {
    any: "不限",
    whole: "整層住家",
    suite: "獨立套房",
    share: "分租套房",
    room: "雅房",
    elevator: "電梯大樓",
    apartment: "公寓",
    other: "其他",
  };
  const layoutLabels = { "1": "1 房", "2": "2 房", "3": "3 房", "4plus": "4 房以上" };
  return publicWishRoomView({
    id: Number(row.id),
    city: String(row.city || "") || (lookupDistrict(districts[0])?.city || ""),
    districts,
    district_labels: labels,
    rent_min: Number(row.rent_min) || 0,
    rent_max: Number(row.rent_max) || 0,
    includes_management: Number(row.includes_management) === 1,
    housing_type: row.housing_type,
    housing_label: housingLabels[row.housing_type] || row.housing_type,
    ping_min: Number(row.ping_min) || 0,
    layout: row.layout,
    layout_label: layoutLabels[row.layout] || row.layout || "格局不限",
    move_in_date: row.move_in_date,
    lease_duration: row.lease_duration,
    lease_label: row.lease_duration,
    transit_note: "",
    commute_minutes: 0,
    mrt_walk: Number(row.mrt_walk) === 1,
    must_have: must,
    must_have_labels: must.map((id) => condMap.get(id) || id),
    nice_to_have: [],
    nice_to_have_labels: [],
    avoid,
    avoid_labels: avoid.map((id) => condMap.get(id) || id),
    body: "",
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
    public_path: row.public_token ? `/w/${row.public_token}` : "",
    public_token: row.public_token,
    remaining_days: null,
  });
}

function scoreCandidates(listing, rows, activityByUser, catalog, now) {
  const scored = [];
  for (const row of rows) {
    const wish = wishMatchSnapshot(row, { catalog });
    if (!wish.public_token) continue;
    const extras = activityByUser.get(Number(row.user_id)) || {
      last_confirmed_at: row.last_confirmed_at,
      wish_edited_at: row.updated_at,
      now,
    };
    const result = evaluateMatch(listing, wish, {
      catalog,
      now,
      activity: { ...extras, now },
    });
    if (!result.eligible) continue;
    const card = ownerSafeWishCard(decoratePublicWish(row), result);
    scored.push({
      ...card,
      wish_id: wish.id,
      wish_ref: wish.public_token,
      rank_score: result.rank_score,
      match_score: result.match_score,
      freshness_score: result.freshness_score,
      activity_score: result.activity_score,
    });
  }
  scored.sort(compareMatchRank);
  return scored;
}

function snapshotFromScored(listing, scored, now) {
  return {
    listing_id: listing.id,
    total: scored.length,
    generated_at: new Date(now instanceof Date ? now.getTime() : now).toISOString(),
    items: scored,
  };
}

export function computeListingMatches(db, listing, { now = new Date(), rows = null, activityByUser = null } = {}) {
  expireOpenPosts(db, now);
  const generation = wishGeneration(db);
  const key = cacheKey(listing, "matches", generation);
  const cached = readCache(key);
  if (cached) return cached;

  const catalog = currentMatchCatalog();
  const candidates = rows || queryAllCandidateWishes(db, listing);
  const activity = activityByUser || preloadActivityByUser(db, candidates, now);
  const scored = scoreCandidates(listing, candidates, activity, catalog, now);
  return writeCache(key, snapshotFromScored(listing, scored, now));
}

function computeListingMatchesBatch(db, listings, now = new Date()) {
  expireOpenPosts(db, now);
  if (!listings.length) return [];
  const districts = [...new Set(listings.flatMap((row) => row.districts || []))];
  const rents = listings.map((row) => Number(row.rent) || 0).filter((n) => n > 0);
  const probe = {
    districts,
    rent: rents.length ? Math.min(...rents) : 0,
  };
  const rows = queryAllCandidateWishes(db, probe);
  const activityByUser = preloadActivityByUser(db, rows, now);
  return listings.map((listing) => computeListingMatches(db, listing, { now, rows, activityByUser }));
}

export function ownerListingMatchSummary(db, postId, userId, now = new Date()) {
  const { listing } = loadOwnedMatchListing(db, postId, userId, now);
  const snapshot = computeListingMatches(db, listing, { now });
  return {
    listing_id: listing.id,
    enabled: true,
    count: snapshot.total,
    unavailable: false,
    label: snapshot.total
      ? `目前可能符合 ${snapshot.total} 個活躍需求`
      : "目前沒有符合的活躍需求",
    empty: snapshot.total === 0,
  };
}

function ownerPublicMatchItem(row) {
  const safe = { ...row };
  for (const key of OWNER_INTERNAL_SCORE_KEYS) delete safe[key];
  return safe;
}

export function ownerListingMatches(db, postId, userId, { limit, cursor, now = new Date() } = {}) {
  const { listing } = loadOwnedMatchListing(db, postId, userId, now);
  const snapshot = computeListingMatches(db, listing, { now });
  const decoded = decodeMatchCursor(cursor);
  if (cursor && !decoded) throw httpError("分頁游標不正確", 400, "bad_cursor");
  const page = applyMatchCursor(snapshot.items, decoded, limit);
  return {
    listing_id: listing.id,
    total: snapshot.total,
    limit: clampLimit(limit),
    cursor: cursor || "",
    next_cursor: page.next_cursor,
    items: page.items.map(ownerPublicMatchItem),
  };
}

function unavailableSummary(listingId = null) {
  return {
    listing_id: listingId,
    enabled: true,
    count: null,
    unavailable: true,
    empty: false,
    label: "配對暫時無法取得",
  };
}

export function attachOwnerMatchSummaries(db, listings, userId, now = new Date()) {
  if (!isWishOwnerMatchingEnabled(flagsCache)) {
    return (listings || []).map((row) => ({ ...row, match_summary: null }));
  }
  const catalog = currentMatchCatalog();
  const open = [];
  const result = (listings || []).map((row) => {
    if (String(row.status || "") !== "open") {
      return {
        ...row,
        match_summary: {
          count: 0,
          enabled: true,
          unavailable: false,
          empty: true,
          label: "已關閉的刊登不參與配對",
        },
      };
    }
    open.push(row);
    return row;
  });
  try {
    const snaps = open.map((row) => listingMatchSnapshot(row, { catalog }));
    computeListingMatchesBatch(db, snaps, now);
    return result.map((row) => {
      if (String(row.status || "") !== "open") return row;
      try {
        const summary = ownerListingMatchSummary(db, row.post_id, userId, now);
        return { ...row, match_summary: summary };
      } catch {
        return { ...row, match_summary: unavailableSummary(row.post_id) };
      }
    });
  } catch {
    return result.map((row) => (
      String(row.status || "") === "open"
        ? { ...row, match_summary: unavailableSummary(row.post_id) }
        : row
    ));
  }
}

function activeMatchingConditionIds(catalog) {
  return new Set(matchingConditions(catalog).map((row) => row.id));
}

function wishMatchesAggregateFilters(row, filters, catalog) {
  const snap = wishMatchSnapshot(row, { catalog });
  const allowed = activeMatchingConditionIds(catalog);
  if (filters.districts.length) {
    if (!filters.districts.some((key) => snap.districts.includes(key))) return false;
  }
  if (filters.city) {
    const hit = snap.city === filters.city || snap.districts.some((key) => lookupDistrict(key)?.city === filters.city);
    if (!hit) return false;
  }
  if (filters.layout && layoutBucket(snap.layout) !== filters.layout) return false;
  if (filters.housing_type && filters.housing_type !== "any" && snap.housing_type !== filters.housing_type) return false;
  if (filters.rent_min || filters.rent_max) {
    const wishLow = snap.rent_min || 0;
    const wishHigh = snap.rent_max || 200000;
    const filterLow = filters.rent_min || 0;
    const filterHigh = filters.rent_max || 200000;
    if (wishHigh < filterLow || wishLow > filterHigh) return false;
  }
  if (filters.conditions.length) {
    for (const id of filters.conditions) {
      if (!allowed.has(id) || snap.choices?.[id] !== "want") return false;
    }
  }
  return true;
}

function aggregateSql(filters, { afterId = 0, limit = AGGREGATE_SCAN_CHUNK } = {}) {
  const params = [];
  let sql;
  const districts = filters.districts || [];
  if (districts.length) {
    const marks = districts.map(() => "?").join(",");
    sql = `
      SELECT ${CANDIDATE_COLUMNS}
      FROM (
        SELECT DISTINCT wish_id
        FROM demand_match_districts
        WHERE district IN (${marks}) AND wish_id > ?
      ) d
      JOIN demand_posts p ON p.id = d.wish_id
      WHERE p.status = 'open'
        AND ${ELIGIBLE_LIFE_SQL.replaceAll("lifecycle", "p.lifecycle")}
        AND p.id > ?
    `;
    params.push(...districts, afterId, afterId);
  } else {
    sql = `
      SELECT ${CANDIDATE_COLUMNS}
      FROM demand_posts p
      WHERE p.status = 'open'
        AND ${ELIGIBLE_LIFE_SQL.replaceAll("lifecycle", "p.lifecycle")}
        AND p.id > ?
    `;
    params.push(afterId);
  }
  if (filters.layout) {
    sql += " AND p.layout = ?";
    params.push(filters.layout);
  }
  if (filters.housing_type && filters.housing_type !== "any") {
    sql += " AND p.housing_type = ?";
    params.push(filters.housing_type);
  }
  if (filters.rent_min) {
    sql += " AND (p.rent_max = 0 OR p.rent_max >= ?)";
    params.push(filters.rent_min);
  }
  if (filters.rent_max) {
    sql += " AND (p.rent_min = 0 OR p.rent_min <= ?)";
    params.push(filters.rent_max);
  }
  sql += " ORDER BY p.id ASC LIMIT ?";
  params.push(limit);
  return { sql, params };
}

function queryAllAggregateWishes(db, filters) {
  ensureRentalMatchIndexes(db);
  const rows = [];
  let afterId = 0;
  while (true) {
    const { sql, params } = aggregateSql(filters, { afterId, limit: AGGREGATE_SCAN_CHUNK });
    const chunk = db.prepare(sql).all(...params);
    if (!chunk.length) break;
    rows.push(...chunk);
    afterId = Number(chunk[chunk.length - 1].id) || afterId;
    if (chunk.length < AGGREGATE_SCAN_CHUNK) break;
  }
  return rows;
}

export function explainAggregatePlan(db, filters = {}) {
  ensureRentalMatchIndexes(db);
  const { sql, params } = aggregateSql(filters, { afterId: 0, limit: AGGREGATE_SCAN_CHUNK });
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
}

function assertAggregateConditions(filters, catalog) {
  const allowed = activeMatchingConditionIds(catalog);
  for (const id of filters.conditions) {
    if (!allowed.has(id)) {
      throw httpError("條件目前不可用於統計", 400, "aggregate_filter");
    }
  }
}

export function aggregateDemand(db, rawFilters = {}, now = new Date()) {
  assertMatchingEnabled();
  expireOpenPosts(db, now);
  const filters = normalizeAggregateFilters(rawFilters);
  const catalog = currentMatchCatalog();
  assertAggregateConditions(filters, catalog);
  const allowed = activeMatchingConditionIds(catalog);
  const rows = queryAllAggregateWishes(db, filters).filter((row) => (
    wishMatchesAggregateFilters(row, filters, catalog)
  ));

  const total = rows.length;
  if (total < AGGREGATE_PRIVACY_THRESHOLD) {
    return {
      enabled: true,
      total: 0,
      suppressed: true,
      message: "需求樣本不足",
      privacy_threshold: AGGREGATE_PRIVACY_THRESHOLD,
      districts: [],
      budget_bands: [],
      layouts: [],
      conditions: [],
    };
  }

  const districtMap = new Map();
  const bandMap = new Map();
  const layoutMap = new Map();
  const conditionMap = new Map();

  for (const row of rows) {
    const snap = wishMatchSnapshot(row, { catalog });
    for (const key of snap.districts) {
      const info = lookupDistrict(key);
      const label = info ? `${info.city}${info.name}` : key;
      const cur = districtMap.get(key) || { id: key, label, count: 0 };
      cur.count += 1;
      districtMap.set(key, cur);
    }
    const band = budgetBandId(snap.rent_max);
    const bandMeta = BUDGET_BANDS.find((item) => item.id === band);
    const bandCur = bandMap.get(band) || { id: band, label: bandMeta?.label || "未填預算", count: 0 };
    bandCur.count += 1;
    bandMap.set(band, bandCur);
    const layout = layoutBucket(snap.layout);
    const layoutCur = layoutMap.get(layout) || {
      id: layout,
      label: layout === "unspecified" ? "未指定格局" : layout === "4plus" ? "4 房以上" : `${layout} 房`,
      count: 0,
    };
    layoutCur.count += 1;
    layoutMap.set(layout, layoutCur);
    for (const [id, action] of Object.entries(snap.choices || {})) {
      if (action !== "want" || !allowed.has(id)) continue;
      const cond = matchingConditions(catalog).find((item) => item.id === id);
      const cur = conditionMap.get(id) || { id, label: cond?.label || id, count: 0 };
      cur.count += 1;
      conditionMap.set(id, cur);
    }
  }

  const districts = suppressSmallGroups([...districtMap.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)));
  const budget = suppressSmallGroups([...bandMap.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)));
  const layouts = suppressSmallGroups([...layoutMap.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)));
  const conditions = suppressSmallGroups([...conditionMap.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)));

  return {
    enabled: true,
    total,
    suppressed: false,
    message: "",
    privacy_threshold: AGGREGATE_PRIVACY_THRESHOLD,
    districts: districts.items,
    budget_bands: budget.items,
    layouts: layouts.items,
    conditions: conditions.items,
    low_sample: districts.low_sample,
  };
}

export function homepageDemandExposure(db, now = new Date()) {
  if (!isWishOwnerMatchingEnabled(flagsCache)) {
    return { enabled: false, districts: [] };
  }
  const agg = aggregateDemand(db, {}, now);
  return {
    enabled: true,
    suppressed: agg.suppressed,
    message: agg.suppressed ? agg.message : "",
    districts: (agg.districts || []).slice(0, 6),
  };
}

export function matchRulesForAdmin() {
  return {
    ...defaultMatchRulesPublic(),
    catalog_version: currentMatchCatalog().version || 1,
    catalog_on: isRentalCatalogV2Enabled(flagsCache),
    owner_matching_on: isWishOwnerMatchingEnabled(flagsCache),
  };
}

export function ownerMatchingMeta() {
  return {
    enabled: isWishOwnerMatchingEnabled(flagsCache),
    catalog_v2: isRentalCatalogV2Enabled(flagsCache),
    privacy_threshold: AGGREGATE_PRIVACY_THRESHOLD,
  };
}
