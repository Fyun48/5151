import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureDataRevisionTable,
  currentRevision,
  bumpRevision,
  changesSince,
} from "../src/dataRevision.js";

function memDb() {
  const db = new DatabaseSync(":memory:");
  ensureDataRevisionTable(db);
  return db;
}

test("bumpRevision increments and changesSince returns rows after a revision", () => {
  const db = memDb();
  assert.equal(currentRevision(db), 0);

  const r1 = bumpRevision(db, { entityType: "listing", entityId: 1, eventType: "listing_updated", now: 1000 });
  const r2 = bumpRevision(db, { entityType: "listing", entityId: 2, eventType: "search_membership_changed", now: 2000 });
  assert.equal(r2, r1 + 1);
  assert.equal(currentRevision(db), 2);

  const since = changesSince(db, r1);
  assert.equal(since.length, 1);
  assert.equal(since[0].entity_id, 2);
  assert.equal(since[0].event_type, "search_membership_changed");
});

test("changesSince from zero returns all, limit caps", () => {
  const db = memDb();
  for (let i = 1; i <= 5; i++) bumpRevision(db, { entityType: "listing", entityId: i, eventType: "listing_updated", now: i });
  assert.equal(changesSince(db, 0).length, 5);
  assert.equal(changesSince(db, 0, { limit: 2 }).length, 2);
  db.close();
});
