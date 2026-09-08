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
import { createReleaseCandidate, submitOwnerReleaseDecision } from "../src/releaseCandidate.js";
import { createMigrationSafetyAssessment } from "../src/release/migrationSafety.js";
import { makeStubProductionReleaseProvider } from "../src/release/productionReleaseProvider.js";
import { seedProductionStable } from "../src/release/productionRelease.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
const NOW = new Date();
let seq = 1;

function initGitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m15-api-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "m15-api-remote-"));
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
async function seedCleared(db, repoRef) {
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
  const decided = submitOwnerReleaseDecision(db, {
    codingTaskId: task.id, action: "APPROVE_RELEASE", manifestId: candidate.id, manifestVersion: candidate.manifest_version,
    manifestHash: candidate.manifest_hash, artifactDigest: candidate.artifact_digest, headSha: candidate.head_sha, repo, now: NOW,
  });
  const assessed = createMigrationSafetyAssessment(db, {
    codingTaskId: task.id, repo, now: NOW,
    releaseAuthorizationId: decided.authorization.id, manifestId: candidate.id, manifestVersion: candidate.manifest_version,
    manifestHash: candidate.manifest_hash, headSha: candidate.head_sha, artifactDigest: candidate.artifact_digest,
  });
  seedProductionStable(db, {
    sourceSha: repo.resolveRef("master"),
    artifactDigest: "sha256:" + "11".repeat(32),
    workflowRunId: "33999999999",
    provenance: { kind: "seeded_previous_stable" },
    now: NOW,
  });
  repoRef.repo = repo; repoRef.git = g;
  return { iid, codingTaskId: task.id, authorization: decided.authorization, assessment: assessed.assessment, master: repo.resolveRef("master") };
}

async function withServer(run, provider = makeStubProductionReleaseProvider()) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(CFG);
  const repoRef = {};
  const seeded = await seedCleared(db, repoRef);
  const server = createApp({ db, auth, codingRepo: repoRef.repo, productionReleaseProvider: provider }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db, seeded, provider }); } finally { server.close(); db.close(); repoRef.git.cleanup(); }
}
async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.com", password: "pw" }) });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}
function execPayload(seeded) {
  const a = seeded.authorization;
  const m = seeded.assessment;
  return {
    release_authorization_id: a.id,
    release_authorization_hash: a.authorization_hash,
    manifest_id: a.release_manifest_id,
    manifest_version: a.release_manifest_version,
    manifest_hash: a.manifest_hash,
    migration_safety_assessment_id: m.id,
    migration_safety_policy_fingerprint: m.policy_fingerprint,
    migration_safety_input_fingerprint: m.input_fingerprint,
    clearance_result: m.clearance_result,
    qa_run_id: m.qa_run_id,
    staging_deployment_id: m.staging_deployment_id,
    head_sha: a.head_sha,
    artifact_digest: a.artifact_digest,
    target_environment: "production",
    workflow_ref: "refs/heads/master",
    expected_master_head: seeded.master,
  };
}

test("production-release read APIs require owner auth and do not leak secrets", async () => {
  await withServer(async ({ base, seeded }) => {
    assert.equal((await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/production-release`)).status, 401);
    assert.equal((await fetch(`${base}/ops/api/production-stable`)).status, 401);
    const { cookie } = await login(base);
    const view = await (await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/production-release`, { headers: { cookie } })).json();
    assert.equal(view.coding_task_id, seeded.codingTaskId);
    assert.equal(view.readiness.allowed, true);
    assert.equal(view.current, null);
    assert.doesNotMatch(JSON.stringify(view), /leak@example\.com|GITHUB_TOKEN|NAS_SSH|AUTH_PASSWORD/i);
  });
});

test("production-release execute requires owner + CSRF/Origin and exact identities", async () => {
  await withServer(async ({ base, seeded, db, provider }) => {
    const body = JSON.stringify(execPayload(seeded));
    assert.equal((await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/production-release/execute`, { method: "POST" })).status, 401);
    const { cookie, csrf } = await login(base);
    const noCsrf = await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/production-release/execute`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json" }, body,
    });
    assert.equal(noCsrf.status, 403);
    const cross = await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/production-release/execute`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: "http://evil.example" }, body,
    });
    assert.equal(cross.status, 403);
    const missing = await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/production-release/execute`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ target_environment: "production" }),
    });
    assert.equal(missing.status, 400);
    const ok = await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/production-release/execute`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base }, body,
    });
    if (ok.status !== 200) {
      const errBody = await ok.json();
      throw new Error(`execute ${ok.status}: ${errBody.error || JSON.stringify(errBody)}`);
    }
    const out = await ok.json();
    assert.equal(out.run.current_status, "SUCCEEDED");
    assert.equal(out.current_stable.source_sha, seeded.authorization.head_sha);
    assert.equal(out.db_restore, false);
    assert.doesNotMatch(JSON.stringify(out), /leak@example\.com|ghs_|NAS_SSH|AUTH_PASSWORD/i);
    const replay = await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/production-release/execute`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base }, body,
    });
    assert.equal(replay.status, 200);
    const replayJson = await replay.json();
    assert.equal(replayJson.idempotent, true);
    assert.equal(provider.dispatchCount, 3);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_run").get().n, 1);
    const got = await (await fetch(`${base}/ops/api/production-releases/${out.run.id}`, { headers: { cookie } })).json();
    assert.ok(got.evidence.length > 0);
    const rec = await fetch(`${base}/ops/api/production-releases/${out.run.id}/reconcile`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base }, body: "{}",
    });
    assert.equal(rec.status, 200);
  });
});

test("rollback API requires exact previous stable and never calls DB restore", async () => {
  const provider = makeStubProductionReleaseProvider({ healthFailFor: null });
  await withServer(async ({ base, seeded, provider: p }) => {
    const { cookie, csrf } = await login(base);
    const payload = execPayload(seeded);
    p.healthFailFor = payload.artifact_digest;
    const exec = await fetch(`${base}/ops/api/coding-tasks/${seeded.codingTaskId}/production-release/execute`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify(payload),
    });
    assert.equal(exec.status, 200);
    const out = await exec.json();
    assert.equal(out.rolled_back, true);
    assert.equal(p.restoreCallCount, 0);
    const bad = await fetch(`${base}/ops/api/production-releases/${out.run.id}/rollback`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ previous_stable_sha: "b".repeat(40), previous_stable_digest: "sha256:" + "22".repeat(32), previous_stable_workflow_run_id: "1" }),
    });
    assert.equal(bad.status, 409);
  }, provider);
});

test("unknown coding task production-release is 404 for owner", async () => {
  await withServer(async ({ base }) => {
    const { cookie } = await login(base);
    assert.equal((await fetch(`${base}/ops/api/coding-tasks/99999/production-release`, { headers: { cookie } })).status, 404);
  });
});
