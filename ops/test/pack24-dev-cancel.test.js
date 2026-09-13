import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import { cancelCodingTask, claimCodingTaskBatch } from "../src/codingTask.js";
import { cancelQaRun, claimQaBatch } from "../src/qaRun.js";
import { cancelStagingDeployment, claimStagingBatch, executeStagingDeployment } from "../src/stagingDeploy.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function seedApprovedIssue(db, productId, title = "製作取消驗收") {
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

function insertCodingTask(db, { issueId, authId, propId, generation, fingerprint, status = "pending", headSha = null, resultHash = null }) {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO development_coding_task(
      issue_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, task_fingerprint,
      base_branch, base_sha, head_sha, result_hash, status, attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, 1, 'hash-1', ?, 'master', 'deadbeef', ?, ?, ?, 0, 3, ?, ?, ?)
  `).run(issueId, authId, propId, fingerprint, headSha, resultHash, status, ts, ts, generation).lastInsertRowid);
}

function insertQaRun(db, { issueId, taskId, authId, propId, generation, fingerprint, status = "pending", finalResult = null }) {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO development_qa_run(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      base_sha, head_sha, qa_version, qa_policy_fingerprint, input_fingerprint, status, final_result,
      attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', 'deadbeef', 'cafebabe', 'qa-v1', 'pol', ?, ?, ?, 0, 3, ?, ?, ?)
  `).run(issueId, taskId, authId, propId, fingerprint, status, finalResult, ts, ts, generation).lastInsertRowid);
}

function insertStaging(db, { issueId, taskId, authId, propId, qaId, generation, fingerprint, status = "pending", validationResult = null }) {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO development_staging_deployment(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      qa_run_id, base_sha, head_sha, staging_policy_version, staging_policy_fingerprint, input_fingerprint,
      status, validation_result, attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', ?, 'deadbeef', 'cafebabe', 'stg-v1', 'spf', ?, ?, ?, 0, 3, ?, ?, ?)
  `).run(issueId, taskId, authId, propId, qaId, fingerprint, status, validationResult, ts, ts, generation).lastInsertRowid);
}

test("cancel pending coding, QA, and staging and drop them from the pending list", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const codingId = insertCodingTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-code-1" });
  const qaTaskId = insertCodingTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-code-qa", status: "changes_ready", headSha: "cafebabe" });
  const qaId = insertQaRun(db, { issueId, taskId: qaTaskId, authId, propId, generation: 1, fingerprint: "fp-qa-1" });
  const stgId = insertStaging(db, { issueId, taskId: qaTaskId, authId, propId, qaId, generation: 1, fingerprint: "fp-stg-1" });

  const pending = listPendingWork(db, "shop").items;
  assert.ok(pending.find((it) => it.kind === "coding" && it.id === codingId));
  assert.ok(pending.find((it) => it.kind === "qa" && it.id === qaId));
  assert.ok(pending.find((it) => it.kind === "staging" && it.id === stgId));
  assert.match(pending.find((it) => it.kind === "coding").note, /可取消/);
  assert.match(pending.find((it) => it.kind === "qa").note, /可取消/);
  assert.match(pending.find((it) => it.kind === "staging").note, /可取消/);

  const codingOut = cancelCodingTask(db, codingId, { actor: "owner", reason: "stop_code" });
  const qaOut = cancelQaRun(db, qaId, { actor: "owner", reason: "stop_qa" });
  const stgOut = cancelStagingDeployment(db, stgId, { actor: "owner", reason: "stop_stg" });
  assert.equal(codingOut.cancelled, true);
  assert.equal(codingOut.in_flight_not_withdrawn, false);
  assert.equal(codingOut.task.status, "cancelled");
  assert.equal(qaOut.cancelled, true);
  assert.equal(stgOut.cancelled, true);
  assert.equal(stgOut.in_flight_not_withdrawn, false);
  assert.equal(stgOut.deployment.status, "cancelled");

  const after = listPendingWork(db, "shop").items;
  assert.equal(after.filter((it) => it.kind === "coding" && it.id === codingId).length, 0);
  assert.equal(after.filter((it) => it.kind === "qa").length, 0);
  assert.equal(after.filter((it) => it.kind === "staging").length, 0);
  assert.equal(listPendingWork(db, "other").items.filter((it) => ["coding", "qa", "staging"].includes(it.kind)).length, 0);
  assert.equal(claimCodingTaskBatch(db, { limit: 5 }).length, 0);
  assert.equal(claimQaBatch(db, { limit: 5 }).length, 0);
  assert.equal(claimStagingBatch(db, { limit: 5 }).length, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.coding.cancelled'").get().n >= 1);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.staging.cancelled'").get().n >= 1);

  const again = cancelStagingDeployment(db, stgId, { actor: "owner" });
  assert.equal(again.idempotent, true);
  db.close();
});

test("ready staging cannot be rewritten by cancel", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop", "已完成 staging");
  const taskId = insertCodingTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-ready-task", status: "changes_ready", headSha: "cafebabe" });
  const qaId = insertQaRun(db, { issueId, taskId, authId, propId, generation: 1, fingerprint: "fp-ready-qa", status: "completed", finalResult: "PASS" });
  const stgId = insertStaging(db, { issueId, taskId, authId, propId, qaId, generation: 1, fingerprint: "fp-ready-stg", status: "ready", validationResult: "PASS" });
  db.prepare(`
    INSERT INTO development_staging_current(coding_task_id, staging_deployment_id, head_sha, input_fingerprint, validation_result, updated_at)
    VALUES (?, ?, 'cafebabe', 'fp-ready-stg', 'PASS', ?)
  `).run(taskId, stgId, new Date().toISOString());
  assert.throws(() => cancelStagingDeployment(db, stgId, { actor: "owner" }), (err) => err.status === 409 && /不改寫/.test(err.message));
  assert.equal(db.prepare("SELECT status FROM development_staging_deployment WHERE id=?").get(stgId).status, "ready");
  assert.equal(db.prepare("SELECT staging_deployment_id FROM development_staging_current WHERE coding_task_id=?").get(taskId).staging_deployment_id, stgId);
  db.close();
});

test("late staging execute after cancel does not write current", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop", "晚到 staging");
  const taskId = insertCodingTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-late-task", status: "changes_ready", headSha: "cafebabe" });
  const qaId = insertQaRun(db, { issueId, taskId, authId, propId, generation: 1, fingerprint: "fp-late-qa", status: "completed", finalResult: "PASS" });
  const stgId = insertStaging(db, { issueId, taskId, authId, propId, qaId, generation: 1, fingerprint: "fp-late-stg" });
  cancelStagingDeployment(db, stgId, { actor: "owner" });
  const out = await executeStagingDeployment(db, { id: stgId }, {
    repo: { available: false },
    provider: { available: true, name: "stub" },
  });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, "cancelled");
  assert.equal(db.prepare("SELECT status FROM development_staging_deployment WHERE id=?").get(stgId).status, "cancelled");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_staging_current").get().n, 0);
  db.close();
});

test("cancel during staging does not claim the deploy was withdrawn", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop", "中途 staging");
  const taskId = insertCodingTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-mid-task", status: "changes_ready", headSha: "cafebabe", resultHash: "res-1" });
  const qaId = insertQaRun(db, { issueId, taskId, authId, propId, generation: 1, fingerprint: "fp-mid-qa", status: "completed", finalResult: "PASS" });
  const stgId = insertStaging(db, { issueId, taskId, authId, propId, qaId, generation: 1, fingerprint: "fp-mid-stg", status: "building" });
  const out = cancelStagingDeployment(db, stgId, { actor: "owner", reason: "mid_build" });
  assert.equal(out.cancelled, true);
  assert.equal(out.in_flight_not_withdrawn, true);
  const late = await executeStagingDeployment(db, { id: stgId }, {
    repo: {
      available: true,
      createDetachedWorktree() { return "/tmp/stg-cancel"; },
      treeHash() { return "tree"; },
      cleanupWorktree() {},
    },
    provider: {
      available: true,
      name: "stub",
      async build() { return { artifact_id: "a", artifact_digest: "sha256:aa", source_head_sha: "cafebabe" }; },
      async deploy() { return { deployed: true, environment_id: "stg", environment_class: "staging" }; },
      async health() { return { ok: true }; },
      async smoke() { return { ok: true }; },
    },
  });
  assert.equal(late.skipped, true);
  assert.equal(late.reason, "cancelled");
  assert.equal(db.prepare("SELECT status FROM development_staging_deployment WHERE id=?").get(stgId).status, "cancelled");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_staging_current").get().n, 0);
  db.close();
});

test("console exposes pending-list cancel for coding, QA, and staging", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /未送出的製作、QA、隔離 staging 也可從未決清單取消/);
  assert.match(html, /未送出的發布通知也可取消/);
  assert.match(html, /未送出的遠端客服也可取消/);
  assert.match(html, /未送出的分析、評估、提案也可取消/);
  assert.match(html, /console\.js\?v=20260913-pkg25/);
  assert.match(js, /\/ops\/api\/coding-tasks\/\$\{id\}\/cancel/);
  assert.match(js, /\/ops\/api\/qa-runs\/\$\{id\}\/cancel/);
  assert.match(js, /\/ops\/api\/staging-deployments\/\$\{id\}\/cancel/);
  assert.match(js, /取消未送出的製作/);
  assert.match(js, /取消未送出的 QA/);
  assert.match(js, /取消未送出的隔離 staging/);
  assert.match(js, /已完成的結果不會被這一步改寫/);
  assert.match(js, /async function loadPending\(id, statusText\)/);
  assert.match(js, /await loadPending\(pid, resultText\)/);
});
