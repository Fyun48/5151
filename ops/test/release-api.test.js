import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";
Object.assign(process.env, { STAGING_PROVIDER: "stub", STAGING_ENV_CLASS: "staging", STAGING_ENV_ID: "staging-1", STAGING_DB_CLASS: "disposable", STAGING_STORAGE_MODE: "isolated", STAGING_INTEGRATION_MODE: "sandbox", STAGING_MIGRATION_MODE: "isolated" });

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
import { makeStubPrGateway } from "../src/coding/prGateway.js";
import { createCodingTask, claimCodingTaskBatch, executeCodingTask } from "../src/codingTask.js";
import { createQaRun, executeQaRun } from "../src/qaRun.js";
import { createStagingDeployment, claimStagingBatch, executeStagingDeployment } from "../src/stagingDeploy.js";
import { makeStubStagingProvider } from "../src/staging/provider.js";
import { createReleaseCandidate } from "../src/releaseCandidate.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
const NOW = new Date();
let seq = 1;

function initGitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rc-api-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "rc-api-remote-"));
  execFileSync("git", ["init", "-q", "-b", "master", dir]);
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github", "workflows", "test.yml"), "name: Tests\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: 'node -e "process.exit(0)"' } }) + "\n");
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
async function seedRC(db, repoRef) {
  const iid = seedApprovable(db);
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  submitOwnerDecision(db, iid, { action: "APPROVE_DEVELOPMENT", proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
  const g = initGitRepo(); const repo = makeGitRepo(g.dir); const prov = makeStubCodingProvider();
  const { task } = createCodingTask(db, { issueId: iid, provider: prov, repo, now: NOW });
  const [c] = claimCodingTaskBatch(db, { now: NOW, limit: 5 });
  await executeCodingTask(db, c, { provider: prov, repo, pr: makeStubPrGateway(), selfTest: async () => ({ ran: true, passed: true }), now: NOW });
  const { run } = createQaRun(db, { codingTaskId: task.id, repo, now: NOW });
  await executeQaRun(db, run, { repo, now: NOW });
  createStagingDeployment(db, { codingTaskId: task.id, repo, now: NOW });
  const [d] = claimStagingBatch(db, { now: NOW, limit: 5 });
  await executeStagingDeployment(db, d, { repo, provider: makeStubStagingProvider(), now: NOW });
  const { candidate } = createReleaseCandidate(db, { codingTaskId: task.id, repo, now: NOW });
  repoRef.repo = repo; repoRef.git = g;
  return { iid, codingTaskId: task.id, manifest: candidate };
}

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(CFG);
  const repoRef = {};
  const seeded = await seedRC(db, repoRef); // 先建好 RC，server 用同一 repo 驗證 master 新鮮度
  const server = createApp({ db, auth, codingRepo: repoRef.repo }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db, seeded }); } finally { server.close(); db.close(); repoRef.git.cleanup(); }
}
async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.com", password: "pw" }) });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

test("24. owner release inspection API requires auth; returns fresh RC + manifest", async () => {
  await withServer(async ({ base, db, seeded }) => {
    assert.equal((await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/release`)).status, 401);
    const { cookie } = await login(base);
    const view = await (await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/release`, { headers: { cookie } })).json();
    assert.equal(view.coding_task_id, seeded.codingTaskId);
    assert.ok(view.current && view.current.fresh === true);
    assert.ok(view.current.manifest.what_is_changing.title !== undefined);
    const m = await (await fetch(`${base}/ops/api/release-manifests/${seeded.manifest.id}`, { headers: { cookie } })).json();
    assert.equal(m.id, seeded.manifest.id);
    assert.ok(m.manifest.staging.artifact_digest.startsWith("sha256:"));
  });
});

test("32+33. APPROVE_RELEASE requires owner auth + CSRF/Origin; creates authorization", async () => {
  await withServer(async ({ base, db, seeded }) => {
    const m = seeded.manifest;
    const body = JSON.stringify({ action: "APPROVE_RELEASE", manifest_id: m.id, manifest_version: m.manifest_version, manifest_hash: m.manifest_hash, artifact_digest: m.artifact_digest, head_sha: m.head_sha });
    assert.equal((await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/release/decision`, { method: "POST" })).status, 401);
    const { cookie, csrf } = await login(base);
    const noCsrf = await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/release/decision`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body });
    assert.equal(noCsrf.status, 403);
    const ok = await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/release/decision`, { method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base }, body });
    assert.equal(ok.status, 200);
    const out = await ok.json();
    assert.ok(out.authorization.id > 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_authorization WHERE status='active'").get().n, 1);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.release.authorization_created'").get().n >= 1);
  });
});

test("release API exposes no raw PII/secrets", async () => {
  await withServer(async ({ base, seeded }) => {
    const { cookie } = await login(base);
    const raw = await (await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/release`, { headers: { cookie } })).text();
    assert.doesNotMatch(raw, /leak@example\.com/);
    assert.doesNotMatch(raw, /reporter-\d/);
  });
});

test("unknown coding task / manifest returns 404 for owner", async () => {
  await withServer(async ({ base }) => {
    const { cookie } = await login(base);
    assert.equal((await fetch(`${base}/ops/api/coding-tasks/99999/release`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/ops/api/release-manifests/99999`, { headers: { cookie } })).status, 404);
  });
});
