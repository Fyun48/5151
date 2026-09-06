import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import {
  createEntity,
  transition,
  getEntity,
  listTransitions,
  allowedTransitions,
  isTerminal,
} from "../src/stateMachine.js";

test("createEntity starts at initial state and is idempotent", () => {
  const db = openOpsDb(":memory:");
  const e = createEntity(db, { id: "e1", actor: "system" });
  assert.equal(e.state, "COLLECTING");
  assert.equal(e.version, 0);
  const again = createEntity(db, { id: "e1", actor: "system" });
  assert.equal(again.version, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM state_entity").get().n, 1);
  db.close();
});

test("legal transition bumps version and writes audit + transition rows", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1" });
  const r = transition(db, { id: "e1", to: "EVALUATING", actor: "system" });
  assert.equal(r.from, "COLLECTING");
  assert.equal(r.to, "EVALUATING");
  assert.equal(r.version, 1);
  assert.equal(r.idempotent, false);
  assert.equal(getEntity(db, "e1").state, "EVALUATING");
  assert.equal(listTransitions(db, { entityId: "e1" }).length, 1);
  const audits = db.prepare("SELECT * FROM audit_log WHERE action = 'state.transition'").all();
  assert.equal(audits.length, 1);
  db.close();
});

test("illegal transition is rejected (422)", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1" });
  assert.throws(() => transition(db, { id: "e1", to: "RELEASED" }), (err) => err.status === 422);
  // entity unchanged, no transition recorded
  assert.equal(getEntity(db, "e1").state, "COLLECTING");
  assert.equal(listTransitions(db, { entityId: "e1" }).length, 0);
  db.close();
});

test("idempotency key makes repeated transition a no-op", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1" });
  const first = transition(db, { id: "e1", to: "EVALUATING", idempotencyKey: "k-1" });
  const second = transition(db, { id: "e1", to: "EVALUATING", idempotencyKey: "k-1" });
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.version, 1);
  assert.equal(getEntity(db, "e1").version, 1);
  assert.equal(listTransitions(db, { entityId: "e1" }).length, 1);
  db.close();
});

test("optimistic lock rejects stale expectedVersion (409)", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1" });
  transition(db, { id: "e1", to: "EVALUATING" }); // now version 1
  assert.throws(
    () => transition(db, { id: "e1", to: "WAITING_OWNER_APPROVAL", expectedVersion: 0 }),
    (err) => err.status === 409,
  );
  // correct version works
  const ok = transition(db, { id: "e1", to: "WAITING_OWNER_APPROVAL", expectedVersion: 1 });
  assert.equal(ok.version, 2);
  db.close();
});

test("terminal state forbids further transitions (409)", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1" });
  transition(db, { id: "e1", to: "CANCELLED" });
  assert.equal(isTerminal("lifecycle", "CANCELLED"), true);
  assert.throws(() => transition(db, { id: "e1", to: "EVALUATING" }), (err) => err.status === 409);
  db.close();
});

test("state_transition rows are append-only at DB level", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1" });
  transition(db, { id: "e1", to: "EVALUATING" });
  assert.throws(() => db.prepare("UPDATE state_transition SET to_state = 'X' WHERE id = 1").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM state_transition WHERE id = 1").run(), /append-only/);
  db.close();
});

test("transition on missing entity throws 404; unknown target rejected", () => {
  const db = openOpsDb(":memory:");
  assert.throws(() => transition(db, { id: "nope", to: "EVALUATING" }), (err) => err.status === 404);
  db.close();
});

test("allowedTransitions reflects the lifecycle map", () => {
  assert.deepEqual(allowedTransitions("lifecycle", "COLLECTING"), ["EVALUATING", "DEFERRED", "CANCELLED"]);
  assert.deepEqual(allowedTransitions("lifecycle", "SUPERSEDED"), []);
});
