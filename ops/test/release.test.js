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
import { buildManifestContent, computeManifestHash, releaseInputFingerprint } from "../src/release/manifest.js";
import { buildReleasePolicy, releasePolicyFingerprint } from "../src/release/releasePolicy.js";
import {
  createReleaseCandidate, getCurrentReleaseCandidate, getReleaseManifest, getReleaseCandidateView,
  submitOwnerReleaseDecision, currentReleaseDecision, retryReleaseNotification, listReleaseNotifications, validateReleaseChain,
} from "../src/releaseCandidate.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "rc-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "rc-remote-"));
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
function advanceMaster(dir) {
  writeFileSync(path.join(dir, "m.txt"), "x\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "master advance"]);
}
async function makeStagedTask(db, { codingBehavior, stagingOpts = {}, stagingEnvExtra = {} } = {}) {
  const iid = seedProposeIssue(db);
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  submitOwnerDecision(db, iid, { action: "APPROVE_DEVELOPMENT", proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
  const g = initGitRepo(); const repo = makeGitRepo(g.dir); const prov = makeStubCodingProvider(codingBehavior ? { behavior: codingBehavior } : {});
  const { task } = createCodingTask(db, { issueId: iid, provider: prov, repo, now: NOW });
  const [c] = claimCodingTaskBatch(db, { now: NOW, limit: 5 });
  await executeCodingTask(db, c, { provider: prov, repo, pr: makeStubPrGateway(), selfTest: async () => ({ ran: true, passed: true }), now: NOW });
  const { run } = createQaRun(db, { codingTaskId: task.id, repo, now: NOW });
  await executeQaRun(db, run, { repo, now: NOW });
  const qaOk = db.prepare("SELECT final_result FROM development_qa_run WHERE id=?").get(run.id).final_result === "PASS";
  let stagingReady = false;
  if (qaOk) {
    const env = { ...process.env, ...stagingEnvExtra };
    createStagingDeployment(db, { codingTaskId: task.id, repo, env, now: NOW });
    const [d] = claimStagingBatch(db, { now: NOW, limit: 5 });
    const out = await executeStagingDeployment(db, d, { repo, provider: makeStubStagingProvider(stagingOpts), env, now: NOW });
    stagingReady = out.validation_result === "PASS";
  }
  return { iid, codingTaskId: task.id, repo, git: g, coding: db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(task.id), qaOk, stagingReady };
}

// ================= 單元：manifest / fingerprints =================
test("18+19+20. manifest hash / policy fp / input fp deterministic", () => {
  const content = { a: 1, b: [3, 2, 1] };
  const h1 = computeManifestHash({ content, version: 1, headSha: "h", artifactDigest: "d", releaseInputFingerprint: "i" });
  assert.equal(h1, computeManifestHash({ content: { b: [3, 2, 1], a: 1 }, version: 1, headSha: "h", artifactDigest: "d", releaseInputFingerprint: "i" }));
  assert.notEqual(h1, computeManifestHash({ content, version: 2, headSha: "h", artifactDigest: "d", releaseInputFingerprint: "i" }));
  assert.equal(releasePolicyFingerprint(buildReleasePolicy()), releasePolicyFingerprint(buildReleasePolicy()));
  const base = { codingTaskId: 1, authorizationId: 1, proposalId: 1, proposalVersion: 1, proposalHash: "p", baseSha: "b", headSha: "H", currentMaster: "b", codingResultHash: "r", diffHash: "d", qaRunId: 1, qaInputFp: "qi", qaPolicyFp: "qp", stagingId: 1, stagingInputFp: "si", stagingPolicyFp: "sp", stagingConfigFp: "sc", artifactDigest: "ad", releasePolicyFp: "rp" };
  assert.equal(releaseInputFingerprint(base), releaseInputFingerprint({ ...base }));
  assert.notEqual(releaseInputFingerprint(base), releaseInputFingerprint({ ...base, headSha: "H2" }));
  assert.notEqual(releaseInputFingerprint(base), releaseInputFingerprint({ ...base, currentMaster: "c2" }));
});
test("47+48+49. manifest surfaces DB migration / config / security / QA / staging artifact+health+smoke", () => {
  const snapshot = { title: "T", proposed_change: "c", scope: [], non_goals: [], acceptance_criteria: ["a"], known_risks: ["r"], security_considerations: "s" };
  const qa = { id: 5, final_result: "PASS", fresh: true, diff_hash: "d", checks: [
    { check_type: "TESTS", status: "PASS", severity: "none" },
    { check_type: "SECRET_SCAN", status: "PASS", severity: "none", finding: "" },
    { check_type: "DEPENDENCY_CHANGE", status: "WARN", severity: "low", evidence: { manifests: ["package.json"] } },
    { check_type: "DATABASE_MIGRATION", status: "WARN", severity: "medium", finding: "schema change", evidence: { schema: true } },
    { check_type: "CONFIG_CHANGE", status: "WARN", severity: "low", evidence: { files: [".env"] } },
  ] };
  const staging = { id: 7, artifact_digest: "sha256:abc", head_sha: "H", staging_environment_id: "s1", staging_environment_class: "staging", validation_result: "PASS", staging_url: "staging://x", config_fingerprint: "cf", checks: [
    { check_type: "HEALTH", status: "PASS" }, { check_type: "SMOKE", status: "PASS" }, { check_type: "DATABASE_ISOLATION", status: "PASS", severity: "none" },
  ] };
  const content = buildManifestContent({ snapshot, task: { id: 1, base_sha: "b", head_sha: "H", changed_files: ["a.js"], diff_insertions: 1, diff_deletions: 0 }, auth: { id: 2, proposal_id: 3, proposal_version: 1, proposal_hash: "p", approved_by: "owner", approved_at: "t" }, qa, staging, currentMaster: "b" });
  assert.ok(content.database_config.migration && content.database_config.migration.finding === "schema change");
  assert.match(content.database_config.production_migration_safety, /Phase 14/);
  assert.ok(content.database_config.config_change);
  assert.ok(content.qa.checks.length >= 5);
  assert.equal(content.staging.artifact_digest, "sha256:abc");
  assert.equal(content.staging.health, "PASS");
  assert.equal(content.staging.smoke, "PASS");
  assert.doesNotMatch(JSON.stringify(content), /leak@example\.com/);
});

// ================= 整合：RC 建立 gating =================
test("1. no coding task ⇒ no RC", () => {
  const db = openOpsDb(":memory:");
  try { assert.throws(() => createReleaseCandidate(db, { codingTaskId: 9999, repo: { available: true, resolveRef: () => "x" }, now: NOW }), /coding task not found/); } finally { db.close(); }
});
test("3. QA FAIL ⇒ no RC; 4. QA REVIEW ⇒ no RC", async () => {
  for (const b of ["protected", "oversize"]) {
    const db = openOpsDb(":memory:");
    const { codingTaskId, repo, git } = await makeStagedTask(db, { codingBehavior: b });
    try { assert.throws(() => createReleaseCandidate(db, { codingTaskId, repo, now: NOW }), /QA (result|stale)/); } finally { git.cleanup(); db.close(); }
  }
});
test("6+7+8. no/failed/review staging ⇒ no RC", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db, { stagingOpts: { healthFail: true } });
  try { assert.throws(() => createReleaseCandidate(db, { codingTaskId, repo, now: NOW }), /no current staging/); } finally { git.cleanup(); db.close(); }
});
test("5. stale QA PASS ⇒ no RC; 9. stale staging PASS ⇒ no RC", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    assert.throws(() => createReleaseCandidate(db, { codingTaskId, repo, env: { ...process.env, QA_MAX_DIFF_LINES: "10" }, now: NOW }), /QA stale/);
    assert.throws(() => createReleaseCandidate(db, { codingTaskId, repo, env: { ...process.env, STAGING_TTL_MS: "999" }, now: NOW }), /staging stale/);
  } finally { git.cleanup(); db.close(); }
});
test("10-17+24. fresh QA+Staging PASS creates RC bound to exact evidence; canonical current", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git, coding } = await makeStagedTask(db);
  try {
    const staging = db.prepare("SELECT * FROM development_staging_current WHERE coding_task_id=?").get(codingTaskId);
    const { candidate } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.equal(candidate.coding_task_id, codingTaskId);
    assert.equal(candidate.development_authorization_id, coding.development_authorization_id);
    assert.equal(candidate.proposal_hash, coding.proposal_hash);
    assert.equal(candidate.qa_run_id, db.prepare("SELECT qa_run_id FROM development_qa_current WHERE coding_task_id=?").get(codingTaskId).qa_run_id);
    assert.equal(candidate.staging_deployment_id, staging.staging_deployment_id);
    assert.equal(candidate.base_sha, coding.base_sha);
    assert.equal(candidate.head_sha, coding.head_sha);
    assert.ok(candidate.artifact_digest.startsWith("sha256:"));
    assert.ok(candidate.manifest_hash.length === 64);
    const curr = getCurrentReleaseCandidate(db, codingTaskId, { repo, now: NOW });
    assert.equal(curr.id, candidate.id);
    assert.equal(curr.fresh, true);
    assert.equal(curr.source_base_drift, false);
  } finally { git.cleanup(); db.close(); }
});
test("21. completed manifest is immutable; 22+23. changed evidence ⇒ new version, history intact", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate: v1 } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.throws(() => db.prepare("UPDATE development_release_candidate SET manifest_content='x' WHERE id=?").run(v1.id), /immutable/);
    // 變更證據（master 前進 → current_master 改變 → input fp 改變）→ 新版本。
    advanceMaster(git.dir);
    const { candidate: v2 } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.equal(v2.manifest_version, 2);
    assert.notEqual(v2.manifest_hash, v1.manifest_hash);
    assert.ok(db.prepare("SELECT id FROM development_release_candidate WHERE id=?").get(v1.id)); // 歷史保留
  } finally { git.cleanup(); db.close(); }
});
test("26+27+29. QA/staging/policy change makes RC stale", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.equal(getCurrentReleaseCandidate(db, codingTaskId, { repo, now: NOW }).fresh, true);
    assert.ok(getCurrentReleaseCandidate(db, codingTaskId, { repo, env: { ...process.env, QA_MAX_DIFF_LINES: "10" }, now: NOW }).stale_reasons.includes("qa_not_fresh_pass"));
    assert.ok(getCurrentReleaseCandidate(db, codingTaskId, { repo, env: { ...process.env, STAGING_TTL_MS: "999" }, now: NOW }).stale_reasons.includes("staging_not_fresh_pass"));
    assert.ok(getCurrentReleaseCandidate(db, codingTaskId, { repo, env: { ...process.env, RELEASE_ALLOW_BASE_DRIFT: "1" }, now: NOW }).stale_reasons.includes("release_policy_changed"));
  } finally { git.cleanup(); db.close(); }
});
test("28. artifact digest change makes RC stale (synthetic current)", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    // 合成一個新的 ready staging（不同 artifact），並把 current 指過去（staging 本體不可變 → 用 INSERT 而非 UPDATE）。
    const st = db.prepare("SELECT * FROM development_staging_current WHERE coding_task_id=?").get(codingTaskId);
    const newStg = Number(db.prepare(`INSERT INTO development_staging_deployment(issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, qa_run_id, qa_input_fingerprint, qa_policy_fingerprint, base_sha, head_sha, coding_result_hash, diff_hash, source_tree_hash, artifact_id, artifact_digest, staging_provider, staging_environment_id, staging_environment_class, staging_url, staging_policy_version, staging_policy_fingerprint, config_fingerprint, config_snapshot, input_fingerprint, status, validation_result, attempt_count, max_attempts, next_attempt_at, created_at, completed_at) SELECT issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, qa_run_id, qa_input_fingerprint, qa_policy_fingerprint, base_sha, head_sha, coding_result_hash, diff_hash, source_tree_hash, artifact_id, 'sha256:different', staging_provider, staging_environment_id, staging_environment_class, staging_url, staging_policy_version, staging_policy_fingerprint, config_fingerprint, config_snapshot, 'stg-fp-2', 'ready', 'PASS', attempt_count, max_attempts, next_attempt_at, created_at, completed_at FROM development_staging_deployment WHERE id=?`).run(st.staging_deployment_id).lastInsertRowid);
    db.prepare("UPDATE development_staging_current SET staging_deployment_id=?, input_fingerprint='stg-fp-2' WHERE coding_task_id=?").run(newStg, codingTaskId);
    void candidate;
    assert.ok(getCurrentReleaseCandidate(db, codingTaskId, { repo, now: NOW }).stale_reasons.includes("artifact_digest_changed"));
  } finally { git.cleanup(); db.close(); }
});
test("25. head SHA change makes RC stale (synthetic current)", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    const ts = NOW.toISOString();
    const oldId = Number(db.prepare(`INSERT INTO development_release_candidate(issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, qa_run_id, staging_deployment_id, manifest_version, release_manifest_version, release_policy_version, base_sha, head_sha, current_master_sha, coding_result_hash, diff_hash, artifact_digest, release_policy_fingerprint, release_input_fingerprint, manifest_hash, manifest_content, source_base_drift, status, generated_at, created_at) SELECT issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, qa_run_id, staging_deployment_id, 99, release_manifest_version, release_policy_version, base_sha, 'oldhead', current_master_sha, coding_result_hash, diff_hash, artifact_digest, release_policy_fingerprint, 'inp-old', 'hash-old', manifest_content, 0, 'completed', ?, ? FROM development_release_candidate WHERE id=?`).run(ts, ts, candidate.id).lastInsertRowid);
    db.prepare("UPDATE development_release_current SET release_manifest_id=?, manifest_version=99, manifest_hash='hash-old' WHERE coding_task_id=?").run(oldId, codingTaskId);
    assert.ok(getCurrentReleaseCandidate(db, codingTaskId, { repo, now: NOW }).stale_reasons.includes("head_sha_changed"));
  } finally { git.cleanup(); db.close(); }
});
test("30+31. source base drift blocks fresh RC / approval", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    advanceMaster(git.dir); // master 前進 → drift
    const { candidate } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.equal(candidate.source_base_drift, true);
    const curr = getCurrentReleaseCandidate(db, codingTaskId, { repo, now: NOW });
    assert.equal(curr.fresh, false);
    assert.ok(curr.stale_reasons.includes("source_base_drift"));
    // 無法核准（stale）
    assert.throws(() => submitOwnerReleaseDecision(db, { codingTaskId, action: "APPROVE_RELEASE", manifestId: candidate.id, manifestVersion: candidate.manifest_version, manifestHash: candidate.manifest_hash, artifactDigest: candidate.artifact_digest, headSha: candidate.head_sha, repo, now: NOW }), /stale/);
  } finally { git.cleanup(); db.close(); }
});

// ================= Gate #2 =================
test("34+35+36+39+40+45+46. APPROVE requires exact identity; creates one immutable auth; idempotent; append-only; no creds", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate: rc } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    const good = { codingTaskId, action: "APPROVE_RELEASE", manifestId: rc.id, manifestVersion: rc.manifest_version, manifestHash: rc.manifest_hash, artifactDigest: rc.artifact_digest, headSha: rc.head_sha, repo, now: NOW };
    assert.throws(() => submitOwnerReleaseDecision(db, { ...good, manifestHash: "wrong" }), /manifest_hash mismatch/);
    assert.throws(() => submitOwnerReleaseDecision(db, { ...good, artifactDigest: "wrong" }), /artifact_digest mismatch/);
    assert.throws(() => submitOwnerReleaseDecision(db, { ...good, headSha: "wrong" }), /head_sha mismatch/);
    const r1 = submitOwnerReleaseDecision(db, good);
    assert.ok(r1.authorization.id > 0);
    const r2 = submitOwnerReleaseDecision(db, good); // 冪等
    assert.equal(r2.idempotent, true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_authorization WHERE coding_task_id=? AND status='active'").get(codingTaskId).n, 1);
    // 授權不含任何 production 憑證欄位
    const cols = db.prepare("PRAGMA table_info(production_release_authorization)").all().map((c) => c.name.toLowerCase());
    for (const c of cols) assert.doesNotMatch(c, /password|secret|ssh|token|credential/);
    // 決策 append-only
    const did = db.prepare("SELECT id FROM release_owner_decision LIMIT 1").get().id;
    assert.throws(() => db.prepare("UPDATE release_owner_decision SET action='x' WHERE id=?").run(did), /append-only/);
  } finally { git.cleanup(); db.close(); }
});
test("37+38+41. TOCTOU: old/new manifest version cannot win; new version supersedes old approval", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate: v1 } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    submitOwnerReleaseDecision(db, { codingTaskId, action: "APPROVE_RELEASE", manifestId: v1.id, manifestVersion: v1.manifest_version, manifestHash: v1.manifest_hash, artifactDigest: v1.artifact_digest, headSha: v1.head_sha, repo, now: NOW });
    assert.equal(db.prepare("SELECT status FROM production_release_authorization WHERE release_manifest_id=?").get(v1.id).status, "active");
    // master 前進 → 新 RC v2 → v1 授權 superseded；對 v1 再核准被拒（非 current）。
    advanceMaster(git.dir);
    const { candidate: v2 } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.equal(v2.manifest_version, 2);
    assert.equal(db.prepare("SELECT status FROM production_release_authorization WHERE release_manifest_id=?").get(v1.id).status, "superseded");
    assert.throws(() => submitOwnerReleaseDecision(db, { codingTaskId, action: "APPROVE_RELEASE", manifestId: v1.id, manifestVersion: v1.manifest_version, manifestHash: v1.manifest_hash, artifactDigest: v1.artifact_digest, headSha: v1.head_sha, repo, now: NOW }), /not current/);
  } finally { git.cleanup(); db.close(); }
});
test("REQUEST_CHANGES without a written reason is rejected", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate: rc } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.throws(
      () => submitOwnerReleaseDecision(db, { codingTaskId, action: "REQUEST_CHANGES", manifestId: rc.id, manifestVersion: rc.manifest_version, manifestHash: rc.manifest_hash, repo, now: NOW }),
      /written reason/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM release_owner_decision WHERE coding_task_id=?").get(codingTaskId).n, 0);
  } finally { git.cleanup(); db.close(); }
});
test("payload owner_direct flag cannot mint a Gate #2 approval", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate: rc } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.throws(
      () => submitOwnerReleaseDecision(db, {
        codingTaskId, action: "APPROVE_RELEASE", manifestId: rc.id, manifestVersion: rc.manifest_version, manifestHash: rc.manifest_hash,
        artifactDigest: rc.artifact_digest, headSha: rc.head_sha, repo, owner_direct: true,
      }),
      /verified session/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_authorization").get().n, 0);
  } finally { git.cleanup(); db.close(); }
});
test("42+43. REQUEST_CHANGES creates no authorization and invokes no coding provider", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate: rc } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    submitOwnerReleaseDecision(db, { codingTaskId, action: "REQUEST_CHANGES", manifestId: rc.id, manifestVersion: rc.manifest_version, manifestHash: rc.manifest_hash, reason: "please adjust", repo, now: NOW });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_authorization WHERE coding_task_id=?").get(codingTaskId).n, 0);
    assert.equal(currentReleaseDecision(db, codingTaskId).label, "changes_requested");
  } finally { git.cleanup(); db.close(); }
});
test("44. CANCEL_RELEASE creates no production deployment; supersedes any auth; preserves evidence", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate: rc } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    submitOwnerReleaseDecision(db, { codingTaskId, action: "APPROVE_RELEASE", manifestId: rc.id, manifestVersion: rc.manifest_version, manifestHash: rc.manifest_hash, artifactDigest: rc.artifact_digest, headSha: rc.head_sha, repo, now: NOW });
    submitOwnerReleaseDecision(db, { codingTaskId, action: "CANCEL_RELEASE", manifestId: rc.id, manifestVersion: rc.manifest_version, manifestHash: rc.manifest_hash, reason: "not now", repo, now: NOW });
    assert.equal(db.prepare("SELECT status FROM production_release_authorization WHERE release_manifest_id=?").get(rc.id).status, "superseded");
    assert.ok(db.prepare("SELECT id FROM development_release_candidate WHERE id=?").get(rc.id)); // 證據保留
  } finally { git.cleanup(); db.close(); }
});
test("58. failed approval leaves no partial authorization/decision", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate: rc } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.throws(() => submitOwnerReleaseDecision(db, { codingTaskId, action: "APPROVE_RELEASE", manifestId: rc.id, manifestVersion: rc.manifest_version, manifestHash: "wrong", artifactDigest: rc.artifact_digest, headSha: rc.head_sha, repo, now: NOW }));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_authorization").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM release_owner_decision").get().n, 0);
  } finally { git.cleanup(); db.close(); }
});

// ================= 通知 outbox =================
test("50+51+52. notification queued idempotently; no adapter → no fake delivery; no PII", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate: rc } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    const notifs = listReleaseNotifications(db, codingTaskId);
    assert.equal(notifs.length, 1);
    assert.equal(notifs[0].status, "pending");
    assert.doesNotMatch(JSON.stringify(notifs[0]), /leak@example\.com|reporter-\d/);
    const retry = await retryReleaseNotification(db, notifs[0].id, { actor: "owner", now: NOW });
    assert.equal(retry.status, "pending"); // 未設 adapter → 不假造送達
    const sent = await retryReleaseNotification(db, notifs[0].id, {
      actor: "owner",
      now: NOW,
      sender: async () => ({ ok: true, status: 204 }),
    });
    assert.equal(sent.status, "sent");
    assert.equal(listReleaseNotifications(db, codingTaskId)[0].status, "sent");
    void rc;
  } finally { git.cleanup(); db.close(); }
});
test("30(audit). audit is metadata-only", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { candidate: rc } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    submitOwnerReleaseDecision(db, { codingTaskId, action: "APPROVE_RELEASE", manifestId: rc.id, manifestVersion: rc.manifest_version, manifestHash: rc.manifest_hash, artifactDigest: rc.artifact_digest, headSha: rc.head_sha, repo, now: NOW });
    const rows = db.prepare("SELECT action, data FROM audit_log WHERE action LIKE 'issue.release%'").all();
    assert.ok(rows.some((r) => r.action === "issue.release_candidate.created"));
    assert.ok(rows.some((r) => r.action === "issue.release.approved"));
    assert.ok(rows.some((r) => r.action === "issue.release.authorization_created"));
    for (const r of rows) { assert.doesNotMatch(r.data || "", /leak@example\.com/); assert.doesNotMatch(r.data || "", /reporter-\d/); }
  } finally { git.cleanup(); db.close(); }
});

// ================= 靜態：不部署/不 merge =================
test("53-57. release modules never deploy production, merge, or trigger workflow (static)", () => {
  for (const f of ["releaseCandidate.js", "releaseWorker.js", "release/manifest.js", "release/releasePolicy.js"]) {
    const txt = readFileSync(path.join(ROOT, "ops", "src", f), "utf8");
    assert.doesNotMatch(txt, /gh\s+pr\s+merge|--auto\b|ready_for_review|workflow_dispatch|deploy-v3\.yml|casaos-compose|ssh |force-with-lease/i);
  }
});
