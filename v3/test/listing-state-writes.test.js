// Listing state writes: the background loops must store their results where the site reads them.
//
// db.js markListingOffline() / restoreListingOnline() / markListingAlive() / touchListingChecked()
// and invalidateListingLocation() are synchronous SQLite statements. The loops already read their
// work from the driver-aware entry points, so a probe result has to land in the same store -
// otherwise "this listing went offline" (or came back) never reaches PostgreSQL.
// crawlerWrites.js gives them one async entry point; the SQLite driver delegates to db.js, so
// production behaviour is unchanged.
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
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-state-writes-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const skip = PG_TEST_URL ? false : "PG_TEST_URL is not set (live PostgreSQL state writes)";

// Everything the state write touches plus what the decorated read of it needs.
const TABLES = [
  "settings",
  "listings",
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

const PG_ID = 940001;
const SQLITE_ID = 940002;
// The local test uses its own listing, so the live comparison starts from a pristine twin.
const LOCAL_ID = 940003;

let fixture = null;

async function loadFixture() {
  if (fixture) return fixture;
  const app = await import("../src/db.js");
  const uid = app.defaultUserId();
  const stamp = "2026-09-07T00:00:00.000Z";
  const seed = (postId) => app.upsertListing({
    post_id: postId,
    source: "591",
    source_id: String(postId),
    source_key: `1|8|${postId}`,
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
  });
  seed(PG_ID);
  seed(SQLITE_ID);
  seed(LOCAL_ID);
  const db = app.sqliteHandle();
  db.prepare("UPDATE listings SET geo_source = 'geocode', content_seq = 3 WHERE post_id > 0").run();
  const jobKey = (postId) => `${postId}|to_work|distance|scooter|25.033,121.5654`;
  const insertJob = db.prepare("INSERT INTO route_jobs (job_key, post_id, direction, kind, commute_mode, job_state, updated_at) VALUES (?, ?, 'to_work', 'distance', 'scooter', 'failed', ?)");
  // One job per listing: the local test invalidates its own, so the mirrored (live) one survives.
  insertJob.run(jobKey(PG_ID), PG_ID, stamp);
  insertJob.run(jobKey(LOCAL_ID), LOCAL_ID, stamp);
  ensureDataRevisionTable(db);
  fixture = { app, uid };
  return fixture;
}

// The state these writes touch, read back through the crawler's own entry point.
async function stateOf(app, uid, postId, options = {}) {
  const { listingForWatchAsync } = await import("../src/crawlerReads.js");
  const row = await listingForWatchAsync(postId, uid, { sameHouse: false, ...options });
  if (!row) return null;
  return {
    offline: Number(row.offline) || 0,
    offline_confirmed: Number(row.offline_confirmed) || 0,
    last_event: String(row.last_event || ""),
    offline_at_set: Boolean(row.offline_at),
    last_checked_at_set: Boolean(row.last_checked_at),
    alive_checked_at_set: Boolean(row.alive_checked_at),
    content_seq: Number(row.content_seq) || 0,
  };
}

function existingTables(sqliteDb, tables) {
  const have = new Set(
    sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  return tables.filter((name) => have.has(name));
}

async function withMirroredSchema(app, fn) {
  const sqliteDb = app.sqliteHandle();
  const schema = `pgstate_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}`;
  const pgDriver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 3, options: `-c search_path=${schema}`, application_name: "5151-state-writes" },
  });
  try {
    await importStore(pgDriver, sqliteDb, { schema, tables: existingTables(sqliteDb, TABLES) });
    return await fn(pgDriver);
  } finally {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.close();
  }
}

test("the state writes go through the driver-aware entry point", async () => {
  const { app, uid } = await loadFixture();
  const {
    invalidateListingLocationAsync,
    markListingAliveAsync,
    markListingOfflineAsync,
    restoreListingOnlineAsync,
    touchListingCheckedAsync,
  } = await import("../src/crawlerWrites.js");

  const before = await stateOf(app, uid, LOCAL_ID);
  // sqlite driver: the db.js behaviour, awaited.
  await markListingOfflineAsync(LOCAL_ID, { driver: "sqlite" });
  const off = await stateOf(app, uid, LOCAL_ID);
  assert.equal(off.offline, 1);
  assert.equal(off.last_event, "offline");
  assert.equal(off.offline_at_set, true);
  assert.ok(off.content_seq > before.content_seq, "the change counter advances");

  await markListingAliveAsync(LOCAL_ID, { driver: "sqlite" });
  const alive = await stateOf(app, uid, LOCAL_ID);
  assert.equal(alive.offline, 0);
  assert.equal(alive.alive_checked_at_set, true);

  await restoreListingOnlineAsync(LOCAL_ID, { driver: "sqlite" });
  const back = await stateOf(app, uid, LOCAL_ID);
  assert.equal(back.offline, 0);
  assert.equal(back.offline_at_set, false);

  await touchListingCheckedAsync(LOCAL_ID, { driver: "sqlite" });
  assert.equal((await stateOf(app, uid, LOCAL_ID)).last_checked_at_set, true);

  const db = app.sqliteHandle();
  const jobCount = (postId) => db.prepare("SELECT COUNT(*) AS n FROM route_jobs WHERE post_id = ?").get(postId).n;
  assert.equal(jobCount(LOCAL_ID), 1);
  await invalidateListingLocationAsync(LOCAL_ID, { driver: "sqlite" });
  assert.equal(jobCount(LOCAL_ID), 0);
  assert.equal(jobCount(PG_ID), 1, "only the invalidated listing's jobs are cleared");

  // Wiring: the loops and the two member handlers await the driver-aware writes.
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(watcher, /await markListingOfflineAsync\(postId\);/);
  assert.match(watcher, /await markListingAliveAsync\(row\.post_id, \{ wasOffline: Boolean\(listing\.offline\) \}\);/);
  assert.match(watcher, /markGoneAsync: \(id\) => markListingOfflineAsync\(id\)/);
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /await markListingOfflineAsync\(postId\);/);
  assert.match(server, /await markListingAliveAsync\(postId, \{ wasOffline: Boolean\(listing\.offline\) \}\);/);
  assert.doesNotMatch(server, /(?<![A-Za-z])markListingOffline\(/);
  assert.doesNotMatch(server, /(?<![A-Za-z])markListingAlive\(/);
  const queue = readFileSync(path.join(dir, "../src/listingEnrichQueue.js"), "utf8");
  assert.match(queue, /runHelper\(helpers, "markGone", listing\.post_id\)/);
  assert.match(queue, /runHelper\(helpers, "markAlive", listing\.post_id\)/);
  assert.match(queue, /function runHelper\(helpers, name, \.\.\.args\)/);
});

test("live PostgreSQL: the state writes land where the site reads", { skip }, async (t) => {
  const { app, uid } = await loadFixture();
  const writes = await import("../src/crawlerWrites.js");
  const pgOptions = (pgDriver) => ({ driver: "postgres", pgDriver, strict: true });
  const pgRead = (pgDriver) => ({ driver: "postgres", pgDriver, deps: app.crawlerReadsBuildContext(), strict: true });

  await t.test("offline -> alive -> restored -> checked match SQLite field for field", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const start = await stateOf(app, uid, PG_ID, pgRead(pgDriver));
      assert.equal(start.offline, 0);
      const twinStart = await stateOf(app, uid, SQLITE_ID);
      assert.deepEqual(start, twinStart, "both listings start from the same imported state");

      await writes.markListingOfflineAsync(PG_ID, pgOptions(pgDriver));
      app.markListingOffline(SQLITE_ID);
      const offPg = await stateOf(app, uid, PG_ID, pgRead(pgDriver));
      assert.deepEqual(offPg, await stateOf(app, uid, SQLITE_ID));
      assert.equal(offPg.offline, 1);
      assert.ok(offPg.content_seq > start.content_seq, "the PostgreSQL row's counter advanced");

      await writes.markListingAliveAsync(PG_ID, { ...pgOptions(pgDriver), wasOffline: true });
      app.markListingAlive(SQLITE_ID);
      assert.deepEqual(await stateOf(app, uid, PG_ID, pgRead(pgDriver)), await stateOf(app, uid, SQLITE_ID));

      await writes.restoreListingOnlineAsync(PG_ID, pgOptions(pgDriver));
      app.restoreListingOnline(SQLITE_ID);
      assert.deepEqual(await stateOf(app, uid, PG_ID, pgRead(pgDriver)), await stateOf(app, uid, SQLITE_ID));

      await writes.touchListingCheckedAsync(PG_ID, pgOptions(pgDriver));
      app.touchListingChecked(SQLITE_ID);
      assert.deepEqual(await stateOf(app, uid, PG_ID, pgRead(pgDriver)), await stateOf(app, uid, SQLITE_ID));
    });
  });

  await t.test("invalidateLocation clears the route_jobs rows", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const before = await pgDriver.query("SELECT COUNT(*) AS n FROM route_jobs WHERE post_id = $1", [PG_ID]);
      assert.equal(Number(before.rows[0].n), 1);
      await writes.invalidateListingLocationAsync(PG_ID, pgOptions(pgDriver));
      const after = await pgDriver.query("SELECT COUNT(*) AS n FROM route_jobs WHERE post_id = $1", [PG_ID]);
      assert.equal(Number(after.rows[0].n), 0);
    });
  });
});



