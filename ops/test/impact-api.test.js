import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { calculateAndStoreImpact } from "../src/impact.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
let seq = 1;

function seedIssueWithMember(db, { userRef = "u1", contact = "leak@example.com" } = {}) {
  const i = seq++;
  const ts = NOW.toISOString();
  db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, ?, ?, '3.47', ?)").run(`d${i}`, `k${i}`, `content ${i}`, contact, userRef, ts);
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', 'BUG', 's', 'HIGH', 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, ts, ts, ts);
  const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
  db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, ts);
  return iid;
}

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(CFG);
  const server = createApp({ db, auth }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db }); } finally { server.close(); db.close(); }
}
async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.com", password: "pw" }) });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

test("19. impact view requires owner auth", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedIssueWithMember(db);
    assert.equal((await fetch(`${base}/ops/api/issues/${iid}/impact`)).status, 401);
  });
});

test("20. recalculate requires CSRF; then succeeds", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedIssueWithMember(db);
    const { cookie, csrf } = await login(base);
    const noCsrf = await fetch(`${base}/ops/api/issues/${iid}/impact/recalculate`, { method: "POST", headers: { cookie } });
    assert.equal(noCsrf.status, 403);
    const ok = await fetch(`${base}/ops/api/issues/${iid}/impact/recalculate`, { method: "POST", headers: { cookie, "X-CSRF-Token": csrf, Origin: base } });
    assert.equal(ok.status, 201);
    assert.ok((await ok.json()).assessmentId > 0);
    // recalculation_requested 事件與 calculated / current_changed 分開記錄
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.impact.recalculation_requested'").get().n, 1);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.impact.calculated'").get().n >= 1);
  });
});

test("21. impact API exposes aggregates only — no contact/user identifiers", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedIssueWithMember(db, { userRef: "reporter-xyz", contact: "leak@example.com" });
    calculateAndStoreImpact(db, iid, { now: NOW });
    const { cookie } = await login(base);
    const raw = await (await fetch(`${base}/ops/api/issues/${iid}/impact`, { headers: { cookie } })).text();
    assert.doesNotMatch(raw, /leak@example\.com/);
    assert.doesNotMatch(raw, /reporter-xyz/);
    const data = JSON.parse(raw);
    assert.equal(data.current.distinct_reporter_count, 1); // 只露聚合
    assert.equal(typeof data.stale, "boolean");
    assert.ok(Array.isArray(data.history));
  });
});

test("22. audit contains metadata only (no contact/raw content)", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedIssueWithMember(db, { contact: "leak@example.com" });
    calculateAndStoreImpact(db, iid, { now: NOW });
    const audits = db.prepare("SELECT action, data FROM audit_log WHERE action LIKE 'issue.impact.%'").all();
    assert.ok(audits.some((a) => a.action === "issue.impact.calculated"));
    assert.ok(audits.some((a) => a.action === "issue.impact.current_changed"));
    for (const a of audits) assert.doesNotMatch(a.data || "", /leak@example\.com/);
  });
});
