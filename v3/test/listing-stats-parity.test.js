// Listing-stats parity: the counters must describe the store the list itself reads.
//
// db.js stats() (SQLite) and listingStatsAsync() (PostgreSQL) share one pipeline
// (buildListingStatsRows + summarizeListingStats) and one set of clause builders, so the two
// drivers can only differ in where the five inputs come from. This suite seeds a single fixture
// that exercises every counter, then compares the two answers field by field - always on
// SQLite, and on the real shadow PostgreSQL when PG_TEST_URL is set (same gate as
// pg-live-integration.test.js).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { ensurePgSchema, importTable } from "../src/pgSchema.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR has to be in place before db.js is imported, and every import of db.js in this file
// is therefore dynamic (inside the test bodies) - the same rule the other v3 suites follow.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-stats-parity-"));
process.env.DATA_DIR = dataDir;
// Windows keeps the SQLite file locked while the process holds it, so the cleanup is best
// effort (the temp directory belongs to the OS anyway).
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // ignored
  }
});

const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const skip = PG_TEST_URL ? false : "PG_TEST_URL is not set (live PostgreSQL listing-stats parity)";

// Every table the stats path reads, plus the ones the decoration preload it runs touches
// (personal flags, same-house index, votes, groups, prep, route/MRT caches, route jobs) and the
// projection the SQL-first page query runs against.
const TABLES = [
  "listings",
  "listing_search_projection",
  "user_listing_flags",
  "user_same_house_members",
  "user_match_votes",
  "listing_group_members",
  "listing_prep",
  "route_cache",
  "mrt_cache",
  "route_jobs",

  "settings",
  "users",
  "user_settings",
  "crawl_covers",
];

const STAMP = "2026-09-01T00:00:00.000Z";
const WORK_LAT = 25.033;
const WORK_LNG = 121.5654;

function settingsFor(app, uid, extra = {}) {
  return {
    ...app.getSettings(uid),
    searchUrls: [],
    watchDistricts: ["1-8"],
    priceMin: 0,
    priceMax: 0,
    priceMaxIncludesExtras: true,
    commuteKm: 0,
    wholeFloorOnly: false,
    excludeLowFloors: false,
    excludeRooftop: false,
    hasParking: false,
    excludeKeywords: [],
    excludeAgents: [],
    excludeAgentIds: [],
    excludeBoxes: [],
    areaMax: 0,
    minBuildingFloors: 0,
    ...extra,
  };
}

// One fixture that puts a value in every counter: plain / price-drop / hidden / duplicate /
// pending-offline / confirmed-offline / no-geo / self listing / other district / suspected.
//
// upsertListing() only carries the crawling columns, so the member-facing states (flag columns,
// offline state, match verdict, owner, geo trust) are set afterwards through the same SQLite
// handle - the PostgreSQL mirror then copies exactly the store the SQLite stats path reads.
function seedListings(app, uid) {
  const base = () => ({
    source: "591",
    url: "https://example.test/listing/",
    cover: "https://example.test/cover.png",
    tags: "[]",
    extra_fees: [],
    address: "台北市士林區測試路",
    area_name: "20坪",
    layout: "2房1廳1衛",
    floor_name: "5/12",
    kind_name: "整層住家/電梯大樓",
    role_name: "",
    refresh_time: STAMP,
    first_seen_at: STAMP,
    last_seen_at: STAMP,
    lat: 25.11,
    lng: 121.52,
  });
  const seed = (postId, extra = {}) => app.upsertListing({
    ...base(),
    post_id: postId,
    source_id: String(postId),
    source_key: `1|8|${postId}`,
    search_key: "https://example.test/search",
    title: `合成住宅 ${postId}`,
    price: "25000元",
    price_num: 25000,
    last_event: "new",
    ...extra,
  });
  seed(900001);                                                     // plain (viewed below)
  seed(900002, { last_event: "price_drop" });                       // same_source (watched below)
  seed(900003, { match_post_id: 900010 });                          // hidden below, peer of 900010
  seed(900004, {});                                                 // duplicate (verdict below)
  seed(900005);                                                     // pending offline (below)
  seed(900006);                                                     // confirmed offline (below)
  seed(900007, { lat: null, lng: null });                           // no trusted geo
  seed(900008, { source: "self" });                                 // member's own listing
  seed(900009, {
    address: "台北市北投區外區路 9 號", source_key: "1|9|900009",
  });                                                              // outside the member region
  seed(900010, { match_post_id: 900003 });                          // suspected (below)

  const db = app.sqliteHandle();
  db.prepare("UPDATE listings SET geo_source = 'geocode' WHERE post_id != 900007").run();
  db.prepare("UPDATE listings SET listed_by_user_id = ? WHERE post_id = 900008").run(Number(uid) || 0);
  db.prepare("UPDATE listings SET offline = 1 WHERE post_id = 900005").run();
  db.prepare("UPDATE listings SET offline = 1, offline_confirmed = 1 WHERE post_id = 900006").run();
  db.prepare("UPDATE listings SET match_level = 'high', match_verdict = 'yes' WHERE post_id = 900004").run();
  db.prepare("UPDATE listings SET match_level = 'high' WHERE post_id = 900010").run();
}

function seedMemberState(app, uid) {
  app.setFlags(900001, { viewed: true }, uid);
  app.setFlags(900002, { watched: true }, uid);
  app.setFlags(900003, { hidden: true }, uid);
}

// Tables that the fixture store actually has - a fixture may not create every domain table.
function existingTables(sqliteDb, tables) {
  const have = new Set(
    sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  return tables.filter((name) => have.has(name));
}

let fixture = null;

// db.js is a singleton per process, so the fixture is built once and both tests share it.
async function loadFixture() {
  if (!fixture) {
    const app = await import("../src/db.js");
    const uid = app.defaultUserId();
    seedListings(app, uid);
    seedMemberState(app, uid);
    fixture = { app, uid };
  }
  return fixture;
}

async function loadFacade() {
  const [{ listingStatsAsync }, { searchListingsAsync }, { createListingStatsRepository }] = await Promise.all([
    import("../src/listingStatsAsync.js"),
    import("../src/listingSearchAsync.js"),
    import("../src/repository/listingStats.js"),
  ]);
  return { listingStatsAsync, searchListingsAsync, createListingStatsRepository };
}

// The fixture store mirrored table for table into a private schema, handed to the PostgreSQL
// path under test. Both parity helpers below share it; the schema is always dropped again.
async function withMirroredSchema(app, fn) {
  const sqliteDb = app.sqliteHandle();
  const schema = `pgstats_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}`;
  const pgDriver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 3, options: `-c search_path=${schema}`, application_name: "5151-stats-parity" },
  });
  try {
    const tables = existingTables(sqliteDb, TABLES);
    await ensurePgSchema(pgDriver, sqliteDb, { schema, tables, indexes: false });
    for (const table of tables) await importTable(pgDriver, sqliteDb, table, { schema });
    return await fn(pgDriver, schema);
  } finally {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.close();
  }
}

// Same fixture, mirrored table for table into a private schema, then the counters compared.
async function assertStatsParity(app, uid, settings) {
  const { listingStatsAsync } = await loadFacade();
  const expected = app.stats(undefined, uid, settings);
  return withMirroredSchema(app, async (pgDriver) => {
    const diagnostics = {};
    const actual = await listingStatsAsync(
      { userId: uid, settings, diagnostics },
      { driver: "postgres", pgDriver, deps: app.listingStatsBuildContext(), strict: true },
    );
    assert.equal(diagnostics.driver, "postgres");
    assert.deepEqual(actual, expected);
    return actual;
  });
}

// The /api/state initial payload: the same page and the same counters, one driver each.
async function assertStatePageParity(app, uid, settings) {
  const { searchListingsAsync } = await loadFacade();
  const args = { filter: "all", sort: "newest", limit: 500, offset: 0, userId: uid, matchVoteUserId: uid };
  const expected = app.listListings({ ...args, settings });
  return withMirroredSchema(app, async (pgDriver) => {
    const actual = await searchListingsAsync(
      { ...args, settings },
      { driver: "postgres", pgDriver, deps: app.listingSearchBuildContext(), strict: true },
    );
    assert.equal(actual.totalMatched, expected.totalMatched);
    assert.deepEqual(actual.listings, expected.listings);
    return actual;
  });
}

test("listingStatsAsync keeps the SQLite counters on the sqlite driver", async () => {
  const { app, uid } = await loadFixture();
  const { listingStatsAsync, createListingStatsRepository } = await loadFacade();
  const settings = settingsFor(app, uid);
  const direct = app.stats(undefined, uid, settings);
  // A fixture of zeros would make the parity test vacuous, so each counter is asserted here.
  assert.ok(direct.total >= 3, `fixture total ${direct.total}`);
  assert.ok(direct.unseen >= 1, `fixture unseen ${direct.unseen}`);
  assert.equal(direct.watched, 1);
  assert.equal(direct.watchedTotal, 1);
  // One member-flagged row plus the duplicate (overlayPersonal() hides match_verdict "yes").
  assert.equal(direct.hidden, 2);
  assert.equal(direct.offline, 1);
  assert.equal(direct.offlineConfirmed, 1);
  assert.equal(direct.suspected, 1);
  assert.equal(direct.missingGeo, 1);
  assert.ok(direct.dbTotal >= 9, `fixture dbTotal ${direct.dbTotal}`);

  const viaAsync = await listingStatsAsync({ userId: uid, settings }, { driver: "sqlite" });
  assert.deepEqual(viaAsync, direct);

  // Wiring: the list handler awaits the driver-aware entry point, and the repository refuses a
  // partial dependency bundle (that would otherwise compute wrong counters silently).
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /const page = await loadListingPage\(args\);/);
  const facade = readFileSync(path.join(dir, "../src/listingStatsAsync.js"), "utf8");
  assert.match(facade, /await buildListingStatsRowsAsync\(\{/);
  assert.match(facade, /await summarizeListingStatsAsync\(\{/);
  assert.match(facade, /return stats\(searchKeys, userId, settings, diagnostics\);/);
  assert.throws(
    () => createListingStatsRepository({ deps: {}, exec: async () => {} }),
    /requires deps\.resolveUserId/,
  );
  // The initial payload (/api/state) goes through the same two entry points, so "first paint"
  // and the first /api/listings refresh cannot describe different stores.
  const stateStart = server.indexOf('app.get("/api/state"');
  const state = server.slice(stateStart, stateStart + 2400);
  assert.match(state, /await loadListingPage\(\{/);
  assert.match(state, /listings = page\.listings/);
  assert.doesNotMatch(state, /listListings\(/);
  assert.doesNotMatch(state, /stats\(undefined/);
});

test("live PostgreSQL: the counters equal the SQLite counters", { skip }, async (t) => {
  const { app, uid } = await loadFixture();

  await t.test("without commute settings", async () => {
    const actual = await assertStatsParity(app, uid, settingsFor(app, uid));
    assert.ok(actual.total >= 3, `PG total ${actual.total}`);
    assert.equal(actual.watchedTotal, 1);
  });

  // The commute branch is the only place the counters read routes, and it is the branch a
  // second store can silently break (SQLite route cache vs the PostgreSQL one).
  await t.test("with commute settings and a cached route", async () => {
    app.setCachedRoute(25.11, 121.52, WORK_LAT, WORK_LNG, [4.2], null, "scooter", "to_work");
    const settings = settingsFor(app, uid, {
      commuteKm: 5,
      commuteMode: "scooter",
      workLat: WORK_LAT,
      workLng: WORK_LNG,
    });
    const actual = await assertStatsParity(app, uid, settings);
    assert.ok(actual.total >= 1, `PG total with commute ${actual.total}`);
  });

  // The initial payload (/api/state): the same page the SQLite path would serve, one driver each.
  await t.test("the initial payload page matches the SQLite page", async () => {
    const actual = await assertStatePageParity(app, uid, settingsFor(app, uid));
    assert.ok(actual.listings.length >= 3, `PG page size ${actual.listings.length}`);
  });
});

