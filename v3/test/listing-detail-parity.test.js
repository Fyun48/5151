// Listing-detail parity: a card the list served has to be readable from the same store.
//
// db.js getListing() is a synchronous SQLite read; with DB_DRIVER=postgres the list comes from
// PostgreSQL, so every detail surface (/go, /api/listings/:id/history, recheck, report-gone)
// would 404 or show a different row. This suite pins the two drivers to the same object - on
// SQLite always, and on the shadow PostgreSQL when PG_TEST_URL is set (same gate as
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
// DATA_DIR has to be in place before db.js is imported, so every import of it here is dynamic.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-detail-parity-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const skip = PG_TEST_URL ? false : "PG_TEST_URL is not set (live PostgreSQL detail parity)";

// The row plus everything the detail decorators and their providers read.
const TABLES = [
  "listings",
  "user_listing_flags",
  "user_same_house_members",
  "user_match_votes",
  "listing_group_members",
  "listing_prep",
  "route_cache",
  "mrt_cache",
  "route_jobs",
];

const DETAIL_IDS = [910001, 910002, 910003, 910005, 999999];

let fixture = null;

// One fixture, four shapes: a plain row that also has a match peer, a row the member has
// flagged, a houseprice row (the listing_prep display gate), a Stage 1 fixture row (invisible on
// this surface) and an id that does not exist.
async function loadFixture() {
  if (fixture) return fixture;
  const app = await import("../src/db.js");
  const uid = app.defaultUserId();
  const stamp = "2026-09-05T00:00:00.000Z";
  const seed = (postId, extra = {}) => app.upsertListing({
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
    ...extra,
  });
  seed(910001);
  seed(910002);
  seed(910003, { source: "houseprice" });
  seed(910005);

  const db = app.sqliteHandle();
  // Columns upsertListing() does not carry (trusted geo, match state, fixture namespace).
  db.prepare("UPDATE listings SET geo_source = 'geocode' WHERE post_id != 910004").run();
  db.prepare("UPDATE listings SET match_post_id = 910002, match_level = 'high' WHERE post_id = 910001").run();
  db.prepare("UPDATE listings SET fixture_namespace = 'stage1-fix' WHERE post_id = 910005").run();
  app.setFlags(910002, { viewed: true, watched: true }, uid);
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
  const schema = `pgdetail_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}`;
  const pgDriver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 3, options: `-c search_path=${schema}`, application_name: "5151-detail-parity" },
  });
  try {
    const tables = existingTables(sqliteDb, TABLES);
    await ensurePgSchema(pgDriver, sqliteDb, { schema, tables, indexes: false });
    for (const table of tables) await importTable(pgDriver, sqliteDb, table, { schema });
    return await fn(pgDriver);
  } finally {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.close();
  }
}

test("detail reads go through the driver-aware entry point", async () => {
  const { app, uid } = await loadFixture();
  const { getListingAsync } = await import("../src/listingDetailAsync.js");
  // sqlite driver: byte-for-byte the synchronous read, including the two undefined cases.
  for (const id of DETAIL_IDS) {
    assert.deepEqual(
      await getListingAsync(id, uid, { driver: "sqlite" }),
      app.getListing(id, uid),
      `sqlite detail for ${id}`,
    );
  }
  assert.equal(await getListingAsync(910005, uid, { driver: "sqlite" }), undefined);
  assert.equal(await getListingAsync(999999, uid, { driver: "sqlite" }), undefined);

  // Wiring: every detail surface awaits it, and no bare synchronous read is left in server.js.
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /import \{ getListingAsync \} from "\.\/listingDetailAsync\.js";/);
  assert.match(server, /listing = await getListingAsync\(id\);/);
  assert.match(server, /await getListingAsync\(id, session\.userId\)/);
  assert.match(server, /const listing = await getListingAsync\(Number\(req\.params\.id\), uid\);/);
  assert.match(server, /const listing = await getListingAsync\(postId\);/);
  assert.doesNotMatch(server, /\bgetListing\(/);
});

test("live PostgreSQL: the detail read matches the SQLite read", { skip }, async (t) => {
  const { app, uid } = await loadFixture();
  const { getListingAsync } = await import("../src/listingDetailAsync.js");
  const deps = app.listingSearchBuildContext();

  await t.test("member detail for every shape", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      for (const id of DETAIL_IDS) {
        const expected = app.getListing(id, uid);
        const actual = await getListingAsync(id, uid, {
          driver: "postgres",
          pgDriver,
          deps,
          settings: app.getSettings(uid),
          strict: true,
        });
        assert.deepEqual(actual, expected, `detail parity for ${id}`);
      }
    });
  });

  await t.test("sameHouse:false (the crawler's read) still matches", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const expected = app.getListing(910001, uid, { sameHouse: false });
      const actual = await getListingAsync(910001, uid, {
        driver: "postgres",
        pgDriver,
        deps,
        settings: app.getSettings(uid),
        sameHouse: false,
        strict: true,
      });
      assert.deepEqual(actual, expected);
    });
  });
});

