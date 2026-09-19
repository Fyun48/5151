import "./secretAtRestKey.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import { cancelCodingTask } from "../src/codingTask.js";
import { cancelQaRun } from "../src/qaRun.js";
import { cancelStagingDeployment } from "../src/stagingDeploy.js";
import { confirmCancelResult, describeCancelResultOffer } from "../src/cancelResult.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function seedApprovedIssue(db, productId, title = "取消結果驗收") {
  const ts = new Date().toISOString();
  const issueId = Number(db.prepare(`
    INSERT INTO issue_candidate(title, summary, category, clustering_version, status, product_id, created_at, updated_at)
    VALUES (?, 's', 'BUG', 'cluster-v1', 'open', ?, ?, ?)
  `).run(title, productId, ts, ts).lastInsertRowid);
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

function insertCodingTask(db, {
  issueId, authId, propId, fingerprint, status = "pending",
  headSha = null, codingBranch = null, prNumber = null, prUrl = null, providerTaskId = null,
} = {}) {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO development_coding_task(
      issue_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, task_fingerprint,
      base_branch, base_sha, head_sha, status, attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation,
      coding_branch, pr_number, pr_url, provider_task_id)
    VALUES (?, ?, ?, 1, 'hash-1', ?, 'master', 'deadbeef', ?, ?, 0, 3, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    issueId, authId, propId, fingerprint, headSha, status, ts, ts,
    codingBranch, prNumber, prUrl, providerTaskId,
  ).lastInsertRowid);
}

function insertQaRun(db, { issueId, taskId, authId, propId, fingerprint, status = "pending", claimedAt = null, startedAt = null } = {}) {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO development_qa_run(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      base_sha, head_sha, qa_version, qa_policy_fingerprint, input_fingerprint, status, final_result,
      attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation, claimed_at, started_at)
    VALUES (?, ?, ?, ?, 1, 'hash-1', 'deadbeef', 'cafebabe', 'qa-v1', 'pol', ?, ?, NULL, 0, 3, ?, ?, 1, ?, ?)
  `).run(issueId, taskId, authId, propId, fingerprint, status, ts, ts, claimedAt, startedAt).lastInsertRowid);
}

function insertStaging(db, {
  issueId, taskId, authId, propId, qaId, fingerprint, status = "pending",
  environmentId = null, stagingUrl = null, artifactId = null, startedAt = null,
} = {}) {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO development_staging_deployment(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      qa_run_id, base_sha, head_sha, staging_policy_version, staging_policy_fingerprint, input_fingerprint,
      status, validation_result, attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation,
      staging_environment_id, staging_url, artifact_id, started_at)
    VALUES (?, ?, ?, ?, 1, 'hash-1', ?, 'deadbeef', 'cafebabe', 'stg-v1', 'spf', ?, ?, NULL, 0, 3, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    issueId, taskId, authId, propId, qaId, fingerprint, status, ts, ts,
    environmentId, stagingUrl, artifactId, startedAt,
  ).lastInsertRowid);
}

function makeProviderSpy() {
  return {
    closePrCount: 0,
    deleteBranchCount: 0,
    cleanupCount: 0,
    cancelProviderCount: 0,
    closePullRequest() { this.closePrCount += 1; },
    deleteBranch() { this.deleteBranchCount += 1; },
    cleanup() { this.cleanupCount += 1; },
    cancelProviderTask() { this.cancelProviderCount += 1; },
  };
}

test("cancelled coding with leftover PR stays on the pending list as a non-blocking door", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const codingId = insertCodingTask(db, {
    issueId, authId, propId, fingerprint: "fp-code-pr",
    status: "changes_ready", headSha: "cafebabe",
    codingBranch: "ai-dev/12", prNumber: 88, prUrl: "https://github.com/Fyun48/5151/pull/88",
    providerTaskId: "prov-1",
  });
  cancelCodingTask(db, codingId, { actor: "owner", reason: "stop_after_pr" });
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "coding" && it.id === codingId);
  assert.ok(item);
  assert.equal(item.state, "cancelled");
  assert.equal(item.blocking, false);
  assert.equal(item.leftover.offered, true);
  assert.equal(item.leftover.confirmed, false);
  assert.equal(item.leftover.auto_cleanup, false);
  assert.ok(item.leftover.leftovers.some((row) => row.kind === "pull_request" && row.pr_number === 88));
  assert.match(item.note, /剩餘工作/);
  assert.match(item.note, /不自動關閉 PR/);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "coding").length, 0);
  assert.equal(describeCancelResultOffer(db, "coding", codingId).offered, true);
  db.close();
});

test("confirming leftover result writes observation and never cleans provider work", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop", "確認剩餘工作");
  const codingId = insertCodingTask(db, {
    issueId, authId, propId, fingerprint: "fp-code-confirm",
    status: "changes_ready", headSha: "cafebabe",
    codingBranch: "ai-dev/13", prNumber: 89, prUrl: "https://example.test/89",
  });
  cancelCodingTask(db, codingId, { actor: "owner" });
  const provider = makeProviderSpy();
  const out = confirmCancelResult(db, "coding", codingId, { actor: "owner", provider });
  assert.equal(out.confirmed, true);
  assert.equal(out.auto_cleanup, false);
  assert.equal(out.cleanup_not_performed, true);
  assert.equal(provider.closePrCount, 0);
  assert.equal(provider.deleteBranchCount, 0);
  assert.equal(provider.cleanupCount, 0);
  assert.equal(db.prepare("SELECT status FROM development_coding_task WHERE id=?").get(codingId).status, "cancelled");
  assert.ok(db.prepare("SELECT COUNT(*) n FROM development_work_result_evidence WHERE work_kind='coding' AND work_id=? AND evidence_kind='cancel_result_confirmed'").get(codingId).n >= 1);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.coding.cancel_result_confirmed'").get().n >= 1);
  const replay = confirmCancelResult(db, "coding", codingId, { actor: "owner", provider });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.auto_cleanup, false);
  assert.equal(provider.closePrCount, 0);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "coding" && it.id === codingId).length, 0);
  db.close();
});

test("cancelled QA and staging leftovers stay listed until confirmed", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop", "QA／staging 剩餘");
  const taskId = insertCodingTask(db, {
    issueId, authId, propId, fingerprint: "fp-leftover-task",
    status: "changes_ready", headSha: "cafebabe",
  });
  const qaId = insertQaRun(db, {
    issueId, taskId, authId, propId, fingerprint: "fp-leftover-qa",
    status: "running", claimedAt: new Date().toISOString(), startedAt: new Date().toISOString(),
  });
  const stgId = insertStaging(db, {
    issueId, taskId, authId, propId, qaId, fingerprint: "fp-leftover-stg",
    status: "deploying", environmentId: "stg-shop-1", stagingUrl: "https://stg.example.test",
    artifactId: "art-1", startedAt: new Date().toISOString(),
  });
  cancelQaRun(db, qaId, { actor: "owner" });
  cancelStagingDeployment(db, stgId, { actor: "owner" });
  const qaItem = listPendingWork(db, "shop").items.find((it) => it.kind === "qa" && it.id === qaId);
  const stgItem = listPendingWork(db, "shop").items.find((it) => it.kind === "staging" && it.id === stgId);
  assert.ok(qaItem);
  assert.ok(stgItem);
  assert.equal(qaItem.leftover.offered, true);
  assert.ok(qaItem.leftover.leftovers.some((row) => row.kind === "worktree"));
  assert.ok(stgItem.leftover.leftovers.some((row) => row.kind === "staging_environment"));
  const provider = makeProviderSpy();
  const qaOut = confirmCancelResult(db, "qa", qaId, { actor: "owner", provider });
  const stgOut = confirmCancelResult(db, "staging", stgId, { actor: "owner", provider });
  assert.equal(qaOut.cleanup_not_performed, true);
  assert.equal(stgOut.cleanup_not_performed, true);
  assert.equal(provider.cleanupCount, 0);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "qa" || it.kind === "staging").length, 0);
  db.close();
});

test("pending cancel without leftovers stays off the list; wrong doors stay 409", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop", "沒有剩餘");
  const emptyId = insertCodingTask(db, { issueId, authId, propId, fingerprint: "fp-empty" });
  const liveId = insertCodingTask(db, {
    issueId, authId, propId, fingerprint: "fp-live",
    status: "changes_ready", headSha: "cafebabe", codingBranch: "ai-dev/14", prNumber: 90,
  });
  cancelCodingTask(db, emptyId, { actor: "owner" });
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "coding" && it.id === emptyId).length, 0);
  assert.equal(describeCancelResultOffer(db, "coding", emptyId).offered, false);
  assert.throws(
    () => confirmCancelResult(db, "coding", emptyId, { actor: "owner" }),
    (err) => err.status === 409 && /沒有剩餘/.test(err.message),
  );
  assert.throws(
    () => confirmCancelResult(db, "coding", liveId, { actor: "owner" }),
    (err) => err.status === 409 && /取消門/.test(err.message),
  );
  assert.throws(
    () => confirmCancelResult(db, "coding", 99999, { actor: "owner" }),
    (err) => err.status === 404,
  );
  db.close();
});

test("console exposes leftover cancel-result as a distinct pending-list door", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /已取消的製作、QA、隔離 staging 若仍留下 branch、PR、測試站或供應商工作/);
  assert.match(html, /不自動關閉 PR、不刪分支、不拆測試容器/);
  assert.match(html, /console\.js\?v=20260915-pkg37/);
  assert.match(js, /\/ops\/api\/coding-tasks\/\$\{id\}\/confirm-cancel-result/);
  assert.match(js, /\/ops\/api\/qa-runs\/\$\{id\}\/confirm-cancel-result/);
  assert.match(js, /\/ops\/api\/staging-deployments\/\$\{id\}\/confirm-cancel-result/);
  assert.match(js, /確認取消後的剩餘工作/);
  assert.match(js, /沒有自動清理 branch／PR／測試站/);
  assert.match(js, /action === "cancelresult"/);
  assert.doesNotMatch(js, /closePullRequest|deleteBranch/);
});
