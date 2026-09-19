import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// 讓 env 推導的 evaluation / proposal / coding provider 皆為決定性 stub（node --test 每檔獨立 process）。
process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";

import { openOpsDb } from "../src/opsDb.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { runProposalOnce } from "../src/proposalWorker.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";
import { getCurrentIssueProposal, submitOwnerDecision } from "../src/proposal.js";
import { findEntity } from "../src/stateMachine.js";
import { makeGitRepo } from "../src/coding/gitRepo.js";
import { makeStubCodingProvider, makeCursorCodingProvider, makeLocalCommandCodingProvider, makeCodingProvider } from "../src/coding/provider.js";
import { makeStubPrGateway, makePrGateway, makeUnavailablePrGateway } from "../src/coding/prGateway.js";
import { classifyChangedPaths } from "../src/coding/pathPolicy.js";
import {
  createCodingTask, claimCodingTaskBatch, executeCodingTask, computeTaskFingerprint,
  validateAuthorizationForCoding, recheckBeforeStart, cancelCodingTask, getIssueCodingView,
  codingProviderPolicyFingerprint, buildApprovedSnapshot,
} from "../src/codingTask.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
let seq = 1;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── seed helpers（沿用 Phase 7/8 樣式：8 個 HIGH reporter → 高影響 → PROPOSE → proposal） ──
function seedProposeIssue(db, { members = 8 } = {}) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
  for (let k = 0; k < members; k++) {
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
async function seedProposalOnly(db) {
  const iid = seedProposeIssue(db);
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const current = getCurrentIssueProposal(db, iid, { now: NOW });
  return { iid, current };
}
async function approvedIssue(db) {
  const { iid, current } = await seedProposalOnly(db);
  const r = submitOwnerDecision(db, iid, { action: "APPROVE_DEVELOPMENT", proposalId: current.id, proposalVersion: current.proposal_version, proposalHash: current.proposal_hash, now: NOW });
  return { iid, auth: r.authorization, proposal: current };
}

// ── 真實 git repo（含 bare remote，可驗證推分支且 master 不被動） ──
function initGitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-dev-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "ai-dev-remote-"));
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
function setup() {
  const db = openOpsDb(":memory:");
  const g = initGitRepo();
  const repo = makeGitRepo(g.dir);
  return { db, repo, git: g, cleanup() { db.close(); g.cleanup(); } };
}
const passSelfTest = async () => ({ ran: true, passed: true, command: "node --test (stub)", output: "ok" });
const failSelfTest = async () => ({ ran: true, passed: false, command: "node --test (stub)", output: "1 failing" });
function remoteBranches(remote) { return execFileSync("git", ["-C", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"], { encoding: "utf8" }).split("\n").filter(Boolean); }

// ================= 1–5 授權即唯一授權來源 =================
test("1. no active development authorization ⇒ no Coding Task", async () => {
  const s = setup();
  try {
    const { iid } = await seedProposalOnly(s.db); // 尚未 approve → state=WAITING_OWNER_APPROVAL
    assert.throws(() => createCodingTask(s.db, { issueId: iid, provider: makeStubCodingProvider(), repo: s.repo, now: NOW }), /no active development authorization|does not permit/);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM development_coding_task").get().n, 0);
  } finally { s.cleanup(); }
});

test("2. exact active authorization can create Coding Task; 3. binds exact proposal id/version/hash", async () => {
  const s = setup();
  try {
    const { iid, auth } = await approvedIssue(s.db);
    const { task } = createCodingTask(s.db, { issueId: iid, provider: makeStubCodingProvider(), repo: s.repo, now: NOW });
    assert.ok(task.id > 0);
    assert.equal(task.proposal_id, auth.proposal_id);
    assert.equal(task.proposal_version, auth.proposal_version);
    assert.equal(task.proposal_hash, auth.proposal_hash);
    assert.equal(task.development_authorization_id, auth.id);
    assert.match(task.coding_branch, /^ai-dev\/\d+-issue-\d+$/);
  } finally { s.cleanup(); }
});

test("4. newer unapproved Proposal is NOT substituted (uses authorization's exact proposal)", async () => {
  const s = setup();
  try {
    const { iid, auth } = await approvedIssue(s.db);
    // 模擬之後出現較新（未核准）的 v2 且成為 current。
    const ts = NOW.toISOString();
    const v2 = Number(s.db.prepare("INSERT INTO issue_proposal(issue_id, proposal_version, generation_version, proposal_hash, title, proposed_change, status, next_attempt_at, created_at, generated_at) VALUES (?,?, 'gen', 'HASHV2', 'v2', 'v2 change', 'completed', ?, ?, ?)").run(iid, auth.proposal_version + 1, ts, ts, ts).lastInsertRowid);
    s.db.prepare("INSERT OR REPLACE INTO issue_proposal_current(issue_id, proposal_id, proposal_version, proposal_hash, input_fingerprint, updated_at) VALUES (?,?,?,?, 'fp', ?)").run(iid, v2, auth.proposal_version + 1, "HASHV2", ts);
    const { task } = createCodingTask(s.db, { issueId: iid, provider: makeStubCodingProvider(), repo: s.repo, now: NOW });
    assert.equal(task.proposal_id, auth.proposal_id);
    assert.equal(task.proposal_version, auth.proposal_version);
    assert.notEqual(task.proposal_hash, "HASHV2");
  } finally { s.cleanup(); }
});

test("5. superseded authorization cannot start coding", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    s.db.prepare("UPDATE development_authorization SET status='superseded' WHERE issue_id=?").run(iid);
    assert.throws(() => createCodingTask(s.db, { issueId: iid, provider: makeStubCodingProvider(), repo: s.repo, now: NOW }), /no active development authorization/);
  } finally { s.cleanup(); }
});

// ================= 6–7 fingerprint / idempotency =================
test("6. task fingerprint deterministic; 7. same authorization/base/policy is idempotent", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const args = { authorizationId: 1, authorizationHash: "ah", proposalId: 2, proposalVersion: 1, proposalHash: "ph", repository: "local", baseBranch: "master", baseSha: "abc", providerPolicyFingerprint: "pp" };
    assert.equal(computeTaskFingerprint(args), computeTaskFingerprint({ ...args }));
    assert.notEqual(computeTaskFingerprint(args), computeTaskFingerprint({ ...args, baseSha: "def" }));
    const a = createCodingTask(s.db, { issueId: iid, provider: makeStubCodingProvider(), repo: s.repo, now: NOW });
    const b = createCodingTask(s.db, { issueId: iid, provider: makeStubCodingProvider(), repo: s.repo, now: NOW });
    assert.equal(b.idempotent, true);
    assert.equal(a.task.id, b.task.id);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM development_coding_task").get().n, 1);
  } finally { s.cleanup(); }
});

// ================= 8–9 claiming / concurrency =================
test("8. duplicate workers cannot claim same task", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    createCodingTask(s.db, { issueId: iid, provider: makeStubCodingProvider(), repo: s.repo, now: NOW });
    const first = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    const second = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
  } finally { s.cleanup(); }
});

test("9. stale claim can recover safely", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const { task } = createCodingTask(s.db, { issueId: iid, provider: makeStubCodingProvider(), repo: s.repo, now: NOW });
    claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    // 讓 claim 變 stale。
    s.db.prepare("UPDATE development_coding_task SET claimed_at=? WHERE id=?").run(new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), task.id);
    const again = claimCodingTaskBatch(s.db, { now: NOW, staleMs: 5 * 60 * 1000, limit: 5 });
    assert.equal(again.length, 1);
    assert.equal(again[0].id, task.id);
  } finally { s.cleanup(); }
});

// ================= 10–11 recheck / TOCTOU =================
test("10+11. authorization rechecked before provider start; invalidation prevents coding", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const { task } = createCodingTask(s.db, { issueId: iid, provider: makeStubCodingProvider(), repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    // TOCTOU：claim 後、provider 執行前授權被 supersede。
    s.db.prepare("UPDATE development_authorization SET status='superseded' WHERE issue_id=?").run(iid);
    let ran = 0;
    const spy = { name: "stub", available: true, async run() { ran++; return { changed: true }; } };
    const pr = makeStubPrGateway();
    const out = await executeCodingTask(s.db, claimed, { provider: spy, repo: s.repo, pr, now: NOW });
    assert.equal(out.invalidated, true);
    assert.equal(ran, 0);
    assert.equal(pr.opened.length, 0);
    assert.equal(s.db.prepare("SELECT status FROM development_coding_task WHERE id=?").get(task.id).status, "cancelled");
    assert.ok(s.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.coding.authorization_invalidated'").get().n >= 1);
  } finally { s.cleanup(); }
});

// ================= 12–15 provider behavior / abstraction =================
test("12. provider unavailable does not create fake success", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const unavailable = makeCursorCodingProvider();
    const { task } = createCodingTask(s.db, { issueId: iid, provider: unavailable, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    const pr = makeStubPrGateway();
    const out = await executeCodingTask(s.db, claimed, { provider: unavailable, repo: s.repo, pr, now: NOW });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, "provider_unavailable");
    assert.equal(pr.opened.length, 0);
    const row = s.db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(task.id);
    assert.equal(row.status, "pending");
    assert.equal(row.pr_number, null);
  } finally { s.cleanup(); }
});

test("13. provider failure leaves safe task state (no PR, no fake success)", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider({ behavior: "error" });
    const { task } = createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    const pr = makeStubPrGateway();
    await executeCodingTask(s.db, claimed, { provider: prov, repo: s.repo, pr, now: NOW });
    const row = s.db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(task.id);
    assert.match(row.status, /failed/);
    assert.notEqual(row.status, "changes_ready");
    assert.equal(row.pr_number, null);
    assert.equal(pr.opened.length, 0);
  } finally { s.cleanup(); }
});

test("14. provider abstraction works with deterministic stub (full success → Draft PR)", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider();
    createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    const pr = makeStubPrGateway();
    const out = await executeCodingTask(s.db, claimed, { provider: prov, repo: s.repo, pr, selfTest: passSelfTest, now: NOW });
    assert.equal(out.changes_ready, true);
    assert.equal(out.task.status, "changes_ready");
    assert.ok(out.task.pr_number > 0);
    assert.ok(out.task.changed_files.length >= 1);
    // issue 生命週期進入 DEVELOPING（Phase 10 止於此，Phase 11 才 TESTING）。
    assert.equal(findEntity(s.db, `issue:${iid}`).state, "DEVELOPING");
  } finally { s.cleanup(); }
});

test("15. unsupported Cursor integration is reported unavailable rather than invented", () => {
  const cursor = makeCursorCodingProvider();
  assert.equal(cursor.available, false);
  assert.equal(cursor.name, "cursor");
  assert.ok(Array.isArray(cursor.setup.required) && cursor.setup.required.length > 0);
  assert.equal(makeLocalCommandCodingProvider({}).available, false);
  // 預設（未設 CODING_PROVIDER）→ 不可用（不會偷跑）。
  assert.equal(makeCodingProvider({}).available, false);
});

// ================= 16–18 approved snapshot only / no PII / no prod creds =================
test("16+17. provider receives approved snapshot only; no raw feedback/PII", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const captured = [];
    const spy = { name: "stub", available: true, async run(ctx) { captured.push(ctx); mkdirSync(path.join(ctx.workspace, "x"), { recursive: true }); writeFileSync(path.join(ctx.workspace, "x", "f.txt"), "hi\n"); return { changed: true, provider_task_id: "spy" }; } };
    createCodingTask(s.db, { issueId: iid, provider: spy, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    await executeCodingTask(s.db, claimed, { provider: spy, repo: s.repo, pr: makeStubPrGateway(), selfTest: passSelfTest, now: NOW });
    const ctx = captured[0];
    const snapJson = JSON.stringify(ctx.snapshot);
    assert.doesNotMatch(snapJson, /leak@example\.com/);
    assert.doesNotMatch(snapJson, /reporter-\d/);
    assert.doesNotMatch(snapJson, /content \d/);
    assert.ok(ctx.snapshot.proposal_hash && ctx.snapshot.acceptance_criteria);
  } finally { s.cleanup(); }
});

test("18. coding environment/context contains no production credentials", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const captured = [];
    const spy = { name: "stub", available: true, async run(ctx) { captured.push(ctx); writeFileSync(path.join(ctx.workspace, "f.txt"), "hi\n"); return { changed: true }; } };
    createCodingTask(s.db, { issueId: iid, provider: spy, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    await executeCodingTask(s.db, claimed, { provider: spy, repo: s.repo, pr: makeStubPrGateway(), now: NOW });
    // provider 只拿到 workspace/snapshot/timeoutMs，沒有任何 credential/secret 欄位。
    assert.deepEqual(Object.keys(captured[0]).sort(), ["snapshot", "timeoutMs", "workspace"]);
  } finally { s.cleanup(); }
});

// ================= 19–22 master protection / diff truth =================
test("19. coding provider cannot push directly to master (gateway guard)", () => {
  const s = setup();
  try {
    assert.throws(() => s.repo.pushBranch(s.git.dir, "master", "master"), /protected base branch/);
    assert.throws(() => s.repo.pushBranch(s.git.dir, "feature/x", "master"), /ai-dev\/ prefix/);
  } finally { s.cleanup(); }
});

test("20. coding branch derives from exact stored base SHA; 21. git diff captures actual changed files", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider();
    const { task: created } = createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    const baseSha = s.repo.resolveBaseSha("master");
    assert.equal(created.base_sha, baseSha);
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    const out = await executeCodingTask(s.db, claimed, { provider: prov, repo: s.repo, pr: makeStubPrGateway(), selfTest: passSelfTest, now: NOW });
    // head 的 parent 必須正是 base_sha。
    const parent = execFileSync("git", ["-C", s.git.dir, "log", "-1", "--format=%P", out.task.head_sha], { encoding: "utf8" }).trim();
    assert.equal(parent, baseSha);
    // git diff 抓到實際變更檔（stub 寫入 ai-dev-notes/*.md）。
    assert.ok(out.task.changed_files.some((f) => /^ai-dev-notes\//.test(f.path)));
    // 分支已推到 remote，且 master 未被動。
    assert.ok(remoteBranches(s.git.remote).includes(created.coding_branch));
    assert.ok(!remoteBranches(s.git.remote).includes("master"));
  } finally { s.cleanup(); }
});

test("22. provider prose cannot override authoritative git diff (empty diff ⇒ no_changes)", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider({ behavior: "lie" }); // 宣稱有改但不動檔案
    const { task } = createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    const pr = makeStubPrGateway();
    await executeCodingTask(s.db, claimed, { provider: prov, repo: s.repo, pr, now: NOW });
    const row = s.db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(task.id);
    assert.match(row.error_code, /no_changes/);
    assert.notEqual(row.status, "changes_ready");
    assert.equal(pr.opened.length, 0);
  } finally { s.cleanup(); }
});

// ================= 23–25 protected paths / change size =================
test("23+24. sensitive/deploy-safety path changes are detected/flagged", async () => {
  // 單元：classifyChangedPaths
  const c = classifyChangedPaths([".github/workflows/test.yml", "v3/src/db.js", "ops/src/auth.js"]);
  assert.ok(c.deploy_safety.includes(".github/workflows/test.yml"));
  assert.ok(c.sensitive.includes("ops/src/auth.js"));
  assert.equal(c.has_protected, true);
  // 端到端：provider 動到部署安全控制檔 → task 標記 protected_flags + warnings（不靜默放行）。
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider({ behavior: "protected" });
    createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    const out = await executeCodingTask(s.db, claimed, { provider: prov, repo: s.repo, pr: makeStubPrGateway(), selfTest: passSelfTest, now: NOW });
    assert.ok(out.task.protected_flags.deploy_safety.includes(".github/workflows/test.yml"));
    assert.ok(out.task.warnings.some((w) => w.type === "deploy_safety_paths"));
  } finally { s.cleanup(); }
});

test("25. change-size threshold warning works", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider({ behavior: "oversize", files: 60 });
    createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    const out = await executeCodingTask(s.db, claimed, { provider: prov, repo: s.repo, pr: makeStubPrGateway(), selfTest: passSelfTest, now: NOW });
    assert.ok(out.task.warnings.some((w) => w.type === "too_many_files"));
  } finally { s.cleanup(); }
});

// ================= 26 self-test metadata =================
test("26. self-test result metadata is recorded; failing self-test blocks PR", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider();
    createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    const pr = makeStubPrGateway();
    const out = await executeCodingTask(s.db, claimed, { provider: prov, repo: s.repo, pr, selfTest: failSelfTest, now: NOW });
    assert.match(out.error_code, /selftest_failed/);
    assert.equal(pr.opened.length, 0);
    const row = s.db.prepare("SELECT selftest_results FROM development_coding_task WHERE id=?").get(claimed.id);
    assert.match(row.selftest_results, /1 failing/);
  } finally { s.cleanup(); }
});

// ================= 27–33 Draft PR / anti-auto-merge / provenance =================
test("27+28+32+33. successful coding opens Draft PR base=master with provenance and no secrets", async () => {
  const s = setup();
  try {
    const { iid, auth } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider();
    createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    const pr = makeStubPrGateway();
    const out = await executeCodingTask(s.db, claimed, { provider: prov, repo: s.repo, pr, selfTest: passSelfTest, now: NOW });
    assert.equal(pr.opened.length, 1);
    const opened = pr.opened[0];
    assert.equal(opened.base, "master");
    assert.equal(opened.draft, true);
    assert.match(opened.branch, /^ai-dev\//);
    // provenance
    assert.match(opened.body, new RegExp(`Coding Task ID: ${out.task.id}`));
    assert.match(opened.body, new RegExp(`Development Authorization ID: ${auth.id}`));
    assert.match(opened.body, new RegExp(`Proposal hash: ${auth.proposal_hash}`));
    assert.match(opened.body, new RegExp(`Base branch/SHA:`));
    assert.match(opened.body, /Head SHA:/);
    assert.match(opened.body, /Self-test/);
    // no secrets/PII
    assert.doesNotMatch(opened.body, /leak@example\.com/);
    assert.doesNotMatch(opened.body, /reporter-\d/);
  } finally { s.cleanup(); }
});

test("29. coding PR cannot auto-merge under existing CI policy (draft + ai-dev/ excluded)", () => {
  const wfPath = path.join(ROOT, ".github", "workflows", "test.yml");
  assert.ok(existsSync(wfPath), "Tests workflow must exist");
  const wf = readFileSync(wfPath, "utf8");
  assert.match(wf, /ai-dev\//);
  assert.match(wf, /draft == false/);
  assert.match(wf, /npm test/);
  assert.doesNotMatch(wf, /gh workflow run deploy|DEPLOY-PRODUCTION|appleboy\/(scp|ssh)-action/i);
});

test("30. coding PR gateway cannot merge its own PR (no merge capability)", () => {
  const pr = makeStubPrGateway();
  assert.equal(typeof pr.openDraftPr, "function");
  assert.equal(pr.merge, undefined);
  assert.equal(pr.mergePr, undefined);
  assert.equal(pr.approve, undefined);
});

test("31. deployment workflows remain manual-only (opening PR does not deploy production)", () => {
  for (const f of ["deploy-v3.yml", "docker.yml", "deploy-v2.yml", "deploy.yml"]) {
    const p = path.join(ROOT, ".github", "workflows", f);
    let txt; try { txt = readFileSync(p, "utf8"); } catch { continue; }
    assert.match(txt, /workflow_dispatch/);
    assert.doesNotMatch(txt, /^on:\s*[\r\n]+\s*push:/m);
  }
});

// ================= 37–40 cancel / failure / retry / audit =================
test("37. cancelled task cannot subsequently start provider", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider();
    const { task } = createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    cancelCodingTask(s.db, task.id, { actor: "owner", now: NOW });
    let ran = 0;
    const spy = { name: "stub", available: true, async run() { ran++; return { changed: true }; } };
    const pr = makeStubPrGateway();
    const out = await executeCodingTask(s.db, task, { provider: spy, repo: s.repo, pr, now: NOW });
    assert.equal(out.skipped, true);
    assert.equal(ran, 0);
    assert.equal(pr.opened.length, 0);
  } finally { s.cleanup(); }
});

test("38. failed PR creation does not pretend task completed", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider();
    const { task } = createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    const pr = makeStubPrGateway({ fail: true });
    await executeCodingTask(s.db, claimed, { provider: prov, repo: s.repo, pr, selfTest: passSelfTest, now: NOW });
    const row = s.db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(task.id);
    assert.notEqual(row.status, "changes_ready");
    assert.match(row.error_code, /pr_creation_failed/);
    assert.equal(row.pr_number, null);
    assert.ok(row.head_sha); // 變更/自測歷史仍保留
  } finally { s.cleanup(); }
});

test("39. retry does not create uncontrolled duplicate PRs (stable task/branch identity)", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider();
    const { task } = createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    // 第一次：PR gateway 失敗 → failed_retry。
    const [c1] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    await executeCodingTask(s.db, c1, { provider: prov, repo: s.repo, pr: makeStubPrGateway({ fail: true }), selfTest: passSelfTest, now: NOW });
    const mid = s.db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(task.id);
    assert.equal(mid.status, "failed_retry");
    // 第二次（到期後）：同一 task/branch，PR gateway 正常 → 只有一個 PR。
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const [c2] = claimCodingTaskBatch(s.db, { now: later, limit: 5 });
    assert.equal(c2.id, task.id);
    const goodPr = makeStubPrGateway();
    const out = await executeCodingTask(s.db, c2, { provider: prov, repo: s.repo, pr: goodPr, selfTest: passSelfTest, now: later });
    assert.equal(out.task.status, "changes_ready");
    assert.equal(goodPr.opened.length, 1);
    assert.equal(out.task.coding_branch, mid.coding_branch);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM development_coding_task WHERE issue_id=?").get(iid).n, 1);
  } finally { s.cleanup(); }
});

test("40. audit contains metadata only (no PII/secrets)", async () => {
  const s = setup();
  try {
    const { iid } = await approvedIssue(s.db);
    const prov = makeStubCodingProvider();
    createCodingTask(s.db, { issueId: iid, provider: prov, repo: s.repo, now: NOW });
    const [claimed] = claimCodingTaskBatch(s.db, { now: NOW, limit: 5 });
    await executeCodingTask(s.db, claimed, { provider: prov, repo: s.repo, pr: makeStubPrGateway(), selfTest: passSelfTest, now: NOW });
    const rows = s.db.prepare("SELECT action, data FROM audit_log WHERE action LIKE 'issue.coding.%'").all();
    assert.ok(rows.some((r) => r.action === "issue.coding.task_created"));
    assert.ok(rows.some((r) => r.action === "issue.coding.started"));
    assert.ok(rows.some((r) => r.action === "issue.coding.pr_created"));
    assert.ok(rows.some((r) => r.action === "issue.coding.completed"));
    for (const r of rows) {
      assert.doesNotMatch(r.data || "", /leak@example\.com/);
      assert.doesNotMatch(r.data || "", /reporter-\d/);
      assert.doesNotMatch(r.data || "", /content \d/);
    }
  } finally { s.cleanup(); }
});

// ================= 額外：安全邊界靜態檢查 =================
test("coding modules do not trigger deploy or bypass master (static)", () => {
  for (const f of ["codingTask.js", "codingWorker.js", "coding/provider.js", "coding/gitRepo.js", "coding/prGateway.js"]) {
    const txt = readFileSync(path.join(ROOT, "ops", "src", f), "utf8");
    assert.doesNotMatch(txt, /workflow_dispatch|gh\s+pr\s+merge|--auto\b|force-with-lease|push\s+--force/i);
  }
});
