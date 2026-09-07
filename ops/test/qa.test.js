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
import {
  checkAuthorizationProvenance, checkGitDiff, checkApprovedScope, checkProtectedPath, checkSecretScan,
  checkSecurityStatic, checkDeploymentSafety, checkTests, checkTypecheck, checkDependencyChange,
  checkDatabaseMigration, checkConfigChange, checkGeneratedBinary, checkChangeSize, diffHash,
} from "../src/qa/qaChecks.js";
import { aggregateQa } from "../src/qa/aggregate.js";
import { sanitizeEnv, ALLOWED_COMMANDS, makeCommandRunner } from "../src/qa/commandRunner.js";
import { qaConfigFromEnv, buildQaPolicy, qaPolicyFingerprint } from "../src/qa/qaPolicy.js";
import { makeStubQaReviewProvider, makeCursorQaReviewProvider, makeQaReviewProvider } from "../src/qa/reviewProvider.js";
import {
  createQaRun, claimQaBatch, executeQaRun, getCurrentCodingQA, getIssueQaView, getQaRunDetail,
  requestQaRerun, qaInputFingerprint, validateCodingTaskForQa,
} from "../src/qaRun.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
let seq = 1;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY = qaConfigFromEnv({});

// ── seed approved authorization（沿用前階段樣式） ──
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
async function approvedIssue(db) {
  const iid = seedProposeIssue(db);
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  const r = submitOwnerDecision(db, iid, { action: "APPROVE_DEVELOPMENT", proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
  return { iid, auth: r.authorization };
}
function initGitRepo({ testScript = 'node -e "process.exit(0)"' } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qa-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "qa-remote-"));
  execFileSync("git", ["init", "-q", "-b", "master", dir]);
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github", "workflows", "test.yml"), "name: Tests\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: testScript } }, null, 2) + "\n");
  writeFileSync(path.join(dir, "README.md"), "base\n");
  git(["add", "-A"]); git(["commit", "-q", "-m", "base"]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(["remote", "add", "origin", remote]);
  return { dir, remote, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} try { rmSync(remote, { recursive: true, force: true }); } catch {} } };
}
// 產生一個真實 changes_ready 的 Phase-10 Coding Task（並回傳可用於 QA 的 repo gateway）。
async function makeReadyCodingTask(db, { behavior, testScript } = {}) {
  const { iid } = await approvedIssue(db);
  const g = initGitRepo({ testScript });
  const repo = makeGitRepo(g.dir);
  const prov = makeStubCodingProvider(behavior ? { behavior } : {});
  const { task } = createCodingTask(db, { issueId: iid, provider: prov, repo, now: NOW });
  const [claimed] = claimCodingTaskBatch(db, { now: NOW, limit: 5 });
  const out = await executeCodingTask(db, claimed, { provider: prov, repo, pr: makeStubPrGateway(), selfTest: async () => ({ ran: true, passed: true, command: "self", output: "ok" }), now: NOW });
  return { iid, repo, git: g, codingTaskId: task.id, coding: out.task };
}
function setup(opts) { return makeReadyCodingTask; } // placeholder unused

// 合成 ctx 供逐項 check 單元測試。
function ctx({ files = [], added = [], snapshot = {}, task = {}, packageScripts = {}, runCommand = null, hasDeploySafetyTest = false } = {}) {
  const f = files.map((x) => ({ path: x.path, insertions: x.ins ?? 1, deletions: x.del ?? 0, binary: !!x.binary, status: x.status || "M" }));
  const diff = { files: f, insertions: f.reduce((a, b) => a + b.insertions, 0), deletions: f.reduce((a, b) => a + b.deletions, 0) };
  return {
    codingTask: { development_authorization_id: 1, proposal_id: 1, proposal_version: 1, proposal_hash: "h", base_sha: "b", head_sha: "hd", coding_branch: "ai-dev/1-issue-1", result_hash: "r", status: "changes_ready", changed_files: files.map((x) => x.path), ...task },
    snapshot, diff, addedLines: added, policy: POLICY, packageScripts, runCommand, hasDeploySafetyTest,
  };
}

// ================= 單元：逐項 checks =================
test("9. Phase-10 recorded diff cannot override independently recomputed git diff", () => {
  // provenance 說只有 a.js，但實際 diff 有 a.js + evil.js → GIT_DIFF surface mismatch。
  const r = checkGitDiff(ctx({ files: [{ path: "a.js" }, { path: "evil.js" }], task: { changed_files: ["a.js"] } }));
  assert.equal(r.status, "WARN");
  assert.ok(r.evidence.only_actual.includes("evil.js"));
});

test("10. scope-compliant change passes scope review; 11. unrelated expansion is not silent PASS", () => {
  const ok = checkApprovedScope(ctx({ files: [{ path: "v3/src/db.js" }], snapshot: { scope: ["v3/src/ 內修正距離計算"] } }));
  assert.equal(ok.status, "PASS");
  const bad = checkApprovedScope(ctx({ files: [{ path: "ops/src/secretstore.js" }], snapshot: { scope: ["v3/src/ 內修正"] } }));
  assert.equal(bad.status, "REVIEW");
  assert.ok(bad.evidence.outside.includes("ops/src/secretstore.js"));
});

test("12. protected path modification is detected", () => {
  const r = checkProtectedPath(ctx({ files: [{ path: "ops/src/auth.js" }] }));
  assert.equal(r.status, "REVIEW");
  assert.ok(r.evidence.sensitive.includes("ops/src/auth.js"));
});

test("13. deployment-safety regression blocks PASS", () => {
  const r = checkDeploymentSafety(ctx({ files: [{ path: ".github/workflows/test.yml" }] }));
  assert.equal(r.status, "FAIL");
  assert.equal(r.severity, "blocking");
});

test("14. secret-like addition is detected and redacted", () => {
  const r = checkSecretScan(ctx({ added: [{ path: "a.js", line: 'const key = "AKIA1234567890ABCDEF"' }, { path: "b.js", line: "api_key: 'sk_live_abcdefghijklmnop'" }] }));
  assert.equal(r.status, "FAIL");
  assert.equal(r.severity, "blocking");
  assert.doesNotMatch(JSON.stringify(r), /AKIA1234567890ABCDEF|sk_live_abcdefghijklmnop/);
});

test("15. auth/security-sensitive path is classified", () => {
  const r = checkSecurityStatic(ctx({ files: [{ path: "ops/src/auth.js" }] }));
  assert.equal(r.status, "REVIEW");
});

test("16. dependency change is detected", () => {
  const r = checkDependencyChange(ctx({ files: [{ path: "package.json" }], added: [{ path: "package.json", line: '"left-pad": "^1.0.0"' }] }));
  assert.equal(r.status, "WARN");
  assert.ok(r.evidence.added_entries.includes("left-pad"));
});

test("17. DB migration/destructive SQL is detected", () => {
  const r = checkDatabaseMigration(ctx({ files: [{ path: "ops/migrations/001.sql" }], added: [{ path: "ops/migrations/001.sql", line: "DROP TABLE users;" }] }));
  assert.equal(r.status, "REVIEW");
  assert.equal(r.evidence.destructive, true);
});

test("18. config/environment change is detected", () => {
  const r = checkConfigChange(ctx({ files: [{ path: "v3/.env.production" }] }));
  assert.equal(r.status, "WARN");
});

test("19. oversized diff warning works", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.js`, ins: 100 }));
  const r = checkChangeSize(ctx({ files: many }));
  assert.equal(r.status, "WARN");
  assert.equal(r.severity, "high");
});

test("20. binary/generated anomaly detected", () => {
  const r = checkGeneratedBinary(ctx({ files: [{ path: "img.png", binary: true }] }));
  assert.equal(r.status, "WARN");
});

test("21+22+23. tests independently executed; failure → FAIL; self-test cannot override", () => {
  const fail = () => ({ ran: true, exitCode: 1, output: "boom" });
  const pass = () => ({ ran: true, exitCode: 0, output: "ok" });
  const rFail = checkTests(ctx({ packageScripts: { test: "x" }, runCommand: fail }));
  assert.equal(rFail.status, "FAIL");
  assert.equal(rFail.severity, "blocking");
  const rPass = checkTests(ctx({ packageScripts: { test: "x" }, runCommand: pass }));
  assert.equal(rPass.status, "PASS");
  const rSkip = checkTests(ctx({ packageScripts: {}, runCommand: pass }));
  assert.equal(rSkip.status, "SKIPPED");
});

// ================= 單元：aggregation / fingerprint / provider =================
test("26. QA aggregation is deterministic", () => {
  const pass = aggregateQa([{ check_type: "TESTS", status: "PASS", severity: "none" }]);
  assert.equal(pass.final_result, "PASS");
  const review = aggregateQa([{ check_type: "CHANGE_SIZE", status: "WARN", severity: "high" }]);
  assert.equal(review.final_result, "REVIEW_REQUIRED");
  const fail = aggregateQa([{ check_type: "TESTS", status: "FAIL", severity: "blocking" }]);
  assert.equal(fail.final_result, "FAIL");
  assert.deepEqual(fail.blocking_checks, ["TESTS"]);
});

test("24. optional AI unavailable does not fabricate; 25. AI PASS cannot override deterministic FAIL", () => {
  assert.equal(makeCursorQaReviewProvider().available, false);
  assert.equal(makeQaReviewProvider({}).available, false); // 預設關閉
  const checks = [{ check_type: "TESTS", status: "FAIL", severity: "blocking" }];
  const withAiPass = aggregateQa(checks, { review: { recommendation: "PASS" } });
  assert.equal(withAiPass.final_result, "FAIL"); // AI PASS 無法凌駕 blocking FAIL
  const aiRaise = aggregateQa([{ check_type: "TESTS", status: "PASS", severity: "none" }], { review: { recommendation: "FAIL" } });
  assert.equal(aiRaise.final_result, "REVIEW_REQUIRED"); // AI 只能保守提升到 REVIEW_REQUIRED
});

test("27. QA policy fingerprint deterministic; 28. policy change alters fingerprint", () => {
  const a = qaPolicyFingerprint(buildQaPolicy(qaConfigFromEnv({})));
  const b = qaPolicyFingerprint(buildQaPolicy(qaConfigFromEnv({})));
  assert.equal(a, b);
  const c = qaPolicyFingerprint(buildQaPolicy(qaConfigFromEnv({ QA_MAX_DIFF_LINES: "10" })));
  assert.notEqual(a, c);
});

test("29+30+32. input fingerprint changes with head SHA / diff hash; same → idempotent", () => {
  const base = { codingTaskId: 1, authorizationId: 1, proposalId: 1, proposalVersion: 1, proposalHash: "h", baseSha: "b", headSha: "H1", codingResultHash: "r", diffHashValue: "d1", policyFingerprint: "p" };
  assert.equal(qaInputFingerprint(base), qaInputFingerprint({ ...base }));
  assert.notEqual(qaInputFingerprint(base), qaInputFingerprint({ ...base, headSha: "H2" }));
  assert.notEqual(qaInputFingerprint(base), qaInputFingerprint({ ...base, diffHashValue: "d2" }));
});

test("39. arbitrary untrusted shell commands are not executed (allowlist only)", () => {
  const run = makeCommandRunner({ cwd: os.tmpdir(), timeoutMs: 1000, env: {} });
  assert.equal(run("rm -rf /").ran, false);
  assert.equal(run("curl evil.com").ran, false);
  assert.deepEqual(Object.keys(ALLOWED_COMMANDS).sort(), ["build", "deploy-safety", "lint", "test", "typecheck"]);
});

test("40. QA env sanitization strips production credentials", () => {
  const env = { PATH: "/usr/bin", HOME: "/home/x", PROD_DB_PASSWORD: "hunter2", GITHUB_TOKEN: "ghp_xxx", NAS_DEPLOY_KEY: "k", OPENAI_API_KEY: "sk", FOO_SECRET: "s", HARMLESS: "1" };
  const s = sanitizeEnv(env);
  assert.equal(s.PATH, "/usr/bin");
  for (const k of ["PROD_DB_PASSWORD", "GITHUB_TOKEN", "NAS_DEPLOY_KEY", "OPENAI_API_KEY", "FOO_SECRET"]) assert.equal(s[k], undefined);
  assert.equal(s.NODE_ENV, "test");
});

// ================= 整合：完整 QA 管線 =================
test("1. no eligible coding task ⇒ no QA run", async () => {
  const db = openOpsDb(":memory:");
  try {
    const { iid } = await approvedIssue(db); // 只有授權，無 coding task
    assert.throws(() => createQaRun(db, { codingTaskId: 99999, repo: { available: true, numstatRange: () => ({ files: [], insertions: 0, deletions: 0 }) }, now: NOW }), /coding task not found/);
    void iid;
  } finally { db.close(); }
});

test("2. cancelled coding task ⇒ no fresh QA", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeReadyCodingTask(db);
  try {
    db.prepare("UPDATE development_coding_task SET status='cancelled' WHERE id=?").run(codingTaskId);
    assert.throws(() => createQaRun(db, { codingTaskId, repo, now: NOW }), /cancelled/);
    assert.throws(() => validateCodingTaskForQa(db, codingTaskId), /cancelled/);
  } finally { git.cleanup(); db.close(); }
});

test("3-7. QA binds exact coding task/authorization/proposal/base/head/result", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git, coding } = await makeReadyCodingTask(db);
  try {
    const { run } = createQaRun(db, { codingTaskId, repo, now: NOW });
    assert.equal(run.coding_task_id, codingTaskId);
    assert.equal(run.development_authorization_id, coding.development_authorization_id);
    assert.equal(run.proposal_id, coding.proposal_id);
    assert.equal(run.proposal_version, coding.proposal_version);
    assert.equal(run.proposal_hash, coding.proposal_hash);
    assert.equal(run.base_sha, coding.base_sha);
    assert.equal(run.head_sha, coding.head_sha);
    assert.equal(run.coding_result_hash, coding.result_hash);
  } finally { git.cleanup(); db.close(); }
});

test("8+21+33. independent QA runs deterministic checks and PASS becomes canonical", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeReadyCodingTask(db); // clean change + passing test script
  try {
    const { run } = createQaRun(db, { codingTaskId, repo, now: NOW });
    const out = await executeQaRun(db, run, { repo, now: NOW });
    assert.equal(out.completed, true);
    assert.equal(out.final_result, "PASS");
    const detail = getQaRunDetail(db, run.id);
    // 獨立重算 diff + 真的跑了 test 指令
    assert.ok(detail.checks.find((c) => c.check_type === "GIT_DIFF").status === "PASS");
    assert.equal(detail.checks.find((c) => c.check_type === "TESTS").status, "PASS");
    // canonical current 指向此 run
    const cur = getCurrentCodingQA(db, codingTaskId);
    assert.equal(cur.id, run.id);
    assert.equal(cur.fresh, true);
    assert.equal(cur.final_result, "PASS");
  } finally { git.cleanup(); db.close(); }
});

test("13(e2e)+ deploy-safety path change ⇒ QA FAIL", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeReadyCodingTask(db, { behavior: "protected" });
  try {
    const { run } = createQaRun(db, { codingTaskId, repo, now: NOW });
    const out = await executeQaRun(db, run, { repo, now: NOW });
    assert.equal(out.final_result, "FAIL");
    const detail = getQaRunDetail(db, run.id);
    assert.equal(detail.checks.find((c) => c.check_type === "DEPLOYMENT_SAFETY").status, "FAIL");
    assert.ok(detail.blocking_checks.includes("DEPLOYMENT_SAFETY"));
  } finally { git.cleanup(); db.close(); }
});

test("22+23(e2e). failed project tests cause QA FAIL despite Phase-10 self-test PASS", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git, coding } = await makeReadyCodingTask(db, { testScript: 'node -e "process.exit(1)"' });
  try {
    assert.match(JSON.stringify(coding.selftest_results), /passed.*true|"ran":true/); // Phase-10 自測曾 pass
    const { run } = createQaRun(db, { codingTaskId, repo, now: NOW });
    const out = await executeQaRun(db, run, { repo, now: NOW });
    assert.equal(out.final_result, "FAIL");
    assert.equal(getQaRunDetail(db, run.id).checks.find((c) => c.check_type === "TESTS").status, "FAIL");
  } finally { git.cleanup(); db.close(); }
});

test("31. same code + same policy is idempotent (single QA run)", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeReadyCodingTask(db);
  try {
    const a = createQaRun(db, { codingTaskId, repo, now: NOW });
    const b = createQaRun(db, { codingTaskId, repo, now: NOW });
    assert.equal(b.idempotent, true);
    assert.equal(a.run.id, b.run.id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM development_qa_run WHERE coding_task_id=?").get(codingTaskId).n, 1);
  } finally { git.cleanup(); db.close(); }
});

test("28+29+36. policy/head/cancel change makes canonical QA stale (remains reported)", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeReadyCodingTask(db);
  try {
    const { run } = createQaRun(db, { codingTaskId, repo, now: NOW });
    await executeQaRun(db, run, { repo, now: NOW });
    assert.equal(getCurrentCodingQA(db, codingTaskId).fresh, true);
    // 政策改變 → stale
    const staleByPolicy = getCurrentCodingQA(db, codingTaskId, { env: { QA_MAX_DIFF_LINES: "10" } });
    assert.equal(staleByPolicy.stale, true);
    assert.ok(staleByPolicy.stale_reasons.includes("qa_policy_changed"));
    // head 改變（coding task 不可變 → 以合成較舊 head 的 completed run 模擬 current 指向舊 head）→ stale，仍回報舊 PASS。
    const ts = NOW.toISOString();
    const oldId = Number(db.prepare(`INSERT INTO development_qa_run(issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, base_sha, head_sha, coding_result_hash, diff_hash, qa_version, qa_policy_fingerprint, input_fingerprint, status, final_result, attempt_count, max_attempts, next_attempt_at, created_at, completed_at) SELECT issue_id, id, development_authorization_id, proposal_id, proposal_version, proposal_hash, base_sha, 'oldhead', coding_result_hash, 'dhold', qa_version, qa_policy_fingerprint, 'inp-old', 'completed', 'PASS', 0, 3, ?, ?, ? FROM development_qa_run WHERE id=?`).run(ts, ts, ts, run.id).lastInsertRowid);
    db.prepare("UPDATE development_qa_current SET qa_run_id=?, head_sha='oldhead' WHERE coding_task_id=?").run(oldId, codingTaskId);
    const staleByHead = getCurrentCodingQA(db, codingTaskId);
    assert.equal(staleByHead.stale, true);
    assert.ok(staleByHead.stale_reasons.includes("head_sha_changed"));
    assert.equal(staleByHead.final_result, "PASS");
    // 取消 coding task → stale（不可變的 provenance 欄位未動，僅 status）。
    db.prepare("UPDATE development_qa_current SET qa_run_id=?, head_sha=? WHERE coding_task_id=?").run(run.id, run.head_sha, codingTaskId);
    db.prepare("UPDATE development_coding_task SET status='cancelled' WHERE id=?").run(codingTaskId);
    assert.ok(getCurrentCodingQA(db, codingTaskId).stale_reasons.includes("coding_task_cancelled"));
  } finally { git.cleanup(); db.close(); }
});

test("34+35. failed new QA run does not replace last successful canonical QA", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeReadyCodingTask(db);
  try {
    const { run: run1 } = createQaRun(db, { codingTaskId, repo, now: NOW });
    await executeQaRun(db, run1, { repo, now: NOW });
    assert.equal(db.prepare("SELECT qa_run_id FROM development_qa_current WHERE coding_task_id=?").get(codingTaskId).qa_run_id, run1.id);
    // 合成一個綁定「與 task 不同 head」的新 run → 執行時因 head_sha_changed 而 job 失敗，不更新 current（不動 coding task provenance）。
    const ts = NOW.toISOString();
    const badId = Number(db.prepare(`INSERT INTO development_qa_run(issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, base_sha, head_sha, coding_result_hash, diff_hash, qa_version, qa_policy_fingerprint, input_fingerprint, status, attempt_count, max_attempts, next_attempt_at, created_at) SELECT issue_id, id, development_authorization_id, proposal_id, proposal_version, proposal_hash, base_sha, 'deadbeef', coding_result_hash, 'dh2', 'qa-v1', qa_policy_fingerprint, 'inp2', 'pending', 0, 3, ?, ? FROM development_qa_run WHERE id=?`).run(ts, ts, run1.id).lastInsertRowid);
    const out = await executeQaRun(db, db.prepare("SELECT * FROM development_qa_run WHERE id=?").get(badId), { repo, now: NOW });
    assert.ok(out.failed || out.ineligible);
    assert.equal(db.prepare("SELECT qa_run_id FROM development_qa_current WHERE coding_task_id=?").get(codingTaskId).qa_run_id, run1.id);
    assert.equal(db.prepare("SELECT final_result FROM development_qa_run WHERE id=?").get(run1.id).final_result, "PASS");
    assert.ok(db.prepare("SELECT id FROM development_qa_run WHERE id=?").get(run1.id)); // 歷史保留
  } finally { git.cleanup(); db.close(); }
});

test("37. QA worker concurrency does not duplicate run; 38. stale claim recovery", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeReadyCodingTask(db);
  try {
    createQaRun(db, { codingTaskId, repo, now: NOW });
    const first = claimQaBatch(db, { now: NOW, limit: 5 });
    const second = claimQaBatch(db, { now: NOW, limit: 5 });
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    db.prepare("UPDATE development_qa_run SET claimed_at=? WHERE id=?").run(new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), first[0].id);
    const again = claimQaBatch(db, { now: NOW, staleMs: 5 * 60 * 1000, limit: 5 });
    assert.equal(again.length, 1);
  } finally { git.cleanup(); db.close(); }
});

test("47. audit is metadata-only (no PII/secrets)", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeReadyCodingTask(db);
  try {
    const { run } = createQaRun(db, { codingTaskId, repo, now: NOW });
    await executeQaRun(db, run, { repo, now: NOW });
    const rows = db.prepare("SELECT action, data FROM audit_log WHERE action LIKE 'issue.qa.%'").all();
    assert.ok(rows.some((r) => r.action === "issue.qa.started"));
    assert.ok(rows.some((r) => r.action === "issue.qa.completed"));
    assert.ok(rows.some((r) => r.action === "issue.qa.current_changed"));
    for (const r of rows) {
      assert.doesNotMatch(r.data || "", /leak@example\.com/);
      assert.doesNotMatch(r.data || "", /reporter-\d/);
      assert.doesNotMatch(r.data || "", /content \d/);
    }
  } finally { git.cleanup(); db.close(); }
});

// ================= 靜態：不 merge / 不部署 / PR 保持 draft / self-test≠QA =================
test("41-44. QA modules never merge, deploy, or un-draft the PR (static)", () => {
  for (const f of ["qaRun.js", "qaWorker.js", "qa/qaChecks.js", "qa/aggregate.js", "qa/reviewProvider.js", "qa/commandRunner.js", "qa/qaPolicy.js"]) {
    const txt = readFileSync(path.join(ROOT, "ops", "src", f), "utf8");
    assert.doesNotMatch(txt, /gh\s+pr\s+merge|--auto\b|ready_for_review|workflow_dispatch|deploy-v3|casaos|force-with-lease/i);
  }
});
