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
];

const SEEDED = [920001, 920002, 920003];
// The scan subtests need a pending-offline row (see loadFixture).
const PENDING_OFFLINE = 920004;
// Written through PostgreSQL only, so a SQLite read cannot see it.
const PG_ONLY = 930001;

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
  const db = app.sqliteHandle();
  db.prepare("UPDATE listings SET geo_source = 'geocode' WHERE post_id > 0").run();
  db.prepare("UPDATE listings SET offline = 1, offline_at = ? WHERE post_id = 920004").run("2026-09-06T00:00:00.000Z");
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
  assert.match(watcher, /import \{ listingForWatchAsync, matchCandidatesAsync, needingAliveCheckAsync, needingOfflineRecheckAsync, watchSiblings \} from "\.\/crawlerReads\.js";/);
  assert.match(watcher, /await needingAliveCheckAsync\(\{ excludeIds: \[\.\.\.seenIds\], limit \}\);/);
  assert.match(watcher, /await needingOfflineRecheckAsync\(\{ limit: 8 \}\);/);
  assert.match(watcher, /const existing = await listingForWatchAsync\(listing\.post_id\);/);
  assert.match(watcher, /siblings = await watchSiblings\(listing\.source_key, listing\.post_id\);/);
  assert.match(watcher, /candidates = await matchCandidatesAsync\(listing\.post_id, listing\);/);
  assert.match(watcher, /classify\(listing, existing, siblings, candidates\)/);
  assert.match(watcher, /function classify\(incoming, existing, siblings = null, candidates = null\)/);
  // The only synchronous listing read left is the enrich queue seam.
  const syncReads = watcher.match(/listingForWatch\(/g) || [];
  assert.equal(syncReads.length, 2, "getListing stays only for the enrich helper (definition + use)");
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

