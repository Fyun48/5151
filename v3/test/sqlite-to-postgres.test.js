import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  snapshotTables,
  tableHash,
  copyTable,
  verifyMigration,
  planMigration,
  runMigration,
} from "../src/sqliteToPostgres.js";

function seed(db) {
  db.exec(`
    CREATE TABLE listings (post_id INTEGER PRIMARY KEY, title TEXT, price_num INTEGER);
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
  `);
  db.prepare("INSERT INTO listings (post_id, title, price_num) VALUES (?, ?, ?)").run(1, "A", 10000);
  db.prepare("INSERT INTO listings (post_id, title, price_num) VALUES (?, ?, ?)").run(2, "B", 20000);
  db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(1, "a@x.test");
}

function sourceTarget() {
  const source = new DatabaseSync(":memory:");
  const target = new DatabaseSync(":memory:");
  seed(source);
  // mirror schema in target (empty)
  seed(target);
  target.exec("DELETE FROM listings; DELETE FROM users;");
  return { source, target };
}

test("snapshotTables lists user tables with counts", () => {
  const { source } = sourceTarget();
  const snap = snapshotTables(source);
  const byName = Object.fromEntries(snap.map((t) => [t.name, t]));
  assert.equal(byName.listings.rowCount, 2);
  assert.equal(byName.users.rowCount, 1);
  assert.ok(byName.listings.columns.some((c) => c.name === "price_num"));
  source.close();
});

test("copyTable is idempotent (no duplication on re-run)", () => {
  const { source, target } = sourceTarget();
  copyTable(source, target, "listings");
  copyTable(source, target, "listings"); // re-run
  assert.equal(target.prepare("SELECT COUNT(*) AS n FROM listings").get().n, 2);
  source.close(); target.close();
});

test("verifyMigration compares counts and hashes", () => {
  const { source, target } = sourceTarget();
  copyTable(source, target, "listings");
  copyTable(source, target, "users");
  const check = verifyMigration(source, target, ["listings", "users"]);
  assert.ok(check.every((r) => r.ok));
  assert.equal(tableHash(source, "listings"), tableHash(target, "listings"));
  source.close(); target.close();
});

test("planMigration dry-run reports counts without writing", () => {
  const { source, target } = sourceTarget();
  const plan = planMigration(source, ["listings"]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].table, "listings");
  assert.equal(plan[0].rowCount, 2);
  assert.equal(target.prepare("SELECT COUNT(*) AS n FROM listings").get().n, 0);
  source.close(); target.close();
});

test("runMigration dry-run does not write; resume skips copied tables", () => {
  const { source, target } = sourceTarget();
  const dry = runMigration(source, target, { tables: ["listings"], dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(target.prepare("SELECT COUNT(*) AS n FROM listings").get().n, 0);

  const first = runMigration(source, target, { tables: ["listings"] });
  assert.equal(first.copied.length, 1);
  assert.equal(first.verify[0].ok, true);

  // resume: second run skips the already-copied table
  const second = runMigration(source, target, { tables: ["listings"], resume: true });
  assert.equal(second.copied.length, 0);
  assert.equal(target.prepare("SELECT COUNT(*) AS n FROM listings").get().n, 2);
  source.close(); target.close();
});
