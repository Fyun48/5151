import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct, reconnectProduct, unsubscribeProduct } from "../src/products.js";
import { issueWriteDecision } from "../src/insightConsent.js";
import { createCodingTask, claimCodingTaskBatch, recheckBeforeStart } from "../src/codingTask.js";
import { claimQaBatch } from "../src/qaRun.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function seedApprovedIssue(db, productId) {
  const ts = new Date().toISOString();
  const issueId = Number(db.prepare(`
    INSERT INTO issue_candidate(title, summary, category, clustering_version, status, product_id, created_at, updated_at)
    VALUES ('製作世代驗收', 's', 'BUG', 'cluster-v1', 'open', ?, ?, ?)
  `).run(productId, ts, ts).lastInsertRowid);
  const propId = Number(db.prepare(`
    INSERT INTO issue_proposal(issue_id, proposal_version, generation_version, proposal_hash, status, retry_count, max_retries, next_attempt_at, created_at)
    VALUES (?, 1, 'proposal-v1', 'hash-1', 'completed', 0, 5, ?, ?)
  `).run(issueId, ts, ts).lastInsertRowid);
  const authId = Number(db.prepare(`
    INSERT INTO development_authorization(issue_id, proposal_id, proposal_version, proposal_hash, authorization_hash, approved_by, approved_at, status, created_at)
    VALUES (?, ?, 1, 'hash-1', 'auth-1', 'owner', ?, 'active', ?)
  `).run(issueId, propId, ts, ts).lastInsertRowid);
  db.prepare(`
    INSERT INTO state_entity(id, entity_type, state, version, created_at, updated_at)
    VALUES (?, 'issue', 'APPROVED_FOR_DEVELOPMENT', 1, ?, ?)
  `).run(`issue:${issueId}`, ts, ts);
  return { issueId, propId, authId };
}

function insertCodingTask(db, { issueId, authId, propId, generation, fingerprint }) {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO development_coding_task(
      issue_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, task_fingerprint,
      base_branch, base_sha, status, attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, 1, 'hash-1', ?, 'master', 'deadbeef', 'pending', 0, 3, ?, ?, ?)
  `).run(issueId, authId, propId, fingerprint, ts, ts, generation).lastInsertRowid);
}

function insertQaRun(db, { issueId, taskId, authId, propId, generation, fingerprint }) {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO development_qa_run(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      base_sha, head_sha, qa_version, qa_policy_fingerprint, input_fingerprint, status, attempt_count, max_attempts,
      next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', 'deadbeef', 'cafebabe', 'qa-v1', 'pol', ?, 'pending', 0, 3, ?, ?, ?)
  `).run(issueId, taskId, authId, propId, fingerprint, ts, ts, generation).lastInsertRowid);
}

test("createCodingTask stamps the current subscription generation", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId } = seedApprovedIssue(db, "shop");
  const repo = { available: true, resolveBaseSha: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const out = createCodingTask(db, { issueId, authorizationId: authId, provider: { name: "stub" }, repo });
  assert.equal(out.task.issue_id, issueId);
  const row = db.prepare("SELECT subscription_generation FROM development_coding_task WHERE id=?").get(out.task.id);
  assert.equal(row.subscription_generation, 1);
  db.close();
});

test("claim abandons coding and QA after unsubscribe", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const taskId = insertCodingTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-code-1" });
  const qaId = insertQaRun(db, { issueId, taskId, authId, propId, generation: 1, fingerprint: "fp-qa-1" });
  unsubscribeProduct(db, "shop");
  assert.equal(issueWriteDecision(db, issueId, { expectedGeneration: 1 }).ok, false);
  assert.equal(claimCodingTaskBatch(db, { limit: 5 }).length, 0);
  assert.equal(claimQaBatch(db, { limit: 5 }).length, 0);
  assert.equal(db.prepare("SELECT error_code FROM development_coding_task WHERE id=?").get(taskId).error_code, "subscription_revoked");
  assert.equal(db.prepare("SELECT error_code FROM development_qa_run WHERE id=?").get(qaId).error_code, "subscription_revoked");
  db.close();
});

test("reconnect makes previous-generation coding recheck fail without writing", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const taskId = insertCodingTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-code-2" });
  const claimed = claimCodingTaskBatch(db, { limit: 1 });
  assert.equal(claimed.length, 1);
  unsubscribeProduct(db, "shop");
  reconnectProduct(db, "shop");
  const rc = recheckBeforeStart(db, claimed[0]);
  assert.equal(rc.ok, false);
  assert.equal(rc.reason, "stale_generation");
  assert.notEqual(db.prepare("SELECT status FROM development_coding_task WHERE id=?").get(taskId).status, "changes_ready");
  db.close();
});

test("pending list scopes coding/QA notes when product can be inferred", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  insertCodingTask(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-code-3" });
  const pending = listPendingWork(db, "shop");
  const coding = pending.items.find((it) => it.kind === "coding");
  assert.ok(coding);
  assert.equal(coding.unscoped, false);
  assert.match(coding.note, /不會開 PR/);
  db.close();
});

test("console explains late coding and QA will not open a PR", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  assert.match(html, /製作／QA/);
  assert.match(html, /開 PR/);
  assert.match(html, /console\.js\?v=20260911-pkg1/);
});
