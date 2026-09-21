// Write-path parity: the same payload must produce identical rows on SQLite and PostgreSQL.
//
// repository/writePath.js restates the hot-path writes (user_listing_flags / route_cache /
// route_jobs) against an injected executor. This test drives the same sequence of upserts through
// both drivers and compares what repository/decorationData.js reads back - the read loaders are the
// same ones the decorated list path uses, so a match here means the two stores stay in step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWritePath } from "../src/repository/writePath.js";
import {
  loadPersonalFlagMap,
  loadRouteCacheEntries,
  loadRouteJobs,
} from "../src/repository/decorationData.js";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { ensurePgSchema, importTable } from "../src/pgSchema.js";

const TABLES = ["user_listing_flags", "route_cache", "route_jobs"];

function createFixtureDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE user_listing_flags (
      user_id INTEGER NOT NULL, post_id INTEGER NOT NULL,
      viewed INTEGER NOT NULL DEFAULT 0, watched INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0, watch_note TEXT NOT NULL DEFAULT '',
      viewed_at TEXT, watched_at TEXT, hidden_at TEXT,
      PRIMARY KEY (user_id, post_id)
    );
    CREATE TABLE route_cache (
      route_key TEXT PRIMARY KEY, distances TEXT NOT NULL DEFAULT '[]',
      min_km REAL, min_m REAL, updated_at TEXT,
      rush_am_min INTEGER, rush_pm_min INTEGER, rush_updated_at TEXT
    );
    CREATE TABLE route_jobs (
      job_key TEXT PRIMARY KEY, post_id INTEGER, direction TEXT, kind TEXT, commute_mode TEXT,
      work_lat REAL, work_lng REAL, job_state TEXT, fail_reason TEXT, attempts INTEGER,
      next_retry_at TEXT, updated_at TEXT
    );
  `);
  return db;
}

const sqliteExec = (db) => async (sql, params = []) => db.prepare(sql).all(...(params || []));
const pgExec = (pgDriver) => async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;

const TO_WORK = "v2:to_work:scooter:25.11,121.52>25.03,121.55";
const FROM_WORK = "v2:from_work:scooter:25.03,121.55>25.11,121.52";
const JOB_KEY = "25.11,121.52|to_work|distance|scooter|25.03|121.55";

// One deterministic payload sequence: the second flags write exercises the watched_at CASE, the
// route_cache writes exercise both the plain and the rush-aware statement plus the ON CONFLICT
// update, and the job is written twice to exercise the update path.
async function applySequence(writer) {
  await writer.upsertPersonalFlags({
    userId: 7, postId: 591401, viewed: 1, watchNote: "", viewedAt: "2026-09-21T01:00:00.000Z",
  });
  await writer.upsertPersonalFlags({
    userId: 7, postId: 591401, viewed: 1, watched: 1, watchNote: "重點",
    viewedAt: "2026-09-21T02:00:00.000Z", watchedAt: "2026-09-21T03:00:00.000Z",
  });
  await writer.upsertPersonalFlags({
    userId: 7, postId: 591402, viewed: 0, hidden: 1, hiddenAt: "2026-09-21T04:00:00.000Z",
  });
  await writer.upsertRouteCache({
    routeKey: TO_WORK, distances: [4.2, 5.1], rush: { am: 12, pm: 15 },
    updatedAt: "2026-09-21T05:00:00.000Z",
  });
  await writer.upsertRouteCache({ routeKey: FROM_WORK, distances: [4.4, 6.2], updatedAt: "2026-09-21T05:30:00.000Z" });
  await writer.upsertRouteCache({ routeKey: FROM_WORK, distances: [3.9], updatedAt: "2026-09-21T06:00:00.000Z" });
  await writer.upsertRouteJob({
    jobKey: JOB_KEY, postId: 591403, commuteMode: "scooter", workLat: 25.03, workLng: 121.55,
    jobState: "wait_route", updatedAt: "2026-09-21T07:00:00.000Z",
  });
  await writer.upsertRouteJob({
    jobKey: JOB_KEY, postId: 591403, commuteMode: "scooter", workLat: 25.03, workLng: 121.55,
    jobState: "failed", failReason: "timeout", attempts: 3, nextRetryAt: "2026-09-21T08:00:00.000Z",
    updatedAt: "2026-09-21T08:00:00.000Z",
  });
}

async function snapshot(exec, driver) {
  const flags = await loadPersonalFlagMap(exec, 7);
  const routes = await loadRouteCacheEntries(exec, [TO_WORK, FROM_WORK], driver);
  const jobs = await loadRouteJobs(exec, [JOB_KEY], driver);
  return {
    flags: [...flags.entries()]
      .map(([id, r]) => [id, Number(r.viewed), Number(r.watched), Number(r.hidden), String(r.watch_note), r.viewed_at, r.watched_at, r.hidden_at])
      .sort((a, b) => a[0] - b[0]),
    routes: [...routes.entries()]
      .map(([key, r]) => [key, String(r.distances), Number(r.min_km), Number(r.min_m), r.rush_am_min ?? null, r.rush_pm_min ?? null, r.rush_updated_at ?? null])
      .sort((a, b) => a[0].localeCompare(b[0])),
    jobs: [...jobs.entries()]
      .map(([key, r]) => [key, Number(r.post_id), String(r.job_state), Number(r.attempts), String(r.fail_reason), String(r.next_retry_at || "")])
      .sort((a, b) => a[0].localeCompare(b[0])),
  };
}

const EXPECTED = {
  flags: [
    [591401, 1, 1, 0, "重點", "2026-09-21T01:00:00.000Z", "2026-09-21T03:00:00.000Z", null],
    [591402, 0, 0, 1, "", null, null, "2026-09-21T04:00:00.000Z"],
  ],
  routes: [
    [FROM_WORK, "[3.9]", 3.9, 3900, null, null, null],
    [TO_WORK, "[4.2,5.1]", 4.2, 4200, 12, 15, "2026-09-21T05:00:00.000Z"],
  ],
  jobs: [[JOB_KEY, 591403, "failed", 3, "timeout", "2026-09-21T08:00:00.000Z"]],
};

test("the hot-path writes land the expected rows on SQLite", async () => {
  const db = createFixtureDb();
  const writer = createWritePath({ driver: "sqlite", sqliteDb: db });
  await applySequence(writer);
  const rows = await snapshot(sqliteExec(db), "sqlite");
  assert.deepEqual(rows, EXPECTED);
  db.close();
});

test("PostgreSQL writes read back identically to SQLite", async (t) => {
  if (!process.env.PG_TEST_URL) return t.skip("PG_TEST_URL not set");
  const db = createFixtureDb();
  const schema = `write_path_parity_${process.pid}`;
  const pgDriver = await createPostgresDriver({
    connectionString: process.env.PG_TEST_URL,
    poolOptions: { options: `-c search_path=${schema}` },
  });
  try {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.exec(`CREATE SCHEMA ${schema}`);
    await ensurePgSchema(pgDriver, db, { schema, tables: TABLES, indexes: false });

    // SQLite side first (fixture rows are inserted by the writes themselves, so both stores start
    // from empty tables and receive the identical payload sequence).
    await applySequence(createWritePath({ driver: "sqlite", sqliteDb: db }));
    const viaSqlite = await snapshot(sqliteExec(db), "sqlite");

    await applySequence(createWritePath({ driver: "postgres", pgDriver }));
    const viaPostgres = await snapshot(pgExec(pgDriver), "postgres");

    assert.deepEqual(viaPostgres, viaSqlite, "PostgreSQL write path must match SQLite");
    assert.deepEqual(viaPostgres, EXPECTED);
  } finally {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.close();
    db.close();
  }
});
