// SQL-first search projection (Phase 7).
//
// Precomputes the derived columns the search hot path actually filters/sorts
// on, so the query can use indexed SQL filtering + ORDER BY + LIMIT instead of
// loading every candidate into Node. Derived values are computed with the SAME
// functions the Node filter/sort uses, so behavior stays identical by
// construction (see listing-search-projection.test.js for the parity check).
import { rentAmount, listingCompareCost } from "./listingCost.js";
import { areaNum, listingRefreshAt } from "./match.js";
import {
  buildingTotalFloors,
  housingTypeLabel,
  isAtOrBelowFirstFloor,
  isRooftopAddition,
  listingFilterHay,
  listingHasElevator,
  listingHasParking,
} from "./floors.js";
import { districtNameFromListing } from "./regions.js";

export const PROJECTION_TABLE = "listing_search_projection";

export function ensureListingSearchProjection(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PROJECTION_TABLE} (
      post_id INTEGER PRIMARY KEY,
      district TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      rent INTEGER NOT NULL DEFAULT 0,
      total_monthly_cost INTEGER NOT NULL DEFAULT 0,
      area REAL,
      floor INTEGER,
      total_floors INTEGER,
      elevator INTEGER NOT NULL DEFAULT 0,
      parking INTEGER NOT NULL DEFAULT 0,
      rooftop INTEGER NOT NULL DEFAULT 0,
      low_floor INTEGER NOT NULL DEFAULT 0,
      lat REAL,
      lng REAL,
      location_class TEXT NOT NULL DEFAULT '',
      primary_listing_id INTEGER NOT NULL DEFAULT 0,
      offline_state INTEGER NOT NULL DEFAULT 0,
      commute_km REAL,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_proj_updated_at ON ${PROJECTION_TABLE}(updated_at);
    CREATE INDEX IF NOT EXISTS idx_proj_total_cost ON ${PROJECTION_TABLE}(total_monthly_cost);
    CREATE INDEX IF NOT EXISTS idx_proj_district ON ${PROJECTION_TABLE}(district);
    CREATE INDEX IF NOT EXISTS idx_proj_commute ON ${PROJECTION_TABLE}(commute_km);
  `);
}

// Mirrors db.js listingEffectiveUpdatedAt (same precedence + relative-time skip).
function effectiveUpdatedAt(row, now = Date.now()) {
  const sourceUpdated = Date.parse(row?.source_updated_at || "");
  if (Number.isFinite(sourceUpdated)) return sourceUpdated;
  const published = Date.parse(row?.source_published_at || "");
  if (Number.isFinite(published)) return published;
  const raw = String(row?.refresh_time || "").trim();
  if (raw && !/剛剛|秒前|分鐘前|小時|今日|今天|昨日|昨天|天前/.test(raw)) {
    const abs = Date.parse(raw);
    if (Number.isFinite(abs)) return abs;
  }
  const first = Date.parse(row?.first_seen_at || "");
  if (Number.isFinite(first)) return first;
  return listingRefreshAt({ ...row, refresh_time: "", last_seen_at: row?.first_seen_at }, now) || 0;
}

function parseFloorNumber(floorName) {
  const text = String(floorName || "").replace(/\s+/g, "");
  const m = text.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

function commuteKm(row) {
  const decorated = Number(row?.commute_km);
  if (Number.isFinite(decorated)) return decorated;
  const raw = Number(row?.route_km);
  if (Number.isFinite(raw)) return Math.round(raw * 10) / 10;
  return null;
}

export function computeListingProjection(row, now = Date.now()) {
  const floorName = String(row?.floor_name || "");
  return {
    post_id: Number(row?.post_id),
    district: districtNameFromListing(row) || "",
    source: String(row?.source || "591"),
    kind: housingTypeLabel(row),
    rent: rentAmount(row),
    total_monthly_cost: listingCompareCost(row, { includeExtras: true }),
    area: areaNum(row?.area_name),
    floor: parseFloorNumber(floorName),
    total_floors: buildingTotalFloors(floorName),
    elevator: listingHasElevator(row) ? 1 : 0,
    parking: listingHasParking(row) ? 1 : 0,
    rooftop: isRooftopAddition(row) ? 1 : 0,
    low_floor: isAtOrBelowFirstFloor(floorName, listingFilterHay(row)) ? 1 : 0,
    lat: Number.isFinite(Number(row?.lat)) ? Number(row.lat) : null,
    lng: Number.isFinite(Number(row?.lng)) ? Number(row.lng) : null,
    location_class: String(row?.location_class || ""),
    primary_listing_id: Number(row?.match_post_id) || 0,
    offline_state: Number(row?.offline) || 0,
    commute_km: commuteKm(row),
    updated_at: effectiveUpdatedAt(row, now),
  };
}

const COLS = `post_id, district, source, kind, rent, total_monthly_cost, area, floor, total_floors,
  elevator, parking, rooftop, low_floor, lat, lng, location_class, primary_listing_id,
  offline_state, commute_km, updated_at`;

const UPDATE_SQL = `
  INSERT INTO ${PROJECTION_TABLE} (${COLS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(post_id) DO UPDATE SET
    district = excluded.district,
    source = excluded.source,
    kind = excluded.kind,
    rent = excluded.rent,
    total_monthly_cost = excluded.total_monthly_cost,
    area = excluded.area,
    floor = excluded.floor,
    total_floors = excluded.total_floors,
    elevator = excluded.elevator,
    parking = excluded.parking,
    rooftop = excluded.rooftop,
    low_floor = excluded.low_floor,
    lat = excluded.lat,
    lng = excluded.lng,
    location_class = excluded.location_class,
    primary_listing_id = excluded.primary_listing_id,
    offline_state = excluded.offline_state,
    commute_km = excluded.commute_km,
    updated_at = excluded.updated_at
`;

function bind(p) {
  return [p.post_id, p.district, p.source, p.kind, p.rent, p.total_monthly_cost, p.area, p.floor,
    p.total_floors, p.elevator, p.parking, p.rooftop, p.low_floor, p.lat, p.lng,
    p.location_class, p.primary_listing_id, p.offline_state, p.commute_km, p.updated_at];
}

// Exposed for the PostgreSQL write port (repository/writePath.js): the statement text and the
// value order must stay identical to what syncListingProjection() runs.
export function listingProjectionUpsertSql() {
  return UPDATE_SQL;
}

export function bindProjectionValues(projection) {
  return bind(projection);
}

export function syncListingProjection(db, row, now = Date.now()) {
  db.prepare(UPDATE_SQL).run(...bind(computeListingProjection(row, now)));
}

export function deleteListingProjection(db, postId) {
  db.prepare(`DELETE FROM ${PROJECTION_TABLE} WHERE post_id = ?`).run(postId);
}

export function rebuildListingSearchProjection(db, listingRows, now = Date.now()) {
  ensureListingSearchProjection(db);
  const insert = db.prepare(`INSERT INTO ${PROJECTION_TABLE} (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec(`DELETE FROM ${PROJECTION_TABLE}`);
  db.exec("BEGIN");
  try {
    for (const row of listingRows) insert.run(...bind(computeListingProjection(row, now)));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Idempotent safety net: fills projection rows that are missing. A row is missing only when it
// was created before the projection existed (Phase 7) and never re-upserted since — the SQL-first
// search paths read this table, so a missing row would simply disappear from the list. Runs in
// bounded batches so a cold database cannot make boot slow; returns how many rows were added.
export function backfillListingSearchProjection(db, { maxBatches = 40, batchSize = 500 } = {}) {
  ensureListingSearchProjection(db);
  const missingSql = `SELECT l.* FROM listings l
    LEFT JOIN ${PROJECTION_TABLE} p ON p.post_id = l.post_id
    WHERE p.post_id IS NULL
    LIMIT ?`;
  const insert = db.prepare(UPDATE_SQL);
  let added = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const rows = db.prepare(missingSql).all(batchSize);
    if (!rows.length) break;
    db.exec("BEGIN");
    try {
      for (const row of rows) insert.run(...bind(computeListingProjection(row)));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    added += rows.length;
    if (rows.length < batchSize) break;
  }
  return added;
}

