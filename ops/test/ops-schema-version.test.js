import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openOpsDb, migrateOpsSchema, readOpsSchemaVersion, OPS_SCHEMA_VERSION } from "../src/opsDb.js";

test("fresh DB ends at OPS_SCHEMA_VERSION", () => {
  const db = openOpsDb(":memory:");
  assert.equal(readOpsSchemaVersion(db), OPS_SCHEMA_VERSION);
  db.close();
});

test("re-open / re-migrate is idempotent", () => {
  const db = openOpsDb(":memory:");
  assert.equal(migrateOpsSchema(db), OPS_SCHEMA_VERSION);
  assert.equal(migrateOpsSchema(db), OPS_SCHEMA_VERSION);
  assert.equal(readOpsSchemaVersion(db), OPS_SCHEMA_VERSION);
  db.close();
});

test("old (unversioned) DB upgrades stepwise to current and schema is applied", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA user_version = 0");
  migrateOpsSchema(db);
  assert.equal(readOpsSchemaVersion(db), OPS_SCHEMA_VERSION);
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state_entity'").get();
  assert.ok(table);
  db.close();
});

test("unsupported newer DB fails closed and does not rewrite the version", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA user_version = 99");
  assert.throws(() => migrateOpsSchema(db), /newer than supported/);
  assert.equal(readOpsSchemaVersion(db), 99);
  db.close();
});
