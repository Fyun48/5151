import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct, reconnectProduct, unsubscribeProduct } from "../src/products.js";
import { issueWriteDecision } from "../src/insightConsent.js";
import { claimStagingBatch, executeStagingDeployment } from "../src/stagingDeploy.js";
import { retryReleaseNotification } from "../src/releaseCandidate.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function seedApprovedIssue(db, productId) {
  const ts = new Date().toISOString();
  const issueId = Number(db.prepare(`
    INSERT INTO issue_candidate(title, summary, category, clustering_version, status, product_id, created_at, updated_at)
    VALUES ('發行世代驗收', 's', 'BUG', 'cluster-v1', 'open', ?, ?, ?)
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

function insertStaging(db, { issueId, authId, propId, generation, fingerprint }) {
  const ts = new Date().toISOString();
  const taskId = Number(db.prepare(`
    INSERT INTO development_coding_task(
      issue_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, task_fingerprint,
      base_branch, base_sha, status, attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, 1, 'hash-1', ?, 'master', 'deadbeef', 'changes_ready', 0, 3, ?, ?, ?)
  `).run(issueId, authId, propId, `fp-task-${fingerprint}`, ts, ts, generation).lastInsertRowid);
  const qaId = Number(db.prepare(`
    INSERT INTO development_qa_run(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      base_sha, head_sha, qa_version, qa_policy_fingerprint, input_fingerprint, status, attempt_count, max_attempts,
      next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', 'deadbeef', 'cafebabe', 'qa-v1', 'pol', ?, 'completed', 0, 3, ?, ?, ?)
  `).run(issueId, taskId, authId, propId, `fp-qa-${fingerprint}`, ts, ts, generation).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO development_staging_deployment(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      qa_run_id, base_sha, head_sha, staging_policy_version, staging_policy_fingerprint, input_fingerprint,
      status, attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', ?, 'deadbeef', 'cafebabe', 'stg-v1', 'spf', ?, 'pending', 0, 3, ?, ?, ?)
  `).run(issueId, taskId, authId, propId, qaId, fingerprint, ts, ts, generation).lastInsertRowid);
}

function insertNotification(db, { issueId, authId, propId, generation }) {
  const ts = new Date().toISOString();
  const depId = insertStaging(db, { issueId, authId, propId, generation, fingerprint: `fp-note-${issueId}` });
  const dep = db.prepare("SELECT * FROM development_staging_deployment WHERE id=?").get(depId);
  const rcId = Number(db.prepare(`
    INSERT INTO development_release_candidate(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      qa_run_id, staging_deployment_id, manifest_version, release_manifest_version, release_policy_version,
      base_sha, head_sha, artifact_digest, release_policy_fingerprint, release_input_fingerprint,
      manifest_hash, manifest_content, source_base_drift, status, generated_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', ?, ?, 1, 'rm-v1', 'rp-v1', 'deadbeef', 'cafebabe', 'sha256:aa', 'rpf', ?, 'mh', '{}', 0, 'completed', ?, ?, ?)
  `).run(issueId, dep.coding_task_id, authId, propId, dep.qa_run_id, depId, `fp-rc-${issueId}`, ts, ts, generation).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO release_notification(issue_id, coding_task_id, release_manifest_id, manifest_version, channel, status, payload, created_at, updated_at, subscription_generation)
    VALUES (?, ?, ?, 1, 'internal', 'pending', '{}', ?, ?, ?)
  `).run(issueId, dep.coding_task_id, rcId, ts, ts, generation).lastInsertRowid);
}

test("claim abandons staging after unsubscribe", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const depId = insertStaging(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-stg-1" });
  unsubscribeProduct(db, "shop");
  assert.equal(issueWriteDecision(db, issueId, { expectedGeneration: 1 }).ok, false);
  assert.equal(claimStagingBatch(db, { limit: 5 }).length, 0);
  assert.equal(db.prepare("SELECT error_code FROM development_staging_deployment WHERE id=?").get(depId).error_code, "subscription_revoked");
  db.close();
});

test("reconnect makes previous-generation staging execute fail without writing current", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const depId = insertStaging(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-stg-2" });
  unsubscribeProduct(db, "shop");
  reconnectProduct(db, "shop");
  const out = await executeStagingDeployment(db, { id: depId }, { repo: { available: false }, provider: { available: true, name: "stub" } });
  assert.equal(out.failed, true);
  assert.equal(out.error_code, "stale_generation");
  assert.equal(db.prepare("SELECT status FROM development_staging_deployment WHERE id=?").get(depId).status, "failed");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_staging_current").get().n, 0);
  db.close();
});

test("late release notification is not sent after unsubscribe", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const noteId = insertNotification(db, { issueId, authId, propId, generation: 1 });
  unsubscribeProduct(db, "shop");
  const sent = [];
  const out = await retryReleaseNotification(db, noteId, {
    sender: async (payload) => { sent.push(payload); return { ok: true }; },
  });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "subscription_revoked");
  assert.equal(sent.length, 0);
  assert.equal(db.prepare("SELECT status FROM release_notification WHERE id=?").get(noteId).status, "failed");
  db.close();
});

test("pending list scopes staging and release notes when product can be inferred", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  insertStaging(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-stg-3" });
  const pending = listPendingWork(db, "shop");
  const staging = pending.items.find((it) => it.kind === "staging");
  assert.ok(staging);
  assert.equal(staging.unscoped, false);
  assert.match(staging.note, /不會寫入 current/);
  db.close();
});

test("console explains late staging and release will not deploy", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  assert.match(html, /隔離 staging/);
  assert.match(html, /佈測試站/);
  assert.match(html, /console\.js\?v=2026091/);
});
