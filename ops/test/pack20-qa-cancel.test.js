import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import { cancelQaRun, claimQaBatch, executeQaRun } from "../src/qaRun.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function seedApprovedIssue(db, productId) {
  const ts = new Date().toISOString();
  const issueId = Number(db.prepare(`
    INSERT INTO issue_candidate(title, summary, category, clustering_version, status, product_id, created_at, updated_at)
    VALUES ('QA 取消驗收', 's', 'BUG', 'cluster-v1', 'open', ?, ?, ?)
  `).run(productId, ts, ts).lastInsertRowid);
  const propId = Number(db.prepare(`
    INSERT INTO issue_proposal(issue_id, proposal_version, generation_version, proposal_hash, status, retry_count, max_retries, next_attempt_at, created_at)
    VALUES (?, 1, 'proposal-v1', 'hash-1', 'completed', 0, 5, ?, ?)
  `).run(issueId, ts, ts).lastInsertRowid);
  const authId = Number(db.prepare(`
    INSERT INTO development_authorization(issue_id, proposal_id, proposal_version, proposal_hash, authorization_hash, approved_by, approved_at, status, created_at)
    VALUES (?, ?, 1, 'hash-1', 'auth-1', 'owner', ?, 'active', ?)
  `).run(issueId, propId, ts, ts).lastInsertRowid);
  return { issueId, propId, authId };
}

function insertReadyTask(db, { issueId, authId, propId, generation, fingerprint }) {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO development_coding_task(
      issue_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, task_fingerprint,
      base_branch, base_sha, head_sha, coding_branch, result_hash, status, attempt_count, max_attempts,
      next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, 1, 'hash-1', ?, 'master', 'deadbeef', 'cafebabe', 'ai-dev/qa-cancel', 'res-1', 'changes_ready', 0, 3, ?, ?, ?)
  `).run(issueId, authId, propId, fingerprint, ts, ts, generation).lastInsertRowid);
}

function insertQaRun(db, { issueId, taskId, authId, propId, generation, fingerprint, status = "pending" }) {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO development_qa_run(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      base_sha, head_sha, coding_result_hash, qa_version, qa_policy_fingerprint, input_fingerprint, status,
      attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', 'deadbeef', 'cafebabe', 'res-1', 'qa-v1', 'pol', ?, ?, 0, 3, ?, ?, ?)
  `).run(issueId, taskId, authId, propId, fingerprint, status, ts, ts, generation).lastInsertRowid);
}

function fakeRepo(onWorktree) {
  return {
    available: true,
    numstatRange() { return { files: [], insertions: 0, deletions: 0 }; },
    createDetachedWorktree() {
      onWorktree?.();
      return "/tmp/qa-cancel-wt";
    },
    readFileAt() { return null; },
    addedLines() { return []; },
    addedLinesScan() { return { lines: [], truncated: false, scan_complete: true, inferred_incomplete: false }; },
    cleanupWorktree() {},
  };
}

test("cancel pending QA and drop it from the pending list", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const taskId = insertReadyTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-task-1" });
  const qaId = insertQaRun(db, { issueId, taskId, authId, propId, generation: 1, fingerprint: "fp-qa-1" });
  const before = listPendingWork(db, "shop").items.find((it) => it.kind === "qa");
  assert.ok(before);
  assert.equal(before.id, qaId);
  assert.match(before.note, /不改寫/);
  const out = cancelQaRun(db, qaId, { actor: "owner", reason: "stop_test" });
  assert.equal(out.cancelled, true);
  assert.equal(out.in_flight_not_withdrawn, false);
  assert.equal(out.run.status, "cancelled");
  assert.equal(out.run.error_code, "owner_cancelled:stop_test");
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "qa").length, 0);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "qa").length, 0);
  assert.equal(claimQaBatch(db, { limit: 5 }).length, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.qa.cancelled'").get().n >= 1);
  db.close();
});

test("cancel is idempotent and does not rewrite a completed result", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const taskId = insertReadyTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-task-2" });
  const qaId = insertQaRun(db, { issueId, taskId, authId, propId, generation: 1, fingerprint: "fp-qa-2" });
  const first = cancelQaRun(db, qaId, { actor: "owner" });
  const second = cancelQaRun(db, qaId, { actor: "owner" });
  assert.equal(first.cancelled, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.run.status, "cancelled");

  const doneAt = new Date().toISOString();
  const doneId = Number(db.prepare(`
    INSERT INTO development_qa_run(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      base_sha, head_sha, coding_result_hash, qa_version, qa_policy_fingerprint, input_fingerprint, status,
      final_result, attempt_count, max_attempts, next_attempt_at, created_at, completed_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', 'deadbeef', 'cafebabe', 'res-1', 'qa-v1', 'pol', 'fp-qa-done', 'completed',
      'PASS', 1, 3, ?, ?, ?, 1)
  `).run(issueId, taskId, authId, propId, doneAt, doneAt, doneAt).lastInsertRowid);
  db.prepare(`
    INSERT INTO development_qa_current(coding_task_id, qa_run_id, head_sha, input_fingerprint, final_result, updated_at)
    VALUES (?, ?, 'cafebabe', 'fp-qa-done', 'PASS', ?)
  `).run(taskId, doneId, new Date().toISOString());
  assert.throws(() => cancelQaRun(db, doneId, { actor: "owner" }), (err) => err.status === 409 && /不改寫/.test(err.message));
  assert.equal(db.prepare("SELECT status, final_result FROM development_qa_run WHERE id=?").get(doneId).final_result, "PASS");
  assert.equal(db.prepare("SELECT qa_run_id FROM development_qa_current WHERE coding_task_id=?").get(taskId).qa_run_id, doneId);
  db.close();
});

test("late execute after cancel does not write current", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const taskId = insertReadyTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-task-3" });
  const qaId = insertQaRun(db, { issueId, taskId, authId, propId, generation: 1, fingerprint: "fp-qa-3" });
  cancelQaRun(db, qaId, { actor: "owner" });
  const out = await executeQaRun(db, { id: qaId }, { repo: fakeRepo() });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, "cancelled");
  assert.equal(db.prepare("SELECT status FROM development_qa_run WHERE id=?").get(qaId).status, "cancelled");
  assert.equal(db.prepare("SELECT qa_run_id FROM development_qa_current WHERE coding_task_id=?").get(taskId), undefined);
  db.close();
});

test("cancel during execute does not claim the worktree was withdrawn", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const taskId = insertReadyTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-task-4" });
  const qaId = insertQaRun(db, { issueId, taskId, authId, propId, generation: 1, fingerprint: "fp-qa-4", status: "claimed" });
  let cancelledMid = null;
  const repo = fakeRepo(() => {
    cancelledMid = cancelQaRun(db, qaId, { actor: "owner", reason: "mid_run" });
  });
  const out = await executeQaRun(db, { id: qaId }, { repo });
  assert.equal(cancelledMid.cancelled, true);
  assert.equal(cancelledMid.in_flight_not_withdrawn, true);
  assert.equal(out.skipped, true);
  assert.equal(out.reason, "cancelled");
  assert.equal(db.prepare("SELECT status FROM development_qa_run WHERE id=?").get(qaId).status, "cancelled");
  assert.equal(db.prepare("SELECT qa_run_id FROM development_qa_current WHERE coding_task_id=?").get(taskId), undefined);
  db.close();
});

test("console exposes Owner QA cancel with confirmation", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /取消獨立 QA/);
  assert.match(html, /已完成的結果不改寫/);
  assert.match(html, /console\.js\?v=20260912-pkg23/);
  assert.match(js, /\/ops\/api\/qa-runs\/\$\{devOpen\.qaRunId\}\/cancel/);
  assert.match(js, /已在跑的檢查不宣稱撤回/);
  assert.match(js, /待取消 qa run/);
});
