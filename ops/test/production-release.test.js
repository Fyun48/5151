import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";
Object.assign(process.env, { STAGING_PROVIDER: "stub", STAGING_ENV_CLASS: "staging", STAGING_ENV_ID: "staging-1", STAGING_DB_CLASS: "disposable", STAGING_STORAGE_MODE: "isolated", STAGING_INTEGRATION_MODE: "sandbox", STAGING_MIGRATION_MODE: "isolated" });

import { openOpsDb } from "../src/opsDb.js";
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
import { MIGRATION_CLASSIFICATIONS } from "../src/qa/migrationEvidence.js";
import {
  PRODUCTION_WORKFLOWS, REQUIRED_WORKFLOW_REF, REQUIRED_TARGET_ENVIRONMENT,
  buildProductionReleasePolicy, decideDbRollbackDisposition, digestLooksImmutable,
  isSuccessfulConclusion, previousStableComplete, productionReleasePolicyFingerprint,
} from "../src/release/productionReleasePolicy.js";
import { makeStubProductionReleaseProvider, makeProductionReleaseProvider, makeGithubProductionReleaseProvider } from "../src/release/productionReleaseProvider.js";
import {
  createProductionReleaseRun, executeProductionRelease, getProductionRelease, getProductionReleaseView,
  getProductionStable, parseProductionWorkflowTriggers, reconcileProductionRelease, requestCodeRollback,
  retryProductionRelease, sanitizeReleaseEvidence, seedProductionStable,
} from "../src/release/productionRelease.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
let seq = 1;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function seedProposeIssue(db) {
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
function initGitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m15-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "m15-remote-"));
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
async function makeStagedTask(db) {
  const iid = seedProposeIssue(db);
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
  return { iid, codingTaskId: task.id, repo, git: g };
}
function approve(db, codingTaskId, repo) {
  const { candidate: rc } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
  const out = submitOwnerReleaseDecision(db, {
    codingTaskId, action: "APPROVE_RELEASE", manifestId: rc.id, manifestVersion: rc.manifest_version,
    manifestHash: rc.manifest_hash, artifactDigest: rc.artifact_digest, headSha: rc.head_sha, repo, now: NOW,
  });
  return { rc, authorization: out.authorization };
}
function bind(auth) {
  return {
    releaseAuthorizationId: auth.id, manifestId: auth.release_manifest_id, manifestVersion: auth.release_manifest_version,
    manifestHash: auth.manifest_hash, headSha: auth.head_sha, artifactDigest: auth.artifact_digest,
  };
}
async function cleared(db, codingTaskId, repo) {
  const { rc, authorization } = approve(db, codingTaskId, repo);
  const created = createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
  return { rc, authorization, assessment: created.assessment };
}
function execBody(codingTaskId, auth, assessment, extra = {}) {
  return {
    codingTaskId,
    releaseAuthorizationId: auth.id,
    releaseAuthorizationHash: auth.authorization_hash,
    manifestId: auth.release_manifest_id,
    manifestVersion: auth.release_manifest_version,
    manifestHash: auth.manifest_hash,
    migrationSafetyAssessmentId: assessment.id,
    migrationSafetyPolicyFingerprint: assessment.policy_fingerprint,
    migrationSafetyInputFingerprint: assessment.input_fingerprint,
    clearanceResult: assessment.clearance_result,
    qaRunId: assessment.qa_run_id,
    stagingDeploymentId: assessment.staging_deployment_id,
    headSha: auth.head_sha,
    artifactDigest: auth.artifact_digest,
    targetEnvironment: REQUIRED_TARGET_ENVIRONMENT,
    workflowRef: REQUIRED_WORKFLOW_REF,
    ...extra,
  };
}
function seedPrev(db, repo) {
  return seedProductionStable(db, {
    sourceSha: repo.resolveRef("master"),
    artifactDigest: "sha256:" + "11".repeat(32),
    workflowRunId: "33999999999",
    provenance: { kind: "seeded_previous_stable", workflow_file: PRODUCTION_WORKFLOWS.DEPLOY, workflow_ref: REQUIRED_WORKFLOW_REF },
    now: NOW,
  });
}

test("Phase 15 policy is deterministic, fail-closed, and excludes secrets", () => {
  const p = buildProductionReleasePolicy();
  assert.equal(productionReleasePolicyFingerprint(p), productionReleasePolicyFingerprint(buildProductionReleasePolicy()));
  assert.equal(p.no_llm_decision, true);
  assert.equal(p.no_third_human_gate, true);
  assert.equal(p.no_auto_db_restore, true);
  assert.equal(p.no_direct_ssh, true);
  assert.equal(p.merge_push_does_not_deploy, true);
  assert.doesNotMatch(JSON.stringify(p), /password|GITHUB_TOKEN|NAS_SSH|AUTH_PASSWORD/i);
  assert.equal(digestLooksImmutable("latest"), false);
  assert.equal(digestLooksImmutable("sha256:" + "ab".repeat(32)), true);
  assert.equal(previousStableComplete({ source_sha: "abc", artifact_digest: "sha256:" + "11".repeat(32), workflow_run_id: "1" }), false);
  assert.equal(decideDbRollbackDisposition(MIGRATION_CLASSIFICATIONS.NONE).disposition, "NO_DB_ROLLBACK");
  assert.equal(decideDbRollbackDisposition(MIGRATION_CLASSIFICATIONS.ADDITIVE_BACKWARD_COMPATIBLE).disposition, "MANUAL_REQUIRED");
  assert.equal(decideDbRollbackDisposition(MIGRATION_CLASSIFICATIONS.DATA_MIGRATION).auto_restore, false);
  assert.equal(decideDbRollbackDisposition(MIGRATION_CLASSIFICATIONS.DESTRUCTIVE_OR_IRREVERSIBLE).disposition, "MANUAL_REQUIRED");
  assert.equal(decideDbRollbackDisposition(MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN).disposition, "MANUAL_REQUIRED");
  assert.equal(isSuccessfulConclusion("success", "completed"), true);
  assert.equal(isSuccessfulConclusion("cancelled", "completed"), false);
  assert.equal(isSuccessfulConclusion("skipped", "completed"), false);
  assert.equal(isSuccessfulConclusion("neutral", "completed"), false);
  assert.equal(isSuccessfulConclusion("failure", "completed"), false);
  assert.equal(isSuccessfulConclusion(null, "completed"), false);
  assert.equal(isSuccessfulConclusion("success", "in_progress"), false);
  assert.equal(isSuccessfulConclusion("success", "pending"), false);
});

test("default and GitHub production providers stay unavailable (no live dispatch)", () => {
  const none = makeProductionReleaseProvider({ PRODUCTION_RELEASE_PROVIDER: "" });
  assert.equal(none.available, false);
  const gh = makeGithubProductionReleaseProvider({ GITHUB_TOKEN: "ghs_this_must_not_enable_dispatch" });
  assert.equal(gh.available, false);
  assert.equal(makeProductionReleaseProvider({ PRODUCTION_RELEASE_PROVIDER: "github" }).available, false);
});

test("Production workflows remain workflow_dispatch only; merge/push does not deploy", () => {
  for (const rel of [
    ".github/workflows/build-production-image.yml",
    ".github/workflows/production-predeploy-check.yml",
    ".github/workflows/deploy-v3.yml",
    ".github/workflows/docker.yml",
    ".github/workflows/deploy.yml",
    ".github/workflows/deploy-v2.yml",
  ]) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    const trig = parseProductionWorkflowTriggers(text);
    assert.equal(trig.workflow_dispatch, true, rel);
    assert.equal(trig.push, false, rel);
    assert.equal(trig.pull_request, false, rel);
    assert.equal(trig.schedule, false, rel);
  }
  const ci = readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8");
  assert.match(ci, /Auto-merge \(no production deploy\)/);
  assert.doesNotMatch(ci, /workflow_dispatch:[\s\S]*deploy-v3/);
});

test("A→H isolated stub release succeeds only after health/smoke and updates current stable", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    const provider = makeStubProductionReleaseProvider();
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW, actor: "owner:test" });
    const out = await executeProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner:test" });
    assert.equal(out.run.current_status, "SUCCEEDED");
    const stable = getProductionStable(db);
    assert.equal(stable.source_sha, authorization.head_sha);
    assert.equal(stable.artifact_digest, authorization.artifact_digest);
    assert.ok(stable.workflow_run_id);
    const detail = getProductionRelease(db, created.run.id);
    assert.ok(detail.evidence.some((e) => e.evidence_kind === "health_smoke" && e.health_result === "PASS"));
    assert.ok(detail.evidence.some((e) => e.evidence_kind === "db_rollback_disposition" && e.payload.disposition === "NO_DB_ROLLBACK"));
    assert.equal(provider.restoreCallCount, 0);
    assert.equal(provider.dispatchCount, 3);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_run").get().n, 1);
    assert.throws(() => db.prepare("UPDATE production_release_run SET artifact_digest='x' WHERE id=?").run(created.run.id), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM production_release_run WHERE id=?").run(created.run.id), /append-only/);
    assert.throws(() => db.prepare("UPDATE production_release_evidence SET payload_json='{}' WHERE release_run_id=?").run(created.run.id), /immutable/);
    const again = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: created.run.expected_master_head }), { repo, now: NOW });
    assert.equal(again.idempotent, true);
    assert.equal(again.run.id, created.run.id);
    const replay = await executeProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner:test" });
    assert.equal(replay.idempotent, true);
    assert.equal(provider.dispatchCount, 3);
  } finally { git.cleanup(); db.close(); }
});

test("exact active authorization + fresh CLEARED clearance is required; all drifts are blocked", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const good = execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") });
    assert.throws(() => createProductionReleaseRun(db, { ...good, targetEnvironment: "staging" }, { repo, now: NOW }), /target environment/);
    assert.throws(() => createProductionReleaseRun(db, { ...good, workflowRef: "refs/heads/feat" }, { repo, now: NOW }), /workflow ref/);
    assert.throws(() => createProductionReleaseRun(db, { ...good, artifactDigest: "latest" }, { repo, now: NOW }), /immutable digest/);
    assert.throws(() => createProductionReleaseRun(db, { ...good, releaseAuthorizationHash: "nope" }, { repo, now: NOW }), /authorization_hash/);
    assert.throws(() => createProductionReleaseRun(db, { ...good, manifestHash: "deadbeefdeadbeef" }, { repo, now: NOW }), /cannot start|mismatch/);
    assert.throws(() => createProductionReleaseRun(db, { ...good, headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { repo, now: NOW }), /cannot start|mismatch/);
    assert.throws(() => createProductionReleaseRun(db, { ...good, clearanceResult: "BLOCKED_UNKNOWN" }, { repo, now: NOW }), /clearance_result/);
    assert.throws(() => createProductionReleaseRun(db, { ...good, qaRunId: 999999 }, { repo, now: NOW }), /qa_run_id/);
    assert.throws(() => createProductionReleaseRun(db, { ...good, releaseAuthorizationId: authorization.id, releaseAuthorizationHash: authorization.authorization_hash, migrationSafetyAssessmentId: 999999 }, { repo, now: NOW }), /assessment/);
  } finally { git.cleanup(); db.close(); }
});

test("missing Phase-14 clearance and superseded authorization cannot create a release run", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization } = approve(db, codingTaskId, repo);
    const authRow = db.prepare("SELECT * FROM production_release_authorization WHERE id=?").get(authorization.id);
    const fake = execBody(codingTaskId, authorization, {
      id: 1, policy_fingerprint: "x", input_fingerprint: "y", clearance_result: "CLEARED_NO_MIGRATION",
      qa_run_id: authRow.qa_run_id, staging_deployment_id: authRow.staging_deployment_id,
    }, { expectedMasterHead: repo.resolveRef("master") });
    assert.throws(() => createProductionReleaseRun(db, fake, { repo, now: NOW }), /phase14_clearance_missing|cannot start|not found/);
    const { authorization: auth2, assessment } = await cleared(db, codingTaskId, repo);
    writeFileSync(path.join(git.dir, "m15-advance.txt"), "x\n");
    execFileSync("git", ["-C", git.dir, "add", "-A"]);
    execFileSync("git", ["-C", git.dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "master advance"]);
    createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.equal(db.prepare("SELECT status FROM production_release_authorization WHERE id=?").get(auth2.id).status, "superseded");
    assert.throws(() => createProductionReleaseRun(db, execBody(codingTaskId, auth2, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW }), /superseded|cannot start|stale/);
  } finally { git.cleanup(); db.close(); }
});

test("expected HEAD race and branch protection rejection are fail-closed without admin override", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const master = repo.resolveRef("master");
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: master }), { repo, now: NOW });
    writeFileSync(path.join(git.dir, "race.txt"), "race\n");
    execFileSync("git", ["-C", git.dir, "add", "-A"]);
    execFileSync("git", ["-C", git.dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "race"]);
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider: makeStubProductionReleaseProvider(), repo, now: NOW }), /expected_head_race|protected merge|source_base|stale|eligibility/);
    const db2 = openOpsDb(":memory:");
    const staged2 = await makeStagedTask(db2);
    const c2 = await cleared(db2, staged2.codingTaskId, staged2.repo);
    const run2 = createProductionReleaseRun(db2, execBody(staged2.codingTaskId, c2.authorization, c2.assessment, { expectedMasterHead: staged2.repo.resolveRef("master") }), { repo: staged2.repo, now: NOW });
    await assert.rejects(() => executeProductionRelease(db2, run2.run.id, { provider: makeStubProductionReleaseProvider({ protectionReject: true }), repo: staged2.repo, now: NOW }), /branch_protection/);
    staged2.git.cleanup(); db2.close();
  } finally { git.cleanup(); db.close(); }
});

test("image digest / OCI revision / source mismatch is blocked", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, {
      provider: makeStubProductionReleaseProvider({ imageMismatch: true }), repo, now: NOW,
    }), /digest mismatch|OCI /);
    assert.equal(getProductionStable(db), null);
  } finally { git.cleanup(); db.close(); }
});

test("pending/cancelled/skipped/neutral/failed workflow conclusions are never success", async () => {
  for (const conclusion of ["cancelled", "skipped", "neutral", "failure"]) {
    const db = openOpsDb(":memory:");
    const { codingTaskId, repo, git } = await makeStagedTask(db);
    try {
      const { authorization, assessment } = await cleared(db, codingTaskId, repo);
      const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW });
      const conclusions = { [PRODUCTION_WORKFLOWS.BUILD]: conclusion };
      await assert.rejects(() => executeProductionRelease(db, created.run.id, {
        provider: makeStubProductionReleaseProvider({ conclusions }), repo, now: NOW,
      }), /not success/);
    } finally { git.cleanup(); db.close(); }
  }
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, {
      provider: makeStubProductionReleaseProvider({ pendingWorkflows: [PRODUCTION_WORKFLOWS.BUILD] }), repo, now: NOW,
    }), /not success/);
  } finally { git.cleanup(); db.close(); }
});

test("predeploy backup missing or unverified is blocked", async () => {
  for (const opt of [{ missingBackup: true }, { unverifiedBackup: true }]) {
    const db = openOpsDb(":memory:");
    const { codingTaskId, repo, git } = await makeStagedTask(db);
    try {
      const { authorization, assessment } = await cleared(db, codingTaskId, repo);
      const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW });
      await assert.rejects(() => executeProductionRelease(db, created.run.id, {
        provider: makeStubProductionReleaseProvider(opt), repo, now: NOW,
      }), /backup/);
      assert.equal(getProductionStable(db), null);
    } finally { git.cleanup(); db.close(); }
  }
});

test("provider API success without a verifiable workflow run is not started or deployed", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW });
    const provider = makeStubProductionReleaseProvider({ dispatchNoRunId: true });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /not a verifiable workflow run/);
    assert.equal(getProductionRelease(db, created.run.id).run.current_status, "BLOCKED");
    assert.equal(getProductionStable(db), null);
    await assert.rejects(() => retryProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /reconcile instead/);
  } finally { git.cleanup(); db.close(); }
});

test("timeout/unknown result reconciles by idempotency and never double-dispatches", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW });
    const provider = makeStubProductionReleaseProvider({ dispatchTimeout: true });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /verifiable workflow run|reconcile/);
    assert.equal(provider.dispatchCount, 1);
    await assert.rejects(() => reconcileProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /re-dispatch|verifiable|reconcile/);
    assert.equal(provider.dispatchCount, 1);
    assert.equal(getProductionStable(db), null);
  } finally { git.cleanup(); db.close(); }
});

test("health failure rolls back exact previous stable code and never restores DB", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const prev = seedPrev(db, repo);
    const provider = makeStubProductionReleaseProvider({ healthFailFor: authorization.artifact_digest });
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW });
    const out = await executeProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner:test" });
    assert.equal(out.rolled_back, true);
    assert.equal(out.db_restore, false);
    assert.equal(out.run.current_status, "ROLLED_BACK");
    const stable = getProductionStable(db);
    assert.equal(stable.source_sha, prev.source_sha);
    assert.equal(stable.artifact_digest, prev.artifact_digest);
    assert.equal(provider.restoreCallCount, 0);
    const detail = getProductionRelease(db, created.run.id);
    assert.ok(detail.evidence.some((e) => e.evidence_kind === "db_rollback_disposition" && e.payload.auto_restore === false));
    assert.ok(detail.events.some((e) => e.to_status === "ROLLED_BACK"));
  } finally { git.cleanup(); db.close(); }
});

test("previous stable identity incomplete blocks rollback", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW });
    assert.equal(created.run.previous_stable_sha, null);
    const provider = makeStubProductionReleaseProvider({ healthFail: true });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /previous stable identity is incomplete/);
    await assert.rejects(() => requestCodeRollback(db, {
      releaseRunId: created.run.id, previousStableSha: "a".repeat(40), previousStableDigest: "sha256:" + "11".repeat(32),
      previousStableWorkflowRunId: "1", provider, repo, now: NOW,
    }), /previous stable identity mismatch/);
  } finally { git.cleanup(); db.close(); }
});

test("sanitized evidence never stores secrets or PII; Owner view stays clean", async () => {
  const dirty = sanitizeReleaseEvidence({
    token: "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
    password: "secret",
    email: "leak@example.com",
    connection_string: "sqlite:///prod",
    backup_hash: "sha256:abc",
  });
  assert.equal(dirty.token, "[REDACTED]");
  assert.equal(dirty.password, "[REDACTED]");
  assert.equal(dirty.email, "[REDACTED]");
  assert.equal(dirty.connection_string, "[REDACTED]");
  assert.equal(dirty.backup_hash, "sha256:abc");
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW });
    await executeProductionRelease(db, created.run.id, { provider: makeStubProductionReleaseProvider(), repo, now: NOW });
    const view = getProductionReleaseView(db, codingTaskId, { repo });
    assert.doesNotMatch(JSON.stringify(view), /leak@example\.com|reporter-\d|NAS_SSH|GITHUB_TOKEN|AUTH_PASSWORD/i);
  } finally { git.cleanup(); db.close(); }
});
