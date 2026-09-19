import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureListingSearchProjection,
  computeListingProjection,
  syncListingProjection,
  deleteListingProjection,
  rebuildListingSearchProjection,
  PROJECTION_TABLE,
} from "../src/listingSearchProjection.js";
import { rentAmount, listingCompareCost } from "../src/listingCost.js";
import { areaNum } from "../src/match.js";
import { buildingTotalFloors, listingHasElevator, listingHasParking } from "../src/floors.js";
import { districtNameFromListing } from "../src/regions.js";

function memDb() {
  const db = new DatabaseSync(":memory:");
  ensureListingSearchProjection(db);
  return db;
}

const SAMPLE = {
  post_id: 12345,
  source: "591",
  source_key: "1|8||台北市士林區測試路1號",
  title: "電梯大樓 含車位 2房",
  price: "25000元",
  price_num: 25000,
  extra_fee: 2000,
  extra_fees: "[]",
  extra_fee_text: "管理費2000元",
  address: "台北市士林區測試路1號",
  area_name: "25坪",
  floor_name: "5/12",
  kind_name: "整層住家/電梯大樓",
  tags: "[]",
  lat: 25.09,
  lng: 121.51,
  location_class: "address",
  match_post_id: 0,
  offline: 0,
  first_seen_at: "2026-09-01T00:00:00.000Z",
  last_seen_at: "2026-09-01T00:00:00.000Z",
  refresh_time: "2026-09-01T00:00:00.000Z",
};

test("computeListingProjection derives columns from the same functions the filter/sort uses", () => {
  const p = computeListingProjection(SAMPLE, Date.parse("2026-09-10T00:00:00Z"));
  assert.equal(p.post_id, 12345);
  assert.equal(p.district, districtNameFromListing(SAMPLE));
  assert.equal(p.rent, rentAmount(SAMPLE));
  assert.equal(p.total_monthly_cost, listingCompareCost(SAMPLE, { includeExtras: true }));
  assert.equal(p.area, areaNum(SAMPLE.area_name));
  assert.equal(p.total_floors, buildingTotalFloors(SAMPLE.floor_name));
  assert.equal(p.elevator, listingHasElevator(SAMPLE) ? 1 : 0);
  assert.equal(p.parking, listingHasParking(SAMPLE) ? 1 : 0);
  assert.equal(p.floor, 5);
  // effective updated at resolves to first_seen_at here
  assert.equal(p.updated_at, Date.parse("2026-09-01T00:00:00.000Z"));
});

test("syncListingProjection upserts and deleteListingProjection removes", () => {
  const db = memDb();
  syncListingProjection(db, SAMPLE);
  const row = db.prepare(`SELECT * FROM ${PROJECTION_TABLE} WHERE post_id = ?`).get(12345);
  assert.equal(row.total_monthly_cost, listingCompareCost(SAMPLE, { includeExtras: true }));
  assert.equal(row.district, districtNameFromListing(SAMPLE));

  // upsert (idempotent)
  syncListingProjection(db, { ...SAMPLE, price_num: 30000 });
  const updated = db.prepare(`SELECT rent, total_monthly_cost FROM ${PROJECTION_TABLE} WHERE post_id = ?`).get(12345);
  assert.equal(updated.rent, 30000);

  deleteListingProjection(db, 12345);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${PROJECTION_TABLE}`).get().n, 0);
  db.close();
});

test("rebuildListingSearchProjection reconstructs all rows and clears stale ones", () => {
  const db = memDb();
  syncListingProjection(db, SAMPLE);
  syncListingProjection(db, { ...SAMPLE, post_id: 9999 });
  rebuildListingSearchProjection(db, [SAMPLE]); // only 12345 survives
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${PROJECTION_TABLE}`).get().n, 1);
  assert.equal(db.prepare(`SELECT post_id FROM ${PROJECTION_TABLE}`).get().post_id, 12345);
  db.close();
});
