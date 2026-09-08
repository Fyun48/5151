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
  isAllowedReleaseTransition, isAuthorizedGithubActor, isSuccessfulConclusion, isTerminalReleaseStatus, previousStableComplete,
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
  git(["push", "-q", "-u", "origin", "master"]);
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
  const coding = db.prepare("SELECT head_sha FROM development_coding_task WHERE id=?").get(task.id);
  // Simulate an already-merged GitHub PR: remote protected master has the
  // authorized SHA, but local master stays at the coding base so Phase 13
  // source-base freshness still holds.
  if (coding?.head_sha) {
    execFileSync("git", ["-C", g.dir, "push", "-q", "origin", `${coding.head_sha}:master`]);
  }
  return { iid, codingTaskId: task.id, repo, git: g };
}
function expectedMaster(repo) {
  return repo.resolveRemoteRef("master") || repo.resolveRef("master");
}
function advanceRemoteMaster(git, name) {
  const branch = `tmp-${name}`;
  execFileSync("git", ["-C", git.dir, "fetch", "-q", "origin", "master"]);
  execFileSync("git", ["-C", git.dir, "checkout", "-q", "-B", branch, "origin/master"]);
  writeFileSync(path.join(git.dir, `${name}.txt`), `${name}\n`);
  execFileSync("git", ["-C", git.dir, "add", "-A"]);
  execFileSync("git", ["-C", git.dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", name]);
  execFileSync("git", ["-C", git.dir, "push", "-q", "origin", `${branch}:master`]);
  execFileSync("git", ["-C", git.dir, "checkout", "-q", "master"]);
  execFileSync("git", ["-C", git.dir, "branch", "-q", "-D", branch]);
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
  assert.equal(isTerminalReleaseStatus("PRODUCTION_STATE_UNKNOWN"), false);
  assert.equal(isAllowedReleaseTransition("PRODUCTION_STATE_UNKNOWN", "DEPLOY_RECONCILED"), true);
  assert.equal(isAllowedReleaseTransition("PRODUCTION_STATE_UNKNOWN", "BUILD_DISPATCHED"), false);
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
  for (const rel of [
    ".github/workflows/build-production-image.yml",
    ".github/workflows/production-predeploy-check.yml",
    ".github/workflows/deploy-v3.yml",
  ]) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(text, /run-name:\s*"phase15-intent:\$\{\{ inputs\.release_intent_id \}\}"/);
    assert.match(text, /if: always\(\)/);
    assert.match(text, /name: phase15-run-identity/);
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
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW, actor: "owner:test" });
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
    const good = execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) });
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
    }, { expectedMasterHead: expectedMaster(repo) });
    assert.throws(() => createProductionReleaseRun(db, fake, { repo, now: NOW }), /phase14_clearance_missing|cannot start|not found/);
    const { authorization: auth2, assessment } = await cleared(db, codingTaskId, repo);
    writeFileSync(path.join(git.dir, "m15-advance.txt"), "x\n");
    execFileSync("git", ["-C", git.dir, "add", "-A"]);
    execFileSync("git", ["-C", git.dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "master advance"]);
    createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.equal(db.prepare("SELECT status FROM production_release_authorization WHERE id=?").get(auth2.id).status, "superseded");
    assert.throws(() => createProductionReleaseRun(db, execBody(codingTaskId, auth2, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW }), /superseded|cannot start|stale/);
  } finally { git.cleanup(); db.close(); }
});

test("expected HEAD race and branch protection rejection are fail-closed without admin override", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const master = expectedMaster(repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: master }), { repo, now: NOW });
    advanceRemoteMaster(git, "race");
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider: makeStubProductionReleaseProvider(), repo, now: NOW }), /expected_head_race|protected merge|source_base|stale|eligibility|not reachable from protected remote master/);
    const db2 = openOpsDb(":memory:");
    const staged2 = await makeStagedTask(db2);
    const c2 = await cleared(db2, staged2.codingTaskId, staged2.repo);
    const run2 = createProductionReleaseRun(db2, execBody(staged2.codingTaskId, c2.authorization, c2.assessment, { expectedMasterHead: expectedMaster(staged2.repo) }), { repo: staged2.repo, now: NOW });
    const oldRemote = staged2.repo.resolveRef("master");
    execFileSync("git", ["-C", staged2.git.remote, "update-ref", "refs/heads/master", oldRemote]);
    await assert.rejects(() => executeProductionRelease(db2, run2.run.id, { provider: makeStubProductionReleaseProvider({ protectionReject: true }), repo: staged2.repo, now: NOW }), /not reachable from protected remote master|branch_protection/);
    staged2.git.cleanup(); db2.close();
  } finally { git.cleanup(); db.close(); }
});

test("image digest / OCI revision / source mismatch is blocked", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
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
      const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
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
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
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
      const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
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
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
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
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    const provider = makeStubProductionReleaseProvider({ dispatchTimeout: true });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /still queued|in_progress|verifiable/);
    assert.equal(provider.dispatchCount, 1);
    assert.equal(getProductionRelease(db, created.run.id).run.current_status, "BUILD_DISPATCHED");
    await assert.rejects(() => reconcileProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /still queued|reconcile/);
    assert.equal(provider.dispatchCount, 1);
    const fresh = makeStubProductionReleaseProvider({ dispatchTimeout: true });
    await assert.rejects(() => reconcileProductionRelease(db, created.run.id, { provider: fresh, repo, now: NOW }), /still queued|reconcile/);
    assert.equal(fresh.dispatchCount, 0);
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
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
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
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    assert.equal(created.run.previous_stable_sha, null);
    const provider = makeStubProductionReleaseProvider({ healthFail: true });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /previous stable identity is incomplete/);
    assert.ok(!getProductionRelease(db, created.run.id).bindings.some((b) => b.workflow_kind === "deploy" && b.workflow_run_id));
    assert.ok(provider.dispatchCount < 3);
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
    seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
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
      const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
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
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, additive, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW, actor: "owner:test" });
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
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW, actor: "owner" });
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
    seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW, actor: "owner" });
    const key = workflowIdempotencyKey({
      releaseAuthorizationId: created.run.release_authorization_id,
      targetEnvironment: created.run.target_environment,
      workflowKind: "build",
    });
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
    const runA = createProductionReleaseRun(db, execBody(stagedA.codingTaskId, a.authorization, a.assessment, { expectedMasterHead: stagedA.repo.resolveRemoteRef("master") }), { repo: stagedA.repo, now: NOW, actor: "owner" });
    const outA = await executeProductionRelease(db, runA.run.id, { provider, repo: stagedA.repo, now: NOW, actor: "owner" });
    assert.equal(outA.run.current_status, "SUCCEEDED");
    const b = await cleared(db, stagedB.codingTaskId, stagedB.repo);
    const runB = createProductionReleaseRun(db, execBody(stagedB.codingTaskId, b.authorization, b.assessment, { expectedMasterHead: stagedB.repo.resolveRemoteRef("master") }), { repo: stagedB.repo, now: NOW, actor: "owner" });
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
    const created = createProductionReleaseRun(db, execBody(staged.codingTaskId, authorization, assessment, { expectedMasterHead: staged.repo.resolveRemoteRef("master") }), { repo: staged.repo, now: NOW, actor: "owner" });
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
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW, actor: "owner:alice" });
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
      const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW, actor: "owner:alice" });
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
    const created = createProductionReleaseRun(db, execBody(staged.codingTaskId, authorization, assessment, { expectedMasterHead: staged.repo.resolveRemoteRef("master") }), { repo: staged.repo, now: NOW, actor: "owner:alice" });
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
    const runA = createProductionReleaseRun(db, execBody(stagedA.codingTaskId, a.authorization, a.assessment, { expectedMasterHead: stagedA.repo.resolveRemoteRef("master") }), { repo: stagedA.repo, now: NOW, actor: "owner:alice" });
    const outA = await executeProductionRelease(db, runA.run.id, { provider, repo: stagedA.repo, now: NOW, actor: "owner:alice" });
    assert.equal(outA.run.current_status, "SUCCEEDED");
    const stableA = getProductionStable(db);
    const b = await cleared(db, stagedB.codingTaskId, stagedB.repo);
    const runB = createProductionReleaseRun(db, execBody(stagedB.codingTaskId, b.authorization, b.assessment, { expectedMasterHead: stagedB.repo.resolveRemoteRef("master") }), { repo: stagedB.repo, now: NOW, actor: "owner:alice" });
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
    const runC = createProductionReleaseRun(db, execBody(stagedC.codingTaskId, c.authorization, c.assessment, { expectedMasterHead: stagedC.repo.resolveRemoteRef("master") }), { repo: stagedC.repo, now: NOW, actor: "owner:alice" });
    seedPrev(db, stagedC.repo);
    await assert.rejects(() => executeProductionRelease(db, runC.run.id, {
      provider: makeStubProductionReleaseProvider(), repo: stagedC.repo, now: NOW, actor: "owner:alice",
      hooks: { beforeStableWrite() { driftProvenanceOnly(db); } },
    }), /stable identity drifted or superseded|compare-and-swap/);
    assert.notEqual(getProductionRelease(db, runC.run.id).run.current_status, "SUCCEEDED");
    stagedC.git.cleanup();
  } finally { stagedA.git.cleanup(); stagedB.git.cleanup(); db.close(); }
});

test("matching digest with missing OCI revision/source is BLOCKED", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const prev = seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, {
      provider: makeStubProductionReleaseProvider({ imageMissingLabels: true }), repo, now: NOW,
    }), /digest missing|OCI /);
    assert.equal(getProductionRelease(db, created.run.id).run.current_status, "BLOCKED");
    assert.equal(getProductionStable(db).source_sha, prev.source_sha);
  } finally { git.cleanup(); db.close(); }
});

test("public health HTTP 200 without landing/login/container/digest proof must not SUCCEED", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const prev = seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, {
      provider: makeStubProductionReleaseProvider({ healthHttpOnly: true }), repo, now: NOW,
    }), /health/);
    assert.notEqual(getProductionRelease(db, created.run.id).run.current_status, "SUCCEEDED");
    assert.equal(getProductionStable(db).source_sha, prev.source_sha);
  } finally { git.cleanup(); db.close(); }
});

test("empty production_stable_current blocks before deploy dispatch", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    const provider = makeStubProductionReleaseProvider();
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /previous stable identity is incomplete/);
    const deploy = getProductionRelease(db, created.run.id).bindings.find((b) => b.workflow_kind === "deploy");
    assert.ok(!deploy || !deploy.workflow_run_id);
    assert.equal(getProductionRelease(db, created.run.id).run.current_status, "BLOCKED");
  } finally { git.cleanup(); db.close(); }
});

test("local master containing authorized SHA is not enough if remote GitHub master does not", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    execFileSync("git", ["-C", git.dir, "merge", "--ff-only", authorization.head_sha]);
    assert.equal(repo.isAncestor(authorization.head_sha, "master"), true);
    const old = repo.resolveRef("HEAD~1");
    execFileSync("git", ["-C", git.remote, "update-ref", "refs/heads/master", old]);
    assert.equal(repo.isRemoteAncestor(authorization.head_sha, "master"), false);
    const provider = makeStubProductionReleaseProvider();
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /not reachable from protected remote master/);
    assert.notEqual(getProductionRelease(db, created.run.id).run.current_status, "MERGED");
    assert.ok(!getProductionRelease(db, created.run.id).bindings.some((b) => b.workflow_run_id));
    assert.equal(provider.dispatchCount, 0);
  } finally { git.cleanup(); db.close(); }
});

test("rewriting bound actor/run-id/attempt/provenance is aborted by DB", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    await executeProductionRelease(db, created.run.id, { provider: makeStubProductionReleaseProvider(), repo, now: NOW });
    const b = getProductionRelease(db, created.run.id).bindings.find((x) => x.workflow_kind === "build");
    assert.ok(b.workflow_run_id);
    assert.throws(() => db.prepare("UPDATE production_release_workflow_binding SET workflow_run_id=? WHERE id=?").run("999", b.id), /immutable/);
    assert.throws(() => db.prepare("UPDATE production_release_workflow_binding SET workflow_attempt=? WHERE id=?").run(9, b.id), /immutable/);
    assert.throws(() => db.prepare("UPDATE production_release_workflow_binding SET authorized_github_actor=? WHERE id=?").run("attacker", b.id), /immutable/);
    assert.throws(() => db.prepare("UPDATE production_release_workflow_binding SET dispatch_request_id=? WHERE id=?").run("other-req", b.id), /immutable/);
    assert.throws(() => db.prepare("UPDATE production_release_workflow_binding SET provider_response_identity=? WHERE id=?").run("other-resp", b.id), /immutable/);
    assert.throws(() => db.prepare("UPDATE production_release_workflow_binding SET dispatch_submitted_at=? WHERE id=?").run("2099-01-01T00:00:00.000Z", b.id), /immutable/);
  } finally { git.cleanup(); db.close(); }
});

function persistClaimedBinding(db, run, workflowKind, { intent, submitted = false, actor = GITHUB_ACTOR } = {}) {
  const key = workflowIdempotencyKey({
    releaseAuthorizationId: run.release_authorization_id,
    targetEnvironment: run.target_environment,
    workflowKind,
  });
  db.prepare(
    `INSERT INTO production_release_workflow_binding(
      release_run_id, workflow_kind, idempotency_key, binding_status, dispatch_owner,
      dispatch_intent_id, dispatch_request_id, dispatch_claimed_at, dispatch_submitted_at,
      authorized_github_actor, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    run.id, workflowKind, key, "claimed", "dead-owner",
    intent, intent, NOW.toISOString(), submitted ? NOW.toISOString() : null,
    actor, NOW.toISOString(),
  );
  return key;
}

test("caller-controlled github actor and expected master do not create a second run", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    assert.throws(() => createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, {
      expectedMasterHead: expectedMaster(repo), githubActor: "attacker",
    }), { repo, now: NOW }), /github actor|GitHub login/);
    const first = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, {
      expectedMasterHead: expectedMaster(repo),
    }), { repo, now: NOW, actor: "owner:a" });
    const second = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, {
      expectedMasterHead: "d".repeat(40),
    }), { repo, now: NOW, actor: "owner:b" });
    assert.equal(second.idempotent, true);
    assert.equal(first.run.id, second.run.id);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM production_release_run WHERE release_authorization_id=?").get(authorization.id).c, 1);
    const provider = makeStubProductionReleaseProvider({ deduplicate: false });
    const settled = await Promise.allSettled([
      executeProductionRelease(db, first.run.id, { provider, repo, now: NOW, actor: "owner:a" }),
      executeProductionRelease(db, first.run.id, { provider, repo, now: NOW, actor: "owner:b" }),
    ]);
    assert.ok(settled.some((s) => s.status === "fulfilled"));
    assert.equal(provider.dispatchCount, 3);
    assert.equal(getProductionRelease(db, first.run.id).run.current_status, "SUCCEEDED");
    assert.equal(getProductionRelease(db, first.run.id).run.authorized_github_actor, GITHUB_ACTOR);
  } finally { git.cleanup(); db.close(); }
});

test("crash before dispatch call may retry once; crash after 204 never redispatches", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    persistClaimedBinding(db, created.run, "build", { intent: "crash-before-call-1", submitted: false });
    const before = makeStubProductionReleaseProvider({ deduplicate: false });
    const out = await executeProductionRelease(db, created.run.id, { provider: before, repo, now: NOW });
    assert.equal(out.run.current_status, "SUCCEEDED");
    assert.equal(before.dispatchCount, 3);
  } finally { git.cleanup(); db.close(); }
});

test("crash after accepted 204 binds by release_intent_id on a fresh provider", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    const intent = "crash-after-204-intent";
    const key = persistClaimedBinding(db, created.run, "build", { intent, submitted: true });
    const fresh = makeStubProductionReleaseProvider({ deduplicate: false });
    await fresh.dispatchWorkflow({
      workflowFile: PRODUCTION_WORKFLOWS.BUILD,
      workflowRef: REQUIRED_WORKFLOW_REF,
      inputs: { sha: authorization.head_sha, expected_digest: authorization.artifact_digest, image_digest: authorization.artifact_digest },
      idempotencyKey: key,
      actor: GITHUB_ACTOR,
      requestId: intent,
    });
    assert.equal(fresh.dispatchCount, 1);
    const out = await executeProductionRelease(db, created.run.id, { provider: fresh, repo, now: NOW });
    assert.equal(out.run.current_status, "SUCCEEDED");
    assert.equal(fresh.dispatchCount, 3);
    const build = getProductionRelease(db, created.run.id).bindings.find((b) => b.workflow_kind === "build");
    assert.equal(build.dispatch_intent_id, intent);
    assert.ok(build.workflow_run_id);
  } finally { git.cleanup(); db.close(); }
});

test("unrelated same-SHA manual run is not bound after restart", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    persistClaimedBinding(db, created.run, "build", { intent: "claimed-intent-xxxx", submitted: true });
    const fresh = makeStubProductionReleaseProvider({ deduplicate: false });
    await fresh.dispatchWorkflow({
      workflowFile: PRODUCTION_WORKFLOWS.BUILD,
      workflowRef: REQUIRED_WORKFLOW_REF,
      inputs: { sha: authorization.head_sha, expected_digest: authorization.artifact_digest, image_digest: authorization.artifact_digest },
      idempotencyKey: "unrelated-manual-key",
      actor: GITHUB_ACTOR,
      requestId: "unrelated-manual-run",
    });
    assert.equal(fresh.dispatchCount, 1);
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider: fresh, repo, now: NOW }), /still queued/);
    assert.equal(fresh.dispatchCount, 1);
    const build = getProductionRelease(db, created.run.id).bindings.find((b) => b.workflow_kind === "build");
    assert.equal(build.workflow_run_id, null);
    assert.equal(build.dispatch_intent_id, "claimed-intent-xxxx");
  } finally { git.cleanup(); db.close(); }
});

test("ambiguous intent-correlated runs fail closed without binding", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    const intent = "intent-ambiguous-xx";
    persistClaimedBinding(db, created.run, "build", { intent, submitted: true });
    const fresh = makeStubProductionReleaseProvider({ deduplicate: false });
    for (const suffix of ["a", "b"]) {
      await fresh.dispatchWorkflow({
        workflowFile: PRODUCTION_WORKFLOWS.BUILD,
        workflowRef: REQUIRED_WORKFLOW_REF,
        inputs: { sha: authorization.head_sha, expected_digest: authorization.artifact_digest, image_digest: authorization.artifact_digest },
        idempotencyKey: `ambiguous-key-${suffix}`,
        actor: GITHUB_ACTOR,
        requestId: intent,
      });
    }
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider: fresh, repo, now: NOW }), /ambiguous/);
    const build = getProductionRelease(db, created.run.id).bindings.find((b) => b.workflow_kind === "build");
    assert.equal(build.workflow_run_id, null);
    assert.equal(fresh.dispatchCount, 2);
  } finally { git.cleanup(); db.close(); }
});

test("A waiting on build then B success: resume A must not deploy or move the pointer", async () => {
  const db = openOpsDb(":memory:");
  const stagedA = await makeStagedTask(db);
  const stagedB = await makeStagedTask(db);
  try {
    const a = await cleared(db, stagedA.codingTaskId, stagedA.repo);
    seedPrev(db, stagedA.repo);
    const providerA = makeStubProductionReleaseProvider({ pendingWorkflows: [PRODUCTION_WORKFLOWS.BUILD] });
    const runA = createProductionReleaseRun(db, execBody(stagedA.codingTaskId, a.authorization, a.assessment, { expectedMasterHead: stagedA.repo.resolveRemoteRef("master") }), { repo: stagedA.repo, now: NOW });
    await assert.rejects(() => executeProductionRelease(db, runA.run.id, { provider: providerA, repo: stagedA.repo, now: NOW }), /still in_progress|still queued/);
    assert.equal(providerA.dispatchCount, 1);
    const b = await cleared(db, stagedB.codingTaskId, stagedB.repo);
    const providerB = makeStubProductionReleaseProvider();
    const runB = createProductionReleaseRun(db, execBody(stagedB.codingTaskId, b.authorization, b.assessment, { expectedMasterHead: stagedB.repo.resolveRemoteRef("master") }), { repo: stagedB.repo, now: NOW });
    const outB = await executeProductionRelease(db, runB.run.id, { provider: providerB, repo: stagedB.repo, now: NOW });
    assert.equal(outB.run.current_status, "SUCCEEDED");
    assert.equal(getProductionStable(db).source_sha, b.authorization.head_sha);
    for (const run of providerA._runsById.values()) {
      if (run.workflow_file === PRODUCTION_WORKFLOWS.BUILD) {
        run.status = "completed";
        run.conclusion = "success";
      }
    }
    await assert.rejects(() => executeProductionRelease(db, runA.run.id, { provider: providerA, repo: stagedA.repo, now: NOW }), /stable identity|superseded/);
    assert.equal(providerA.dispatchCount, 1);
    assert.ok(!getProductionRelease(db, runA.run.id).bindings.some((x) => x.workflow_kind === "deploy" && x.workflow_run_id));
    assert.equal(getProductionStable(db).source_sha, b.authorization.head_sha);
    assert.equal(getProductionStable(db).release_run_id, runB.run.id);
  } finally { stagedA.git.cleanup(); stagedB.git.cleanup(); db.close(); }
});

test("stable identity changing immediately before deploy blocks dispatch and pointer write", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const prev = seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    const provider = makeStubProductionReleaseProvider();
    await assert.rejects(() => executeProductionRelease(db, created.run.id, {
      provider, repo, now: NOW,
      hooks: {
        beforeDispatch({ workflowKind }) {
          if (workflowKind === "deploy") {
            seedProductionStable(db, {
              sourceSha: "b".repeat(40),
              artifactDigest: "sha256:" + "22".repeat(32),
              workflowRunId: "34111111111",
              releaseRunId: created.run.id + 50,
              provenance: { kind: "sneak_b" },
              now: NOW,
            });
          }
        },
      },
    }), /stable identity|superseded/);
    assert.equal(provider.dispatchCount, 2);
    assert.ok(!getProductionRelease(db, created.run.id).bindings.some((x) => x.workflow_kind === "deploy" && x.workflow_run_id));
    assert.equal(getProductionStable(db).source_sha, "b".repeat(40));
    assert.notEqual(getProductionStable(db).source_sha, authorization.head_sha);
    assert.equal(getProductionStable(db).source_sha === prev.source_sha, false);
  } finally { git.cleanup(); db.close(); }
});

test("GitHub live REST fixture plus orchestrator stays fail-closed without evidence", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    const runs = [];
    const artifacts = new Map();
    let dispatchHttp = 0;
    const api = {
      async dispatchWorkflow({ inputs }) {
        dispatchHttp += 1;
        runs.push({
          id: 55000000001,
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
          path: PRODUCTION_WORKFLOWS.BUILD,
          head_sha: "b".repeat(40),
          head_branch: "master",
          actor: { login: GITHUB_ACTOR },
          triggering_actor: { login: GITHUB_ACTOR },
          event: "workflow_dispatch",
          created_at: NOW.toISOString(),
        });
        artifacts.set("55000000001", []);
        return { status: 204, inputs };
      },
      async listWorkflowRuns() { return { runs }; },
      async getWorkflowRun({ runId }) {
        const run = runs.find((r) => String(r.id) === String(runId));
        return run ? { run, jobs: [] } : null;
      },
      async listArtifacts() { return { artifacts: [] }; },
      async downloadArtifact() { return null; },
      async inspectImage({ digest }) { return { digest }; },
    };
    const provider = makeGithubProductionReleaseProvider({
      PRODUCTION_RELEASE_PROVIDER: "github",
      PRODUCTION_RELEASE_MUTATION_GRANT: "owner-dispatch-v1",
      PRODUCTION_RELEASE_GITHUB_ACTOR: GITHUB_ACTOR,
      GITHUB_REPOSITORY: "Fyun48/5151",
    }, { githubApi: api });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /still queued|not an exact successful|evidence|outputs|digest|OCI|image/);
    assert.equal(dispatchHttp, 1);
    assert.notEqual(getProductionRelease(db, created.run.id).run.current_status, "SUCCEEDED");
    assert.notEqual(getProductionStable(db).source_sha, authorization.head_sha);
  } finally { git.cleanup(); db.close(); }
});

function countDeployDispatches(provider) {
  let n = 0;
  const orig = provider.dispatchWorkflow.bind(provider);
  provider.dispatchWorkflow = async (opts) => {
    if (opts.workflowFile === PRODUCTION_WORKFLOWS.DEPLOY) n += 1;
    return orig(opts);
  };
  return {
    get count() { return n; },
  };
}

function countWorkflowDispatches(provider) {
  const counts = { build: 0, predeploy: 0, deploy: 0 };
  const orig = provider.dispatchWorkflow.bind(provider);
  provider.dispatchWorkflow = async (opts) => {
    if (opts.workflowFile === PRODUCTION_WORKFLOWS.BUILD) counts.build += 1;
    if (opts.workflowFile === PRODUCTION_WORKFLOWS.PREDEPLOY) counts.predeploy += 1;
    if (opts.workflowFile === PRODUCTION_WORKFLOWS.DEPLOY) counts.deploy += 1;
    return orig(opts);
  };
  return counts;
}

test("two WAL connections: stable changes before decision TX so A never deploys", async () => {
  const file = path.join(os.tmpdir(), `phase15-wal-${process.pid}-${Date.now()}.db`);
  const db1 = openOpsDb(file);
  const db2 = openOpsDb(file);
  const staged = await makeStagedTask(db1);
  try {
    const { authorization, assessment } = await cleared(db1, staged.codingTaskId, staged.repo);
    seedPrev(db1, staged.repo);
    const created = createProductionReleaseRun(db1, execBody(staged.codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(staged.repo) }), { repo: staged.repo, now: NOW });
    const provider = makeStubProductionReleaseProvider();
    const deploy = countDeployDispatches(provider);
    let unlock;
    const gate = new Promise((resolve) => { unlock = resolve; });
    let atDeploy = false;
    const running = executeProductionRelease(db1, created.run.id, {
      provider, repo: staged.repo, now: NOW,
      hooks: {
        async beforeDispatch({ workflowKind }) {
          if (workflowKind !== "deploy") return;
          atDeploy = true;
          await gate;
        },
      },
    });
    while (!atDeploy) await new Promise((r) => setTimeout(r, 10));
    seedProductionStable(db2, {
      sourceSha: "b".repeat(40),
      artifactDigest: "sha256:" + "22".repeat(32),
      workflowRunId: "34111111111",
      releaseRunId: created.run.id + 50,
      provenance: { kind: "sneak_b_wal" },
      now: NOW,
    });
    unlock();
    await assert.rejects(running, /stable identity|superseded|drifted/);
    assert.equal(deploy.count, 0);
    assert.equal(getProductionStable(db1).source_sha, "b".repeat(40));
  } finally {
    staged.git.cleanup();
    db1.close();
    db2.close();
    try { rmSync(file, { force: true }); } catch {}
    try { rmSync(`${file}-wal`, { force: true }); } catch {}
    try { rmSync(`${file}-shm`, { force: true }); } catch {}
  }
});

test("uncertain mutating deploy holds lease so a second release cannot dispatch production-scoped workflows", async () => {
  const db = openOpsDb(":memory:");
  const stagedA = await makeStagedTask(db);
  const stagedB = await makeStagedTask(db);
  try {
    const a = await cleared(db, stagedA.codingTaskId, stagedA.repo);
    seedPrev(db, stagedA.repo);
    const runA = createProductionReleaseRun(db, execBody(stagedA.codingTaskId, a.authorization, a.assessment, { expectedMasterHead: stagedA.repo.resolveRemoteRef("master") }), { repo: stagedA.repo, now: NOW });
    const providerA = makeStubProductionReleaseProvider();
    let stripDeployEvidence = true;
    wrapGetWorkflowRun(providerA, (wf) => {
      if (!stripDeployEvidence || wf.workflow_file !== PRODUCTION_WORKFLOWS.DEPLOY) return wf;
      return { ...wf, outputs: {}, environment: null };
    });
    const deployA = countDeployDispatches(providerA);
    await assert.rejects(() => executeProductionRelease(db, runA.run.id, { provider: providerA, repo: stagedA.repo, now: NOW }), /not an exact successful|environment|outputs/);
    assert.equal(getProductionRelease(db, runA.run.id).run.current_status, "PRODUCTION_STATE_UNKNOWN");
    assert.equal(deployA.count, 1);
    const lease = db.prepare("SELECT * FROM production_release_global_lease WHERE id=1").get();
    assert.equal(Number(lease.release_run_id), runA.run.id);
    await assert.rejects(() => executeProductionRelease(db, runA.run.id, { provider: providerA, repo: stagedA.repo, now: NOW }), /not an exact successful|environment|outputs/);
    assert.equal(getProductionRelease(db, runA.run.id).run.current_status, "PRODUCTION_STATE_UNKNOWN");
    assert.equal(deployA.count, 1);
    const b = await cleared(db, stagedB.codingTaskId, stagedB.repo);
    const runB = createProductionReleaseRun(db, execBody(stagedB.codingTaskId, b.authorization, b.assessment, { expectedMasterHead: stagedB.repo.resolveRemoteRef("master") }), { repo: stagedB.repo, now: NOW });
    const providerB = makeStubProductionReleaseProvider();
    const countsB = countWorkflowDispatches(providerB);
    await assert.rejects(() => executeProductionRelease(db, runB.run.id, { provider: providerB, repo: stagedB.repo, now: NOW }), /lease held|global production/);
    assert.equal(countsB.predeploy, 0);
    assert.equal(countsB.deploy, 0);
    assert.ok(!getProductionRelease(db, runB.run.id).bindings.some((x) => ["predeploy", "deploy", "rollback"].includes(x.workflow_kind) && (x.workflow_run_id || x.dispatch_submitted_at)));
    assert.equal(Number(db.prepare("SELECT release_run_id FROM production_release_global_lease WHERE id=1").get().release_run_id), runA.run.id);
    stripDeployEvidence = false;
    const reconciled = await executeProductionRelease(db, runA.run.id, { provider: providerA, repo: stagedA.repo, now: NOW });
    assert.equal(reconciled.run.current_status, "SUCCEEDED");
    assert.equal(deployA.count, 1);
  } finally { stagedA.git.cleanup(); stagedB.git.cleanup(); db.close(); }
});

test("accepted deploy without final artifact still correlates by durable intent and does not redispatch", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    seedPrev(db, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    const provider = makeStubProductionReleaseProvider();
    wrapGetWorkflowRun(provider, (wf) => {
      if (wf.workflow_file !== PRODUCTION_WORKFLOWS.DEPLOY) return wf;
      return { ...wf, outputs: {}, environment: null };
    });
    const deploy = countDeployDispatches(provider);
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /not an exact successful|environment|outputs/);
    const detail = getProductionRelease(db, created.run.id);
    const deployBinding = detail.bindings.find((b) => b.workflow_kind === "deploy");
    assert.ok(deployBinding.workflow_run_id);
    const found = await provider.findWorkflowRunByIdempotency({
      workflowFile: PRODUCTION_WORKFLOWS.DEPLOY,
      dispatchIntentId: deployBinding.dispatch_intent_id,
    });
    assert.equal(String(found.id), String(deployBinding.workflow_run_id));
    assert.match(found.name, /^phase15-intent:/);
    assert.equal(detail.run.current_status, "PRODUCTION_STATE_UNKNOWN");
    assert.equal(deploy.count, 1);
    await assert.rejects(() => executeProductionRelease(db, created.run.id, { provider, repo, now: NOW }), /not an exact successful|environment|outputs/);
    assert.equal(deploy.count, 1);
    assert.equal(getProductionRelease(db, created.run.id).run.current_status, "PRODUCTION_STATE_UNKNOWN");
    assert.equal(Number(db.prepare("SELECT release_run_id FROM production_release_global_lease WHERE id=1").get().release_run_id), created.run.id);
  } finally { git.cleanup(); db.close(); }
});

test("first-live bootstrap uses independently inspected predeploy current production, never caller identity", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    assert.equal(created.run.previous_stable_sha, null);
    const liveSha = execFileSync("git", ["-C", git.dir, "rev-parse", "origin/master^"], { encoding: "utf8" }).trim();
    const liveDigest = "sha256:" + "33".repeat(32);
    const provider = makeStubProductionReleaseProvider({
      currentProduction: { digest: liveDigest, image_ref: `ghcr.io/fyun48/5151@${liveDigest}` },
      inspectByDigest: {
        [liveDigest]: { digest: liveDigest, oci_revision: liveSha, oci_source: "https://github.com/Fyun48/5151" },
      },
    });
    const out = await executeProductionRelease(db, created.run.id, {
      provider, repo, now: NOW,
      currentStableSha: "c".repeat(40),
      currentStableDigest: "sha256:" + "99".repeat(32),
      currentStable: { source_sha: "c".repeat(40) },
    });
    assert.equal(out.run.current_status, "SUCCEEDED");
    const stable = getProductionStable(db);
    assert.equal(stable.source_sha, authorization.head_sha);
    assert.equal(stable.artifact_digest, authorization.artifact_digest);
    const detail = getProductionRelease(db, created.run.id);
    const boot = detail.evidence.find((e) => e.evidence_kind === "first_live_bootstrap");
    assert.ok(boot);
    assert.equal(boot.payload.inspected.oci_revision, liveSha);
    assert.equal(boot.payload.observed.digest, liveDigest);
    assert.notEqual(boot.payload.observed.digest, "sha256:" + "99".repeat(32));
  } finally { git.cleanup(); db.close(); }
});

test("first-live bootstrap refuses unverified or caller-only current-stable identity", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization, assessment } = await cleared(db, codingTaskId, repo);
    const created = createProductionReleaseRun(db, execBody(codingTaskId, authorization, assessment, { expectedMasterHead: expectedMaster(repo) }), { repo, now: NOW });
    const noEvidence = makeStubProductionReleaseProvider({
      currentStableSha: "c".repeat(40),
      currentStableDigest: "sha256:" + "99".repeat(32),
    });
    await assert.rejects(() => executeProductionRelease(db, created.run.id, {
      provider: noEvidence, repo, now: NOW,
      currentStableSha: "c".repeat(40),
      currentStableDigest: "sha256:" + "99".repeat(32),
    }), /previous stable identity is incomplete/);
    assert.equal(getProductionRelease(db, created.run.id).run.current_status, "BLOCKED");
    assert.equal(getProductionStable(db), null);

    const db2 = openOpsDb(":memory:");
    const staged2 = await makeStagedTask(db2);
    try {
      const cleared2 = await cleared(db2, staged2.codingTaskId, staged2.repo);
      const created2 = createProductionReleaseRun(db2, execBody(staged2.codingTaskId, cleared2.authorization, cleared2.assessment, { expectedMasterHead: expectedMaster(staged2.repo) }), { repo: staged2.repo, now: NOW });
      const badInspect = makeStubProductionReleaseProvider({
        currentProduction: { digest: "sha256:" + "33".repeat(32), image_ref: "ghcr.io/fyun48/5151@sha256:" + "33".repeat(32) },
        inspectByDigest: {
          ["sha256:" + "33".repeat(32)]: { digest: "sha256:" + "33".repeat(32), oci_revision: "0".repeat(40), oci_source: "https://github.com/Fyun48/5151" },
        },
      });
      await assert.rejects(() => executeProductionRelease(db2, created2.run.id, { provider: badInspect, repo: staged2.repo, now: NOW }), /previous stable identity is incomplete/);
      assert.equal(getProductionStable(db2), null);
    } finally { staged2.git.cleanup(); db2.close(); }
  } finally { git.cleanup(); db.close(); }
});

