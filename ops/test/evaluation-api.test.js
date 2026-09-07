import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
let seq = 1;

function seedIssueWithImpact(db, { members = 8, contact = "leak@example.com", userRefBase = "reporter-xyz" } = {}) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
  for (let k = 0; k < members; k++) {
    const i = seq++;
    db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, ?, ?, '3.47', ?)").run(`d${i}`, `k${i}`, `content ${i}`, contact, `${userRefBase}-${k}`, ts);
    const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
    db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', 'BUG', 'symptom', 'HIGH', 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, ts, ts, ts);
    const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
    db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
    db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, ts);
  }
  calculateAndStoreImpact(db, iid, { now: NOW });
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

test("29. evaluation view requires owner auth", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedIssueWithImpact(db);
    assert.equal((await fetch(`${base}/ops/api/issues/${iid}/evaluation`)).status, 401);
  });
});

test("30. recalculate requires CSRF; then queues (202)", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedIssueWithImpact(db);
    const { cookie, csrf } = await login(base);
    const noCsrf = await fetch(`${base}/ops/api/issues/${iid}/evaluation/recalculate`, { method: "POST", headers: { cookie } });
    assert.equal(noCsrf.status, 403);
    const ok = await fetch(`${base}/ops/api/issues/${iid}/evaluation/recalculate`, { method: "POST", headers: { cookie, "X-CSRF-Token": csrf, Origin: base } });
    assert.equal(ok.status, 202);
    const body = await ok.json();
    assert.ok(body.evaluation_run_id > 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.evaluation.recalculation_requested'").get().n, 1);
  });
});

test("31/32. API exposes conclusions/aggregates only — no chain-of-thought, contact, or user identifiers", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedIssueWithImpact(db, { contact: "leak@example.com", userRefBase: "reporter-xyz" });
    await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
    const { cookie } = await login(base);
    const raw = await (await fetch(`${base}/ops/api/issues/${iid}/evaluation`, { headers: { cookie } })).text();
    assert.doesNotMatch(raw, /leak@example\.com/);   // 32 contact
    assert.doesNotMatch(raw, /reporter-xyz/);         // 32 user identifier
    assert.doesNotMatch(raw, /chain_of_thought|reasoning_steps/i); // 31 no hidden CoT
    const data = JSON.parse(raw);
    assert.equal(data.current.status, "completed");
    assert.ok(["PROPOSE", "WAIT", "IGNORE", "ESCALATE"].includes(data.current.final_recommendation));
    // role evals only expose conclusion-style fields
    const allowed = new Set(["id", "evaluation_run_id", "role", "round", "recommendation", "confidence", "risk_level", "rationale", "evidence_refs", "missing_evidence", "risk_flags", "provider", "model", "model_version", "prompt_version", "output_hash", "created_at"]);
    for (const re of data.current_run.role_evaluations) {
      for (const k of Object.keys(re)) assert.ok(allowed.has(k), `unexpected key ${k}`);
    }
  });
});

test("33. audit contains metadata only (no contact/raw content)", async () => {
  await withServer(async ({ base, db }) => {
    seedIssueWithImpact(db, { contact: "leak@example.com" });
    await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
    const audits = db.prepare("SELECT action, data FROM audit_log WHERE action LIKE 'issue.evaluation.%' OR action='issue.role_evaluated'").all();
    assert.ok(audits.some((a) => a.action === "issue.evaluation.started"));
    assert.ok(audits.some((a) => a.action === "issue.role_evaluated"));
    assert.ok(audits.some((a) => a.action === "issue.evaluation.completed"));
    assert.ok(audits.some((a) => a.action === "issue.evaluation.current_changed"));
    for (const a of audits) {
      assert.doesNotMatch(a.data || "", /leak@example\.com/);
      assert.doesNotMatch(a.data || "", /content \d/); // no raw feedback content
    }
  });
});

test("run detail endpoint returns role votes for the current run", async () => {
  await withServer(async ({ base, db }) => {
    const iid = seedIssueWithImpact(db);
    await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
    const { cookie } = await login(base);
    const view = await (await fetch(`${base}/ops/api/issues/${iid}/evaluation`, { headers: { cookie } })).json();
    const runId = view.current_run_id;
    const detail = await (await fetch(`${base}/ops/api/issues/${iid}/evaluation/runs/${runId}`, { headers: { cookie } })).json();
    assert.equal(detail.run.id, runId);
    assert.equal(detail.role_evaluations.length, 5);
  });
});
