import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";

import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { runProposalOnce } from "../src/proposalWorker.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";
import { getCurrentIssueProposal, submitOwnerDecision } from "../src/proposal.js";
import { findEntity } from "../src/stateMachine.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
const NOW = new Date(); // 用現在時間讓 server route（真實 new Date()）視為 fresh
let seq = 1;

function seedFeedback(db, { severity = "HIGH" } = {}) {
  const i = seq++; const ts = NOW.toISOString();
  db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, 'leak@example.com', ?, '3.47', ?)").run(`d${i}`, `k${i}`, `c${i}`, `reporter-${i}`, ts);
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', 'BUG', 's', ?, 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, severity, ts, ts, ts);
  const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
  return { fid, aid };
}
async function decide(db, decision) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
  for (let k = 0; k < 8; k++) { const f = seedFeedback(db); db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, f.fid, f.aid, ts); }
  calculateAndStoreImpact(db, iid, { now: NOW });
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  submitOwnerDecision(db, iid, { action: decision, proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
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

test("33. reevaluation view requires owner auth", async () => {
  await withServer(async ({ base, db }) => {
    const iid = await decide(db, "DEFER");
    assert.equal((await fetch(`${base}/ops/api/issues/${iid}/reevaluation`)).status, 401);
  });
});

test("34. manual reopen requires CSRF; then reopens DEFERRED via owner", async () => {
  await withServer(async ({ base, db }) => {
    const iid = await decide(db, "DEFER");
    const { cookie, csrf } = await login(base);
    const noCsrf = await fetch(`${base}/ops/api/issues/${iid}/reevaluation/reopen`, { method: "POST", headers: { cookie } });
    assert.equal(noCsrf.status, 403);
    const ok = await fetch(`${base}/ops/api/issues/${iid}/reevaluation/reopen`, { method: "POST", headers: { cookie, "X-CSRF-Token": csrf, Origin: base, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(ok.status, 200);
    assert.equal(findEntity(db, `issue:${iid}`).state, "EVALUATING");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.reevaluation.reopened'").get().n, 1);
  });
});

test("Owner UNBLOCK via API requires CSRF; then unblocks", async () => {
  await withServer(async ({ base, db }) => {
    const iid = await decide(db, "BLOCK");
    assert.equal(findEntity(db, `issue:${iid}`).state, "BLOCKED");
    const { cookie, csrf } = await login(base);
    const noCsrf = await fetch(`${base}/ops/api/issues/${iid}/unblock`, { method: "POST", headers: { cookie } });
    assert.equal(noCsrf.status, 403);
    const ok = await fetch(`${base}/ops/api/issues/${iid}/unblock`, { method: "POST", headers: { cookie, "X-CSRF-Token": csrf, Origin: base, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(ok.status, 200);
    assert.equal(findEntity(db, `issue:${iid}`).state, "EVALUATING");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.unblocked'").get().n, 1);
  });
});

test("35. reevaluation API exposes aggregate evidence only (no raw PII); audit metadata only", async () => {
  await withServer(async ({ base, db }) => {
    const iid = await decide(db, "DEFER");
    const { cookie } = await login(base);
    const raw = await (await fetch(`${base}/ops/api/issues/${iid}/reevaluation`, { headers: { cookie } })).text();
    assert.doesNotMatch(raw, /leak@example\.com/);
    assert.doesNotMatch(raw, /reporter-\d/);
    const audits = db.prepare("SELECT data FROM audit_log WHERE action LIKE 'issue.reevaluation.%' OR action='issue.unblocked'").all();
    for (const a of audits) { assert.doesNotMatch(a.data || "", /leak@example\.com/); assert.doesNotMatch(a.data || "", /content \d/); }
  });
});
