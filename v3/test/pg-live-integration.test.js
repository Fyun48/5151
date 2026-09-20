import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { ensurePgSchema, importTable } from "../src/pgSchema.js";
import { createListingsRepository } from "../src/repository/listings.js";
import { createJobQueue, POSTGRES_JOB_QUEUE_DDL } from "../src/jobQueue.js";

// Live PostgreSQL integration. Gated on PG_TEST_URL so CI (no PostgreSQL yet)
// stays green and `npm test` on a laptop without a server is unaffected.
//
//   PG_TEST_URL=postgres://postgres:<pw>@<host>:15432/5151_shadow \
//     node --test v3/test/pg-live-integration.test.js
//
// The test creates and drops its own schema (`pgtest_<random>`), so it never
// touches existing tables — the run must be pointed at a NON-production database
// (the shadow cluster). PG_TEST_STANDBY_URL is optional and only asserts that
// the streamed schema is visible on the standby.
const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const PG_TEST_STANDBY_URL = (process.env.PG_TEST_STANDBY_URL || "").trim();
const skip = PG_TEST_URL ? false : "PG_TEST_URL is not set (live PostgreSQL integration test)";
// Every table the SQL-first statement touches, including the visibility clauses'
// dependencies (listing_prep for the houseprice display gate).
const TABLES = ["listings", "listing_prep", "listing_search_projection", "user_listing_flags"];

function seedListings(app) {
  const uid = app.defaultUserId();
  for (let i = 1; i <= 120; i++) {
    const inScope = i % 3 !== 0;
    const stamp = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
    app.upsertListing({
      post_id: i, source: "591", source_id: String(i),
      source_key: (inScope ? "1|8|" : "1|9|") + i, search_key: "https://example.test/search",
      title: "合成住宅 " + i, url: "https://example.test/listing/" + i,
      price: `${9000 + (i * 173) % 51000}元`, price_num: 9000 + (i * 173) % 51000,
      extra_fee: i % 4 === 0 ? 1500 : 0, extra_fees: [],
      address: (inScope ? "台北市士林區" : "台北市北投區") + "測試路" + i + "號", area_name: "20坪",
      layout: "2房1廳1衛", floor_name: i % 7 === 0 ? "1/5" : "5/12",
      kind_name: "整層住家/電梯大樓", role_name: "",
      cover: "https://example.test/cover.png", tags: "[]",
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    });
  }
  return uid;
}

function settingsFor(app, uid) {
  return {
    ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
    priceMin: 0, priceMax: 0, priceMaxIncludesExtras: true,
    commuteKm: 0, wholeFloorOnly: false,
    excludeLowFloors: false, excludeRooftop: false, hasParking: false,
    excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
    areaMax: 0, minBuildingFloors: 0,
  };
}

test("live PostgreSQL: driver, schema import, listings parity and queue claim", { skip }, async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-pg-live-"));
  process.env.DATA_DIR = dataDir;
  const app = await import("../src/db.js");
  const uid = seedListings(app);
  const settings = settingsFor(app, uid);
  const schema = `pgtest_${Date.now().toString(36)}_${Math.floor(Math.random() * 10000)}`;
  const driver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 4, application_name: "5151-pgtest" },
  });
  // Two pools with search_path pinned to this run's schema = the two runtime
  // nodes (the shared builder emits unqualified table names, so the connection's
  // search_path is what scopes them).
  const scoped = { max: 3, options: `-c search_path=${schema}` };
  const nodeA = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { ...scoped, application_name: "5151-pgtest-a" },
  });
  const nodeB = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { ...scoped, application_name: "5151-pgtest-b" },
  });
  let subtests = 0;
  // Counts every subtest that actually ran (t.test() returns undefined, so the
  // count is the only honest "did the whole live suite execute" signal).
  const step = async (name, fn) => {
    subtests += 1;
    return t.test(name, fn);
  };
  try {
    const health = await driver.healthCheck();

    await step("driver health check reports the server role", () => {
      assert.equal(health.ok, true);
      assert.equal(typeof health.inRecovery, "boolean");
    });

    const ddl = await ensurePgSchema(driver, app.sqliteHandle(), { schema, tables: TABLES, indexes: false });
    assert.deepEqual(ddl.tables.sort(), [...TABLES].sort());
    const copied = {};
    for (const table of TABLES) copied[table] = await importTable(driver, app.sqliteHandle(), table, { schema });
    const sqliteCounts = {};
    for (const table of TABLES) {
      sqliteCounts[table] = Number(app.sqliteHandle().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    }

    await step("the SQLite schema is mirrored into PostgreSQL with identical row counts", async () => {
      for (const table of TABLES) {
        const res = await driver.query(`SELECT COUNT(*) AS n FROM ${schema}.${table}`);
        assert.equal(Number(res.rows[0].n), sqliteCounts[table], `${table} row count`);
        assert.equal(copied[table], sqliteCounts[table], `${table} copied`);
      }
    });

    await step("import is idempotent (re-import adds no rows)", async () => {
      const again = await importTable(driver, app.sqliteHandle(), "listings", { schema });
      const res = await driver.query(`SELECT COUNT(*) AS n FROM ${schema}.listings`);
      assert.equal(Number(res.rows[0].n), sqliteCounts.listings);
      assert.equal(again, sqliteCounts.listings, "every row was re-sent");
    });

    const repo = createListingsRepository({
      driver: "postgres",
      pgDriver: nodeA,
      schema,
      deps: app.listingSearchBuildContext(),
    });

    await step("listings search returns the same ids/order/paging/cursor as the SQLite path", async () => {
      for (const sort of ["newest", "price_asc", "price_desc"]) {
        const base = { userId: uid, searchKeys: [], settings, sort, limit: 25, districts: ["士林區", "北投區"] };
        const legacy = app.listListingsSqlFirst(base);
        assert.ok(legacy, `sql-first should be supported for ${sort}`);
        const page = await repo.searchPage(base);
        assert.ok(page, `postgres repository should support ${sort}`);
        assert.equal(page.driver, "postgres");
        assert.deepEqual(page.ids, legacy.listings.map((row) => Number(row.post_id)), `${sort} ids/order`);
        assert.equal(page.totalMatched, legacy.totalMatched, `${sort} total`);
        assert.equal(page.hasMore, legacy.hasMore, `${sort} hasMore`);
        assert.equal(page.nextOffset, legacy.nextOffset, `${sort} nextOffset`);
        assert.deepEqual(page.nextCursor, legacy.nextCursor, `${sort} nextCursor`);

        const offsetPage = await repo.searchPage({ ...base, offset: 25 });
        const legacyOffset = app.listListingsSqlFirst({ ...base, offset: 25 });
        assert.deepEqual(offsetPage.ids, legacyOffset.listings.map((row) => Number(row.post_id)), `${sort} offset page`);

        const cursorPage = await repo.searchPage({ ...base, cursor: page.nextCursor });
        const legacyCursor = app.listListingsSqlFirst({ ...base, cursor: page.nextCursor });
        assert.deepEqual(cursorPage.ids, legacyCursor.listings.map((row) => Number(row.post_id)), `${sort} cursor page`);
        assert.equal(page.ids.filter((id) => cursorPage.ids.includes(id)).length, 0, `${sort} no overlap`);

        const rows = await repo.hydrate(page.ids);
        assert.deepEqual(rows.map((row) => Number(row.post_id)), page.ids, `${sort} hydrate order`);
        assert.match(String(rows[0].title), /合成住宅/);
      }
    });

    await step("outside the envelope the PostgreSQL repository reports null (Node fallback)", async () => {
      assert.equal(await repo.searchPage({ userId: uid, searchKeys: [], settings, sort: "newest", filter: "watched" }), null);
      assert.equal(await repo.searchPage({ userId: uid, searchKeys: [], settings: { ...settings, priceMax: 25000 }, sort: "newest" }), null);
    });

    await step("durable queue: two workers never claim the same job (FOR UPDATE SKIP LOCKED)", async () => {
      await nodeA.exec(POSTGRES_JOB_QUEUE_DDL); // search_path=schema on this pool
      const workerA = createJobQueue({ driver: "postgres", pgPool: nodeA.pool });
      const workerB = createJobQueue({ driver: "postgres", pgPool: nodeB.pool });
      const now = Date.now();
      for (let i = 1; i <= 6; i++) {
        await workerA.enqueue({ jobType: "enrich", payload: { i }, priority: 20, now, availableAt: now });
      }
      const [claimedA, claimedB] = await Promise.all([
        workerA.claim({ workerId: "worker-a", limit: 4, now }),
        workerB.claim({ workerId: "worker-b", limit: 4, now }),
      ]);
      const idsA = claimedA.map((row) => Number(row.id));
      const idsB = claimedB.map((row) => Number(row.id));
      assert.equal(idsA.length, 4, "worker A claims its share");
      assert.equal(idsB.length, 2, "worker B only gets what is left");
      assert.equal(idsA.filter((id) => idsB.includes(id)).length, 0, "no duplicate claim");
      assert.equal(new Set([...idsA, ...idsB]).size, 6);

      // Ownership: only the claiming worker may complete its job.
      assert.equal(await workerB.complete({ jobId: idsA[0], workerId: "worker-b", now }), false);
      assert.equal(await workerA.complete({ jobId: idsA[0], workerId: "worker-a", now }), true);
    });

    await step("durable queue: expired lease is reclaimed and re-claimed by the other worker", async () => {
      const workerA = createJobQueue({ driver: "postgres", pgPool: nodeA.pool });
      const workerB = createJobQueue({ driver: "postgres", pgPool: nodeB.pool });
      const now = Date.now();
      const job = await workerA.enqueue({ jobType: "geo", payload: { crash: true }, now, availableAt: now });
      const jobId = Number(job.id);
      const claimed = await workerA.claim({ workerId: "worker-a", limit: 1, leaseDurationMs: 40, now });
      assert.equal(Number(claimed[0].id), jobId);

      // Worker A "dies"; after the lease expires worker B reclaims the job.
      const later = now + 5_000;
      assert.equal(await workerB.reclaimExpired({ now: later }), 1);
      const reclaimed = await workerB.claim({ workerId: "worker-b", limit: 1, now: later });
      assert.equal(reclaimed.length, 1);
      assert.equal(Number(reclaimed[0].id), jobId, "the same durable job, not a new one");
      assert.equal(reclaimed[0].lease_owner, "worker-b");
    });

    await step("durable queue: idempotency key collapses duplicate enqueues", async () => {
      const workerA = createJobQueue({ driver: "postgres", pgPool: nodeA.pool });
      const now = Date.now();
      const first = await workerA.enqueue({ jobType: "crm", payload: { k: 1 }, idempotencyKey: `parity-${schema}`, now });
      const second = await workerA.enqueue({ jobType: "crm", payload: { k: 1 }, idempotencyKey: `parity-${schema}`, now });
      assert.equal(Number(second.id), Number(first.id));
      const res = await driver.query(
        `SELECT COUNT(*) AS n FROM ${schema}.job_queue WHERE idempotency_key = $1`,
        [`parity-${schema}`],
      );
      assert.equal(Number(res.rows[0].n), 1);
    });

    if (PG_TEST_STANDBY_URL) {
      const standby = await createPostgresDriver({ connectionString: PG_TEST_STANDBY_URL, poolOptions: { max: 1 } });
      try {
        await step("the test schema is visible on the standby (streaming replication)", async () => {
          const role = await standby.healthCheck();
          assert.equal(role.inRecovery, true, "PG_TEST_STANDBY_URL must point at the standby");
          const res = await standby.query(`SELECT COUNT(*) AS n FROM ${schema}.listings`);
          assert.equal(Number(res.rows[0].n), sqliteCounts.listings);
        });
      } finally {
        await standby.close();
      }
    }
  } finally {
    await driver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await driver.close();
    await nodeA.close();
    await nodeB.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
  assert.ok(subtests >= 8, `expected the full live suite to run, got ${subtests} subtests`);
});
