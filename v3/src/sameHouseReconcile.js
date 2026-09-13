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

export const RECONCILE_BATCH = 50;
export const RECONCILE_CANDIDATE_LIMIT = 80;
export const BACKFILL_SETTING_KEY = "sameHouseBackfillCursor";

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

export function blockMatchCandidates(db, incoming, { limit = RECONCILE_CANDIDATE_LIMIT } = {}) {
  const pid = Number(incoming?.post_id) || 0;
  const street = streetKey(incoming?.address);
  const community = String(incoming?.community_name || "").trim();
  const district = likeDistrict(incoming);
  const floor = floorMain(incoming?.floor_name);
  const area = areaNum(incoming?.area_name);
  const rooms = layoutRooms(incoming?.layout);
  const lat = Number(incoming?.lat);
  const lng = Number(incoming?.lng);
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  if (!street && !community && !hasGeo) return [];

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
    blocks.push("(lat IS NOT NULL AND lng IS NOT NULL AND ABS(lat - ?) < 0.002 AND ABS(lng - ?) < 0.002)");
    params.push(lat, lng);
  }
  clauses.push(`(${blocks.join(" OR ")})`);
  if (district) {
    clauses.push("(IFNULL(address, '') LIKE '%' || ? || '%')");
    params.push(district);
  }

  const cap = Math.max(1, Math.min(Number(limit) || RECONCILE_CANDIDATE_LIMIT, 200));
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT * FROM listings
       WHERE ${clauses.join(" AND ")}
       ORDER BY IFNULL(offline, 0) DESC, last_seen_at DESC
       LIMIT ${cap}`,
    ).all(...params);
  } catch {
    return [];
  }

  return rows.filter((row) => {
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

export function nextBackfillBatch(db, { cursor = 0, limit = RECONCILE_BATCH } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || RECONCILE_BATCH, 200));
  const after = Number(cursor) || 0;
  return db.prepare(
    `SELECT post_id FROM listings
     WHERE post_id > ?
       AND IFNULL(offline_confirmed, 0) = 0
     ORDER BY post_id
     LIMIT ?`,
  ).all(after, cap);
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
