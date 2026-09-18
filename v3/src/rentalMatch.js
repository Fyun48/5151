/** Deterministic rental Match Engine（PR B）。
 * 獨立 domain：不碰 listingScore / sortListingsRows / same-house match.js。
 * 結果可解釋；同樣 input 必須得到同樣 output。
 */

import { randomBytes } from "node:crypto";
import { lookupDistrict, normalizeWatchDistricts } from "./regions.js";
import {
  compatibilityForChoice,
  defaultCatalog,
  listingValuesFromKnownTraits,
  normalizeCatalog,
  resolveWishChoices,
  wishChoicesFromLegacy,
} from "./rentalCatalog.js";
import { listingFormFields } from "./selfListings.js";
import {
  activityBucket,
  activityBucketLabel,
  activityScoreFromSignals,
  mapLegacyLifecycle,
} from "./wishLifecycle.js";
import { fixtureNamespacesCompatible } from "./stage1FixtureIsolation.js";

export const MATCHABLE_WISH_LIFECYCLES = Object.freeze(["active", "needs_confirmation"]);
export const BLOCKED_WISH_LIFECYCLES = Object.freeze(["draft", "paused", "completed", "expired", "blocked"]);
export const MATCHABLE_LISTING_STATUSES = Object.freeze(["open"]);

export const MATCH_PAGE_DEFAULT = 20;
export const MATCH_PAGE_MAX = 50;
export const AGGREGATE_PRIVACY_THRESHOLD = 3;
export const AGGREGATE_MAX_DISTRICTS = 8;
export const AGGREGATE_MAX_CONDITIONS = 8;
export const MATCH_CACHE_TTL_MS = 15_000;
/** 分批掃描大小，不是正確性上限。 */
export const MATCH_CANDIDATE_CHUNK = 400;
export const AGGREGATE_SCAN_CHUNK = 500;
export const ACTIVITY_PRELOAD_CHUNK = 400;
export const MATCH_PAGE_CURSOR_TTL_MS = 15_000;
export const MATCH_SNAPSHOT_MAX = 32;
export const MATCH_SNAPSHOT_ITEMS_MAX = 20_000;
export const MATCH_CURSOR_MAX = 64;
export const OWNER_INTERNAL_SCORE_KEYS = Object.freeze([
  "rank_score", "freshness_score", "activity_score", "wish_id", "last_active_at",
]);

/** 品質權重集中定義，禁止散落 magic numbers。 */
export const MATCH_QUALITY_WEIGHTS = Object.freeze({
  layout: 18,
  area: 12,
  housing_type: 8,
  condition_default: 8,
  condition_by_id: Object.freeze({
    need_pet: 10,
    need_cook: 10,
    need_tax: 10,
    elevator: 10,
    parking_car: 8,
    parking_scooter: 6,
    trash: 6,
    trash24: 6,
    parcel: 6,
    manage: 5,
    short_ok: 6,
    fridge: 5,
    washer: 5,
    ac: 5,
    bed: 4,
    closet: 4,
  }),
});

export const RANK_WEIGHTS = Object.freeze({
  match: 70,
  freshness: 15,
  activity: 15,
});

export const BUDGET_BANDS = Object.freeze([
  { id: "0_15k", label: "15,000 以下", min: 0, max: 15000 },
  { id: "15_20k", label: "15,000–20,000", min: 15000, max: 20000 },
  { id: "20_25k", label: "20,000–25,000", min: 20000, max: 25000 },
  { id: "25_30k", label: "25,000–30,000", min: 25000, max: 30000 },
  { id: "30_40k", label: "30,000–40,000", min: 30000, max: 40000 },
  { id: "40k_plus", label: "40,000 以上", min: 40000, max: 0 },
]);

const MATCH_BANNED_KEYS = Object.freeze([
  "user_id", "email", "phone", "line_url", "contact", "contact_name",
  "author", "location_note", "destination_note", "ip", "replies",
  "last_login_at", "last_active_at", "last_confirmed_at",
]);

export function isMatchingConditionActive(row, categories = []) {
  if (!row || row.enabled === false || row.matching_enabled === false) return false;
  const cat = (categories || []).find((item) => item.id === row.category_id);
  return !cat || cat.enabled !== false;
}

export function matchingConditions(catalog = defaultCatalog()) {
  const normalized = normalizeCatalog(catalog);
  return normalized.conditions.filter((row) => isMatchingConditionActive(row, normalized.categories));
}

export function conditionWeight(conditionId) {
  return MATCH_QUALITY_WEIGHTS.condition_by_id[conditionId] || MATCH_QUALITY_WEIGHTS.condition_default;
}

export function parseJsonValue(raw, fallback) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw || "") || fallback;
  } catch {
    return fallback;
  }
}

export function listingDistrictKey(row = {}) {
  const fields = listingFormFields(row);
  return String(fields.district || "").trim();
}

export function listingRooms(row = {}) {
  const fields = listingFormFields(row);
  if (fields.rooms > 0) return fields.rooms;
  const text = String(row.layout || "");
  const hit = text.match(/(\d+)\s*房/);
  return hit ? Number(hit[1]) : 0;
}

export function listingPing(row = {}) {
  const fields = listingFormFields(row);
  if (fields.ping > 0) return fields.ping;
  return Number(String(row.area_name || "").replace(/坪/g, "")) || 0;
}

export function wishRooms(layout) {
  const id = String(layout || "").trim();
  if (id === "4plus") return 4;
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function listingMatchSnapshot(row = {}, { catalog = defaultCatalog() } = {}) {
  const fields = listingFormFields(row);
  const district = String(fields.district || "").trim();
  const stored = fields.listing_values && typeof fields.listing_values === "object" ? fields.listing_values : {};
  const traits = Array.isArray(fields.traits) ? fields.traits : [];
  const listing_values = Object.keys(stored).length
    ? stored
    : listingValuesFromKnownTraits(traits, catalog);
  const info = district ? lookupDistrict(district) : null;
  return {
    id: Number(row.post_id || row.id) || 0,
    owner_id: Number(row.listed_by_user_id) || 0,
    status: String(row.self_status || row.status || "open"),
    expires_at: row.self_expires_at || row.expires_at || null,
    rent: Number(row.price_num || fields.rent) || 0,
    districts: district ? [district] : [],
    district_labels: info ? [`${info.city}${info.name}`] : [],
    rooms: listingRooms(row),
    ping: listingPing(row),
    housing_type: String(fields.kind || ""),
    layout_text: String(row.layout || fields.layout || ""),
    listing_values,
    source: String(row.source || "self"),
    fixture_namespace: String(row.fixture_namespace || "").trim(),
    updated_at: row.last_seen_at || row.first_seen_at || "",
  };
}

export function wishMatchSnapshot(row = {}, { catalog = defaultCatalog() } = {}) {
  const districts = normalizeWatchDistricts(parseJsonValue(row.districts, []));
  const storedChoices = parseJsonValue(row.condition_choices, {});
  const must = parseJsonValue(row.must_have, []);
  const nice = parseJsonValue(row.nice_to_have, []);
  const avoid = parseJsonValue(row.avoid, []);
  const fromLegacy = wishChoicesFromLegacy(must, nice, avoid).choices;
  const merged = { ...fromLegacy, ...(storedChoices && typeof storedChoices === "object" ? storedChoices : {}) };
  const choices = catalog ? resolveWishChoices(catalog, merged) : merged;
  const labels = districts.map((key) => {
    const info = lookupDistrict(key);
    return info ? `${info.city}${info.name}` : key;
  });
  return {
    id: Number(row.id) || 0,
    public_token: String(row.public_token || ""),
    lifecycle: mapLegacyLifecycle(row),
    status: String(row.status || ""),
    city: String(row.city || ""),
    districts,
    district_labels: labels,
    rent_min: Number(row.rent_min) || 0,
    rent_max: Number(row.rent_max) || 0,
    layout: String(row.layout || ""),
    ping_min: Number(row.ping_min) || 0,
    housing_type: String(row.housing_type || "any"),
    move_in_date: String(row.move_in_date || ""),
    lease_duration: String(row.lease_duration || ""),
    choices,
    last_confirmed_at: row.last_confirmed_at || "",
    last_active_at: row.last_active_at || "",
    updated_at: row.updated_at || row.published_at || row.created_at || "",
    created_at: row.created_at || "",
    published_at: row.published_at || "",
    activity_score: Number(row.activity_score) || 0,
    fixture_namespace: String(row.fixture_namespace || "").trim(),
    body: String(row.body || ""),
  };
}

export function isWishMatchable(wish, now = Date.now()) {
  const lifecycle = wish.lifecycle || mapLegacyLifecycle(wish);
  if (BLOCKED_WISH_LIFECYCLES.includes(lifecycle)) return false;
  if (!MATCHABLE_WISH_LIFECYCLES.includes(lifecycle)) return false;
  if (String(wish.status || "") === "hidden") return false;
  if (String(wish.status || "") === "draft") return false;
  if (String(wish.status || "") === "closed" && lifecycle !== "needs_confirmation") return false;
  void now;
  return true;
}

export function isListingMatchable(listing, now = Date.now()) {
  if (String(listing.source || "self") !== "self") return false;
  if (!MATCHABLE_LISTING_STATUSES.includes(String(listing.status || "open"))) return false;
  const expires = Date.parse(listing.expires_at);
  if (Number.isFinite(expires) && expires <= (now instanceof Date ? now.getTime() : now)) return false;
  return true;
}

/** Only lifecycle/status are normalized. Catalog, district, budget, and conditions stay real. */
export function normalizeWishLifecycleForCounterfactual(wishRow = {}) {
  return {
    ...wishRow,
    lifecycle: "active",
    status: "open",
    closed_reason: "",
  };
}

export function evaluateCounterfactualMatch(listingRow, wishRow, options = {}) {
  const listing = listingMatchSnapshot(listingRow, options);
  const wish = wishMatchSnapshot(normalizeWishLifecycleForCounterfactual(wishRow), options);
  return evaluateMatch(listing, wish, options);
}

export function isCounterfactuallyMatchable(listingRow, wishRow, options = {}) {
  return evaluateCounterfactualMatch(listingRow, wishRow, options).eligible === true;
}

function districtOverlap(listingDistricts, wishDistricts) {
  const listing = (listingDistricts || []).filter(Boolean);
  const wish = (wishDistricts || []).filter(Boolean);
  if (!listing.length || !wish.length) return "unknown";
  return listing.some((key) => wish.includes(key)) ? "compatible" : "conflict";
}

function budgetGate(listingRent, wish) {
  const rent = Number(listingRent) || 0;
  if (rent <= 0) return "unknown";
  const max = Number(wish.rent_max) || 0;
  if (max > 0 && rent > max) return "conflict";
  return "compatible";
}

function layoutQuality(listingRoomsCount, wishLayout) {
  const want = wishRooms(wishLayout);
  const have = Number(listingRoomsCount) || 0;
  if (!want) return "unspecified";
  if (!have) return "unknown";
  if (wishLayout === "4plus") return have >= 4 ? "compatible" : "unmet";
  return have === want ? "compatible" : have > want ? "partial" : "unmet";
}

function areaQuality(listingPingValue, wishPingMin) {
  const want = Number(wishPingMin) || 0;
  const have = Number(listingPingValue) || 0;
  if (!want) return "unspecified";
  if (!have) return "unknown";
  return have + 1e-9 >= want ? "compatible" : "unmet";
}

function housingQuality(listingKind, wishHousing) {
  const want = String(wishHousing || "any");
  if (!want || want === "any") return "unspecified";
  const have = String(listingKind || "");
  if (!have) return "unknown";
  if (want === "elevator") return "unknown";
  return have === want ? "compatible" : "unmet";
}

export function freshnessScoreFrom(wish, now = Date.now()) {
  const stamp = wish.last_confirmed_at || wish.updated_at || wish.published_at || wish.created_at;
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, ((now instanceof Date ? now.getTime() : now) - t) / 86400000);
  return Math.max(0, Math.round((1 - Math.min(ageDays, 30) / 30) * 100));
}

export function activitySignalsFromWish(wish = {}, extras = {}) {
  return activityScoreFromSignals({
    last_confirmed_at: extras.last_confirmed_at || wish.last_confirmed_at,
    wish_edited_at: extras.wish_edited_at || wish.updated_at,
    last_login_at: extras.last_login_at,
    listing_viewed_at: extras.listing_viewed_at,
    watched_at: extras.watched_at,
  }, extras.now || Date.now());
}

function pushConflict(list, code, label) {
  list.push({ code, label });
}

function explanationItem(kind, label, code) {
  return { kind, label, code };
}

export function evaluateMatch(listing, wish, {
  catalog = defaultCatalog(),
  now = Date.now(),
  activity = null,
} = {}) {
  const hard_conflicts = [];
  const matched_conditions = [];
  const unmet_unknowns = [];
  const explanation = [];

  if (!isListingMatchable(listing, now)) {
    pushConflict(hard_conflicts, "listing_status", "刊登目前不是可配對狀態");
  }
  if (!isWishMatchable(wish, now)) {
    pushConflict(hard_conflicts, "lifecycle", "需求目前不可配對");
  }
  if (!fixtureNamespacesCompatible(listing, wish)) {
    pushConflict(hard_conflicts, "fixture_namespace", "測試資料與正式需求不可交叉配對");
  }

  const loc = districtOverlap(listing.districts, wish.districts);
  if (loc === "conflict") pushConflict(hard_conflicts, "district", "行政區不相符");
  else if (loc === "unknown") pushConflict(hard_conflicts, "district_unknown", "行政區資料不足，不能當成符合");
  else {
    matched_conditions.push("district");
    explanation.push(explanationItem("matched", (wish.district_labels || listing.district_labels || []).join("、") || "行政區符合", "district"));
  }

  const budget = budgetGate(listing.rent, wish);
  if (budget === "conflict") pushConflict(hard_conflicts, "budget", "租金超出需求上限");
  else if (budget === "unknown") pushConflict(hard_conflicts, "budget_unknown", "租金資料不足，不能當成符合");
  else {
    matched_conditions.push("budget");
    explanation.push(explanationItem("matched", "租金在預算內", "budget"));
  }

  const conditions = matchingConditions(catalog);
  for (const row of conditions) {
    const action = wish.choices?.[row.id] || "unspecified";
    if (action === "unspecified") continue;
    const listingValue = listing.listing_values?.[row.id] || "unknown";
    const compat = compatibilityForChoice(row, action, listingValue);
    if (compat === "conflict") {
      pushConflict(hard_conflicts, `condition:${row.id}`, `${row.label}不相容`);
    } else if (compat === "compatible") {
      matched_conditions.push(row.id);
      explanation.push(explanationItem("matched", row.label, row.id));
    } else {
      unmet_unknowns.push(row.id);
      explanation.push(explanationItem("unknown", `${row.label}未確認`, row.id));
    }
  }

  const layoutState = layoutQuality(listing.rooms, wish.layout);
  if (layoutState === "compatible" || layoutState === "partial") {
    matched_conditions.push("layout");
    explanation.push(explanationItem("matched", wish.layout === "4plus" ? "4 房以上" : `${wishRooms(wish.layout)} 房`, "layout"));
  } else if (layoutState === "unknown") {
    unmet_unknowns.push("layout");
    explanation.push(explanationItem("unknown", "格局未確認", "layout"));
  } else if (layoutState === "unmet") {
    explanation.push(explanationItem("unmet", "格局尚未符合", "layout"));
  }

  const areaState = areaQuality(listing.ping, wish.ping_min);
  if (areaState === "compatible") {
    matched_conditions.push("area");
    explanation.push(explanationItem("matched", `至少 ${wish.ping_min} 坪`, "area"));
  } else if (areaState === "unknown") {
    unmet_unknowns.push("area");
    explanation.push(explanationItem("unknown", "坪數未確認", "area"));
  } else if (areaState === "unmet") {
    explanation.push(explanationItem("unmet", "坪數尚未符合", "area"));
  }

  const housingState = housingQuality(listing.housing_type, wish.housing_type);
  if (housingState === "compatible") {
    matched_conditions.push("housing_type");
    explanation.push(explanationItem("matched", housingLabel(wish.housing_type), "housing_type"));
  } else if (housingState === "unknown") {
    unmet_unknowns.push("housing_type");
    explanation.push(explanationItem("unknown", "房屋類型未確認", "housing_type"));
  } else if (housingState === "unmet") {
    explanation.push(explanationItem("unmet", "房屋類型尚未符合", "housing_type"));
  }

  const eligible = hard_conflicts.length === 0;
  const match_score = eligible ? qualityScore({
    catalog,
    wish,
    listing,
    layoutState,
    areaState,
    housingState,
    matched_conditions,
    unmet_unknowns,
  }) : 0;

  const scored = activity && Number.isFinite(Number(activity.activity_score))
    ? activity
    : activitySignalsFromWish(wish, { ...(activity || {}), now });
  const activity_score = Number(scored.activity_score) || 0;
  const freshness_score = freshnessScoreFrom(wish, now);
  const rank_score = eligible
    ? Math.round(match_score * RANK_WEIGHTS.match + freshness_score * RANK_WEIGHTS.freshness + activity_score * RANK_WEIGHTS.activity)
    : 0;
  const bucket = scored.activity_bucket || activityBucket(scored.last_active_at || wish.last_active_at, now);

  return {
    eligible,
    hard_conflicts,
    matched_conditions: unique(matched_conditions),
    unmet_unknowns: unique(unmet_unknowns),
    match_score,
    activity_score,
    freshness_score,
    rank_score,
    activity_bucket: bucket,
    activity_label: activityBucketLabel(bucket),
    explanation: eligible ? explanation.filter((item) => item.kind !== "unmet" || true) : [],
    diagnostics: eligible ? undefined : hard_conflicts,
  };
}

function qualityScore({ catalog, wish, listing, layoutState, areaState, housingState, matched_conditions }) {
  let earned = 0;
  let possible = 0;

  if (wishRooms(wish.layout)) {
    possible += MATCH_QUALITY_WEIGHTS.layout;
    if (layoutState === "compatible") earned += MATCH_QUALITY_WEIGHTS.layout;
    else if (layoutState === "partial") earned += Math.round(MATCH_QUALITY_WEIGHTS.layout * 0.6);
  }
  if (Number(wish.ping_min) > 0) {
    possible += MATCH_QUALITY_WEIGHTS.area;
    if (areaState === "compatible") earned += MATCH_QUALITY_WEIGHTS.area;
  }
  if (wish.housing_type && wish.housing_type !== "any") {
    possible += MATCH_QUALITY_WEIGHTS.housing_type;
    if (housingState === "compatible") earned += MATCH_QUALITY_WEIGHTS.housing_type;
  }

  for (const row of matchingConditions(catalog)) {
    const action = wish.choices?.[row.id] || "unspecified";
    if (action === "unspecified") continue;
    const weight = conditionWeight(row.id);
    possible += weight;
    const listingValue = listing.listing_values?.[row.id] || "unknown";
    if (compatibilityForChoice(row, action, listingValue) === "compatible") earned += weight;
  }

  if (possible <= 0) {
    return matched_conditions.includes("district") && matched_conditions.includes("budget") ? 70 : 0;
  }
  return Math.max(0, Math.min(100, Math.round((earned / possible) * 100)));
}

function housingLabel(id) {
  return {
    whole: "整層住家",
    suite: "獨立套房",
    share: "分租套房",
    room: "雅房",
    elevator: "電梯大樓",
    apartment: "公寓",
    other: "其他",
  }[id] || id;
}

function unique(list) {
  return [...new Set(list)];
}

export function compareMatchRank(a, b) {
  const ra = Number(a.rank_score) || 0;
  const rb = Number(b.rank_score) || 0;
  if (ra !== rb) return rb - ra;
  const ma = Number(a.match_score) || 0;
  const mb = Number(b.match_score) || 0;
  if (ma !== mb) return mb - ma;
  const ta = String(a.wish_ref || a.public_token || "");
  const tb = String(b.wish_ref || b.public_token || "");
  if (ta !== tb) return ta.localeCompare(tb);
  return (Number(a.wish_id) || 0) - (Number(b.wish_id) || 0);
}

const matchSnapshots = new Map();
const pageCursors = new Map();

function asTime(now) {
  if (now instanceof Date) return now.getTime();
  const n = Number(now);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function snapshotItemTotal() {
  let n = 0;
  for (const snap of matchSnapshots.values()) n += snap.items.length;
  return n;
}

function evictSnapshot(snapshotId) {
  matchSnapshots.delete(snapshotId);
  for (const [token, row] of pageCursors) {
    if (row.snapshotId === snapshotId) pageCursors.delete(token);
  }
}

function releaseSnapshotIfUnused(snapshotId) {
  for (const row of pageCursors.values()) {
    if (row.snapshotId === snapshotId) return;
  }
  matchSnapshots.delete(snapshotId);
}

function pruneMatchStores(now = Date.now()) {
  const at = asTime(now);
  for (const [id, snap] of matchSnapshots) {
    if (snap.expires <= at) evictSnapshot(id);
  }
  for (const [token, row] of pageCursors) {
    if (row.expires <= at || !matchSnapshots.has(row.snapshotId)) pageCursors.delete(token);
  }
}

function snapshotTooLargeError() {
  const err = new Error("配對結果暫時無法一次載入");
  err.status = 503;
  err.code = "match_snapshot_too_large";
  return err;
}

function evictSnapshotsToFit(extraItems = 0, now = Date.now()) {
  pruneMatchStores(now);
  if (extraItems > MATCH_SNAPSHOT_ITEMS_MAX) throw snapshotTooLargeError();
  while (
    matchSnapshots.size >= MATCH_SNAPSHOT_MAX
    || snapshotItemTotal() + extraItems > MATCH_SNAPSHOT_ITEMS_MAX
  ) {
    const oldest = matchSnapshots.keys().next().value;
    if (!oldest) break;
    evictSnapshot(oldest);
  }
}

function evictCursorsToFit() {
  while (pageCursors.size >= MATCH_CURSOR_MAX) {
    const oldest = pageCursors.keys().next().value;
    if (!oldest) break;
    const row = pageCursors.get(oldest);
    pageCursors.delete(oldest);
    if (row) releaseSnapshotIfUnused(row.snapshotId);
  }
}

function createMatchSnapshot(items, { listingId = "", now = Date.now(), epoch = "" } = {}) {
  const at = asTime(now);
  const source = Array.isArray(items) ? items : [];
  if (source.length > MATCH_SNAPSHOT_ITEMS_MAX) throw snapshotTooLargeError();
  evictSnapshotsToFit(source.length, at);
  const list = source.slice();
  const id = randomBytes(16).toString("base64url");
  matchSnapshots.set(id, {
    listingId: String(listingId || ""),
    items: list,
    epoch: epoch == null ? "" : String(epoch),
    expires: at + MATCH_PAGE_CURSOR_TTL_MS,
  });
  return id;
}

function createMatchCursor(snapshotId, afterIndex, now = Date.now()) {
  const at = asTime(now);
  evictCursorsToFit();
  const token = randomBytes(24).toString("base64url");
  pageCursors.set(token, {
    snapshotId: String(snapshotId || ""),
    afterIndex: Math.max(0, Number(afterIndex) || 0),
    expires: at + MATCH_PAGE_CURSOR_TTL_MS,
  });
  return token;
}

function resolveCursorRow(token, now = Date.now()) {
  const at = asTime(now);
  pruneMatchStores(at);
  const row = pageCursors.get(String(token || ""));
  if (!row) return null;
  const snap = matchSnapshots.get(row.snapshotId);
  if (!snap || snap.expires <= at || row.expires <= at) {
    pageCursors.delete(String(token || ""));
    if (row.snapshotId) releaseSnapshotIfUnused(row.snapshotId);
    return null;
  }
  return {
    token: String(token),
    snapshotId: row.snapshotId,
    listingId: snap.listingId,
    items: snap.items,
    afterIndex: row.afterIndex,
    epoch: snap.epoch,
    expires: Math.min(row.expires, snap.expires),
  };
}

export function clearMatchPageCursors() {
  pageCursors.clear();
  matchSnapshots.clear();
}

export function expireMatchPageCursor(token) {
  const row = pageCursors.get(String(token || ""));
  pageCursors.delete(String(token || ""));
  if (row) releaseSnapshotIfUnused(row.snapshotId);
}

export function inspectMatchCursorPayload(token) {
  try {
    const text = Buffer.from(String(token || ""), "base64url").toString("utf8");
    JSON.parse(text);
    return { reversible_json: true, text };
  } catch {
    return { reversible_json: false };
  }
}

export function inspectMatchCursorState() {
  const arrays = new Set();
  for (const snap of matchSnapshots.values()) arrays.add(snap.items);
  return {
    snapshots: matchSnapshots.size,
    cursors: pageCursors.size,
    item_arrays: arrays.size,
    total_items: snapshotItemTotal(),
  };
}

export function createOpaqueMatchCursor(items, { listingId = "", afterIndex = 0, now = Date.now(), epoch = "" } = {}) {
  const snapshotId = createMatchSnapshot(items, { listingId, now, epoch });
  return createMatchCursor(snapshotId, afterIndex, now);
}

export function readOpaqueMatchCursor(token, now = Date.now()) {
  return resolveCursorRow(token, now);
}

function cursorError(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

function consumeMatchCursor(token, now = Date.now()) {
  const stored = resolveCursorRow(token, now);
  if (!stored) return null;
  pageCursors.delete(String(token));
  return stored;
}

export function applyMatchCursor(rows, cursor, limit, { listingId = "", now = Date.now(), epoch } = {}) {
  const size = clampLimit(limit);
  const at = asTime(now);
  if (cursor) {
    const token = typeof cursor === "string" ? cursor.trim() : "";
    if (!token) throw cursorError("分頁游標不正確", "bad_cursor");
    const stored = consumeMatchCursor(token, at);
    if (!stored) throw cursorError("分頁已過期，請重新查詢", "cursor_expired");
    if (listingId && stored.listingId && String(stored.listingId) !== String(listingId)) {
      releaseSnapshotIfUnused(stored.snapshotId);
      throw cursorError("分頁游標不正確", "bad_cursor");
    }
    if (epoch != null && stored.epoch !== "" && String(stored.epoch) !== String(epoch)) {
      evictSnapshot(stored.snapshotId);
      throw cursorError("分頁已過期，請重新查詢", "cursor_expired");
    }
    const snap = matchSnapshots.get(stored.snapshotId);
    if (snap) snap.expires = at + MATCH_PAGE_CURSOR_TTL_MS;
    const start = stored.afterIndex;
    const items = stored.items.slice(start, start + size);
    const nextIndex = start + items.length;
    const next_cursor = nextIndex < stored.items.length
      ? createMatchCursor(stored.snapshotId, nextIndex, at)
      : "";
    if (!next_cursor) releaseSnapshotIfUnused(stored.snapshotId);
    return { items, total: stored.items.length, next_cursor };
  }
  const list = rows || [];
  if (list.length > MATCH_SNAPSHOT_ITEMS_MAX) throw snapshotTooLargeError();
  const items = list.slice(0, size);
  if (list.length <= items.length) {
    return { items, total: list.length, next_cursor: "" };
  }
  const snapshotId = createMatchSnapshot(list, { listingId, now: at, epoch: epoch == null ? "" : epoch });
  return {
    items,
    total: list.length,
    next_cursor: createMatchCursor(snapshotId, items.length, at),
  };
}

/** 舊可逆 cursor 僅供測試證明已拒絕；不再編碼分數或 numeric id。 */
export function encodeMatchCursor() {
  return createOpaqueMatchCursor([], { afterIndex: 0 });
}

export function decodeMatchCursor(raw) {
  return raw ? readOpaqueMatchCursor(raw) : null;
}

export function clampLimit(value, fallback = MATCH_PAGE_DEFAULT) {
  const n = Math.round(Number(value) || 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MATCH_PAGE_MAX, n);
}

export function budgetBandId(rentMax) {
  const n = Number(rentMax) || 0;
  if (n <= 0) return "unspecified";
  for (const band of BUDGET_BANDS) {
    if (band.max === 0 && n >= band.min) return band.id;
    if (n >= band.min && n < band.max) return band.id;
  }
  return "40k_plus";
}

export function layoutBucket(layout) {
  const id = String(layout || "").trim();
  if (["1", "2", "3", "4plus"].includes(id)) return id;
  return "unspecified";
}

export function normalizeAggregateFilters(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const extraKeys = Object.keys(src).filter((key) => ![
    "district", "districts", "city", "rent_min", "rent_max",
    "layout", "housing_type", "conditions", "condition",
  ].includes(key));
  if (extraKeys.length) {
    const err = new Error("不支援的查詢條件");
    err.status = 400;
    err.code = "aggregate_filter";
    throw err;
  }
  const districts = normalizeWatchDistricts(
    Array.isArray(src.districts) ? src.districts : src.district ? [src.district] : [],
  );
  if (districts.length > AGGREGATE_MAX_DISTRICTS) {
    const err = new Error(`行政區最多 ${AGGREGATE_MAX_DISTRICTS} 個`);
    err.status = 400;
    err.code = "aggregate_filter";
    throw err;
  }
  const conditions = [];
  const rawConditions = Array.isArray(src.conditions) ? src.conditions : src.condition ? [src.condition] : [];
  for (const item of rawConditions) {
    const id = String(item || "").trim();
    if (!id || conditions.includes(id)) continue;
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(id)) {
      const err = new Error("條件代碼不正確");
      err.status = 400;
      err.code = "aggregate_filter";
      throw err;
    }
    conditions.push(id);
  }
  if (conditions.length > AGGREGATE_MAX_CONDITIONS) {
    const err = new Error(`條件最多 ${AGGREGATE_MAX_CONDITIONS} 個`);
    err.status = 400;
    err.code = "aggregate_filter";
    throw err;
  }
  const rentMin = Math.max(0, Math.min(200000, Math.round(Number(src.rent_min) || 0)));
  const rentMax = Math.max(0, Math.min(200000, Math.round(Number(src.rent_max) || 0)));
  if (rentMin && rentMax && rentMin > rentMax) {
    const err = new Error("最低預算不能高於最高預算");
    err.status = 400;
    err.code = "aggregate_filter";
    throw err;
  }
  return {
    districts,
    city: String(src.city || "").trim().slice(0, 40),
    rent_min: rentMin,
    rent_max: rentMax,
    layout: layoutBucket(src.layout) === "unspecified" ? "" : String(src.layout || "").trim(),
    housing_type: String(src.housing_type || "").trim().slice(0, 20),
    conditions,
  };
}

export function suppressSmallGroups(groups, { threshold = AGGREGATE_PRIVACY_THRESHOLD, label = "其他" } = {}) {
  const kept = [];
  let suppressed = 0;
  let suppressedCount = 0;
  for (const row of groups) {
    const count = Number(row.count) || 0;
    if (count > 0 && count < threshold) {
      suppressed += 1;
      suppressedCount += count;
      continue;
    }
    kept.push(row);
  }
  if (suppressedCount > 0 && suppressedCount >= threshold) {
    kept.push({ id: "other", label, count: suppressedCount, suppressed: true });
  }
  return {
    items: kept,
    suppressed_groups: suppressed,
    low_sample: kept.length === 0 && suppressed > 0,
  };
}

export function defaultMatchRulesPublic() {
  return {
    product: "deterministic_v1",
    editable: false,
    hard_gates: [
      "wish lifecycle 必須是 active 或 needs_confirmation（PR A 仍可有限曝光）",
      "paused / completed / expired / blocked / draft 不可新配對",
      "刊登必須是有效的 open 屋主刊登且未過期",
      "行政區需有明確重疊；缺資料排除",
      "租金不可超過許願上限；刊登缺租金排除",
      "matching_enabled 條件的 want/avoid 明確衝突即淘汰",
      "unknown 不當成符合",
    ],
    quality: MATCH_QUALITY_WEIGHTS,
    rank: RANK_WEIGHTS,
    privacy_threshold: AGGREGATE_PRIVACY_THRESHOLD,
    note: "只讀預設規則。不會影響找房排序或同房源判定。",
  };
}

export function assertOwnerSafeMatchView(view) {
  const banned = MATCH_BANNED_KEYS;
  const json = JSON.stringify(view);
  for (const key of banned) {
    if (Object.prototype.hasOwnProperty.call(view, key)) {
      const err = new Error("配對結果含有不該出現的資料");
      err.status = 500;
      throw err;
    }
  }
  for (const key of OWNER_INTERNAL_SCORE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(view, key)) {
      const err = new Error("配對結果含有不該出現的內部分數");
      err.status = 500;
      throw err;
    }
  }
  if (/@example\.com|line\.me|09\d{8}/i.test(json) && /phone|line_url|email/.test(json)) {
    const err = new Error("配對結果含有不該出現的資料");
    err.status = 500;
    throw err;
  }
  return view;
}

export function ownerSafeWishCard(publicWish, match) {
  const view = {
    wish_ref: publicWish.public_token || publicWish.public_ref || "",
    public_path: publicWish.public_path,
    city: publicWish.city,
    districts: publicWish.districts,
    district_labels: publicWish.district_labels,
    rent_min: publicWish.rent_min,
    rent_max: publicWish.rent_max,
    housing_type: publicWish.housing_type,
    housing_label: publicWish.housing_label,
    ping_min: publicWish.ping_min,
    layout: publicWish.layout,
    layout_label: publicWish.layout_label,
    move_in_date: publicWish.move_in_date,
    lease_duration: publicWish.lease_duration,
    lease_label: publicWish.lease_label,
    must_have: publicWish.must_have,
    must_have_labels: publicWish.must_have_labels,
    avoid: publicWish.avoid,
    avoid_labels: publicWish.avoid_labels,
    label_want: publicWish.label_want,
    label_avoid: publicWish.label_avoid,
    activity_bucket: match.activity_bucket,
    activity_label: match.activity_label,
    match_score: match.match_score,
    matched_count: match.matched_conditions.length,
    unmatched_unknown_count: match.unmet_unknowns.length,
    explanation: match.explanation,
    offer_available: false,
    offer_cta: "提供房源（即將推出）",
  };
  return assertOwnerSafeMatchView(view);
}
