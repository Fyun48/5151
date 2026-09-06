import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openOpsDb } from "../src/opsDb.js";
import { appendAudit, verifyAuditChain, createCheckpoint, listAudit } from "../src/audit.js";

test("audit chain appends and verifies", () => {
  const db = openOpsDb(":memory:");
  appendAudit(db, { actor: "system", action: "a.one" });
  appendAudit(db, { actor: "owner:x", action: "a.two", entityType: "lifecycle", entityId: "abc", data: { k: 1 } });
  appendAudit(db, { actor: "system", action: "a.three", data: { nested: { b: 2, a: 1 } } });
  const v = verifyAuditChain(db);
  assert.equal(v.ok, true);
  assert.equal(v.count, 3);
  assert.ok(v.head && v.head.length === 64);
  const items = listAudit(db);
  assert.equal(items.length, 3);
  // first row prev_hash empty, chained
  const asc = db.prepare("SELECT * FROM audit_log ORDER BY id ASC").all();
  assert.equal(asc[0].prev_hash, "");
  assert.equal(asc[1].prev_hash, asc[0].hash);
  db.close();
});

test("stable hashing is order-independent for data keys", () => {
  const dbA = openOpsDb(":memory:");
  const dbB = openOpsDb(":memory:");
  const now = new Date("2026-01-01T00:00:00.000Z");
  const a = appendAudit(dbA, { actor: "s", action: "x", data: { a: 1, b: 2 }, now });
  const b = appendAudit(dbB, { actor: "s", action: "x", data: { b: 2, a: 1 }, now });
  assert.equal(a.hash, b.hash);
  dbA.close();
  dbB.close();
});

test("checkpoint captures the current range", () => {
  const db = openOpsDb(":memory:");
  appendAudit(db, { actor: "s", action: "one" });
  appendAudit(db, { actor: "s", action: "two" });
  const cp = createCheckpoint(db);
  assert.equal(cp.fromId, 1);
  assert.equal(cp.toId, 2);
  assert.ok(cp.rangeRoot.length === 64);
  const stored = db.prepare("SELECT * FROM audit_checkpoint").all();
  assert.equal(stored.length, 1);
  db.close();
});

test("DB triggers block UPDATE and DELETE on audit_log and audit_checkpoint", () => {
  const db = openOpsDb(":memory:");
  appendAudit(db, { actor: "s", action: "one" });
  createCheckpoint(db);
  assert.throws(() => db.prepare("UPDATE audit_log SET action = 'hacked' WHERE id = 1").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM audit_log WHERE id = 1").run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE audit_checkpoint SET signature = 'x' WHERE id = 1").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM audit_checkpoint WHERE id = 1").run(), /append-only/);
  db.close();
});

test("verifyAuditChain detects tampering (on a trigger-less copy)", () => {
  // 用一個沒有 trigger 的原始表模擬竄改，證明 hash-chain 能偵測。
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, action TEXT,
    entity_type TEXT, entity_id TEXT, data TEXT, prev_hash TEXT, hash TEXT);`);
  appendAudit(db, { actor: "s", action: "one" });
  appendAudit(db, { actor: "s", action: "two" });
  appendAudit(db, { actor: "s", action: "three" });
  assert.equal(verifyAuditChain(db).ok, true);
  db.prepare("UPDATE audit_log SET action = 'tampered' WHERE id = 2").run();
  const v = verifyAuditChain(db);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
  db.close();
});
