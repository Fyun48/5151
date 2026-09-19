import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { createEntity, transition, getEntity } from "../src/stateMachine.js";
import { createFollowUpIssue, inferIssueProductId } from "../src/followUp.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { validateAuthorizationForCoding } from "../src/codingTask.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };

function seedIssue(db, { title = "已發布議題", productId = "v3" } = {}) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare(
    "INSERT INTO issue_candidate(title,summary,category,clustering_version,status,product_id,created_at,updated_at) VALUES(?,?,?,'cluster-v1','open',?,?,?)",
  ).run(title, "summary", "BUG", productId, ts, ts).lastInsertRowid);
  createEntity(db, { id: `issue:${iid}`, entityType: "issue", now: NOW });
  return iid;
}

function drive(db, iid, states) {
  for (const to of states) transition(db, { id: `issue:${iid}`, to, actor: "system" });
}

const TO_RELEASED = [
  "EVALUATING", "WAITING_OWNER_APPROVAL", "APPROVED_FOR_DEVELOPMENT",
  "DEVELOPING", "TESTING", "STAGING", "WAITING_RELEASE_APPROVAL", "RELEASING", "RELEASED",
];

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(CFG);
  const server = createApp({ db, auth }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db }); } finally { server.close(); db.close(); }
}

async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "pw" }),
  });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

test("follow-up is a new issue and does not reuse the released authorization", () => {
  const db = openOpsDb(":memory:");
  const parentId = seedIssue(db);
  drive(db, parentId, TO_RELEASED);
  const created = createFollowUpIssue(db, { parentIssueId: parentId, reason: "要修回歸", actor: "owner:x", now: NOW });
  assert.notEqual(created.issue_id, parentId);
  assert.equal(created.parent_issue_id, parentId);
  assert.equal(created.issue_kind, "followup");
  assert.equal(created.product_id, "v3");
  assert.equal(getEntity(db, `issue:${parentId}`).state, "RELEASED");
  assert.equal(getEntity(db, `issue:${created.issue_id}`).state, "COLLECTING");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_authorization WHERE issue_id=?").get(created.issue_id).n, 0);
  assert.throws(
    () => validateAuthorizationForCoding(db, { issueId: created.issue_id, now: NOW }),
    /no active development authorization/,
  );
  assert.equal(inferIssueProductId(db, created.issue_id), "v3");
  const audit = db.prepare("SELECT data FROM audit_log WHERE action='issue.followup.created'").get();
  assert.match(audit.data, /"copied_parent_grant":false/);
  db.close();
});

test("follow-up is refused before the issue is released", () => {
  const db = openOpsDb(":memory:");
  const parentId = seedIssue(db);
  assert.throws(() => createFollowUpIssue(db, { parentIssueId: parentId, now: NOW }), /RELEASED or ROLLED_BACK/);
  drive(db, parentId, ["EVALUATING", "WAITING_OWNER_APPROVAL"]);
  assert.throws(() => createFollowUpIssue(db, { parentIssueId: parentId, now: NOW }), /RELEASED or ROLLED_BACK/);
  db.close();
});

test("follow-up API requires owner + CSRF and rejects owner_direct spoof", async () => {
  await withServer(async ({ base, db }) => {
    const parentId = seedIssue(db);
    drive(db, parentId, TO_RELEASED);
    assert.equal((await fetch(`${base}/ops/api/issues/${parentId}/follow-up`, { method: "POST" })).status, 401);
    const { cookie, csrf } = await login(base);
    const noCsrf = await fetch(`${base}/ops/api/issues/${parentId}/follow-up`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ reason: "x" }),
    });
    assert.equal(noCsrf.status, 403);
    const spoof = await fetch(`${base}/ops/api/issues/${parentId}/follow-up`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ reason: "x", owner_direct: true }),
    });
    assert.equal(spoof.status, 403);
    const ok = await fetch(`${base}/ops/api/issues/${parentId}/follow-up`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ reason: "修回歸" }),
    });
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.ok(body.issue_id > parentId);
    const view = await (await fetch(`${base}/ops/api/issues/${parentId}`, { headers: { cookie } })).json();
    assert.equal(view.lifecycle_state, "RELEASED");
    assert.equal(view.follow_ups.length, 1);
    assert.equal(view.follow_ups[0].id, body.issue_id);
  });
});
