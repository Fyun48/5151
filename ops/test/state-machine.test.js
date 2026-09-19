import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import {
  createEntity,
  transition,
  getEntity,
  listTransitions,
  allowedTransitions,
  allowedTransitionsByEntityType,
  isTerminal,
} from "../src/stateMachine.js";

// 把 entity 推到指定狀態的小工具（走一般轉移）。
function drive(db, id, states) {
  for (const to of states) transition(db, { id, to, actor: "system" });
}

test("createEntity starts at initial state and is idempotent", () => {
  const db = openOpsDb(":memory:");
  const e = createEntity(db, { id: "e1", entityType: "issue" });
  assert.equal(e.state, "COLLECTING");
  assert.equal(e.version, 0);
  const again = createEntity(db, { id: "e1", entityType: "issue" });
  assert.equal(again.version, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM state_entity").get().n, 1);
  db.close();
});

test("legal transition bumps version and writes transition + audit", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1", entityType: "issue" });
  const r = transition(db, { id: "e1", to: "EVALUATING" });
  assert.equal(r.from, "COLLECTING");
  assert.equal(r.to, "EVALUATING");
  assert.equal(r.version, 1);
  assert.equal(getEntity(db, "e1").state, "EVALUATING");
  assert.equal(listTransitions(db, { entityId: "e1" }).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='state.transition'").get().n, 1);
  db.close();
});

test("illegal transition is rejected (422) with no writes", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1", entityType: "issue" });
  assert.throws(() => transition(db, { id: "e1", to: "RELEASED" }), (e) => e.status === 422);
  assert.equal(getEntity(db, "e1").state, "COLLECTING");
  assert.equal(listTransitions(db, { entityId: "e1" }).length, 0);
  db.close();
});

test("REJECTED can be re-evaluated only via authorized 'reevaluation'", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1", entityType: "issue" });
  drive(db, "e1", ["EVALUATING", "REJECTED"]);
  // 無授權 → 拒絕
  assert.throws(() => transition(db, { id: "e1", to: "EVALUATING" }), (e) => e.status === 403);
  // 授權 → 可重新評估
  const r = transition(db, { id: "e1", to: "EVALUATING", authorization: "reevaluation" });
  assert.equal(r.to, "EVALUATING");
  db.close();
});

test("DEFERRED can be re-evaluated only via authorized 'reevaluation'", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1", entityType: "issue" });
  drive(db, "e1", ["DEFERRED"]);
  assert.throws(() => transition(db, { id: "e1", to: "EVALUATING" }), (e) => e.status === 403);
  const r = transition(db, { id: "e1", to: "EVALUATING", authorization: "reevaluation" });
  assert.equal(r.to, "EVALUATING");
  db.close();
});

test("BLOCKED never auto-re-evaluates; only explicit owner_unblock leaves it", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1", entityType: "issue" });
  drive(db, "e1", ["EVALUATING", "BLOCKED"]);
  // 一般 → 拒絕
  assert.throws(() => transition(db, { id: "e1", to: "EVALUATING" }), (e) => e.status === 403);
  // 用 reevaluation 授權也不行（BLOCKED 需要 owner_unblock）
  assert.throws(() => transition(db, { id: "e1", to: "EVALUATING", authorization: "reevaluation" }), (e) => e.status === 403);
  // 只有 owner_unblock 可以
  const r = transition(db, { id: "e1", to: "EVALUATING", authorization: "owner_unblock" });
  assert.equal(r.to, "EVALUATING");
  db.close();
});

test("RELEASED cannot reopen the old development lifecycle", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1", entityType: "issue" });
  drive(db, "e1", [
    "EVALUATING", "WAITING_OWNER_APPROVAL", "APPROVED_FOR_DEVELOPMENT",
    "DEVELOPING", "TESTING", "STAGING", "WAITING_RELEASE_APPROVAL", "RELEASING", "RELEASED",
  ]);
  assert.equal(getEntity(db, "e1").state, "RELEASED");
  for (const to of ["DEVELOPING", "TESTING", "EVALUATING", "APPROVED_FOR_DEVELOPMENT"]) {
    assert.throws(() => transition(db, { id: "e1", to }), (e) => e.status === 422 || e.status === 403);
  }
  // 只允許 ROLLED_BACK（運維）；不能走 reevaluation 回到 EVALUATING
  assert.equal(transition(db, { id: "e1", to: "ROLLED_BACK" }).to, "ROLLED_BACK");
  assert.throws(
    () => transition(db, { id: "e1", to: "EVALUATING", authorization: "reevaluation" }),
    (e) => e.status === 422 || e.status === 403,
  );
  db.close();
});

test("ROLLED_BACK cannot reopen EVALUATING; follow-up is a new entity", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1", entityType: "issue" });
  drive(db, "e1", [
    "EVALUATING", "WAITING_OWNER_APPROVAL", "APPROVED_FOR_DEVELOPMENT",
    "DEVELOPING", "TESTING", "STAGING", "WAITING_RELEASE_APPROVAL", "RELEASING", "RELEASED", "ROLLED_BACK",
  ]);
  const map = allowedTransitionsByEntityType("issue");
  assert.equal(map.ROLLED_BACK.guarded.EVALUATING, undefined);
  assert.deepEqual(map.ROLLED_BACK.normal, ["CANCELLED"]);
  assert.throws(() => transition(db, { id: "e1", to: "EVALUATING" }), (e) => e.status === 422);
  const follow = createEntity(db, { id: "issue:follow-1", entityType: "issue" });
  assert.equal(follow.state, "COLLECTING");
  assert.equal(getEntity(db, "e1").state, "ROLLED_BACK");
  db.close();
});

test("terminal states differ per entity type (CANCELLED/SUPERSEDED terminal here)", () => {
  assert.equal(isTerminal("issue", "CANCELLED"), true);
  assert.equal(isTerminal("issue", "SUPERSEDED"), true);
  // DEFERRED/REJECTED/BLOCKED 不是永久 terminal（有 guarded 出口）
  assert.equal(isTerminal("issue", "DEFERRED"), false);
  assert.equal(isTerminal("issue", "REJECTED"), false);
  assert.equal(isTerminal("issue", "BLOCKED"), false);
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1", entityType: "issue" });
  drive(db, "e1", ["CANCELLED"]);
  assert.throws(() => transition(db, { id: "e1", to: "EVALUATING", authorization: "reevaluation" }), (e) => e.status === 409);
  db.close();
});

test("idempotency key makes repeated transition a no-op", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1", entityType: "issue" });
  const first = transition(db, { id: "e1", to: "EVALUATING", idempotencyKey: "k-1" });
  const second = transition(db, { id: "e1", to: "EVALUATING", idempotencyKey: "k-1" });
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(getEntity(db, "e1").version, 1);
  assert.equal(listTransitions(db, { entityId: "e1" }).length, 1);
  db.close();
});

test("optimistic lock rejects stale expectedVersion with no partial write", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1", entityType: "issue" });
  transition(db, { id: "e1", to: "EVALUATING" }); // version 1
  const auditBefore = db.prepare("SELECT COUNT(*) n FROM audit_log").get().n;
  assert.throws(
    () => transition(db, { id: "e1", to: "WAITING_OWNER_APPROVAL", expectedVersion: 0 }),
    (e) => e.status === 409,
  );
  // 無任何部分寫入
  assert.equal(getEntity(db, "e1").version, 1);
  assert.equal(listTransitions(db, { entityId: "e1" }).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log").get().n, auditBefore);
  const ok = transition(db, { id: "e1", to: "WAITING_OWNER_APPROVAL", expectedVersion: 1 });
  assert.equal(ok.version, 2);
  db.close();
});

test("transition is atomic: audit-insert failure rolls back state + transition", () => {
  const db = openOpsDb(":memory:");
  createEntity(db, { id: "e1", entityType: "issue" });
  const auditBefore = db.prepare("SELECT COUNT(*) n FROM audit_log").get().n;

  // Proxy：讓 audit_log 的 INSERT 拋錯，其餘照常。
  const failing = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql) => {
          const stmt = target.prepare(sql);
          if (/INSERT\s+INTO\s+audit_log/i.test(sql)) {
            return { run: () => { throw new Error("boom: audit insert"); } };
          }
          return stmt;
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });

  assert.throws(() => transition(failing, { id: "e1", to: "EVALUATING" }), /boom: audit insert/);
  // 全部回滾：狀態沒變、沒有 transition、沒有新 audit
  assert.equal(getEntity(db, "e1").state, "COLLECTING");
  assert.equal(getEntity(db, "e1").version, 0);
  assert.equal(listTransitions(db, { entityId: "e1" }).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log").get().n, auditBefore);
  db.close();
});

test("transition on missing entity throws 404", () => {
  const db = openOpsDb(":memory:");
  assert.throws(() => transition(db, { id: "nope", to: "EVALUATING" }), (e) => e.status === 404);
  db.close();
});

test("allowedTransitionsByEntityType exposes normal + guarded per state", () => {
  const map = allowedTransitionsByEntityType("issue");
  assert.deepEqual(map.COLLECTING.normal, ["EVALUATING", "DEFERRED", "CANCELLED"]);
  assert.equal(map.DEFERRED.guarded.EVALUATING, "reevaluation");
  assert.equal(map.BLOCKED.guarded.EVALUATING, "owner_unblock");
  assert.equal(map.ROLLED_BACK.guarded.EVALUATING, undefined);
  assert.deepEqual(allowedTransitions("issue", "RELEASED"), ["ROLLED_BACK"]);
});
