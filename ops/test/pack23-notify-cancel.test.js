import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import { cancelReleaseNotification, retryReleaseNotification } from "../src/releaseCandidate.js";
import { runReleaseOnce } from "../src/releaseWorker.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function seedApprovedIssue(db, productId) {
  const ts = new Date().toISOString();
  const issueId = Number(db.prepare(`
    INSERT INTO issue_candidate(title, summary, category, clustering_version, status, product_id, created_at, updated_at)
    VALUES ('通知取消驗收', 's', 'BUG', 'cluster-v1', 'open', ?, ?, ?)
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

function insertNotification(db, { issueId, authId, propId, generation, fingerprint = "fp-note" }) {
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
  const depId = Number(db.prepare(`
    INSERT INTO development_staging_deployment(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      qa_run_id, base_sha, head_sha, staging_policy_version, staging_policy_fingerprint, input_fingerprint,
      status, attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', ?, 'deadbeef', 'cafebabe', 'stg-v1', 'spf', ?, 'pending', 0, 3, ?, ?, ?)
  `).run(issueId, taskId, authId, propId, qaId, fingerprint, ts, ts, generation).lastInsertRowid);
  const rcId = Number(db.prepare(`
    INSERT INTO development_release_candidate(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      qa_run_id, staging_deployment_id, manifest_version, release_manifest_version, release_policy_version,
      base_sha, head_sha, artifact_digest, release_policy_fingerprint, release_input_fingerprint,
      manifest_hash, manifest_content, source_base_drift, status, generated_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', ?, ?, 1, 'rm-v1', 'rp-v1', 'deadbeef', 'cafebabe', 'sha256:aa', 'rpf', ?, 'mh', '{}', 0, 'completed', ?, ?, ?)
  `).run(issueId, taskId, authId, propId, qaId, depId, `fp-rc-${fingerprint}`, ts, ts, generation).lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO release_notification(issue_id, coding_task_id, release_manifest_id, manifest_version, channel, status, payload, created_at, updated_at, subscription_generation)
    VALUES (?, ?, ?, 1, 'internal', 'pending', '{}', ?, ?, ?)
  `).run(issueId, taskId, rcId, ts, ts, generation).lastInsertRowid);
}

test("cancel pending release notification and drop it from the pending list", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const noteId = insertNotification(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-cancel" });
  const before = listPendingWork(db, "shop").items.find((it) => it.kind === "release_notification");
  assert.ok(before);
  assert.equal(before.id, noteId);
  assert.match(before.note, /可取消/);
  const out = cancelReleaseNotification(db, noteId, { actor: "owner", reason: "stop_notify" });
  assert.equal(out.cancelled, true);
  assert.equal(out.in_flight_not_withdrawn, false);
  assert.equal(out.notification.status, "cancelled");
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "release_notification").length, 0);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "release_notification").length, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.release.notification_cancelled'").get().n >= 1);
  const again = cancelReleaseNotification(db, noteId, { actor: "owner" });
  assert.equal(again.idempotent, true);
  assert.equal(again.notification.status, "cancelled");
  db.close();
});

test("sent and failed notifications cannot be rewritten by cancel", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const sentId = insertNotification(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-sent" });
  db.prepare("UPDATE release_notification SET status='sent' WHERE id=?").run(sentId);
  assert.throws(() => cancelReleaseNotification(db, sentId, { actor: "owner" }), (err) => err.status === 409 && /不宣稱撤回/.test(err.message));
  assert.equal(db.prepare("SELECT status FROM release_notification WHERE id=?").get(sentId).status, "sent");

  const { issueId: issue2, authId: auth2, propId: prop2 } = seedApprovedIssue(db, "shop");
  const failedId = insertNotification(db, { issueId: issue2, authId: auth2, propId: prop2, generation: 1, fingerprint: "fp-failed" });
  db.prepare("UPDATE release_notification SET status='failed' WHERE id=?").run(failedId);
  assert.throws(() => cancelReleaseNotification(db, failedId, { actor: "owner" }), (err) => err.status === 409 && /不能取消/.test(err.message));
  assert.equal(db.prepare("SELECT status FROM release_notification WHERE id=?").get(failedId).status, "failed");
  db.close();
});

test("retry after cancel does not deliver or write sent", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const noteId = insertNotification(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-late" });
  cancelReleaseNotification(db, noteId, { actor: "owner" });
  let called = 0;
  const out = await retryReleaseNotification(db, noteId, {
    sender: async () => {
      called += 1;
      return { ok: true };
    },
  });
  assert.equal(called, 0);
  assert.equal(out.status, "cancelled");
  assert.equal(out.skipped, true);
  assert.equal(db.prepare("SELECT status FROM release_notification WHERE id=?").get(noteId).status, "cancelled");
  db.close();
});

test("late send after cancel does not write sent", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const noteId = insertNotification(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-mid" });
  let called = 0;
  const out = await retryReleaseNotification(db, noteId, {
    sender: async () => {
      called += 1;
      cancelReleaseNotification(db, noteId, { actor: "owner", reason: "mid_send" });
      return { ok: true };
    },
  });
  assert.equal(called, 1);
  assert.equal(out.status, "cancelled");
  assert.equal(out.skipped, true);
  assert.equal(out.in_flight_not_withdrawn, true);
  assert.equal(db.prepare("SELECT status FROM release_notification WHERE id=?").get(noteId).status, "cancelled");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.release.notification_sent'").get().n, 0);
  db.close();
});

test("release worker does not reclaim a cancelled notification", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const noteId = insertNotification(db, { issueId, authId, propId, generation: 1, fingerprint: "fp-worker" });
  cancelReleaseNotification(db, noteId, { actor: "owner" });
  const tick = await runReleaseOnce(db, { repo: { available: false } });
  assert.equal(tick.notified, 0);
  assert.equal(db.prepare("SELECT status FROM release_notification WHERE id=?").get(noteId).status, "cancelled");
  db.close();
});

test("console exposes pending-list cancel for unsent release notifications", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /未送出的發布通知也可取消/);
  assert.match(html, /未送出的遠端客服也可取消/);
  assert.match(html, /未送出的分析、評估、提案也可取消/);
  assert.match(html, /console\.js\?v=20260912-pkg23/);
  assert.match(js, /\/ops\/api\/release-notifications\/\$\{id\}\/cancel/);
  assert.match(js, /取消未送出的發布通知/);
  assert.match(js, /已送出的 webhook 不宣稱撤回/);
});
