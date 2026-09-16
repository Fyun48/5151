/** Owner matching query layer（PR B）。
 * 先用 hard gate SQL 縮候選，再對小集合計品質。禁止全表 N×M。
 */

import { lookupDistrict, normalizeWatchDistricts } from "./regions.js";
import {
  collectWishActivitySignals,
  expireOpenPosts,
  publicWishRoomView,
} from "./demand.js";
import { isRentalCatalogV2Enabled, isWishOwnerMatchingEnabled } from "./rentalMarketplaceFlags.js";
import { defaultCatalog, normalizeCatalog } from "./rentalCatalog.js";
import {
  expireOpenSelfListings,
  getSelfRow,
} from "./selfListings.js";
import {
  AGGREGATE_PRIVACY_THRESHOLD,
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
  MATCHABLE_WISH_LIFECYCLES,
  normalizeAggregateFilters,
  ownerSafeWishCard,
  suppressSmallGroups,
  wishMatchSnapshot,
} from "./rentalMatch.js";
import { mapLegacyLifecycle } from "./wishLifecycle.js";

let catalogCache = defaultCatalog();
let flagsCache = {};
const matchCache = new Map();

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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_demand_match_open
      ON demand_posts(status, lifecycle, rent_max, id)
      WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_demand_match_lifecycle
      ON demand_posts(lifecycle, status, id);
    CREATE INDEX IF NOT EXISTS idx_listings_self_owner_open
      ON listings(listed_by_user_id, self_status, post_id)
      WHERE COALESCE(source, '591') = 'self';
  `);
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

function candidateSql(listing) {
  const districts = listing.districts || [];
  const rent = Number(listing.rent) || 0;
  const params = [];
  const lifeList = MATCHABLE_WISH_LIFECYCLES.map(() => "?").join(",");
  params.push(...MATCHABLE_WISH_LIFECYCLES);
  let sql = `
    SELECT * FROM demand_posts
    WHERE status = 'open'
      AND COALESCE(NULLIF(lifecycle, ''), 'active') IN (${lifeList})
  `;
  if (rent > 0) {
    sql += " AND (rent_max = 0 OR rent_max >= ?)";
    params.push(rent);
  }
  if (districts.length) {
    const likes = districts.map(() => "districts LIKE ?").join(" OR ");
    sql += ` AND (${likes})`;
    for (const key of districts) {
      params.push(`%"${key}"%`);
    }
  }
  sql += " ORDER BY id ASC LIMIT 800";
  return { sql, params };
}

export function explainMatchCandidatePlan(db, listing) {
  const { sql, params } = candidateSql(listing);
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
}

function queryCandidateWishes(db, listing) {
  const { sql, params } = candidateSql(listing);
  return db.prepare(sql).all(...params);
}

function activityForWish(db, row, now) {
  const extras = collectWishActivitySignals(db, row.user_id, row);
  extras.now = now;
  return extras;
}

function decoratePublicWish(row) {
  const districts = normalizeWatchDistricts(parseJsonArray(row.districts));
  const labels = districts.map((key) => {
    const info = lookupDistrict(key);
    return info ? `${info.city}${info.name}` : key;
  });
  const must = parseJsonArray(row.must_have);
  const avoid = parseJsonArray(row.avoid);
  return publicWishRoomView({
    id: Number(row.id),
    city: String(row.city || "") || (lookupDistrict(districts[0])?.city || ""),
    districts,
    district_labels: labels,
    rent_min: Number(row.rent_min) || 0,
    rent_max: Number(row.rent_max) || 0,
    includes_management: Number(row.includes_management) === 1,
    housing_type: row.housing_type,
    housing_label: row.housing_type,
    ping_min: Number(row.ping_min) || 0,
    layout: row.layout,
    layout_label: row.layout,
    move_in_date: row.move_in_date,
    lease_duration: row.lease_duration,
    lease_label: row.lease_duration,
    transit_note: "",
    commute_minutes: 0,
    mrt_walk: Number(row.mrt_walk) === 1,
    must_have: must,
    must_have_labels: must,
    nice_to_have: [],
    nice_to_have_labels: [],
    avoid,
    avoid_labels: avoid,
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

export function computeListingMatches(db, listing, { now = new Date() } = {}) {
  expireOpenPosts(db, now);
  const generation = wishGeneration(db);
  const key = cacheKey(listing, "matches", generation);
  const cached = readCache(key);
  if (cached) return cached;

  const catalog = currentMatchCatalog();
  const rows = queryCandidateWishes(db, listing);
  const scored = [];
  for (const row of rows) {
    const fresh = db.prepare("SELECT lifecycle, status, public_token, updated_at FROM demand_posts WHERE id = ?").get(row.id);
    if (!fresh) continue;
    const wish = wishMatchSnapshot({ ...row, ...fresh }, { catalog });
    if (!wish.public_token) continue;
    const extras = activityForWish(db, { ...row, ...fresh }, now);
    const result = evaluateMatch(listing, wish, {
      catalog,
      now,
      activity: {
        last_confirmed_at: extras.last_confirmed_at || wish.last_confirmed_at,
        wish_edited_at: extras.wish_edited_at || wish.updated_at,
        now,
      },
    });
    if (!result.eligible) continue;
    const publicWish = decoratePublicWish({ ...row, ...fresh });
    const card = ownerSafeWishCard(publicWish, result);
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
  const snapshot = {
    listing_id: listing.id,
    total: scored.length,
    generated_at: new Date(now instanceof Date ? now.getTime() : now).toISOString(),
    items: scored,
  };
  return writeCache(key, snapshot);
}

export function ownerListingMatchSummary(db, postId, userId, now = new Date()) {
  const { listing } = loadOwnedMatchListing(db, postId, userId, now);
  const snapshot = computeListingMatches(db, listing, { now });
  return {
    listing_id: listing.id,
    enabled: true,
    count: snapshot.total,
    label: snapshot.total
      ? `目前可能符合 ${snapshot.total} 個活躍需求`
      : "目前沒有符合的活躍需求",
    empty: snapshot.total === 0,
  };
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
    items: page.items.map((row) => {
      const { wish_id, activity_score, ...safe } = row;
      void wish_id;
      void activity_score;
      return safe;
    }),
  };
}

export function attachOwnerMatchSummaries(db, listings, userId, now = new Date()) {
  if (!isWishOwnerMatchingEnabled(flagsCache)) {
    return (listings || []).map((row) => ({ ...row, match_summary: null }));
  }
  return (listings || []).map((row) => {
    if (String(row.status || "") !== "open") {
      return { ...row, match_summary: { count: 0, enabled: true, empty: true, label: "已關閉的刊登不參與配對" } };
    }
    try {
      const summary = ownerListingMatchSummary(db, row.post_id, userId, now);
      return { ...row, match_summary: summary };
    } catch {
      return { ...row, match_summary: { count: 0, enabled: true, empty: true, label: "目前沒有符合的活躍需求" } };
    }
  });
}

function wishMatchesAggregateFilters(row, filters, catalog) {
  const snap = wishMatchSnapshot(row, { catalog });
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
      if (snap.choices?.[id] !== "want") return false;
    }
  }
  return true;
}

function queryAggregateWishes(db) {
  return db.prepare(`
    SELECT id, user_id, districts, city, rent_min, rent_max, layout, housing_type,
           ping_min, must_have, nice_to_have, avoid, condition_choices,
           status, lifecycle, public_token, updated_at, published_at, created_at
    FROM demand_posts
    WHERE status = 'open'
      AND COALESCE(NULLIF(lifecycle, ''), 'active') IN ('active', 'needs_confirmation')
    ORDER BY id ASC
    LIMIT 2000
  `).all();
}

export function explainAggregatePlan(db) {
  return db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id FROM demand_posts
    WHERE status = 'open'
      AND COALESCE(NULLIF(lifecycle, ''), 'active') IN ('active', 'needs_confirmation')
    ORDER BY id ASC
    LIMIT 2000
  `).all();
}

export function aggregateDemand(db, rawFilters = {}, now = new Date()) {
  assertMatchingEnabled();
  expireOpenPosts(db, now);
  const filters = normalizeAggregateFilters(rawFilters);
  const catalog = currentMatchCatalog();
  const rows = queryAggregateWishes(db).filter((row) => {
    const fresh = db.prepare("SELECT lifecycle, status FROM demand_posts WHERE id = ?").get(row.id);
    if (!fresh) return false;
    const lifecycle = mapLegacyLifecycle(fresh);
    if (!MATCHABLE_WISH_LIFECYCLES.includes(lifecycle)) return false;
    return wishMatchesAggregateFilters({ ...row, ...fresh }, filters, catalog);
  });

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
      if (action !== "want") continue;
      const cond = (catalog.conditions || []).find((item) => item.id === id);
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

