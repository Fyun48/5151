// Listing FIELD writes parity: what the loops enrich has to land in the store the site reads.
//
// db.js setListingDetail() / persistHpListingFields() / setCachedMrt() / setCommunityCache() and
// listingEnrichQueue.upsertListingPrep() are synchronous SQLite statements. Once the crawler reads
// its work from PostgreSQL, these writes decide what the site shows - so crawlerWrites.js gives
// them one async entry point (the same repository dispatch the state writes use) and this suite
// pins the result to the SQLite answer on both drivers.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { importStore } from "../src/pgSchema.js";
import { ensureDataRevisionTable } from "../src/dataRevision.js";
import { evaluateHpPrep } from "../src/listingPrep.js";
import { makeMrtKey } from "../src/mrt.js";
import { ensureListingPrepSchema, upsertListingPrep } from "../src/listingEnrichQueue.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-field-writes-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const skip = PG_TEST_URL ? false : "PG_TEST_URL is not set (live PostgreSQL field writes)";

// Everything the field writes touch plus what the decorated read of them needs.
const TABLES = [
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
  "community_cache",
  "user_events",
  "geo_cache",
];

// One pair per write: the PostgreSQL twin and the SQLite twin start identical, and the SQLite
// write happens after the mirror, so the comparison starts from the same row on both sides.
const DETAIL_PG = 940101;
const DETAIL_SQLITE = 940102;
const HP_PG = 940103;
const HP_SQLITE = 940104;

let fixture = null;

async function loadFixture() {
  if (fixture) return fixture;
  const app = await import("../src/db.js");
  const uid = app.defaultUserId();
  const stamp = "2026-09-07T00:00:00.000Z";
  const seed = (postId, posting = {}) => app.upsertListing({
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
    ...posting,
  });
  // The twin pair must start byte-identical (the projection excludes the post_id itself).
  const detail = { title: "合成住宅", source_key: "1|8|twin", address: "台北市士林區測試路" };
  seed(DETAIL_PG, detail);
  seed(DETAIL_SQLITE, detail);
  // The 5168 rows carry what evaluateHpPrep() reads (floor, facility, address precision).
  const hp = {
    source: "houseprice",
    source_id: "16470110",
    source_key: "1|8||台北市士林區測試路|4|19|1房",
    url: "https://rent.houseprice.tw/house/16470110",
    title: "測試路套房",
    price: "28000",
    price_num: 28000,
    address: "台北市士林區測試路 9 巷 3 號",
    area_name: "19坪",
    layout: "1房1廳1衛",
    floor_name: "",
    kind_name: "整層住家",
    role_name: "5168",
    geo_source: "houseprice",
    lat: 25.1105,
    lng: 121.529,
    extra_fees_fetched: 1,
    contact_fetched: 1,
  };
  seed(HP_PG, hp);
  seed(HP_SQLITE, hp);
  const db = app.sqliteHandle();
  db.prepare("UPDATE listings SET geo_source = 'geocode', content_seq = 3, extra_fees_fetched = 1 WHERE post_id > 0").run();
  db.prepare("UPDATE listings SET geo_source = 'houseprice' WHERE post_id IN (?, ?)").run(HP_PG, HP_SQLITE);
  db.prepare("UPDATE listings SET extra_fees = ? WHERE post_id > 0").run(JSON.stringify([{ name: "管理費", amount: 500 }]));
  ensureListingPrepSchema(db);
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
  const schema = `pgfields_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}`;
  const pgDriver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 3, options: `-c search_path=${schema}`, application_name: "5151-field-writes" },
  });
  try {
    await importStore(pgDriver, sqliteDb, { schema, tables: existingTables(sqliteDb, TABLES) });
    return await fn(pgDriver, schema);
  } finally {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.close();
  }
}

// The SQLite driver path is unchanged: the async twin delegates to the same db.js write, and the
// enrich worker's bundle wiring is what selects the driver-aware variant.
test("the field writes go through the driver-aware entry point", async () => {
  const { app } = await loadFixture();
  const writes = await import("../src/crawlerWrites.js");
  const options = { driver: "sqlite" };
  const input = detailInput();

  app.setListingDetail(DETAIL_SQLITE, input);
  await writes.setListingDetailAsync(DETAIL_PG, input, options);
  assert.deepEqual(sqliteFields(app, DETAIL_PG), sqliteFields(app, DETAIL_SQLITE), "setListingDetail (sqlite)");

  const next = { ...input, lat: 25.2, lng: 121.6, geo_source: "591", floor_name: "4/4" };
  app.persistHpListingFields(HP_SQLITE, next, { locationChanged: true, previous: null });
  await writes.persistHpListingFieldsAsync(HP_PG, next, { ...options, locationChanged: true });
  assert.deepEqual(sqliteFields(app, HP_PG), sqliteFields(app, HP_SQLITE), "persistHpListingFields (sqlite)");

  await writes.setCachedMrtAsync(25.31, 121.71, { resolved: true, station: "士林", walk_km: 0.4 }, options);
  app.setCachedMrt(25.31, 121.71, { resolved: true, station: "士林", walk_km: 0.4 });
  assert.deepEqual(
    sqliteCacheRow(app, "mrt_cache", "geo_key", makeMrtKey(25.31, 121.71)),
    { geo_key: makeMrtKey(25.31, 121.71), station: "士林", walk_km: 0.4, walk_min: null, ride_km: null, ride_min: null },
    "setCachedMrt (sqlite)",
  );

  await writes.setCommunityCacheAsync({ id: 771, name: "甲社區", address: "台北市士林區", lat: 25.1, lng: 121.5 }, options);
  app.setCommunityCache({ id: 771, name: "甲社區", address: "台北市士林區", lat: 25.1, lng: 121.5 });
  assert.equal(sqliteCacheRow(app, "community_cache", "community_id", 771)?.name, "甲社區", "setCommunityCache (sqlite)");

  // The enrich worker asks for the Async helpers by name (runHelper) and the prep write has its
  // own seam, so a PostgreSQL bundle stores listing_prep in PostgreSQL.
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  for (const key of ["persistHpListingFieldsAsync", "upsertListingPrepAsync"]) {
    assert.match(watcher, new RegExp(`\\n    ${key}:`), `${key} is exposed in the enrich helper bundle`);
  }
  const queue = readFileSync(path.join(dir, "../src/listingEnrichQueue.js"), "utf8");
  assert.match(queue, /runHelper\(helpers, "persistHpListingFields", current\.post_id, next, \{/);
  assert.match(queue, /function prepWrite\(helpers, conn, postId, listing, evalResult\)/);
  assert.match(queue, /helpers\.upsertListingPrepAsync\(postId, listing, evalResult\)/);
  // The field writes the loops make all have an async twin now.
  for (const name of [
    "setListingDetailAsync",
    "persistHpListingFieldsAsync",
    "setCachedMrtAsync",
    "setCommunityCacheAsync",
    "upsertListingPrepAsync",
  ]) {
    assert.equal(typeof writes[name], "function", `${name} is exported by crawlerWrites.js`);
  }
});

// The bug this slice fixes: every field the 591/5168 loops enrich used to be written through the
// SQLite handle, so with DB_DRIVER=postgres the site never saw it. Here the PostgreSQL write and
// the SQLite write are applied to twin rows and compared column by column.
test("live PostgreSQL: the field writes land in the same store as the reads", { skip }, async (t) => {
  const { app } = await loadFixture();
  const writes = await import("../src/crawlerWrites.js");
  // No `deps` here: each facade defaults to its own bundle (reads vs field writes).
  const pgOptions = (pgDriver) => ({ driver: "postgres", pgDriver, strict: true });

  await t.test("setListingDetail writes the detail columns", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const input = detailInput();
      app.setListingDetail(DETAIL_SQLITE, input);
      await writes.setListingDetailAsync(DETAIL_PG, input, pgOptions(pgDriver));
      assert.deepEqual(await pgFields(pgDriver, DETAIL_PG), sqliteFields(app, DETAIL_SQLITE));
    });
  });

  await t.test("persistHpListingFields writes the 5168 columns and kit", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const next = {
        title: "測試路套房 2.0",
        price: "29000",
        price_num: 29000,
        floor_name: "4/4",
        has_natural_gas: 1,
        has_balcony: 0,
        furnish_items: ["冰箱", "洗衣機"],
        tags: '["冰箱"]',
        lat: 25.2,
        lng: 121.6,
        geo_source: "houseprice",
      };
      app.persistHpListingFields(HP_SQLITE, next, { locationChanged: true });
      await writes.persistHpListingFieldsAsync(HP_PG, next, { ...pgOptions(pgDriver), locationChanged: true });
      assert.deepEqual(await pgFields(pgDriver, HP_PG), sqliteFields(app, HP_SQLITE));
    });
  });

  await t.test("the MRT and community caches are written where the reads look", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const access = { resolved: true, station: "芝山", walk_km: 0.42, walk_min: 6, ride_km: 2.1, ride_min: 9 };
      app.setCachedMrt(25.41, 121.81, access);
      await writes.setCachedMrtAsync(25.41, 121.81, access, pgOptions(pgDriver));
      assert.deepEqual(
        await pgRow(pgDriver, "mrt_cache", "geo_key", makeMrtKey(25.41, 121.81)),
        sqliteCacheRow(app, "mrt_cache", "geo_key", makeMrtKey(25.41, 121.81)),
      );

      const community = { id: 881, name: "測試社區", address: "台北市士林區", lat: 25.1, lng: 121.52 };
      app.setCommunityCache(community);
      await writes.setCommunityCacheAsync(community, pgOptions(pgDriver));
      assert.deepEqual(
        await pgRow(pgDriver, "community_cache", "community_id", 881),
        sqliteCacheRow(app, "community_cache", "community_id", 881),
      );
      // The 591 geo scan reads this table back, so the write has to satisfy it.
      const { needing591GeoAsync } = await import("../src/crawlerReads.js");
      assert.deepEqual(
        await needing591GeoAsync({ limit: 20 }, pgOptions(pgDriver)),
        app.listingsNeeding591Geo(20),
      );
    });
  });

  await t.test("the 5168 prep row is stored in PostgreSQL", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const evalResult = evaluateHpPrep(
        { ...app.sqliteHandle().prepare("SELECT * FROM listings WHERE post_id = ?").get(HP_PG) },
        { fetched: true, detailRecognized: true, facilityBlock: true },
      );
      const sqlitePrep = upsertListingPrepById(app, HP_SQLITE, evalResult);
      const applied = await writes.upsertListingPrepAsync(HP_PG, null, evalResult, pgOptions(pgDriver));
      assert.equal(
        applied.becomingReady,
        sqlitePrep.becomingReady,
        "the prep write reaches the same decision on both drivers",
      );
      const pgPrep = await pgRow(pgDriver, "listing_prep", "post_id", HP_PG);
      const prep = sqliteCacheRow(app, "listing_prep", "post_id", HP_SQLITE);
      assert.deepEqual(pgPrep, { ...prep, post_id: HP_PG });
      assert.equal(pgPrep.ready_at_set, true, "ready_at is stamped by the PostgreSQL write too");
    });
  });
});

// Cache/prep rows are compared without updated_at (a "now" on both sides).
function sqliteCacheRow(app, table, column, value) {
  const row = app.sqliteHandle().prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).get(value);
  if (!row) return null;
  const clean = { ...row };
  delete clean.updated_at;
  delete clean.checked_at;
  if (Object.prototype.hasOwnProperty.call(clean, "ready_at")) {
    clean.ready_at_set = Boolean(clean.ready_at);
    delete clean.ready_at;
  }
  return clean;
}

// The SQLite side of the prep parity: same statement, handled connection.
function upsertListingPrepById(app, postId, evalResult) {
  return upsertListingPrep(app.sqliteHandle(), postId, null, evalResult);
}

function normalizeJson(value) {
  if (value == null || value === "") return [];
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function fieldColumns(row) {
  if (!row) return null;
  const num = (value) => Number(value) || 0;
  const text = (value) => String(value ?? "");
  return {
    extra_fees: normalizeJson(row.extra_fees),
    extra_fees_fetched: num(row.extra_fees_fetched),
    contact_name: text(row.contact_name),
    mobile: text(row.mobile),
    phone: text(row.phone),
    agency: text(row.agency),
    contact_fetched: num(row.contact_fetched),
    contact_uid: text(row.contact_uid),
    lat: num(row.lat),
    lng: num(row.lng),
    geo_source: text(row.geo_source),
    address: text(row.address),
    community_id: num(row.community_id),
    community_name: text(row.community_name),
    community_linked: num(row.community_linked),
    has_natural_gas: num(row.has_natural_gas),
    has_balcony: num(row.has_balcony),
    furnish_items: normalizeJson(row.furnish_items),
    kit_fetched: num(row.kit_fetched),
    geo_approx: num(row.geo_approx),
    // The version is a "bump token" (Date.now()), so only its presence is comparable.
    coord_version_set: num(row.coord_version) > 0,
    content_seq: num(row.content_seq),
    location_class: text(row.location_class),
    address_norm: text(row.address_norm),
    geo_provider: text(row.geo_provider),
    geo_job_state: text(row.geo_job_state),
    title: text(row.title),
    price: text(row.price),
    price_num: num(row.price_num),
    floor_name: text(row.floor_name),
    area_name: text(row.area_name),
    layout: text(row.layout),
    kind_name: text(row.kind_name),
    tags: normalizeJson(row.tags),
    source_key: text(row.source_key),
  };
}

function sqliteFields(app, postId) {
  const row = app.sqliteHandle().prepare("SELECT * FROM listings WHERE post_id = ?").get(postId);
  return fieldColumns(row ? { ...row } : null);
}

async function pgRow(pgDriver, table, idColumn, id) {
  const result = await pgDriver.query(`SELECT * FROM ${table} WHERE ${idColumn} = $1`, [id]);
  const row = (result.rows || [])[0];
  if (!row) return null;
  const clean = { ...row };
  delete clean.updated_at;
  delete clean.checked_at;
  if (Object.prototype.hasOwnProperty.call(clean, "ready_at")) {
    clean.ready_at_set = Boolean(clean.ready_at);
    delete clean.ready_at;
  }
  return clean;
}

async function pgFields(pgDriver, postId) {
  return fieldColumns(await pgRow(pgDriver, "listings", "post_id", Number(postId)));
}

// The detail payload the 591 backfill applies (compact but complete: contact, fees, coordinates).
function detailInput() {
  return {
    extraFees: [{ name: "管理費", amount: 800 }],
    contact: { contact_name: "王先生", mobile: "0911-000-000", agency: "測試房仲" },
    fetched: 1,
    lat: 25.1088,
    lng: 121.5244,
    address: "台北市士林區測試路 7 號",
    community_id: 555,
    community_name: "測試社區",
    geo_source: "591",
    has_natural_gas: 1,
    has_balcony: 1,
    furnish_items: ["冰箱", "洗衣機"],
    kit_fetched: 1,
  };
}
