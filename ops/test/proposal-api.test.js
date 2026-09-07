import { test } from "node:test";
import assert from "node:assert/strict";

// env 推導的 provider 為 stub（本檔獨立 process）。
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

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
// 用「現在時間」建立證據，讓 server route（以真實 new Date() 判斷新鮮度）視為 fresh。
const NOW = new Date();
let seq = 1;

function seedApprovable(db, { members = 8, contact = "leak@example.com" } = {}) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
  for (let k = 0; k < members; k++) {
    const i = seq++;
    db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, ?, ?, '3.47', ?)").run(`d${i}`, `k${i}`, `content ${i}`, contact, `reporter-${i}`, ts);
    const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
    db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', 'BUG', 'symptom', 'HIGH', 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, ts, ts, ts);
    const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
    db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
    db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, ts);
  }
  calculateAndStoreImpact(db, iid, { now: NOW });
  return iid;
}
async function buildProposal(db, iid) {
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
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

test("33. proposal view requires owner auth", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedApprovable(db); await buildProposal(db, iid);
    assert.equal((await fetch(`${base}/ops/api/issues/${iid}/proposal`)).status, 401);
  });
});

test("34. decision requires CSRF; APPROVE then creates authorization", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedApprovable(db); await buildProposal(db, iid);
    const { cookie, csrf } = await login(base);
    const view = await (await fetch(`${base}/ops/api/issues/${iid}/proposal`, { headers: { cookie } })).json();
    assert.ok(view.current);
    const body = JSON.stringify({ action: "APPROVE_DEVELOPMENT", proposal_id: view.current.id, proposal_version: view.current.proposal_version, proposal_hash: view.current.proposal_hash });
    const noCsrf = await fetch(`${base}/ops/api/issues/${iid}/proposal/decision`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body });
    assert.equal(noCsrf.status, 403);
    const ok = await fetch(`${base}/ops/api/issues/${iid}/proposal/decision`, { method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base }, body });
    assert.equal(ok.status, 200);
    const out = await ok.json();
    assert.ok(out.authorization.id > 0);
    // authorization + approval audit recorded
    assert.equal(db.prepare("SELECT COUNT(*) n FROM development_authorization WHERE issue_id=? AND status='active'").get(iid).n, 1);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.development.approved'").get().n >= 1);
  });
});

test("proposal API exposes no raw PII/secrets; audit is metadata-only", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedApprovable(db, { contact: "leak@example.com" }); await buildProposal(db, iid);
    const { cookie } = await login(base);
    const raw = await (await fetch(`${base}/ops/api/issues/${iid}/proposal`, { headers: { cookie } })).text();
    assert.doesNotMatch(raw, /leak@example\.com/);
    assert.doesNotMatch(raw, /reporter-\d/);
    const audits = db.prepare("SELECT data FROM audit_log WHERE action LIKE 'issue.proposal.%' OR action LIKE 'issue.development.%'").all();
    for (const a of audits) {
      assert.doesNotMatch(a.data || "", /leak@example\.com/);
      assert.doesNotMatch(a.data || "", /content \d/);
    }
  });
});

test("38/39. Phase 8 creates no coding branch/PR and triggers no deployment", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedApprovable(db); await buildProposal(db, iid);
    const { cookie, csrf } = await login(base);
    const view = await (await fetch(`${base}/ops/api/issues/${iid}/proposal`, { headers: { cookie } })).json();
    const body = JSON.stringify({ action: "APPROVE_DEVELOPMENT", proposal_id: view.current.id, proposal_version: view.current.proposal_version, proposal_hash: view.current.proposal_hash });
    await fetch(`${base}/ops/api/issues/${iid}/proposal/decision`, { method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base }, body });
    // Approval only produces a domain authorization record; there is no code/branch/PR/deploy artifact in ops.
    const auth = db.prepare("SELECT status FROM development_authorization WHERE issue_id=?").get(iid);
    assert.equal(auth.status, "active");
    // No table or field in ops represents a coding branch/PR/deploy (Phase 8 scope). Sanity: audit has no deploy actions.
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE '%deploy%' OR action LIKE '%release%'").get().n, 0);
  });
});
