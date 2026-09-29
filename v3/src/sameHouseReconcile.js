/** Same-house reconciliation after ingest / enrichment.
 * Candidate blocking first, then score. Never O(N²) full-table compare.
 */

import { districtNameFromListing } from "./regions.js";
import {
  areaNum,
  evaluateMatch,
  floorMain,
  geoDistanceM,
  houseNumber,
  layoutRooms,
  MATCHER_VERSION,
  MATCH_GEO_MAX_METERS,
  streetKey,
} from "./match.js";
import {
  CONFIRM_ADMIN,
  CONFIRM_AUTO,
  CONFIRM_SUSPECTED,
  groupIdForPost,
  isTrustedGroup,
  postConfirmationLevel,
  recordMatchEvaluation,
} from "./listingGroups.js";
import { sqlExcludeFixtureRows } from "./stage1FixtureIsolation.js";

export const RECONCILE_BATCH = 50;
export const RECONCILE_CANDIDATE_LIMIT = 80;
export const BACKFILL_SETTING_KEY = "sameHouseBackfillCursor";
// 同屋判定的地理容差（度）。原本寫成 ABS(lat - ?) < GEO_TOLERANCE，改寫為嚴格不等式以便走索引，
// 數值必須保持 0.002 不得變動，否則塊配對結果會改變。
export const GEO_TOLERANCE = 0.002;

export function listingNeedsReconcile(db, listing) {
  if (!listing || !Number(listing.post_id)) return false;
  if (postConfirmationLevel(db, listing.post_id) === CONFIRM_ADMIN) return false;
  if (isTrustedGroup(db, listing.post_id) && String(listing.match_level || "") === "high") {
    return false;
  }
  return hasReconcileEvidence(listing);
}

export function hasReconcileEvidence(listing) {
  if (!listing) return false;
  const street = streetKey(listing.address);
  const house = houseNumber(listing.address);
  const community = String(listing.community_name || "").replace(/\s+/g, "");
  const floor = floorMain(listing.floor_name);
  const area = areaNum(listing.area_name);
  const rooms = layoutRooms(listing.layout);
  const lat = Number(listing.lat);
  const lng = Number(listing.lng);
  const geo = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  return Boolean(street && house) || Boolean(community && floor) || Boolean(geo && floor && area) || Boolean(street && floor && area && rooms);
}

export function significantListingUpdate(before, after) {
  if (!before || !after) return false;
  const fields = [
    "address",
    "community_name",
    "community_id",
    "floor_name",
    "area_name",
    "layout",
    "lat",
    "lng",
    "mobile",
    "phone",
    "contact_uid",
    "cover",
  ];
  return fields.some((key) => {
    const prev = before[key];
    const next = after[key];
    if (next == null || next === "" || next === 0) return false;
    return String(next) !== String(prev ?? "");
  });
}

function likeDistrict(listing) {
  return String(districtNameFromListing(listing) || "").replace(/區$/, "");
}

// The blocking query and the row filter are separate, exported pieces so the PostgreSQL path
// (repository/listingReads.js) runs the SAME statement text and the SAME post-filter - the
// crawl's same-house matching must not differ between drivers.
// `fixtureColumn` 讓 PG 分支覆寫「這個 driver 的 listings 有沒有 fixture_namespace」：
// 同步版用 PRAGMA 偵測（sqlExcludeFixtureRows），PG 分支用 information_schema 偵測後傳進來。
// 未指定時維持原本的同步偵測行為。
export function blockMatchCandidatesQuery(sqliteDb, incoming, { limit = RECONCILE_CANDIDATE_LIMIT, fixtureColumn } = {}) {
  const pid = Number(incoming?.post_id) || 0;
  const street = streetKey(incoming?.address);
  const community = String(incoming?.community_name || "").trim();
  const district = likeDistrict(incoming);
  const lat = Number(incoming?.lat);
  const lng = Number(incoming?.lng);
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  if (!street && !community && !hasGeo) return { sql: null, params: [] };

  const clauses = ["post_id != ?"];
  const params = [pid];
  const blocks = [];
  if (street) {
    blocks.push("(replace(replace(IFNULL(address, ''), ' ', ''), '-', '') LIKE '%' || ? || '%')");
    params.push(street);
  }
  if (community) {
    blocks.push("(replace(IFNULL(community_name, ''), ' ', '') = ?)");
    params.push(community.replace(/\s+/g, ""));
  }
  if (hasGeo) {
    // 2026-09-26: `ABS(lat - ?) < 0.002` 是對欄位做運算，PostgreSQL 無法用 btree 索引，
    // 整個 OR 因此退化成 127k 筆全表掃描（實測 ~300ms/次），把 crawler 週期卡死。
    // 改寫成等價的嚴格不等式後可走 (lat, lng) 索引。
    // 等價性：ABS(lat - L) < T  ⟺  L - T < lat < L + T（兩邊皆嚴格，邊界行為一致）。
    blocks.push("(lat IS NOT NULL AND lng IS NOT NULL AND lat > ? AND lat < ? AND lng > ? AND lng < ?)");
    params.push(lat - GEO_TOLERANCE, lat + GEO_TOLERANCE, lng - GEO_TOLERANCE, lng + GEO_TOLERANCE);
  }
  clauses.push(`(${blocks.join(" OR ")})`);
  const isolation = fixtureColumn === undefined
    ? sqlExcludeFixtureRows(sqliteDb, "listings")
    : (fixtureColumn
      ? { sql: "(fixture_namespace IS NULL OR fixture_namespace = '')", params: [] }
      : { sql: "1=1", params: [] });
  clauses.push(isolation.sql);
  params.push(...isolation.params);
  if (district) {
    clauses.push("(IFNULL(address, '') LIKE '%' || ? || '%')");
    params.push(district);
  }

  const cap = Math.max(1, Math.min(Number(limit) || RECONCILE_CANDIDATE_LIMIT, 200));
  return {
    sql: `SELECT * FROM listings
       WHERE ${clauses.join(" AND ")}
       ORDER BY IFNULL(offline, 0) DESC, last_seen_at DESC
       LIMIT ${cap}`,
    params,
  };
}

export function filterBlockMatchRows(incoming, rows) {
  const floor = floorMain(incoming?.floor_name);
  const area = areaNum(incoming?.area_name);
  const rooms = layoutRooms(incoming?.layout);
  const lat = Number(incoming?.lat);
  const lng = Number(incoming?.lng);
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  return (rows || []).filter((row) => {
    if (floor && floorMain(row.floor_name) && floorMain(row.floor_name) !== floor) return false;
    const otherArea = areaNum(row.area_name);
    if (area != null && otherArea != null && Math.abs(area - otherArea) > 3) return false;
    const otherRooms = layoutRooms(row.layout);
    if (rooms != null && otherRooms != null && rooms !== otherRooms) return false;
    if (hasGeo) {
      const meters = geoDistanceM(incoming, row);
      if (meters != null && meters > MATCH_GEO_MAX_METERS * 2) return false;
    }
    return true;
  });
}

export function blockMatchCandidates(db, incoming, { limit = RECONCILE_CANDIDATE_LIMIT } = {}) {
  const { sql, params } = blockMatchCandidatesQuery(db, incoming, { limit });
  if (!sql) return [];
  let rows = [];
  try {
    rows = db.prepare(sql).all(...params);
  } catch {
    return [];
  }
  return filterBlockMatchRows(incoming, rows);
}

export function evaluateBlockedMatches(incoming, candidates, { now = new Date() } = {}) {
  const evaluations = [];
  let best = null;
  for (const previous of candidates || []) {
    const evaluation = {
      ...evaluateMatch(incoming, previous, { now }),
      listing: previous,
    };
    if (evaluation.hit) evaluation.hit = { ...evaluation.hit, listing: previous };
    evaluations.push(evaluation);
    if (!evaluation.hit) continue;
    if (!best || (evaluation.confidence || 0) > (best.confidence || 0)) {
      best = evaluation;
    }
    if (evaluation.level === "high") {
      best = evaluation;
      break;
    }
  }
  return { best, evaluations };
}

export function evaluateListingReconciliation(db, listing, { now = new Date(), limit } = {}) {
  if (!listing || !Number(listing.post_id)) {
    return { skipped: true, reason: "missing", evaluations: [] };
  }
  if (postConfirmationLevel(db, listing.post_id) === CONFIRM_ADMIN) {
    return { skipped: true, reason: "admin_confirmed", evaluations: [] };
  }
  if (isTrustedGroup(db, listing.post_id) && String(listing.match_level || "") === "high") {
    return { skipped: true, reason: "auto_confirmed", evaluations: [] };
  }
  if (!hasReconcileEvidence(listing)) {
    return { skipped: true, reason: "insufficient_evidence", evaluations: [] };
  }
  const candidates = blockMatchCandidates(db, listing, { limit });
  const { best, evaluations } = evaluateBlockedMatches(listing, candidates, { now });
  for (const evaluation of evaluations) {
    recordMatchEvaluation(db, evaluation);
  }
  return {
    skipped: false,
    reason: "",
    candidate_count: candidates.length,
    best,
    evaluations,
    confirmation_level: best?.level === "high" ? CONFIRM_AUTO : best?.level === "medium" ? CONFIRM_SUSPECTED : "",
  };
}

export function matchPatchFromEvaluation(evaluation) {
  if (!evaluation?.hit?.listing && !evaluation?.candidate_post_id) return null;
  const hit = evaluation.hit;
  if (!hit) return null;
  return {
    match_post_id: Number(evaluation.candidate_post_id) || Number(hit.listing?.post_id) || 0,
    match_level: hit.level,
    match_detail: hit.detail,
    evidence: {
      ...hit.evidence,
      candidate_source: evaluation.candidate_source,
      candidate_post_id: evaluation.candidate_post_id,
      matcher_version: evaluation.matcher_version || MATCHER_VERSION,
      evaluated_at: evaluation.evaluated_at,
      confidence: evaluation.confidence,
      signals: evaluation.signals,
      veto_reasons: evaluation.veto_reasons,
    },
  };
}

// 語句抽成常數：PG 版（`sameHouseAsync.runSameHouseBackfillAsync()`）逐字共用同一句
// （`?` 佔位由 `toPostgresSql()` 轉 `$n`；`IFNULL` 亦然）。
export const NEXT_BACKFILL_BATCH_SQL = `SELECT post_id FROM listings
     WHERE post_id > ?
       AND IFNULL(offline_confirmed, 0) = 0
     ORDER BY post_id
     LIMIT ?`;

export function nextBackfillBatch(db, { cursor = 0, limit = RECONCILE_BATCH } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || RECONCILE_BATCH, 200));
  const after = Number(cursor) || 0;
  return db.prepare(NEXT_BACKFILL_BATCH_SQL).all(after, cap);
}

export function summarizeReconciliationBatch(results) {
  const summary = {
    scanned: 0,
    candidate_pairs: 0,
    auto_confirmed: 0,
    suspected: 0,
    no_match: 0,
    skipped: 0,
    errors: 0,
    matcher_version: MATCHER_VERSION,
  };
  for (const row of results || []) {
    summary.scanned += 1;
    if (row.error) {
      summary.errors += 1;
      continue;
    }
    if (row.skipped) {
      summary.skipped += 1;
      continue;
    }
    summary.candidate_pairs += Number(row.candidate_count) || 0;
    if (row.best?.level === "high") summary.auto_confirmed += 1;
    else if (row.best?.level === "medium") summary.suspected += 1;
    else summary.no_match += 1;
  }
  return summary;
}

export { MATCHER_VERSION, groupIdForPost };
