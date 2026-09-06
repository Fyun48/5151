import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openOpsDb } from "../src/opsDb.js";
import { appendAudit, verifyAuditChain, createCheckpoint, listAudit, redactAuditData } from "../src/audit.js";

test("audit chain appends and verifies", () => {
  const db = openOpsDb(":memory:");
  appendAudit(db, { actor: "system", action: "a.one" });
  appendAudit(db, { actor: "owner:x", action: "a.two", entityType: "issue", entityId: "abc", data: { k: 1 } });
  appendAudit(db, { actor: "system", action: "a.three", data: { nested: { b: 2, a: 1 } } });
  const v = verifyAuditChain(db);
  assert.equal(v.ok, true);
  assert.equal(v.count, 3);
  assert.equal(v.head.length, 64);
  const page = listAudit(db);
  assert.equal(page.items.length, 3);
  assert.equal(page.total, 3);
  const asc = db.prepare("SELECT * FROM audit_log ORDER BY id ASC").all();
  assert.equal(asc[0].prev_hash, "");
  assert.equal(asc[1].prev_hash, asc[0].hash);
  db.close();
});

test("listAudit is bounded and paginated", () => {
  const db = openOpsDb(":memory:");
  for (let i = 0; i < 12; i++) appendAudit(db, { actor: "s", action: `n${i}` });
  const p1 = listAudit(db, { limit: 5, offset: 0 });
  assert.equal(p1.items.length, 5);
  assert.equal(p1.total, 12);
  assert.equal(p1.limit, 5);
  // 超過上限會被夾到 500
  const capped = listAudit(db, { limit: 100000 });
  assert.ok(capped.limit <= 500);
  db.close();
});

test("audit redaction never persists secrets", () => {
  const db = openOpsDb(":memory:");
  appendAudit(db, {
    actor: "system",
    action: "test.redact",
    data: {
      password: "hunter2",
      token: "abc",
      authorization: "Bearer xyz",
      note: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      nested: { api_key: "k", ok: "keep-me" },
      innocent: "hello",
    },
  });
  const row = db.prepare("SELECT data FROM audit_log ORDER BY id DESC LIMIT 1").get();
  const stored = row.data;
  assert.doesNotMatch(stored, /hunter2/);
  assert.doesNotMatch(stored, /Bearer xyz/);
  assert.doesNotMatch(stored, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/);
  assert.match(stored, /\[REDACTED\]/);
  assert.match(stored, /keep-me/);
  assert.match(stored, /hello/);
  db.close();
});

test("redactAuditData handles nested arrays and depth", () => {
  const out = redactAuditData({ list: [{ secret: "x", ok: 1 }], t: "plain" });
  assert.equal(out.list[0].secret, "[REDACTED]");
  assert.equal(out.list[0].ok, 1);
  assert.equal(out.t, "plain");
});

test("checkpoint captures the current range", () => {
  const db = openOpsDb(":memory:");
  appendAudit(db, { actor: "s", action: "one" });
  appendAudit(db, { actor: "s", action: "two" });
  const cp = createCheckpoint(db);
  assert.equal(cp.fromId, 1);
  assert.equal(cp.toId, 2);
  assert.equal(cp.rangeRoot.length, 64);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_checkpoint").get().n, 1);
  db.close();
});

test("DB triggers block UPDATE and DELETE on append-only tables", () => {
  const db = openOpsDb(":memory:");
  appendAudit(db, { actor: "s", action: "one" });
  createCheckpoint(db);
  assert.throws(() => db.prepare("UPDATE audit_log SET action='x' WHERE id=1").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM audit_log WHERE id=1").run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE audit_checkpoint SET signature='x' WHERE id=1").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM audit_checkpoint WHERE id=1").run(), /append-only/);
  db.close();
});

test("verifyAuditChain detects tampering on a trigger-less copy", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, action TEXT,
    entity_type TEXT, entity_id TEXT, data TEXT, prev_hash TEXT, hash TEXT);`);
  appendAudit(db, { actor: "s", action: "one" });
  appendAudit(db, { actor: "s", action: "two" });
  appendAudit(db, { actor: "s", action: "three" });
  assert.equal(verifyAuditChain(db).ok, true);
  db.prepare("UPDATE audit_log SET action='tampered' WHERE id=2").run();
  const v = verifyAuditChain(db);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
  db.close();
});

test("concurrent appends across two connections keep one valid, fork-free chain", () => {
  const file = path.join(os.tmpdir(), `ops-conc-${process.pid}-${Date.now()}.db`);
  const dbA = openOpsDb(file);
  const dbB = openOpsDb(file);
  const N = 24;
  for (let i = 0; i < N; i++) {
    appendAudit(i % 2 ? dbB : dbA, { actor: "s", action: `evt-${i}` });
  }
  const reader = openOpsDb(file);
  const rows = reader.prepare("SELECT id, prev_hash, hash FROM audit_log ORDER BY id ASC").all();
  assert.equal(rows.length, N); // 沒有遺失
  // id 連續、無分岔（每列 prev_hash == 前一列 hash）
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].id, i + 1);
    if (i > 0) assert.equal(rows[i].prev_hash, rows[i - 1].hash);
  }
  assert.equal(verifyAuditChain(reader).ok, true);
  dbA.close();
  dbB.close();
  reader.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(file + suffix, { force: true }); } catch { /* ignore */ }
  }
});
