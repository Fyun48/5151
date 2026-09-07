import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";

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
import { createQaRun, executeQaRun, getCurrentCodingQA } from "../src/qaRun.js";
import {
  checkSourceIdentity, checkArtifactIntegrity, checkEnvironmentIsolation, checkDatabaseIsolation,
  checkStorageIsolation, checkExternalSideEffectSafety, checkMigration, aggregateStaging,
  isProductionIdentity, isStagingClass,
} from "../src/staging/checks.js";
import { makeStubStagingProvider, makeContainerStagingProvider, makeStagingProvider } from "../src/staging/provider.js";
import { stagingEnvironmentConfig, buildStagingPolicy, stagingPolicyFingerprint, configFingerprint } from "../src/staging/stagingPolicy.js";
import {
  createStagingDeployment, claimStagingBatch, executeStagingDeployment, validateCodingTaskForStaging,
  getCurrentCodingStaging, getStagingDeployment, getCodingStagingView, cancelStagingDeployment,
  cleanupStagingDeployment, stagingInputFingerprint,
} from "../src/stagingDeploy.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
let seq = 1;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAFE_ENV = { STAGING_PROVIDER: "stub", STAGING_ENV_CLASS: "staging", STAGING_ENV_ID: "staging-1", STAGING_DB_CLASS: "disposable", STAGING_STORAGE_MODE: "isolated", STAGING_INTEGRATION_MODE: "sandbox", STAGING_MIGRATION_MODE: "isolated" };

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
function initGitRepo({ testScript = 'node -e "process.exit(0)"' } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "stg-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "stg-remote-"));
  execFileSync("git", ["init", "-q", "-b", "master", dir]);
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github", "workflows", "test.yml"), "name: Tests\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: testScript } }) + "\n");
  writeFileSync(path.join(dir, "README.md"), "base\n");
  git(["add", "-A"]); git(["commit", "-q", "-m", "base"]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(["remote", "add", "origin", remote]);
  return { dir, remote, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} try { rmSync(remote, { recursive: true, force: true }); } catch {} } };
}
// 產生一個「已通過 Phase-11 QA」的 coding task。behavior 控制 coding diff → 影響 QA 結果。
async function makeQaTask(db, { behavior, testScript } = {}) {
  const iid = seedProposeIssue(db);
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  submitOwnerDecision(db, iid, { action: "APPROVE_DEVELOPMENT", proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
  const g = initGitRepo({ testScript });
  const repo = makeGitRepo(g.dir);
  const prov = makeStubCodingProvider(behavior ? { behavior } : {});
  const { task } = createCodingTask(db, { issueId: iid, provider: prov, repo, now: NOW });
  const [c] = claimCodingTaskBatch(db, { now: NOW, limit: 5 });
  await executeCodingTask(db, c, { provider: prov, repo, pr: makeStubPrGateway(), selfTest: async () => ({ ran: true, passed: true }), now: NOW });
  const { run } = createQaRun(db, { codingTaskId: task.id, repo, now: NOW });
  await executeQaRun(db, run, { repo, now: NOW });
  const qa = getCurrentCodingQA(db, task.id);
  return { iid, codingTaskId: task.id, repo, git: g, qa, coding: db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(task.id) };
}
function advanceBranch(dir, branch) {
  const wt = mkdtempSync(path.join(os.tmpdir(), "stg-adv-"));
  execFileSync("git", ["-C", dir, "worktree", "add", "-q", wt, branch]);
  writeFileSync(path.join(wt, "extra.txt"), "more\n");
  execFileSync("git", ["-C", wt, "add", "-A"]);
  execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "advance"]);
  execFileSync("git", ["-C", dir, "worktree", "remove", "--force", wt]);
}

// ================= 單元：checks / fingerprints / provider =================
test("11(u). source identity: branch advanced after QA blocks staging", () => {
  const repo = { resolveRef: () => "NEWHEAD", treeHash: () => "t" };
  const r = checkSourceIdentity({ repo, task: { head_sha: "OLDHEAD", coding_branch: "ai-dev/1" }, qaHeadSha: "OLDHEAD" });
  assert.equal(r.status, "FAIL");
  assert.equal(r.severity, "blocking");
});
test("22. mutable 'latest' is not immutable artifact evidence; digest bound to head", () => {
  assert.equal(checkArtifactIntegrity({ artifact: { artifact_digest: "latest" }, headSha: "h" }).status, "FAIL");
  assert.equal(checkArtifactIntegrity({ artifact: { artifact_digest: "sha256:" + "a".repeat(40), source_head_sha: "h" }, headSha: "h" }).status, "PASS");
  assert.equal(checkArtifactIntegrity({ artifact: { artifact_digest: "sha256:" + "a".repeat(40), source_head_sha: "x" }, headSha: "h" }).status, "FAIL");
});
test("23+26+27+32. isolation checks: prod DB/storage/live integrations fail; ambiguity → REVIEW", () => {
  assert.equal(checkDatabaseIsolation({ db_required: true, db_class: "production" }).status, "FAIL");
  assert.equal(checkStorageIsolation({ storage_mode: "production" }).status, "FAIL");
  assert.equal(checkExternalSideEffectSafety({ integration_mode: "live" }).status, "FAIL");
  assert.equal(checkStorageIsolation({ storage_mode: "unknown" }).status, "REVIEW");
  assert.equal(checkEnvironmentIsolation({ environment_class: "production", environment_id: "prod-1" }).status, "FAIL");
});
test("24. missing safe staging DB config fails closed", () => {
  assert.equal(checkDatabaseIsolation({ db_required: true, db_class: null }).status, "FAIL");
  assert.equal(checkDatabaseIsolation({ db_required: false, db_class: null }).status, "PASS");
});
test("28(u). migration validated only against isolated staging", () => {
  const iso = checkMigration({ qaMigration: { status: "WARN", evidence: {} }, config: { db_required: true, migration_mode: "isolated" } });
  assert.notEqual(iso.status, "FAIL");
  const bad = checkMigration({ qaMigration: { status: "WARN", evidence: {} }, config: { db_required: true, migration_mode: "live" } });
  assert.equal(bad.status, "FAIL");
});
test("31. staging validation aggregation is deterministic", () => {
  assert.equal(aggregateStaging([{ check_type: "HEALTH", status: "PASS", severity: "none" }]).validation_result, "PASS");
  assert.equal(aggregateStaging([{ check_type: "STORAGE_ISOLATION", status: "REVIEW", severity: "high" }]).validation_result, "REVIEW_REQUIRED");
  assert.equal(aggregateStaging([{ check_type: "DEPLOY", status: "FAIL", severity: "blocking" }]).validation_result, "FAIL");
});
test("13+14. staging input & policy fingerprints deterministic", () => {
  const base = { codingTaskId: 1, authorizationId: 1, proposalId: 1, proposalVersion: 1, proposalHash: "h", qaRunId: 1, qaInputFp: "qi", qaPolicyFp: "qp", baseSha: "b", headSha: "H1", codingResultHash: "r", diffHash: "d", stagingPolicyFp: "sp", configFp: "cf" };
  assert.equal(stagingInputFingerprint(base), stagingInputFingerprint({ ...base }));
  assert.notEqual(stagingInputFingerprint(base), stagingInputFingerprint({ ...base, headSha: "H2" }));
  assert.notEqual(stagingInputFingerprint(base), stagingInputFingerprint({ ...base, codingResultHash: "r2" })); // 12: result hash 綁定
  const a = stagingPolicyFingerprint(buildStagingPolicy());
  assert.equal(a, stagingPolicyFingerprint(buildStagingPolicy()));
});
test("18+19. provider unavailable/default is explicit (no fake); container adapter pending", () => {
  assert.equal(makeStagingProvider({}).available, false);
  assert.equal(makeContainerStagingProvider().available, false);
  assert.ok(makeContainerStagingProvider().setup.required.length > 0);
});
test("40+41. cleanup env identity guard (production/ambiguous refused)", () => {
  assert.equal(isProductionIdentity({ environment_class: "production" }), true);
  assert.equal(isProductionIdentity({ environment_id: "prod-nas" }), true);
  assert.equal(isStagingClass({ environment_class: "staging" }), true);
  assert.equal(isStagingClass({ environment_class: "production" }), false);
});

// ================= 整合：完整 Staging 管線 =================
test("1. no coding task ⇒ no staging", async () => {
  const db = openOpsDb(":memory:");
  try { assert.throws(() => createStagingDeployment(db, { codingTaskId: 99999, repo: { available: true }, env: SAFE_ENV, now: NOW }), /coding task not found/); } finally { db.close(); }
});
test("2. coding task without QA ⇒ no staging", async () => {
  const db = openOpsDb(":memory:");
  try {
    // 建 coding task 但不跑 QA。
    const iid = seedProposeIssue(db);
    await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
    await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
    const cur = getCurrentIssueProposal(db, iid, { now: NOW });
    submitOwnerDecision(db, iid, { action: "APPROVE_DEVELOPMENT", proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
    const g = initGitRepo(); const repo = makeGitRepo(g.dir); const prov = makeStubCodingProvider();
    const { task } = createCodingTask(db, { issueId: iid, provider: prov, repo, now: NOW });
    const [c] = claimCodingTaskBatch(db, { now: NOW, limit: 5 });
    await executeCodingTask(db, c, { provider: prov, repo, pr: makeStubPrGateway(), selfTest: async () => ({ ran: true, passed: true }), now: NOW });
    assert.throws(() => createStagingDeployment(db, { codingTaskId: task.id, repo, env: SAFE_ENV, now: NOW }), /no current QA/);
    g.cleanup();
  } finally { db.close(); }
});
test("3. QA FAIL ⇒ no staging", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git, qa } = await makeQaTask(db, { behavior: "protected" });
  try {
    assert.equal(qa.final_result, "FAIL");
    assert.throws(() => createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW }), /not PASS/);
  } finally { git.cleanup(); db.close(); }
});
test("4. QA REVIEW_REQUIRED ⇒ no automatic staging", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git, qa } = await makeQaTask(db, { behavior: "oversize" });
  try {
    assert.equal(qa.final_result, "REVIEW_REQUIRED");
    assert.throws(() => createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW }), /not PASS/);
  } finally { git.cleanup(); db.close(); }
});
test("5. stale QA PASS ⇒ no staging", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeQaTask(db);
  try {
    assert.throws(() => createStagingDeployment(db, { codingTaskId, repo, env: { ...SAFE_ENV, QA_MAX_DIFF_LINES: "10" }, now: NOW }), /stale/);
  } finally { git.cleanup(); db.close(); }
});
test("6-10+20+21+33. fresh QA PASS creates staging; deploy PASS binds exact identity + artifact digest; becomes canonical", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git, qa, coding } = await makeQaTask(db);
  try {
    const { deployment } = createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW });
    assert.equal(deployment.coding_task_id, codingTaskId);
    assert.equal(deployment.qa_run_id, qa.id);
    assert.equal(deployment.proposal_hash, coding.proposal_hash);
    assert.equal(deployment.base_sha, coding.base_sha);
    assert.equal(deployment.head_sha, coding.head_sha);
    const [claimed] = claimStagingBatch(db, { now: NOW, limit: 5 });
    const out = await executeStagingDeployment(db, claimed, { repo, provider: makeStubStagingProvider(), env: SAFE_ENV, now: NOW });
    assert.equal(out.validation_result, "PASS");
    assert.equal(out.deployment.status, "ready");
    assert.match(out.deployment.artifact_digest, /^sha256:[a-f0-9]+$/);
    const detail = getStagingDeployment(db, out.deployment.id);
    assert.equal(detail.checks.find((c) => c.check_type === "SOURCE_IDENTITY").status, "PASS");
    assert.equal(detail.checks.find((c) => c.check_type === "ARTIFACT_INTEGRITY").status, "PASS");
    assert.equal(detail.checks.find((c) => c.check_type === "HEALTH").status, "PASS");
    const curr = getCurrentCodingStaging(db, codingTaskId, { env: SAFE_ENV });
    assert.equal(curr.id, out.deployment.id);
    assert.equal(curr.fresh, true);
    assert.equal(curr.validation_result, "PASS");
  } finally { git.cleanup(); db.close(); }
});
test("11(e2e). branch advanced after QA ⇒ SOURCE_IDENTITY blocks staging", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git, coding } = await makeQaTask(db);
  try {
    const { deployment } = createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW });
    advanceBranch(git.dir, coding.coding_branch); // branch 前進，head 不再等於 QA-approved head
    const [claimed] = claimStagingBatch(db, { now: NOW, limit: 5 });
    const out = await executeStagingDeployment(db, claimed, { repo, provider: makeStubStagingProvider(), env: SAFE_ENV, now: NOW });
    assert.equal(out.validation_result, "FAIL");
    assert.ok(getStagingDeployment(db, deployment.id).blocking_checks.includes("SOURCE_IDENTITY"));
  } finally { git.cleanup(); db.close(); }
});
test("18(e2e). provider unavailable does not fake deployment", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeQaTask(db);
  try {
    const { deployment } = createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW });
    const [claimed] = claimStagingBatch(db, { now: NOW, limit: 5 });
    const out = await executeStagingDeployment(db, claimed, { repo, provider: makeContainerStagingProvider(), env: SAFE_ENV, now: NOW });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, "provider_unavailable");
    assert.equal(getStagingDeployment(db, deployment.id).status, "pending");
  } finally { git.cleanup(); db.close(); }
});
test("23(e2e). staging provider receives sanitized config only (no production credentials)", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeQaTask(db);
  try {
    const captured = [];
    const base = makeStubStagingProvider();
    const spy = { ...base, async build(ctx) { captured.push(ctx); return base.build(ctx); } };
    createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW });
    const [claimed] = claimStagingBatch(db, { now: NOW, limit: 5 });
    await executeStagingDeployment(db, claimed, { repo, provider: spy, env: SAFE_ENV, now: NOW });
    const keys = Object.keys(captured[0].sanitizedConfig || {});
    for (const k of keys) assert.doesNotMatch(k, /secret|token|password|credential|prod/i);
    assert.doesNotMatch(JSON.stringify(captured[0].sanitizedConfig), /password|secret|token/i);
  } finally { git.cleanup(); db.close(); }
});
test("24(e2e). missing staging DB config fails closed (no deploy)", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeQaTask(db);
  try {
    const env = { STAGING_PROVIDER: "stub", STAGING_ENV_CLASS: "staging", STAGING_ENV_ID: "s1", STAGING_STORAGE_MODE: "isolated", STAGING_INTEGRATION_MODE: "sandbox" }; // 無 STAGING_DB_CLASS, db_required 預設 true
    createStagingDeployment(db, { codingTaskId, repo, env, now: NOW });
    const [claimed] = claimStagingBatch(db, { now: NOW, limit: 5 });
    const out = await executeStagingDeployment(db, claimed, { repo, provider: makeStubStagingProvider(), env, now: NOW });
    assert.equal(out.validation_result, "FAIL");
    const detail = getStagingDeployment(db, out.deployment.id);
    assert.equal(detail.checks.find((c) => c.check_type === "DATABASE_ISOLATION").status, "FAIL");
    assert.equal(detail.checks.find((c) => c.check_type === "DEPLOY"), undefined); // 未部署（fail-closed）
  } finally { git.cleanup(); db.close(); }
});
test("29. health failure prevents PASS; 30. smoke failure prevents PASS", async () => {
  for (const opt of [{ healthFail: true }, { smokeFail: true }]) {
    const db = openOpsDb(":memory:");
    const { codingTaskId, repo, git } = await makeQaTask(db);
    try {
      createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW });
      const [claimed] = claimStagingBatch(db, { now: NOW, limit: 5 });
      const out = await executeStagingDeployment(db, claimed, { repo, provider: makeStubStagingProvider(opt), env: SAFE_ENV, now: NOW });
      assert.equal(out.validation_result, "FAIL");
    } finally { git.cleanup(); db.close(); }
  }
});
test("15. idempotent; 16. concurrency no double-deploy; 17. stale claim recovery", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeQaTask(db);
  try {
    const a = createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW });
    const b = createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW });
    assert.equal(b.idempotent, true);
    assert.equal(a.deployment.id, b.deployment.id);
    const first = claimStagingBatch(db, { now: NOW, limit: 5 });
    const second = claimStagingBatch(db, { now: NOW, limit: 5 });
    assert.equal(first.length, 1); assert.equal(second.length, 0);
    db.prepare("UPDATE development_staging_deployment SET claimed_at=? WHERE id=?").run(new Date(NOW.getTime() - 3600000).toISOString(), first[0].id);
    assert.equal(claimStagingBatch(db, { now: NOW, staleMs: 300000, limit: 5 }).length, 1);
  } finally { git.cleanup(); db.close(); }
});
test("34+35+36+37+38+39. freshness/staleness of canonical staging", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeQaTask(db);
  try {
    createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW });
    const [claimed] = claimStagingBatch(db, { now: NOW, limit: 5 });
    const out = await executeStagingDeployment(db, claimed, { repo, provider: makeStubStagingProvider(), env: SAFE_ENV, now: NOW });
    assert.equal(getCurrentCodingStaging(db, codingTaskId, { env: SAFE_ENV }).fresh, true);
    // 37 staging policy change / 38 config change / 36 QA change → stale
    assert.ok(getCurrentCodingStaging(db, codingTaskId, { env: { ...SAFE_ENV, STAGING_TTL_MS: "999" } }).stale_reasons.includes("staging_policy_changed"));
    assert.ok(getCurrentCodingStaging(db, codingTaskId, { env: { ...SAFE_ENV, STAGING_ENV_ID: "other" } }).stale_reasons.includes("config_changed"));
    assert.ok(getCurrentCodingStaging(db, codingTaskId, { env: { ...SAFE_ENV, QA_MAX_DIFF_LINES: "10" } }).stale_reasons.includes("qa_not_fresh_pass"));
    // 34+35 失敗的新嘗試不取代成功 canonical：合成綁定不同 head 的部署 → 執行 superseded，不更新 current。
    const ts = NOW.toISOString();
    const badId = Number(db.prepare(`INSERT INTO development_staging_deployment(issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, qa_run_id, base_sha, head_sha, coding_result_hash, staging_policy_version, staging_policy_fingerprint, config_fingerprint, input_fingerprint, status, attempt_count, max_attempts, next_attempt_at, created_at) SELECT issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, qa_run_id, base_sha, 'deadbeef', coding_result_hash, staging_policy_version, staging_policy_fingerprint, config_fingerprint, 'inp-bad', 'pending', 0, 3, ?, ? FROM development_staging_deployment WHERE id=?`).run(ts, ts, out.deployment.id).lastInsertRowid);
    await executeStagingDeployment(db, db.prepare("SELECT * FROM development_staging_deployment WHERE id=?").get(badId), { repo, provider: makeStubStagingProvider(), env: SAFE_ENV, now: NOW });
    assert.equal(db.prepare("SELECT staging_deployment_id FROM development_staging_current WHERE coding_task_id=?").get(codingTaskId).staging_deployment_id, out.deployment.id);
    // 39 coding task cancel → stale
    db.prepare("UPDATE development_coding_task SET status='cancelled' WHERE id=?").run(codingTaskId);
    assert.ok(getCurrentCodingStaging(db, codingTaskId, { env: SAFE_ENV }).stale_reasons.includes("coding_task_cancelled"));
  } finally { git.cleanup(); db.close(); }
});
test("40+41(e2e). cleanup refuses production/ambiguous; operates only on staging-class", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeQaTask(db);
  try {
    createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW });
    const [claimed] = claimStagingBatch(db, { now: NOW, limit: 5 });
    const out = await executeStagingDeployment(db, claimed, { repo, provider: makeStubStagingProvider(), env: SAFE_ENV, now: NOW });
    // 竄改成 production 身分 → 拒絕清理（fail-closed）。
    db.prepare("UPDATE development_staging_deployment SET staging_environment_class='production' WHERE id=?").run(out.deployment.id);
    assert.throws(() => cleanupStagingDeployment(db, out.deployment.id, { actor: "owner" }), /fail-closed|not an explicit/);
    // 還原為 staging → 允許清理請求。
    db.prepare("UPDATE development_staging_deployment SET staging_environment_class='staging' WHERE id=?").run(out.deployment.id);
    assert.equal(cleanupStagingDeployment(db, out.deployment.id, { actor: "owner" }).cleanup_requested, true);
  } finally { git.cleanup(); db.close(); }
});
test("48. audit is metadata-only (no PII/secrets)", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeQaTask(db);
  try {
    createStagingDeployment(db, { codingTaskId, repo, env: SAFE_ENV, now: NOW });
    const [claimed] = claimStagingBatch(db, { now: NOW, limit: 5 });
    await executeStagingDeployment(db, claimed, { repo, provider: makeStubStagingProvider(), env: SAFE_ENV, now: NOW });
    const rows = db.prepare("SELECT action, data FROM audit_log WHERE action LIKE 'issue.staging.%'").all();
    assert.ok(rows.some((r) => r.action === "issue.staging.created"));
    assert.ok(rows.some((r) => r.action === "issue.staging.ready"));
    for (const r of rows) { assert.doesNotMatch(r.data || "", /leak@example\.com/); assert.doesNotMatch(r.data || "", /reporter-\d/); }
  } finally { git.cleanup(); db.close(); }
});

// ================= 靜態：不 merge / 不部署 Production / PR 保持 draft =================
test("42-45. staging modules never merge, un-draft PR, or deploy production (static)", () => {
  for (const f of ["stagingDeploy.js", "stagingWorker.js", "staging/checks.js", "staging/provider.js", "staging/stagingPolicy.js"]) {
    const txt = readFileSync(path.join(ROOT, "ops", "src", f), "utf8");
    assert.doesNotMatch(txt, /gh\s+pr\s+merge|--auto\b|ready_for_review|workflow_dispatch|deploy-v3\.yml|casaos-compose|force-with-lease/i);
  }
});
