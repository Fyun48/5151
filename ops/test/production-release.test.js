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
  buildProductionReleasePolicy, classifyWorkflowRun, decideDbRollbackDisposition, digestLooksImmutable,
  isAllowedReleaseTransition, isAuthorizedGithubActor, isSuccessfulConclusion, previousStableComplete,
  productionReleasePolicyFingerprint, validateExactWorkflowEvidence, workflowIdempotencyKey,
} from "../src/release/productionReleasePolicy.js";
import { makeStubProductionReleaseProvider, makeProductionReleaseProvider, makeGithubProductionReleaseProvider } from "../src/release/productionReleaseProvider.js";
import {
  createProductionReleaseRun, executeProductionRelease, getProductionRelease, getProductionReleaseView,
  getProductionStable, parseProductionWorkflowTriggers, reconcileProductionRelease, requestCodeRollback,
  retryProductionRelease, sanitizeReleaseEvidence, seedProductionStable,
} from "../src/release/productionRelease.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const GITHUB_ACTOR = "Fyun48";
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
    githubActor: GITHUB_ACTOR,
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
  assert.equal(digestLooksImmutable("sha256:" + "ab".repeat(8)), false);
  assert.equal(digestLooksImmutable("sha256:" + "AB".repeat(32)), false);
  assert.equal(digestLooksImmutable("SHA256:" + "ab".repeat(32)), false);
  assert.equal(digestLooksImmutable("sha256:" + "ab".repeat(32) + "ff"), false);
  assert.equal(previousStableComplete({ source_sha: "abc", artifact_digest: "sha256:" + "11".repeat(32), workflow_run_id: "1" }), false);
  assert.equal(previousStableComplete({ source_sha: "a".repeat(40), artifact_digest: "sha256:" + "11".repeat(8), workflow_run_id: "1" }), false);
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
  assert.equal(isSuccessfulConclusion("success", undefined), false);
  assert.equal(isSuccessfulConclusion("success", ""), false);
  assert.equal(isSuccessfulConclusion("success", null), false);
  assert.equal(isAllowedReleaseTransition(null, "CREATED"), true);
  assert.equal(isAllowedReleaseTransition("SUCCEEDED", "DB_ROLLBACK_MANUAL_REQUIRED"), false);
  assert.equal(isAllowedReleaseTransition("SUCCEEDED", "HEALTH_VERIFIED"), false);
  assert.equal(isAllowedReleaseTransition("BLOCKED", "BUILD_DISPATCHED"), false);
  assert.equal(isAuthorizedGithubActor("Fyun48"), true);
  assert.equal(isAuthorizedGithubActor("owner:demo@example.com"), false);
  assert.equal(isAuthorizedGithubActor("demo@example.com"), false);
  assert.equal(isAuthorizedGithubActor("latest"), false);
  assert.equal(classifyWorkflowRun({ id: "1", status: "in_progress", conclusion: null }).kind, "waiting");
  assert.equal(classifyWorkflowRun({ id: "1", status: "queued", conclusion: null }).kind, "waiting");
  assert.equal(classifyWorkflowRun({ id: "1", status: "completed", conclusion: "failure" }).kind, "failed");
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
    assert.throws(() => createProductionReleaseRun(db, { ...good, artifactDigest: "sha256:" + "ab".repeat(8) }, { repo, now: NOW }), /immutable digest/);
    assert.throws(() => createProductionReleaseRun(db, { ...good, artifactDigest: "sha256:" + "AB".repeat(32) }, { repo, now: NOW }), /immutable digest/);
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
      }), /not success|exactly bound|conclusion/);
    } finally { git.cleanup(); db.close(); }
  }
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW });
    const provider = makeStubProductionReleaseProvider({ pendingWorkflows: [PRODUCTION_WORKFLOWS.BUILD] });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /still in_progress|still queued/);
    assert.equal(getProductionRelease(db, created.run.id).run.current_status, "BUILD_DISPATCHED");
    assert.equal(provider.dispatchCount, 1);
    assert.notEqual(getProductionRelease(db, created.run.id).run.current_status, "BLOCKED");
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
    const replay = await reconcileProductionRelease(db, created.run.id, { provider, repo, now: NOW });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.current_status, "BLOCKED");
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

function exactWf(over = {}) {
  return {
    id: "34000000001",
    attempt: 1,
    status: "completed",
    conclusion: "success",
    workflow_file: PRODUCTION_WORKFLOWS.BUILD,
    workflow_ref: REQUIRED_WORKFLOW_REF,
    head_sha: "a".repeat(40),
    actor: GITHUB_ACTOR,
    triggering_actor: GITHUB_ACTOR,
    environment: null,
    outputs: {
      image_digest: "sha256:" + "ab".repeat(32),
      oci_revision: "a".repeat(40),
      oci_source: "https://github.com/Fyun48/5151",
    },
    ...over,
  };
}

test("workflow evidence requires every identity field; missing or mismatch is failure", () => {
  const expected = {
    workflow_run_id: "34000000001",
    attempt: 1,
    workflow_file: PRODUCTION_WORKFLOWS.BUILD,
    workflow_ref: REQUIRED_WORKFLOW_REF,
    head_sha: "a".repeat(40),
    actor: GITHUB_ACTOR,
    triggering_actor: GITHUB_ACTOR,
    environment: null,
    image_digest: "sha256:" + "ab".repeat(32),
    oci_revision: "a".repeat(40),
    oci_source: "https://github.com/Fyun48/5151",
  };
  assert.equal(validateExactWorkflowEvidence(exactWf(), expected).ok, true);
  assert.equal(validateExactWorkflowEvidence(exactWf({ actor: null, triggering_actor: GITHUB_ACTOR }), expected).ok, false);
  assert.equal(validateExactWorkflowEvidence(exactWf({ actor: "attacker", triggering_actor: GITHUB_ACTOR }), expected).ok, false);
  assert.equal(validateExactWorkflowEvidence(exactWf({ actor: GITHUB_ACTOR, triggering_actor: null }), expected).ok, false);
  assert.equal(validateExactWorkflowEvidence(exactWf({ actor: GITHUB_ACTOR, triggering_actor: "attacker" }), expected).ok, false);
  assert.equal(validateExactWorkflowEvidence({ id: "34000000001", conclusion: "success" }, expected).ok, false);
  const cases = [
    [{ id: null }, "id"],
    [{ id: "9" }, "id_mismatch"],
    [{ attempt: null }, "attempt"],
    [{ attempt: 2 }, "attempt_mismatch"],
    [{ status: undefined }, "status"],
    [{ status: "in_progress" }, "status_mismatch"],
    [{ conclusion: undefined }, "conclusion"],
    [{ conclusion: "failure" }, "conclusion_mismatch"],
    [{ workflow_file: null }, "workflow_file"],
    [{ workflow_file: PRODUCTION_WORKFLOWS.DEPLOY }, "workflow_file_mismatch"],
    [{ workflow_ref: null }, "workflow_ref"],
    [{ workflow_ref: "refs/heads/feat" }, "workflow_ref_mismatch"],
    [{ head_sha: null }, "head_sha"],
    [{ head_sha: "b".repeat(40) }, "head_sha_mismatch"],
    [{ actor: null, triggering_actor: GITHUB_ACTOR }, "actor"],
    [{ actor: "other", triggering_actor: GITHUB_ACTOR }, "actor_mismatch"],
    [{ actor: GITHUB_ACTOR, triggering_actor: null }, "triggering_actor"],
    [{ actor: GITHUB_ACTOR, triggering_actor: "other" }, "triggering_actor_mismatch"],
    [{ environment: "production" }, "environment_mismatch"],
    [{ outputs: {} }, "image_digest"],
    [{ outputs: { image_digest: "sha256:" + "cd".repeat(32), oci_revision: "a".repeat(40), oci_source: "https://github.com/Fyun48/5151" } }, "image_digest_mismatch"],
  ];
  for (const [over, problem] of cases) {
    const wf = exactWf(over);
    if (Object.prototype.hasOwnProperty.call(over, "status") && over.status === undefined) delete wf.status;
    if (Object.prototype.hasOwnProperty.call(over, "conclusion") && over.conclusion === undefined) delete wf.conclusion;
    const got = validateExactWorkflowEvidence(wf, expected);
    assert.equal(got.ok, false, problem);
    assert.ok(got.problems.includes(problem), `${problem} in ${got.problems.join(",")}`);
  }
  const deployExpected = { ...expected, environment: REQUIRED_TARGET_ENVIRONMENT, workflow_file: PRODUCTION_WORKFLOWS.DEPLOY };
  assert.ok(validateExactWorkflowEvidence(exactWf({ workflow_file: PRODUCTION_WORKFLOWS.DEPLOY }), deployExpected).problems.includes("environment"));
});

function wrapGetWorkflowRun(provider, mutate) {
  const orig = provider.getWorkflowRun.bind(provider);
  provider.getWorkflowRun = async (args) => {
    const wf = await orig(args);
    if (!wf) return wf;
    return mutate({ ...wf, outputs: { ...(wf.outputs || {}) } });
  };
  return provider;
}

test("orchestrator rejects missing/mismatched workflow run fields including missing status", async () => {
  const mutations = [
    [(wf) => { const o = { ...wf }; delete o.status; return o; }, /status/],
    [(wf) => ({ ...wf, conclusion: "success", status: "completed", workflow_file: PRODUCTION_WORKFLOWS.DEPLOY }), /workflow_file/],
    [(wf) => ({ ...wf, head_sha: "f".repeat(40) }), /head_sha/],
    [(wf) => ({ ...wf, workflow_ref: "refs/heads/dev" }), /workflow_ref/],
    [(wf) => ({ ...wf, actor: "intruder", triggering_actor: "intruder" }), /actor/],
    [(wf) => ({ ...wf, environment: "staging" }), /environment/],
    [(wf) => ({ id: wf.id, conclusion: "success" }), /exactly bound|status|workflow_file/],
  ];
  for (const [mutate, re] of mutations) {
    const db = openOpsDb(":memory:");
    const { codingTaskId, repo, git } = await makeStagedTask(db);
    try {
      const { authorization, assessment } = await cleared(db, codingTaskId, repo);
      const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW });
      const provider = wrapGetWorkflowRun(makeStubProductionReleaseProvider(), mutate);
      await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner" }), re);
      assert.equal(getProductionStable(db), null);
    } finally { git.cleanup(); db.close(); }
  }
});

function forceClearedAdditive(db, assessment) {
  const row = db.prepare("SELECT * FROM production_migration_safety_assessment WHERE id=?").get(assessment.id);
  const ts = NOW.toISOString();
  const inputFp = "c".repeat(64);
  const res = db.prepare(
    `INSERT INTO production_migration_safety_assessment(
      issue_id, coding_task_id, release_authorization_id, release_manifest_id, release_manifest_version, manifest_hash,
      qa_run_id, staging_deployment_id, head_sha, artifact_digest, migration_classification, clearance_result,
      evidence_snapshot, rollback_assessment, compatibility_assessment, policy_version, policy_fingerprint,
      input_fingerprint, assessment_version, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.issue_id, row.coding_task_id, row.release_authorization_id, row.release_manifest_id, row.release_manifest_version, row.manifest_hash,
    row.qa_run_id, row.staging_deployment_id, row.head_sha, row.artifact_digest, "ADDITIVE_BACKWARD_COMPATIBLE", "CLEARED_ADDITIVE",
    row.evidence_snapshot, row.rollback_assessment, row.compatibility_assessment, row.policy_version, row.policy_fingerprint,
    inputFp, Number(row.assessment_version) + 1, ts,
  );
  const id = Number(res.lastInsertRowid);
  db.prepare("UPDATE production_migration_safety_current SET assessment_id=?, input_fingerprint=?, clearance_result=?, updated_at=? WHERE coding_task_id=?")
    .run(id, inputFp, "CLEARED_ADDITIVE", ts, row.coding_task_id);
  return db.prepare("SELECT * FROM production_migration_safety_assessment WHERE id=?").get(id);
}

test("CLEARED_ADDITIVE success stays terminal SUCCEEDED and replay is side-effect free", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const additive = forceClearedAdditive(db, assessment);
    seedPrev(db, repo);
    const provider = makeStubProductionReleaseProvider();
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, additive, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW, actor: "owner:test" });
    const out = await executeProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner:test" });
    assert.equal(out.run.current_status, "SUCCEEDED");
    assert.equal(out.db_rollback.disposition, "MANUAL_REQUIRED");
    assert.equal(out.db_restore, false);
    const before = getProductionRelease(db, created.run.id);
    const eventCount = before.events.length;
    const evidenceCount = before.evidence.length;
    const stable = getProductionStable(db);
    assert.ok(before.evidence.some((e) => e.evidence_kind === "db_rollback_disposition" && e.payload.disposition === "MANUAL_REQUIRED"));
    assert.ok(!before.events.some((e) => e.to_status === "DB_ROLLBACK_MANUAL_REQUIRED"));
    const replay = await executeProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner:test" });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.run.current_status, "SUCCEEDED");
    const after = getProductionRelease(db, created.run.id);
    assert.equal(after.events.length, eventCount);
    assert.equal(after.evidence.length, evidenceCount);
    assert.equal(getProductionStable(db).source_sha, stable.source_sha);
    assert.equal(getProductionStable(db).artifact_digest, stable.artifact_digest);
    assert.equal(provider.dispatchCount, 3);
    assert.equal(provider.restoreCallCount, 0);
  } finally { git.cleanup(); db.close(); }
});

test("concurrent execute on a non-deduplicating provider dispatches each workflow once", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    const provider = makeStubProductionReleaseProvider({ deduplicate: false, dispatchDelayMs: 40 });
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW, actor: "owner" });
    const settled = await Promise.allSettled([
      executeProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner" }),
      executeProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner" }),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    assert.ok(ok.length >= 1);
    assert.ok(ok.some((s) => s.value.run.current_status === "SUCCEEDED" || s.value.idempotent));
    assert.equal(provider.dispatchCount, 3);
    assert.equal(getProductionRelease(db, created.run.id).run.current_status, "SUCCEEDED");
  } finally { git.cleanup(); db.close(); }
});

test("worker restart after claimed dispatch binds by idempotency and never re-dispatches", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW, actor: "owner" });
    const key = workflowIdempotencyKey({ releaseRunId: created.run.id, workflowKind: "build", inputFingerprint: created.run.input_fingerprint });
    const intent = "restart-intent-1";
    db.prepare(
      `INSERT INTO production_release_workflow_binding(release_run_id, workflow_kind, idempotency_key, binding_status, dispatch_owner, dispatch_intent_id, dispatch_request_id, dispatch_claimed_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(created.run.id, "build", key, "claimed", "dead-owner", intent, intent, NOW.toISOString(), NOW.toISOString());
    const provider = makeStubProductionReleaseProvider({ deduplicate: false });
    await provider.dispatchWorkflow({
      workflowFile: PRODUCTION_WORKFLOWS.BUILD,
      workflowRef: REQUIRED_WORKFLOW_REF,
      inputs: { sha: authorization.head_sha, expected_digest: authorization.artifact_digest, image_digest: authorization.artifact_digest },
      idempotencyKey: key,
      actor: GITHUB_ACTOR,
      requestId: intent,
    });
    assert.equal(provider.dispatchCount, 1);
    const out = await executeProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner" });
    assert.equal(out.run.current_status, "SUCCEEDED");
    assert.equal(provider.dispatchCount, 3);
    const build = getProductionRelease(db, created.run.id).bindings.find((b) => b.workflow_kind === "build");
    assert.equal(build.dispatch_intent_id, intent);
    assert.ok(build.workflow_run_id);
  } finally { git.cleanup(); db.close(); }
});

test("stale rollback of run A after newer release B is rejected", async () => {
  const db = openOpsDb(":memory:");
  const stagedA = await makeStagedTask(db);
  const stagedB = await makeStagedTask(db);
  try {
    const a = await cleared(db, stagedA.codingTaskId, stagedA.repo);
    const prev = seedPrev(db, stagedA.repo);
    const provider = makeStubProductionReleaseProvider();
    const runA = createProductionReleaseRun(db, execBody(stagedA.codingTaskId, a.authorization, a.assessment, { expectedMasterHead: stagedA.repo.resolveRef("master") }), { repo: stagedA.repo, now: NOW, actor: "owner" });
    const outA = await executeProductionRelease(db, runA.run.id, { provider, repo: stagedA.repo, now: NOW, actor: "owner" });
    assert.equal(outA.run.current_status, "SUCCEEDED");
    const b = await cleared(db, stagedB.codingTaskId, stagedB.repo);
    const runB = createProductionReleaseRun(db, execBody(stagedB.codingTaskId, b.authorization, b.assessment, { expectedMasterHead: stagedB.repo.resolveRef("master") }), { repo: stagedB.repo, now: NOW, actor: "owner" });
    const outB = await executeProductionRelease(db, runB.run.id, { provider, repo: stagedB.repo, now: NOW, actor: "owner" });
    assert.equal(outB.run.current_status, "SUCCEEDED");
    assert.equal(getProductionStable(db).source_sha, b.authorization.head_sha);
    await assert.rejects(() => requestCodeRollback(db, {
      releaseRunId: runA.run.id,
      previousStableSha: prev.source_sha,
      previousStableDigest: prev.artifact_digest,
      previousStableWorkflowRunId: prev.workflow_run_id,
      provider, repo: stagedA.repo, now: NOW, actor: "owner",
    }), /stale or superseded/);
    assert.equal(getProductionStable(db).source_sha, b.authorization.head_sha);
    assert.equal(getProductionStable(db).artifact_digest, b.authorization.artifact_digest);
  } finally { stagedA.git.cleanup(); stagedB.git.cleanup(); db.close(); }
});

test("TOCTOU drift of authorization/manifest/clearance/stable stops fail-closed before dispatch and stable write", async () => {
  async function setup() {
    const db = openOpsDb(":memory:");
    const staged = await makeStagedTask(db);
    const { authorization, assessment } = await cleared(db, staged.codingTaskId, staged.repo);
    seedPrev(db, staged.repo);
    const created = createProductionReleaseRun(db, execBody(staged.codingTaskId, authorization, assessment, { expectedMasterHead: staged.repo.resolveRef("master") }), { repo: staged.repo, now: NOW, actor: "owner" });
    return { db, staged, authorization, assessment, created };
  }

  {
    const { db, staged, authorization, created } = await setup();
    try {
      const beforeSha = getProductionStable(db).source_sha;
      await assert.rejects(() => executeProductionRelease(db, created.run.id, {
        provider: makeStubProductionReleaseProvider(), repo: staged.repo, now: NOW, actor: "owner",
        hooks: {
          beforeDispatch({ workflowKind }) {
            if (workflowKind === "build") {
              db.prepare("UPDATE production_release_authorization SET status='superseded', superseded_at=?, superseded_reason='toctou' WHERE id=?")
                .run(NOW.toISOString(), authorization.id);
            }
          },
        },
      }), /superseded|eligibility|authorization/);
      assert.equal(getProductionStable(db)?.source_sha, beforeSha);
    } finally { staged.git.cleanup(); db.close(); }
  }

  {
    const { db, staged, created } = await setup();
    try {
      await assert.rejects(() => executeProductionRelease(db, created.run.id, {
        provider: makeStubProductionReleaseProvider(), repo: staged.repo, now: NOW, actor: "owner",
        hooks: {
          beforeDispatch({ workflowKind }) {
            if (workflowKind === "predeploy") forceClearedAdditive(db, db.prepare("SELECT * FROM production_migration_safety_assessment WHERE id=?").get(created.run.migration_safety_assessment_id));
          },
        },
      }), /drifted|eligibility|assessment|clearance/);
    } finally { staged.git.cleanup(); db.close(); }
  }

  {
    const { db, staged, created } = await setup();
    try {
      await assert.rejects(() => executeProductionRelease(db, created.run.id, {
        provider: makeStubProductionReleaseProvider(), repo: staged.repo, now: NOW, actor: "owner",
        hooks: {
          beforeStableWrite() {
            seedProductionStable(db, {
              sourceSha: "c".repeat(40),
              artifactDigest: "sha256:" + "cc".repeat(32),
              workflowRunId: "34111111111",
              provenance: { kind: "newer_release" },
              now: NOW,
            });
          },
        },
      }), /stable identity drifted or superseded|compare-and-swap/);
      assert.equal(getProductionStable(db).source_sha, "c".repeat(40));
    } finally { staged.git.cleanup(); db.close(); }
  }

  {
    const { db, staged, authorization, assessment, created } = await setup();
    try {
      const provider = makeStubProductionReleaseProvider({ healthFailFor: authorization.artifact_digest });
      await assert.rejects(() => executeProductionRelease(db, created.run.id, {
        provider, repo: staged.repo, now: NOW, actor: "owner",
        hooks: {
          beforeDispatch({ workflowKind }) {
            if (workflowKind === "rollback") {
              seedProductionStable(db, {
                sourceSha: assessment.head_sha || authorization.head_sha,
                artifactDigest: "sha256:" + "dd".repeat(32),
                workflowRunId: "34222222222",
                releaseRunId: created.run.id + 99,
                provenance: { kind: "newer_unrelated" },
                now: NOW,
              });
            }
          },
        },
      }), /stale or superseded|stable identity/);
    } finally { staged.git.cleanup(); db.close(); }
  }
});

test("in-progress GitHub run stays WAITING and second reconcile advances without re-dispatch", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW, actor: "owner:alice" });
    const provider = makeStubProductionReleaseProvider();
    let buildReads = 0;
    wrapGetWorkflowRun(provider, (wf) => {
      if (wf.workflow_file !== PRODUCTION_WORKFLOWS.BUILD) return wf;
      buildReads += 1;
      if (buildReads === 1) return { ...wf, status: "in_progress", conclusion: null };
      return wf;
    });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner:alice" }), /still in_progress/);
    assert.equal(getProductionRelease(db, created.run.id).run.current_status, "BUILD_DISPATCHED");
    assert.equal(provider.dispatchCount, 1);
    const again = await reconcileProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner:bob" });
    assert.equal(again.run.current_status, "SUCCEEDED");
    assert.equal(again.run.authorized_github_actor, GITHUB_ACTOR);
    assert.equal(provider.dispatchCount, 3);
    assert.equal(buildReads, 2);
  } finally { git.cleanup(); db.close(); }
});

test("missing or mismatched actor/triggering_actor fail independently; reconciler identity is ignored", async () => {
  const mutations = [
    [(wf) => ({ ...wf, actor: null }), /actor/],
    [(wf) => ({ ...wf, triggering_actor: null }), /triggering_actor/],
    [(wf) => ({ ...wf, actor: "attacker" }), /actor/],
    [(wf) => ({ ...wf, triggering_actor: "attacker" }), /triggering_actor/],
  ];
  for (const [mutate, re] of mutations) {
    const db = openOpsDb(":memory:");
    const { codingTaskId, repo, git } = await makeStagedTask(db);
    try {
      const { authorization, assessment } = await cleared(db, codingTaskId, repo);
      const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: repo.resolveRef("master") }), { repo, now: NOW, actor: "owner:alice" });
      const provider = wrapGetWorkflowRun(makeStubProductionReleaseProvider(), mutate);
      await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW, actor: "owner:bob" }), re);
      assert.equal(getProductionStable(db), null);
    } finally { git.cleanup(); db.close(); }
  }
});

function driftAuthorization(db, authorizationId) {
  db.prepare("UPDATE production_release_authorization SET status='superseded', superseded_at=?, superseded_reason='review-p1' WHERE id=?")
    .run(NOW.toISOString(), authorizationId);
}

function driftManifest(db, codingTaskId) {
  const cur = db.prepare("SELECT * FROM development_release_current WHERE coding_task_id=?").get(codingTaskId);
  const rc = db.prepare("SELECT * FROM development_release_candidate WHERE id=?").get(cur.release_manifest_id);
  const copy = { ...rc };
  delete copy.id;
  copy.manifest_hash = "e".repeat(64);
  copy.manifest_version = Number(rc.manifest_version) + 1;
  copy.release_input_fingerprint = "f".repeat(64);
  const keys = Object.keys(copy);
  const res = db.prepare(`INSERT INTO development_release_candidate (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => copy[k]));
  db.prepare("UPDATE development_release_current SET release_manifest_id=?, manifest_version=?, manifest_hash=?, updated_at=? WHERE coding_task_id=?")
    .run(Number(res.lastInsertRowid), copy.manifest_version, copy.manifest_hash, NOW.toISOString(), codingTaskId);
}

function driftProvenanceOnly(db) {
  db.prepare("UPDATE production_stable_current SET provenance_fingerprint=? WHERE id=1")
    .run("f".repeat(64));
}

test("final stable writes revalidate authorization/manifest/clearance/stable on release and rollback", async () => {
  async function setup() {
    const db = openOpsDb(":memory:");
    const staged = await makeStagedTask(db);
    const { authorization, assessment } = await cleared(db, staged.codingTaskId, staged.repo);
    seedPrev(db, staged.repo);
    const created = createProductionReleaseRun(db, execBody(staged.codingTaskId, authorization, assessment, { expectedMasterHead: staged.repo.resolveRef("master") }), { repo: staged.repo, now: NOW, actor: "owner:alice" });
    return { db, staged, authorization, assessment, created };
  }

  const releaseDrifts = [
    ["authorization", ({ authorization }) => driftAuthorization(dbRef.db, authorization.id), /superseded|eligibility|authorization/],
    ["manifest", ({ staged }) => driftManifest(dbRef.db, staged.codingTaskId), /stale|manifest|eligibility/],
    ["clearance", ({ created }) => forceClearedAdditive(dbRef.db, dbRef.db.prepare("SELECT * FROM production_migration_safety_assessment WHERE id=?").get(created.run.migration_safety_assessment_id)), /drifted|eligibility|assessment|clearance/],
    ["stable", () => seedProductionStable(dbRef.db, {
      sourceSha: "c".repeat(40), artifactDigest: "sha256:" + "cc".repeat(32), workflowRunId: "34111111111",
      releaseRunId: 999, provenance: { kind: "newer_release" }, now: NOW,
    }), /stable identity drifted or superseded|compare-and-swap/],
  ];
  const dbRef = { db: null };
  for (const [name, mutate, re] of releaseDrifts) {
    const ctx = await setup();
    dbRef.db = ctx.db;
    try {
      const before = getProductionStable(ctx.db);
      await assert.rejects(() => executeProductionRelease(ctx.db, ctx.created.run.id, {
        provider: makeStubProductionReleaseProvider(), repo: ctx.staged.repo, now: NOW, actor: "owner:bob",
        hooks: { beforeStableWrite() { mutate(ctx); } },
      }), re, name);
      assert.notEqual(getProductionRelease(ctx.db, ctx.created.run.id).run.current_status, "SUCCEEDED", name);
      assert.ok(!getProductionRelease(ctx.db, ctx.created.run.id).events.some((e) => e.to_status === "SUCCEEDED"), name);
      if (name !== "stable") assert.equal(getProductionStable(ctx.db).source_sha, before.source_sha, name);
    } finally { ctx.staged.git.cleanup(); ctx.db.close(); }
  }

  const rollbackDrifts = [
    ["authorization", ({ authorization }) => driftAuthorization(dbRef.db, authorization.id), /superseded|eligibility|authorization/],
    ["manifest", ({ staged }) => driftManifest(dbRef.db, staged.codingTaskId), /stale|manifest|eligibility/],
    ["clearance", ({ created }) => forceClearedAdditive(dbRef.db, dbRef.db.prepare("SELECT * FROM production_migration_safety_assessment WHERE id=?").get(created.run.migration_safety_assessment_id)), /drifted|eligibility|assessment|clearance/],
    ["stable", () => seedProductionStable(dbRef.db, {
      sourceSha: "d".repeat(40), artifactDigest: "sha256:" + "dd".repeat(32), workflowRunId: "34222222222",
      releaseRunId: 998, provenance: { kind: "newer_unrelated" }, now: NOW,
    }), /stale|superseded|stable identity|compare-and-swap/],
  ];
  for (const [name, mutate, re] of rollbackDrifts) {
    const ctx = await setup();
    dbRef.db = ctx.db;
    try {
      const before = getProductionStable(ctx.db);
      await assert.rejects(() => executeProductionRelease(ctx.db, ctx.created.run.id, {
        provider: makeStubProductionReleaseProvider({ healthFailFor: ctx.authorization.artifact_digest }),
        repo: ctx.staged.repo, now: NOW, actor: "owner:bob",
        hooks: { beforeStableWrite({ kind }) { if (kind === "rollback") mutate(ctx); } },
      }), re, `rollback ${name}`);
      assert.notEqual(getProductionRelease(ctx.db, ctx.created.run.id).run.current_status, "ROLLED_BACK", `rollback ${name}`);
      if (name !== "stable") assert.equal(getProductionStable(ctx.db).source_sha, before.source_sha, `rollback ${name}`);
    } finally { ctx.staged.git.cleanup(); ctx.db.close(); }
  }
});

test("A→B same SHA/digest different provenance rejects stale-A rollback; provenance-only drift fails CAS", async () => {
  const db = openOpsDb(":memory:");
  const stagedA = await makeStagedTask(db);
  const stagedB = await makeStagedTask(db);
  try {
    const a = await cleared(db, stagedA.codingTaskId, stagedA.repo);
    const prev = seedPrev(db, stagedA.repo);
    const provider = makeStubProductionReleaseProvider();
    const runA = createProductionReleaseRun(db, execBody(stagedA.codingTaskId, a.authorization, a.assessment, { expectedMasterHead: stagedA.repo.resolveRef("master") }), { repo: stagedA.repo, now: NOW, actor: "owner:alice" });
    const outA = await executeProductionRelease(db, runA.run.id, { provider, repo: stagedA.repo, now: NOW, actor: "owner:alice" });
    assert.equal(outA.run.current_status, "SUCCEEDED");
    const stableA = getProductionStable(db);
    const b = await cleared(db, stagedB.codingTaskId, stagedB.repo);
    const runB = createProductionReleaseRun(db, execBody(stagedB.codingTaskId, b.authorization, b.assessment, { expectedMasterHead: stagedB.repo.resolveRef("master") }), { repo: stagedB.repo, now: NOW, actor: "owner:alice" });
    seedProductionStable(db, {
      sourceSha: stableA.source_sha,
      artifactDigest: stableA.artifact_digest,
      workflowRunId: stableA.workflow_run_id,
      releaseRunId: runB.run.id,
      provenance: {
        kind: "release_succeeded",
        release_run_id: runB.run.id,
        authorization_id: b.authorization.id,
        assessment_id: b.assessment.id,
      },
      now: NOW,
    });
    assert.equal(getProductionStable(db).source_sha, stableA.source_sha);
    assert.equal(getProductionStable(db).artifact_digest, stableA.artifact_digest);
    assert.equal(getProductionStable(db).release_run_id, runB.run.id);
    await assert.rejects(() => requestCodeRollback(db, {
      releaseRunId: runA.run.id,
      previousStableSha: prev.source_sha,
      previousStableDigest: prev.artifact_digest,
      previousStableWorkflowRunId: prev.workflow_run_id,
      provider, repo: stagedA.repo, now: NOW, actor: "owner:alice",
    }), /stale or superseded/);
    assert.equal(getProductionStable(db).release_run_id, runB.run.id);

    const stagedC = await makeStagedTask(db);
    const c = await cleared(db, stagedC.codingTaskId, stagedC.repo);
    const runC = createProductionReleaseRun(db, execBody(stagedC.codingTaskId, c.authorization, c.assessment, { expectedMasterHead: stagedC.repo.resolveRef("master") }), { repo: stagedC.repo, now: NOW, actor: "owner:alice" });
    seedPrev(db, stagedC.repo);
    await assert.rejects(() => executeProductionRelease(db, runC.run.id, {
      provider: makeStubProductionReleaseProvider(), repo: stagedC.repo, now: NOW, actor: "owner:alice",
      hooks: { beforeStableWrite() { driftProvenanceOnly(db); } },
    }), /stable identity drifted or superseded|compare-and-swap/);
    assert.notEqual(getProductionRelease(db, runC.run.id).run.current_status, "SUCCEEDED");
    stagedC.git.cleanup();
  } finally { stagedA.git.cleanup(); stagedB.git.cleanup(); db.close(); }
});

