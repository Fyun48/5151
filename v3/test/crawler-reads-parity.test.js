// Crawler reads parity: the crawler must read back from the store it writes to.
//
// watcher.js used db.js getListing()/findBySourceKey() (synchronous SQLite) for change detection
// while persistListing() already writes through PostgreSQL when DB_DRIVER=postgres - so the
// crawler would not see its own rows. crawlerReads.js gives those two reads one async entry
// point. This suite pins them to the SQLite answer on both drivers, and demonstrates the actual
// scenario (write through PostgreSQL, then read the row back) on the shadow cluster.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { importStore } from "../src/pgSchema.js";
import { ensureDataRevisionTable } from "../src/dataRevision.js";
import { DEMO_COMMUTE_MODE, DEMO_WORK_LAT, DEMO_WORK_LNG } from "../src/demo.js";
import { makeMrtKey } from "../src/mrt.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-crawler-reads-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const skip = PG_TEST_URL ? false : "PG_TEST_URL is not set (live PostgreSQL crawler reads)";

const TABLES = [
  "listings",
  // persistListing() also syncs the projection and bumps the change log, so the write-back
  // subtest needs both (this is the "mirror a fully-initialised store" rule from the runbook).
  "listing_search_projection",
  "data_revision",
  "user_listing_flags",
  "user_same_house_members",
  "user_match_votes",
  "listing_group_members",
  "listing_prep",
  "route_cache",
  "mrt_cache",
  "route_jobs",
  // The 591-geo scan asks whether a community is already cached.
  "community_cache",
];

const SEEDED = [920001, 920002, 920003];
// The scan subtests need a pending-offline row (see loadFixture).
const PENDING_OFFLINE = 920004;
// Written through PostgreSQL only, so a SQLite read cannot see it.
const PG_ONLY = 930001;
// One row per branch of the seven remaining backfill scans (see loadFixture).
const FEE_NO_COORDS = 920010;
const FEE_STALE_CONTACT = 920011;
const KIT_SINYI = 920020;
const KIT_HBH_RETRY = 920021;
const KIT_OFFLINE = 920022;
const KIT_RAKUYA = 920023;
const GEO_NO_COORDS = 920030;
const GEO_COMMUNITY_MISSING = 920031;
const GEO_COMMUNITY_CACHED = 920032;
const GEO_UNTRUSTED = 920040;
const GEO_UNKNOWN_QUALITY = 920041;
const ENRICH_DDROOM = 920050;
const ENRICH_PRECISE = 920051;
const MRT_SECOND_KEY = 920060;
const CACHED_COMMUNITY = 999;

let fixture = null;

async function loadFixture() {
  if (fixture) return fixture;
  const app = await import("../src/db.js");
  const uid = app.defaultUserId();
  const stamp = "2026-09-06T00:00:00.000Z";
  const seed = (postId, posting = {}) => app.upsertListing({
    post_id: postId,
    source: "591",
    source_id: String(postId),
    source_key: posting.source_key || `1|8|${postId}`,
    search_key: "https://example.test/search",
    title: `合成住宅 ${postId}`,
    url: `https://example.test/listing/${postId}`,
    price: "25000元",
    price_num: 25000,
    extra_fee: 0,
    extra_fees: [],
    cover: "https://example.test/cover.png",
    tags: "[]",
    address: "台北市士林區測試路",
    area_name: "20坪",
    layout: "2房1廳1衛",
    floor_name: "5/12",
    kind_name: "整層住家/電梯大樓",
    role_name: "",
    refresh_time: stamp,
    first_seen_at: stamp,
    last_seen_at: stamp,
    last_event: "new",
    lat: 25.11,
    lng: 121.52,
    ...posting,
  });
  seed(920001, { source_key: "1|8|same" });
  seed(920002, { source_key: "1|8|same" });
  seed(920003, { source_key: "1|8|other" });
  // One pending-offline row, so the recheck scan has work on both drivers.
  seed(920004, { source_key: "1|8|offline" });
  // --- the seven remaining scans: one row per branch -------------------------------------------
  seed(FEE_NO_COORDS, { source_key: "1|8|fee" });
  seed(FEE_STALE_CONTACT, { source_key: "1|8|stale" });
  // Source kit is per source, and the retry gate is what makes the wide statement interesting.
  seed(KIT_SINYI, { source: "sinyi", source_key: "sinyi|1" });
  seed(KIT_HBH_RETRY, { source: "hbhousing", source_key: "hbhousing|1" });
  seed(KIT_OFFLINE, { source: "housefun", source_key: "housefun|1" });
  seed(KIT_RAKUYA, { source: "rakuya", source_key: "rakuya|1" });
  // 591 geo: the community id can come from the column or from the source_key fingerprint.
  seed(GEO_NO_COORDS, { source_key: "1|8|c777" });
  seed(GEO_COMMUNITY_MISSING, { source_key: "1|8|c888" });
  seed(GEO_COMMUNITY_CACHED, { source_key: `1|8|c${CACHED_COMMUNITY}` });
  seed(GEO_UNTRUSTED, { source_key: "1|8|nog" });
  seed(GEO_UNKNOWN_QUALITY, { source_key: "1|8|district" });
  seed(ENRICH_DDROOM, { source: "ddroom", source_key: "ddroom|1" });
  seed(ENRICH_PRECISE, { source: "rakuya", source_key: "rakuya|2" });
  seed(MRT_SECOND_KEY, { source_key: "1|8|mrt2" });
  const db = app.sqliteHandle();
  // Distinct timestamps: a scan ORDER BY must not have ties that SQLite and PostgreSQL could break
  // differently (the row order is part of the contract - the loops take the first N).
  const stampAt = (step) => new Date(Date.parse(stamp) - step * 60_000).toISOString();
  db.prepare("SELECT post_id FROM listings ORDER BY post_id").all()
    .forEach((row, index) => {
      db.prepare("UPDATE listings SET first_seen_at = ?, last_seen_at = ? WHERE post_id = ?")
        .run(stampAt(index), stampAt(index), row.post_id);
    });
  db.prepare("UPDATE listings SET last_checked_at = NULL, geo_source = 'geocode'").run();
  db.prepare("UPDATE listings SET contact_fetched = 0, extra_fees_fetched = 0, kit_fetched = 0, contact_fetched_at = '', kit_next_retry_at = NULL").run();
  db.prepare("UPDATE listings SET offline = 1, offline_at = ? WHERE post_id = ?").run(stamp, PENDING_OFFLINE);
  // FeeDetail: a row without coordinates lands in the first stage...
  db.prepare("UPDATE listings SET lat = NULL, lng = NULL, geo_source = '' WHERE post_id = ?").run(FEE_NO_COORDS);
  // ...and a row whose contact data is older than the refresh window lands in the second stage.
  db.prepare("UPDATE listings SET contact_fetched = 1, extra_fees_fetched = 1, kit_fetched = 1, contact_fetched_at = ? WHERE post_id = ?")
    .run("2020-01-01T00:00:00.000Z", FEE_STALE_CONTACT);
  // SourceKit: the retry gate hides one row, offline hides another, a fetched kit hides a third.
  db.prepare("UPDATE listings SET kit_next_retry_at = ? WHERE post_id = ?").run("2999-01-01T00:00:00.000Z", KIT_HBH_RETRY);
  db.prepare("UPDATE listings SET kit_next_retry_at = ? WHERE post_id = ?").run("2000-01-01T00:00:00.000Z", KIT_RAKUYA);
  // offline_confirmed keeps this row out of the pending-offline recheck scan: it is only here to
  // prove the kit scan skips offline listings.
  db.prepare("UPDATE listings SET offline = 1, offline_confirmed = 1, offline_at = ? WHERE post_id = ?").run(stamp, KIT_OFFLINE);
  db.prepare("UPDATE listings SET kit_fetched = 1 WHERE post_id = ?").run(ENRICH_PRECISE);
  // 591 geo: no coordinates, a trusted pin with an uncached community, and one with a cached one.
  db.prepare("UPDATE listings SET lat = NULL, lng = NULL, geo_source = '', community_id = 777 WHERE post_id = ?").run(GEO_NO_COORDS);
  db.prepare("UPDATE listings SET geo_source = '591', community_id = 888 WHERE post_id = ?").run(GEO_COMMUNITY_MISSING);
  db.prepare("UPDATE listings SET geo_source = '591', community_id = ? WHERE post_id = ?").run(CACHED_COMMUNITY, GEO_COMMUNITY_CACHED);
  db.prepare(
    "INSERT INTO community_cache(community_id, name, address, lat, lng, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(CACHED_COMMUNITY, "已快取社區", "", 25.11, 121.52, stamp);
  // AddressGeo: an untrusted pin (still worth geocoding) and an address too coarse to try.
  db.prepare("UPDATE listings SET geo_source = '' WHERE post_id = ?").run(GEO_UNTRUSTED);
  db.prepare("UPDATE listings SET address = ? WHERE post_id = ?").run("近捷運好房", GEO_UNKNOWN_QUALITY);
  // AddressEnrich: a coarse ddroom address is work, a house-numbered address is not.
  db.prepare("UPDATE listings SET address = ? WHERE post_id = ?").run("台北市士林區", ENRICH_DDROOM);
  db.prepare("UPDATE listings SET address = ? WHERE post_id = ?").run("台北市士林區測試路 7 號", ENRICH_PRECISE);
  // MRT: a second coordinate key, with the first one already cached.
  db.prepare("UPDATE listings SET lat = 25.22, lng = 121.62 WHERE post_id = ?").run(MRT_SECOND_KEY);
  db.prepare(
    "INSERT INTO mrt_cache(geo_key, station, walk_km, walk_min, ride_km, ride_min, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(makeMrtKey(25.11, 121.52), "士林", 0.4, 6, 2.1, 9, stamp);
  // Route: one listing blocked by a failed route job, one that is already fully cached.
  app.upsertRouteJob({
    post_id: 920001,
    direction: "to_work",
    kind: "distance",
    commuteMode: DEMO_COMMUTE_MODE,
    workLat: DEMO_WORK_LAT,
    workLng: DEMO_WORK_LNG,
    job_state: "failed",
    fail_reason: "no_route",
    attempts: 2,
  });
  app.setCachedRoute(25.11, 121.52, DEMO_WORK_LAT, DEMO_WORK_LNG, [5.4], null, DEMO_COMMUTE_MODE, "to_work");
  app.setCachedRoute(DEMO_WORK_LAT, DEMO_WORK_LNG, 25.11, 121.52, [6.1], null, DEMO_COMMUTE_MODE, "from_work");
  app.setFlags(920002, { viewed: true }, uid);
  // The change log is created on first use, so a fixture has to create it explicitly - otherwise
  // the mirrored PostgreSQL schema would be missing it (runbook: mirror a fully-initialised store).
  ensureDataRevisionTable(db);
  fixture = { app, uid };
  return fixture;
}

function existingTables(sqliteDb, tables) {
  const have = new Set(
    sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  return tables.filter((name) => have.has(name));
}

// The fixture rows are only worth mirroring if they really land in the branch each one was built
// for, so both the SQLite test and the live PostgreSQL subtest run these expectations.
function assertScanFixture(app, routeRows = null) {
  const ids = (rows) => rows.map((row) => Number(row.post_id));
  const fee = ids(app.listingsNeedingFeeDetail(12));
  assert.ok(fee.includes(FEE_NO_COORDS) && fee.includes(FEE_STALE_CONTACT), "both fee stages fire");
  const kit = ids(app.listingsNeedingSourceKit(8));
  assert.ok(kit.includes(KIT_SINYI) && kit.includes(KIT_RAKUYA), "one page per source");
  assert.ok(!kit.includes(KIT_HBH_RETRY), "a future retry hides the row");
  assert.ok(!kit.includes(KIT_OFFLINE), "an offline row is not kit work");
  const geo = ids(app.listingsNeeding591Geo(20));
  assert.ok(geo.includes(GEO_NO_COORDS) && geo.includes(GEO_COMMUNITY_MISSING));
  assert.ok(!geo.includes(GEO_COMMUNITY_CACHED), "a cached community satisfies the pin");
  const address = ids(app.listingsNeedingAddressGeo(20));
  assert.ok(address.includes(GEO_UNTRUSTED) && !address.includes(GEO_UNKNOWN_QUALITY));
  const enrich = ids(app.listingsNeedingAddressEnrich(12));
  assert.ok(enrich.includes(ENRICH_DDROOM) && !enrich.includes(ENRICH_PRECISE));
  assert.deepEqual(app.listingsNeedingMrt(20), [{ lat: 25.22, lng: 121.62 }], "the cached key is skipped");
  const route = routeRows || app.listingsNeedingRoute(20, { cursor: 0, now: ROUTE_NOW });
  // Only the uncached coordinate needs a route: the failed job and the cached pair stay out.
  assert.deepEqual(ids(route), [MRT_SECOND_KEY]);
}

// One fixed clock for the route scan, so "the retry is in the future" cannot depend on wall time.
const ROUTE_NOW = Date.parse("2026-09-06T00:00:00.000Z");

async function withMirroredSchema(app, fn) {
  const sqliteDb = app.sqliteHandle();
  const schema = `pgcrawl_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}`;
  const pgDriver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 3, options: `-c search_path=${schema}`, application_name: "5151-crawler-reads" },
  });
  try {
    // importStore() = schema mirror + streamed copy + identity-sequence re-sync. The re-sync is
    // what makes the write-back subtest possible: without it the change-log insert below would
    // reuse an imported id and fail (this test is where that bug was found).
    await importStore(pgDriver, sqliteDb, {
      schema,
      tables: existingTables(sqliteDb, TABLES),
    });
    return await fn(pgDriver);
  } finally {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.close();
  }
}

test("the crawler reads go through the driver-aware entry point", async () => {
  const { app, uid } = await loadFixture();
  const { listingForWatchAsync, watchSiblings } = await import("../src/crawlerReads.js");
  // sqlite driver: identical to the synchronous reads the crawler used before.
  for (const id of [...SEEDED, 999999]) {
    assert.deepEqual(
      await listingForWatchAsync(id, uid, { driver: "sqlite" }),
      app.getListing(id, uid, { sameHouse: false }),
      `watch row ${id}`,
    );
  }
  assert.deepEqual(
    await watchSiblings("1|8|same", 920001, { driver: "sqlite" }),
    app.findBySourceKey("1|8|same", 920001),
  );
  // No fingerprint, no lookup - never a full table scan.
  assert.deepEqual(await watchSiblings("", 920001, { driver: "sqlite" }), []);

  // Wiring: the crawl loop awaits both reads and hands the fingerprint to classify().
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(watcher, /from "\.\/crawlerReads\.js";/);
  for (const facade of [
    "listingForWatchAsync",
    "matchCandidatesAsync",
    "needing591GeoAsync",
    "needingAddressEnrichAsync",
    "needingAddressGeoAsync",
    "needingAliveCheckAsync",
    "needingFeeDetailAsync",
    "needingMrtAsync",
    "needingOfflineRecheckAsync",
    "needingRouteAsync",
    "needingSourceKitAsync",
    "watchSiblings",
  ]) {
    assert.match(watcher, new RegExp(`\\n  ${facade},`), `${facade} is imported from crawlerReads.js`);
  }
  // The SQLite driver path is unchanged: the async twin delegates to the same db.js scan.
  const reads = await import("../src/crawlerReads.js");
  for (const [facade, sync] of [
    [reads.needingFeeDetailAsync, app.listingsNeedingFeeDetail],
    [reads.needingSourceKitAsync, app.listingsNeedingSourceKit],
    [reads.needing591GeoAsync, app.listingsNeeding591Geo],
    [reads.needingAddressGeoAsync, app.listingsNeedingAddressGeo],
    [reads.needingAddressEnrichAsync, app.listingsNeedingAddressEnrich],
    [reads.needingMrtAsync, app.listingsNeedingMrt],
  ]) {
    assert.deepEqual(await facade({ limit: 12 }, { driver: "sqlite" }), sync(12));
  }
  assert.deepEqual(
    await reads.needingRouteAsync({ limit: 20, cursor: 0 }, { driver: "sqlite" }),
    app.listingsNeedingRoute(20, { cursor: 0 }),
  );
  // Every backfill scan awaits its driver-aware twin...
  for (const call of [
    /const existing = await listingForWatchAsync\(listing\.post_id\);/,
    /siblings = await watchSiblings\(listing\.source_key, listing\.post_id\);/,
    /candidates = await matchCandidatesAsync\(listing\.post_id, listing\);/,
    /classify\(listing, existing, siblings, candidates\)/,
    /function classify\(incoming, existing, siblings = null, candidates = null\)/,
    /const rows = await needingAliveCheckAsync\(\{ excludeIds: \[\.\.\.seenIds\], limit \}\);/,
    /const pendingRecheck = await needingOfflineRecheckAsync\(\{ limit: 8 \}\);/,
    /const pendingFees = await needingFeeDetailAsync\(\{ limit: needsListingGeo\(settings\) \? 30 : 20 \}\);/,
    /const pendingSourceKit = await needingSourceKitAsync\(\{ limit: 8 \}\);/,
    /const rows = await needing591GeoAsync\(\{ limit \}\);/,
    /const rows = \(await needingRouteAsync\(\{ limit, priorityIds \}\)\)\.filter\(/,
    /const rows = await needingAddressGeoAsync\(\{ limit \}\);/,
    /const rows = await needingAddressEnrichAsync\(\{ limit: Math\.max\(0, limit - \(hp\.processed \|\| 0\)\) \}\);/,
    /const rows = await needingMrtAsync\(\{ limit \}\);/,
  ]) {
    assert.match(watcher, call);
  }
  // ...and none of them still calls the synchronous SQLite scan.
  assert.equal((watcher.match(/listingsNeeding[A-Za-z0-9]+\(/g) || []).length, 0);
  // The only synchronous listing read left is the enrich queue seam.
  const syncReads = watcher.match(/listingForWatch\(/g) || [];
  assert.equal(syncReads.length, 2, "getListing stays only for the enrich helper (definition + use)");
});

// The SQLite half of the scan parity: with no PostgreSQL in the picture, the scans still have to
// find exactly the work the fixture was built to describe (this is the CI-visible half).
test("the backfill scans find the fixture's work on the sqlite driver", async () => {
  const { app } = await loadFixture();
  assertScanFixture(app);
});

test("live PostgreSQL: the crawler reads match SQLite, and a PostgreSQL write is readable back", { skip }, async (t) => {
  const { app, uid } = await loadFixture();
  const { listingForWatchAsync, watchSiblings } = await import("../src/crawlerReads.js");
  const deps = app.crawlerReadsBuildContext();
  const pgOptions = (pgDriver) => ({ driver: "postgres", pgDriver, deps, strict: true });

  await t.test("existing row and fingerprint lookup", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      for (const id of [...SEEDED, 999999]) {
        assert.deepEqual(
          await listingForWatchAsync(id, uid, pgOptions(pgDriver)),
          app.getListing(id, uid, { sameHouse: false }),
          `watch row ${id}`,
        );
      }
      assert.deepEqual(
        await watchSiblings("1|8|same", 920001, pgOptions(pgDriver)),
        app.findBySourceKey("1|8|same", 920001),
      );
    });
  });

  // The scans the offline sweep runs: same rows, same order, both drivers.
  await t.test("the offline sweep scans match", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const { needingAliveCheckAsync, needingOfflineRecheckAsync } = await import("../src/crawlerReads.js");
      const alivePg = await needingAliveCheckAsync({ excludeIds: [920001], limit: 20 }, pgOptions(pgDriver));
      const aliveSqlite = app.listingsNeedingAliveCheck({ excludeIds: [920001], limit: 20 });
      assert.deepEqual(alivePg.map((row) => row.post_id), aliveSqlite.map((row) => row.post_id));
      assert.ok(!aliveSqlite.some((row) => Number(row.post_id) === 920001), "excluded ids stay excluded");

      const recheckPg = await needingOfflineRecheckAsync({ limit: 8 }, pgOptions(pgDriver));
      const recheckSqlite = app.listingsNeedingOfflineRecheck({ limit: 8 });
      assert.deepEqual(recheckPg, recheckSqlite);
      assert.equal(recheckSqlite.length, 1);
      assert.equal(Number(recheckSqlite[0].post_id), PENDING_OFFLINE);
    });
  });

  // The seven backfill scans: the loops must find the same work, in the same order, on both
  // drivers. Each one is driven through the async entry point the watcher now awaits.
  await t.test("the backfill scans match", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const reads = await import("../src/crawlerReads.js");
      const ids = (rows) => rows.map((row) => Number(row.post_id));
      for (const [facade, limit, sync] of [
        [reads.needingFeeDetailAsync, 12, app.listingsNeedingFeeDetail],
        [reads.needingSourceKitAsync, 8, app.listingsNeedingSourceKit],
        [reads.needing591GeoAsync, 20, app.listingsNeeding591Geo],
        [reads.needingAddressGeoAsync, 20, app.listingsNeedingAddressGeo],
        [reads.needingAddressEnrichAsync, 12, app.listingsNeedingAddressEnrich],
        [reads.needingMrtAsync, 20, app.listingsNeedingMrt],
      ]) {
        const pgRows = await facade({ limit }, pgOptions(pgDriver));
        const sqliteRows = sync(limit);
        assert.ok(sqliteRows.length > 0, `${facade.name}: the fixture has work to find`);
        assert.deepEqual(pgRows, sqliteRows, facade.name);
      }
      // The route scan is the resumable one, so both sides get the same cursor and clock.
      const now = Date.parse("2026-09-06T00:00:00.000Z");
      const routePg = await reads.needingRouteAsync({ limit: 20, cursor: 0 }, { ...pgOptions(pgDriver), now });
      const routeSqlite = app.listingsNeedingRoute(20, { cursor: 0, now });
      assert.deepEqual(routePg, routeSqlite);
      // ...and the fixture rows really do hit the branches this test claims to cover.
      assertScanFixture(app, routeSqlite);
    });
  });

  await t.test("match candidates match on both paths", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const { matchCandidatesAsync } = await import("../src/crawlerReads.js");
      // Block path: same street + trusted coords + same floor/area/layout as 920001/920002, so the
      // blocking query fires and the pure post-filter decides.
      const blockedIncoming = {
        post_id: 920003,
        address: "台北市士林區測試路 5 號",
        community_name: "",
        floor_name: "5/12",
        area_name: "20坪",
        layout: "2房1廳1衛",
        lat: 25.11,
        lng: 121.52,
      };
      assert.deepEqual(
        await matchCandidatesAsync(blockedIncoming.post_id, blockedIncoming, pgOptions(pgDriver)),
        app.listMatchCandidates(blockedIncoming.post_id, blockedIncoming),
      );
      // Fallback path (no street/community/geo hints): the watched-first ordered page.
      const bareIncoming = { post_id: 920003, address: "", community_name: "", lat: 0, lng: 0 };
      const pgRows = await matchCandidatesAsync(bareIncoming.post_id, bareIncoming, pgOptions(pgDriver));
      const sqliteRows = app.listMatchCandidates(bareIncoming.post_id, bareIncoming);
      assert.deepEqual(pgRows.map((row) => row.post_id), sqliteRows.map((row) => row.post_id));
      assert.ok(sqliteRows.length >= 2, "the fallback path returns the other listings");
    });
  });

  // The bug this slice fixes: persistListing() writes through PostgreSQL, so the crawler has to
  // read the row back from PostgreSQL - a SQLite read would report "not in the store" and the
  // next crawl would treat the listing as brand new.
  await t.test("a listing written through PostgreSQL is readable back", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const row = {
        post_id: PG_ONLY,
        source: "591",
        source_id: String(PG_ONLY),
        source_key: `1|8|${PG_ONLY}`,
        search_key: "https://example.test/search",
        title: "PG 寫入後回讀",
        url: `https://example.test/listing/${PG_ONLY}`,
        price: "31000元",
        price_num: 31000,
        extra_fee: 0,
        extra_fees: [],
        cover: "https://example.test/cover.png",
        tags: "[]",
        address: "台北市士林區測試路 1 號",
        area_name: "22坪",
        layout: "2房1廳1衛",
        floor_name: "6/12",
        kind_name: "整層住家/電梯大樓",
        role_name: "",
        refresh_time: "2026-09-06T01:00:00.000Z",
        first_seen_at: "2026-09-06T01:00:00.000Z",
        last_seen_at: "2026-09-06T01:00:00.000Z",
        last_event: "new",
        lat: 25.11,
        lng: 121.52,
      };
      const written = await app.persistListing(row, { driver: "postgres", pgDriver });
      assert.equal(written.driver, "postgres");
      // Not in SQLite at all - this is what makes the SQLite read wrong in PG mode.
      assert.equal(app.getListing(PG_ONLY, uid, { sameHouse: false }), undefined);
      const readBack = await listingForWatchAsync(PG_ONLY, uid, pgOptions(pgDriver));
      assert.ok(readBack, "PostgreSQL row must be readable through the crawler entry point");
      assert.equal(readBack.post_id, PG_ONLY);
      assert.equal(readBack.title, "PG 寫入後回讀");
    });
  });
});

