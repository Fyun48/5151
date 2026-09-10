import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

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
import { makeGitRepo } from "../src/coding/gitRepo.js";
import { makeStubCodingProvider } from "../src/coding/provider.js";
import { createCodingTask } from "../src/codingTask.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
const NOW = new Date();
let seq = 1;

function initGitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-dev-api-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "ai-dev-api-remote-"));
  execFileSync("git", ["init", "-q", "-b", "master", dir]);
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github", "workflows", "test.yml"), "name: Tests\n");
  writeFileSync(path.join(dir, "README.md"), "base\n");
  git(["add", "-A"]); git(["commit", "-q", "-m", "base"]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(["remote", "add", "origin", remote]);
  return { dir, remote, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} try { rmSync(remote, { recursive: true, force: true }); } catch {} } };
}
function seedApprovable(db) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
  for (let k = 0; k < 8; k++) {
    const i = seq++;
    db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, 'leak@example.com', ?, '3.47', ?)").run(`d${i}`, `k${i}`, `content ${i}`, `reporter-${i}`, ts);
    const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
    db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', 'BUG', 'symptom', 'HIGH', 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, ts, ts, ts);
    const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
    db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
    db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, ts);
  }
  calculateAndStoreImpact(db, iid, { now: NOW });
  return iid;
}
async function seedTask(db) {
  const iid = seedApprovable(db);
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  submitOwnerDecision(db, iid, { action: "APPROVE_DEVELOPMENT", proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
  const g = initGitRepo();
  const { task } = createCodingTask(db, { issueId: iid, provider: makeStubCodingProvider(), repo: makeGitRepo(g.dir), now: NOW });
  g.cleanup();
  return { iid, taskId: task.id };
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

test("34. owner can inspect coding view + task; unauthenticated is rejected", async () => {
  await withServer(async ({ base, db }) => {
    const { iid, taskId } = await seedTask(db);
    assert.equal((await fetch(`${base}/ops/api/issues/${iid}/coding`)).status, 401);
    assert.equal((await fetch(`${base}/ops/api/coding-tasks/${taskId}`)).status, 401);
    const { cookie } = await login(base);
    const view = await (await fetch(`${base}/ops/api/issues/${iid}/coding`, { headers: { cookie } })).json();
    assert.equal(view.issue_id, iid);
    assert.ok(view.active_authorization && view.active_authorization.id > 0);
    assert.ok(view.approved_snapshot_identity.proposal_hash);
    assert.equal(view.tasks.length, 1);
    assert.equal(view.latest_task.id, taskId);
    const task = await (await fetch(`${base}/ops/api/coding-tasks/${taskId}`, { headers: { cookie } })).json();
    assert.equal(task.id, taskId);
    assert.ok(task.base_sha && task.coding_branch);
  });
});

test("35+36. owner cancel requires auth + CSRF/Origin; then cancels", async () => {
  await withServer(async ({ base, db }) => {
    const { taskId } = await seedTask(db);
    // 未登入
    assert.equal((await fetch(`${base}/ops/api/coding-tasks/${taskId}/cancel`, { method: "POST" })).status, 401);
    const { cookie, csrf } = await login(base);
    // 登入但缺 CSRF
    const noCsrf = await fetch(`${base}/ops/api/coding-tasks/${taskId}/cancel`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(noCsrf.status, 403);
    // 具 CSRF + Origin
    const ok = await fetch(`${base}/ops/api/coding-tasks/${taskId}/cancel`, { method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base }, body: JSON.stringify({ reason: "not needed" }) });
    assert.equal(ok.status, 200);
    const out = await ok.json();
    assert.equal(out.cancelled, true);
    assert.equal(db.prepare("SELECT status FROM development_coding_task WHERE id=?").get(taskId).status, "cancelled");
    assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.coding.cancelled'").get().n >= 1);
  });
});

test("coding API exposes no raw PII/secrets; cancel audit is metadata-only", async () => {
  await withServer(async ({ base, db }) => {
    const { iid, taskId } = await seedTask(db);
    const { cookie, csrf } = await login(base);
    const raw = await (await fetch(`${base}/ops/api/issues/${iid}/coding`, { headers: { cookie } })).text();
    assert.doesNotMatch(raw, /leak@example\.com/);
    assert.doesNotMatch(raw, /reporter-\d/);
    await fetch(`${base}/ops/api/coding-tasks/${taskId}/cancel`, { method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base }, body: "{}" });
    const audits = db.prepare("SELECT data FROM audit_log WHERE action LIKE 'issue.coding.%'").all();
    for (const a of audits) {
      assert.doesNotMatch(a.data || "", /leak@example\.com/);
      assert.doesNotMatch(a.data || "", /content \d/);
    }
  });
});

test("unknown issue/task returns 404 for owner", async () => {
  await withServer(async ({ base }) => {
    const { cookie } = await login(base);
    assert.equal((await fetch(`${base}/ops/api/issues/99999/coding`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/ops/api/coding-tasks/99999`, { headers: { cookie } })).status, 404);
  });
});

test("owner can list recent coding tasks", async () => {
  await withServer(async ({ base, db }) => {
    const { taskId } = await seedTask(db);
    assert.equal((await fetch(`${base}/ops/api/coding-tasks`)).status, 401);
    const { cookie } = await login(base);
    const res = await fetch(`${base}/ops/api/coding-tasks?limit=10`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.items));
    assert.ok(data.items.some((t) => Number(t.id) === Number(taskId)));
  });
});
