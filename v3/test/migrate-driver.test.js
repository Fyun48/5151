import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureSchemaMigrations,
  runMigrations,
  verifyMigrations,
  listAppliedMigrations,
} from "../src/migrate.js";
import { resolveDbDriver, dialectOf, nowExpr, createDb } from "../src/dbDriver.js";

const SAMPLE_MIGRATIONS = [
  {
    version: 1,
    name: "create_users",
    up: (db) => db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)"),
    down: (db) => db.exec("DROP TABLE users"),
  },
  {
    version: 2,
    name: "add_flags",
    up: (db) => db.exec("CREATE TABLE flags (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT)"),
  },
];

function memDb() {
  const db = new DatabaseSync(":memory:");
  ensureSchemaMigrations(db);
  return db;
}

test("runMigrations applies in order and records versions", () => {
  const db = memDb();
  const result = runMigrations(db, SAMPLE_MIGRATIONS);
  assert.deepEqual(result.applied, [1, 2]);
  assert.deepEqual(result.skipped, []);
  const applied = listAppliedMigrations(db).map((row) => Number(row.version));
  assert.deepEqual(applied, [1, 2]);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get().name, "users");
  db.close();
});

test("runMigrations is idempotent (re-run skips applied)", () => {
  const db = memDb();
  runMigrations(db, SAMPLE_MIGRATIONS);
  const second = runMigrations(db, SAMPLE_MIGRATIONS);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, [1, 2]);
  assert.equal(listAppliedMigrations(db).length, 2);
  db.close();
});

test("a failing migration rolls back its transaction", () => {
  const db = memDb();
  const bad = [
    { version: 1, name: "ok", up: (d) => d.exec("CREATE TABLE ok (id INTEGER)") },
    {
      version: 2,
      name: "boom",
      up: (d) => {
        d.exec("CREATE TABLE half (id INTEGER)");
        throw new Error("boom");
      },
    },
  ];
  assert.throws(() => runMigrations(db, bad), /migration 2 \(boom\) failed/);
  // version 2 failed and rolled back: no half table, not recorded
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='half'").get(), undefined);
  assert.equal(listAppliedMigrations(db).length, 1);
  db.close();
});

test("verifyMigrations reports missing versions", () => {
  const db = memDb();
  runMigrations(db, SAMPLE_MIGRATIONS);
  const extra = { version: 3, name: "extra", up: (d) => d.exec("SELECT 1") };
  const check = verifyMigrations(db, [...SAMPLE_MIGRATIONS, extra]);
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, [3]);
  assert.deepEqual(check.applied, [1, 2]);
  db.close();
});

test("duplicate migration versions are rejected", () => {
  const db = memDb();
  const dup = [
    { version: 1, name: "a", up: () => {} },
    { version: 1, name: "b", up: () => {} },
  ];
  assert.throws(() => runMigrations(db, dup), /duplicate migration version 1/);
  db.close();
});

test("resolveDbDriver defaults to sqlite and accepts postgres", () => {
  assert.equal(resolveDbDriver({}), "sqlite");
  assert.equal(resolveDbDriver({ DB_DRIVER: "postgres" }), "postgres");
  assert.equal(resolveDbDriver({ DB_DRIVER: "POSTGRESQL" }), "postgres");
  assert.equal(resolveDbDriver({ DB_DRIVER: "pg" }), "postgres");
  assert.equal(resolveDbDriver({ DB_DRIVER: "bogus" }), "sqlite");
  assert.equal(dialectOf("postgres"), "postgres");
  assert.equal(nowExpr("postgres"), "now()");
  assert.equal(nowExpr("sqlite"), "datetime('now')");
});

test("createDb(sqlite) returns a working synchronous driver", async () => {
  const db = await createDb({ driver: "sqlite", dataDir: ":memory:" });
  db.exec("CREATE TABLE t (id INTEGER)");
  db.prepare("INSERT INTO t (id) VALUES (?)").run(1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM t").get().n, 1);
  db.close();
});

test("createDb(postgres) returns the asynchronous pg driver", async () => {
  const driver = await createDb({ driver: "postgres", connectionString: "postgres://user:pass@127.0.0.1:5432/5151_test" });
  assert.equal(driver.dialect, "postgres");
  assert.equal(typeof driver.query, "function");
  assert.equal(typeof driver.withTransaction, "function");
  assert.equal(typeof driver.healthCheck, "function");
  // Never connects eagerly: pointing it at a dead host must not throw at build time.
  assert.equal(driver.config.host, "127.0.0.1");
  assert.ok(!JSON.stringify(driver.config).includes("pass"));
  await driver.close();
});
