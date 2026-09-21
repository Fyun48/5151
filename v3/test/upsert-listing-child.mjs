// upsertListing write adapter verification (child process).
//
// Ground truth = what the production path actually sends: db.prepare is wrapped to capture the
// exact SQL text and parameters upsertListing() uses. The adapter's own statement is then compared
// against that capture (whitespace-normalised) and the rows it writes are compared field by field -
// first against the production row in SQLite, then against PostgreSQL when PG_TEST_URL is set.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcUrl = (name) => pathToFileURL(path.join(dir, "../src", name)).href;

const { db, getSettings, listingSearchBuildContext, persistListing, upsertListing } = await import(srcUrl("db.js"));
const { createListingsRepository } = await import(srcUrl("repository/listings.js"));
const { ensureListingSearchProjection } = await import(srcUrl("listingSearchProjection.js"));
const { ensureListingPrepSchema } = await import(srcUrl("listingEnrichQueue.js"));
const {
  createWritePath,
  listingsUpsertParams,
  listingsUpsertSql,
} = await import(srcUrl("repository/writePath.js"));
const { createPostgresDriver } = await import(srcUrl("dbDriverPostgres.js"));
const { ensurePgSchema } = await import(srcUrl("pgSchema.js"));

const stamp = "2026-09-21T09:00:00.000Z";
const payload = {
  post_id: 592001,
  source: "591",
  source_id: "9911",
  source_key: "g-upsert",
  search_key: "https://example.test",
  url: "https://rent.591.com.tw/9911",
  title: "測試物件",
  price: "3.8萬",
  price_num: 38000,
  extra_fee: 500,
  extra_fee_text: "管理費 500",
  price_contain_text: "",
  extra_fees: [{ label: "管理費", amount: 500 }],
  extra_fees_fetched: 0,
  address: "台北市士林區天玉街9巷3號",
  area_name: "19坪",
  layout: "2房1廳1衛",
  floor_name: "4/4",
  kind_name: "整層住家",
  role_name: "屋主",
  cover: "",
  tags: '["冰箱"]',
  refresh_time: stamp,
  first_seen_at: stamp,
  last_seen_at: stamp,
  last_event: "new",
  lat: 25.1105,
  lng: 121.529,
  geo_source: "591",
  community_id: 0,
  community_name: "天玉社區",
  community_linked: 0,
  cost_changed_at: "",
  cost_change_type: "",
  cost_change_detail: "",
};

// 1. Capture what the production path sends.
const captured = [];
const originalPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const statement = originalPrepare(sql);
  if (typeof statement.run === "function" && String(sql).includes("INSERT INTO listings")) {
    const originalRun = statement.run.bind(statement);
    statement.run = (...params) => {
      captured.push({ sql, params });
      return originalRun(...params);
    };
  }
  return statement;
};
upsertListing(payload);
db.prepare = originalPrepare;
assert.equal(captured.length, 1, "expected exactly one listings upsert");
const sent = captured[0];

// 2. The adapter must send exactly that statement and those parameters.
const normalise = (sql) => String(sql).replace(/\s+/g, " ").trim();
assert.equal(normalise(listingsUpsertSql()), normalise(sent.sql), "adapter SQL must match production");
assert.deepEqual(
  listingsUpsertParams(payload, undefined),
  Array.from(sent.params),
  "adapter parameters must match production",
);

// 3. The rows the two paths write must be identical (post_id/url/source_id differ by design).
const FIELDS = [
  "source_key", "search_key", "title", "price", "price_num", "extra_fee", "extra_fee_text",
  "price_contain_text", "extra_fees", "extra_fees_fetched", "address", "area_name", "layout",
  "floor_name", "kind_name", "role_name", "cover", "tags", "refresh_time", "first_seen_at",
  "last_seen_at", "last_event", "viewed", "watched", "lat", "lng", "community_id",
  "community_name", "community_linked", "cost_changed_at", "cost_change_type", "cost_change_detail",
  "offline", "offline_confirmed", "last_checked_at",
];
// PostgreSQL publishes BIGINT as text, so the comparison normalises numeric-looking values.
const normaliseValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const text = String(value);
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
};
const pick = (row) => Object.fromEntries(FIELDS.map((field) => [field, normaliseValue(row?.[field])]));

const viaProduction = pick(db.prepare("SELECT * FROM listings WHERE post_id = ?").get(payload.post_id));
const adapterPayload = { ...payload, post_id: 592002, source_id: "9912", url: "https://rent.591.com.tw/9912" };
await createWritePath({ driver: "sqlite", sqliteDb: db }).upsertListingRow(adapterPayload);
const viaAdapter = pick(db.prepare("SELECT * FROM listings WHERE post_id = ?").get(adapterPayload.post_id));
assert.deepEqual(viaAdapter, viaProduction, "SQLite: adapter row must match the production row");

// 4. The follow-up steps: the row backfill, the search projection the SQL-first query reads, and
// the change-log entry. The production call above already ran its own copy of these for `payload`.
ensureListingSearchProjection(db);
const adapterWriter = createWritePath({ driver: "sqlite", sqliteDb: db });
await adapterWriter.backfillListing(adapterPayload, null);
await adapterWriter.syncProjection(adapterPayload);
await adapterWriter.bumpRevision({
  entityType: "listing",
  entityId: adapterPayload.post_id,
  eventType: "listing_added",
});

const PROJECTION_FIELDS = [
  "district", "source", "kind", "rent", "total_monthly_cost", "area", "floor", "total_floors",
  "elevator", "parking", "rooftop", "low_floor", "lat", "lng", "location_class",
  "primary_listing_id", "offline_state", "commute_km", "updated_at",
];
const projectionOf = (postId) => {
  const row = db.prepare("SELECT * FROM listing_search_projection WHERE post_id = ?").get(postId);
  assert.ok(row, `expected a projection row for ${postId}`);
  return Object.fromEntries(PROJECTION_FIELDS.map((field) => [field, normaliseValue(row[field])]));
};
assert.deepEqual(projectionOf(adapterPayload.post_id), projectionOf(payload.post_id), "projection rows must match");

const revisionOf = (postId) => {
  const row = db
    .prepare("SELECT entity_type, event_type FROM data_revision WHERE entity_id = ? ORDER BY id DESC")
    .get(postId);
  assert.ok(row, `expected a change-log row for ${postId}`);
  return row;
};
assert.deepEqual(revisionOf(adapterPayload.post_id), revisionOf(payload.post_id), "change-log rows must match");
assert.equal(revisionOf(payload.post_id).event_type, "listing_added");

// 5. The wiring facade: in sqlite mode persistListing() must behave exactly like the production
// upsertListing() - that is what keeps the default deployment untouched.
const facadePayload = { ...payload, post_id: 592003, source_id: "9913", url: "https://rent.591.com.tw/9913" };
assert.deepEqual(await persistListing(facadePayload, { driver: "sqlite" }), { driver: "sqlite", changeEvent: null });
const viaFacade = pick(db.prepare("SELECT * FROM listings WHERE post_id = ?").get(facadePayload.post_id));
assert.deepEqual(viaFacade, viaProduction, "facade (sqlite): row must match production");
assert.deepEqual(
  projectionOf(facadePayload.post_id),
  projectionOf(payload.post_id),
  "facade (sqlite): projection must match production",
);
assert.deepEqual(
  { ...revisionOf(facadePayload.post_id) },
  { ...revisionOf(payload.post_id) },
  "facade (sqlite): change-log must match production",
);

// 5. PostgreSQL: create the same tables there (DDL derived from the SQLite schema, no rows), write
// through the adapter and then prove the loop closes - the freshly written listing must show up in
// the PostgreSQL list query the app would run.
if (process.env.PG_TEST_URL) {
  const schema = `upsert_listing_${process.pid}`;
  const pgDriver = await createPostgresDriver({
    connectionString: process.env.PG_TEST_URL,
    poolOptions: { options: `-c search_path=${schema}` },
  });
  try {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.exec(`CREATE SCHEMA ${schema}`);
    // Mirror the whole SQLite schema (the search SQL also reads listing_prep and the visibility
    // clauses' tables), exactly like a real cutover would.
    ensureListingPrepSchema(db);
    await ensurePgSchema(pgDriver, db, { schema, indexes: false });
    const pgWriter = createWritePath({ driver: "postgres", pgDriver });
    const facadeResult = await persistListing(adapterPayload, { driver: "postgres", pgDriver });
    assert.equal(facadeResult.driver, "postgres");
    assert.equal(facadeResult.changeEvent, "listing_added");
    assert.ok(pgWriter, "adapter remains available for the row-level checks");

    const row = (await pgDriver.query("SELECT * FROM listings WHERE post_id = $1", [adapterPayload.post_id])).rows[0];
    assert.ok(row, "expected the row in PostgreSQL");
    assert.deepEqual(pick(row), viaProduction, "PostgreSQL: adapter row must match the SQLite production row");

    const projection = (
      await pgDriver.query("SELECT * FROM listing_search_projection WHERE post_id = $1", [adapterPayload.post_id])
    ).rows[0];
    assert.ok(projection, "expected the projection row in PostgreSQL");
    assert.deepEqual(
      Object.fromEntries(PROJECTION_FIELDS.map((field) => [field, normaliseValue(projection[field])])),
      projectionOf(payload.post_id),
      "PostgreSQL: projection row must match the SQLite one",
    );
    const revision = (
      await pgDriver.query("SELECT entity_type, event_type FROM data_revision WHERE entity_id = $1", [
        adapterPayload.post_id,
      ])
    ).rows[0];
    assert.deepEqual({ ...revision }, { ...revisionOf(payload.post_id) }, "PostgreSQL: change-log row must match the SQLite one");

    // The closure: the PostgreSQL list query (the same repository the app uses) finds the row.
    const deps = listingSearchBuildContext();
    const repository = createListingsRepository({ driver: "postgres", pgDriver, deps });
    const base = getSettings(0);
    const page = await repository.searchPage({
      filter: "all", kind: "", sources: "", q: "", sort: "newest", limit: 50, offset: 0, cursor: null,
      districts: ["士林區"], userId: 0, matchVoteUserId: 0, sameHouse: true,
      settings: {
        ...base,
        priceMin: 0, priceMax: 0, areaMax: 0, minBuildingFloors: 0, wholeFloorOnly: false,
        excludeLowFloors: false, excludeRooftop: false, commuteKm: 0,
        excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
      },
    });
    assert.ok(page, "expected the PostgreSQL list query to stay inside the SQL-first envelope");
    assert.ok(
      page.ids.includes(adapterPayload.post_id),
      `the freshly written listing must be listable on PostgreSQL (ids=${page.ids.join(",")})`,
    );
    console.log(JSON.stringify({ ok: true, pg: true, fields: FIELDS.length, listable: true }));
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pgDriver.close();
  }
} else {
  console.log(JSON.stringify({ ok: true, pg: false, fields: FIELDS.length, listable: false }));
}
db.close();
