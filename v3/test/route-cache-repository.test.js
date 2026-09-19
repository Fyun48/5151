import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createSqliteRouteCacheRepository,
  createPostgresRouteCacheRepository,
  createRouteCacheRepository,
} from "../src/repository/routeCache.js";

function sqliteRepo() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE route_cache (
    route_key TEXT PRIMARY KEY,
    distances TEXT NOT NULL,
    min_km REAL NOT NULL,
    min_m INTEGER,
    rush_am_min REAL,
    rush_pm_min REAL,
    rush_updated_at TEXT,
    updated_at TEXT NOT NULL,
    location_class TEXT,
    route_version INTEGER
  )`);
  return { db, repo: createSqliteRouteCacheRepository(db) };
}

test("sqlite route cache repository get/set/delete", async () => {
  const { db, repo } = sqliteRepo();
  assert.equal(await repo.get("k1"), null);

  await repo.set("k1", { distances: JSON.stringify([3.4, 3.9]), minKm: 3.4, minM: 3400, updatedAt: "2026-09-01T00:00:00.000Z" });
  const row = await repo.get("k1");
  assert.equal(row.min_km, 3.4);
  assert.equal(row.min_m, 3400);
  assert.equal(JSON.parse(row.distances).length, 2);

  await repo.set("k1", { distances: "[]", minKm: 5.2, rushAmMin: 14, rushPmMin: 22, routeVersion: 2 }); // upsert
  const updated = await repo.get("k1");
  assert.equal(updated.min_km, 5.2);
  assert.equal(updated.rush_am_min, 14);
  assert.equal(updated.route_version, 2);

  assert.equal(await repo.delete("k1"), true);
  assert.equal(await repo.delete("k1"), false);
  assert.equal(await repo.get("k1"), null);
  db.close();
});

test("factory selects sqlite by default and postgres by driver", async () => {
  const { db } = sqliteRepo();
  const repo = createRouteCacheRepository({ sqliteDb: db });
  assert.equal(repo.name, "sqlite");
  await repo.set("k", { distances: "[]", minKm: 1.1 });
  assert.equal((await repo.get("k")).min_km, 1.1);

  assert.throws(() => createRouteCacheRepository({ driver: "postgres" }), /requires pgPool/);
  assert.throws(() => createRouteCacheRepository({ sqliteDb: null }), /requires sqliteDb/);
  db.close();
});

test("postgres route cache repository uses $n placeholders and ON CONFLICT", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ route_key: "k", min_km: 3.4 }], rowCount: 1 };
    },
  };
  const repo = createPostgresRouteCacheRepository(pool);
  await repo.set("k", { distances: "[]", minKm: 3.4 });
  await repo.get("k");
  await repo.delete("k");

  const setSql = calls[0].sql;
  assert.match(setSql, /\$1, \$2, \$3/);
  assert.match(setSql, /ON CONFLICT \(route_key\) DO UPDATE SET/);
  assert.match(setSql, /distances = EXCLUDED\.distances/);
  assert.match(calls[1].sql, /route_key = \$1/);
  assert.match(calls[2].sql, /DELETE FROM route_cache WHERE route_key = \$1/);
});
