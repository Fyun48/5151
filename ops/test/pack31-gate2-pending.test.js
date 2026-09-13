import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import { describeGate2Offer, submitOwnerReleaseDecision } from "../src/releaseCandidate.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function seedApprovedIssue(db, productId, title = "Gate2 未決清單驗收") {
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

function insertWaitingReleaseCandidate(db, {
  issueId, authId, propId, fingerprint = "fp-gate2",
  codingStatus = "failed",
} = {}) {
  const ts = new Date().toISOString();
  const taskId = Number(db.prepare(`
    INSERT INTO development_coding_task(
      issue_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, task_fingerprint,
      base_branch, base_sha, head_sha, result_hash, status, attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, 1, 'hash-1', ?, 'master', 'deadbeef', 'cafebabe', 'rh-1', ?, 0, 3, ?, ?, 1)
  `).run(issueId, authId, propId, `fp-task-${fingerprint}`, codingStatus, ts, ts).lastInsertRowid);
  const qaId = Number(db.prepare(`
    INSERT INTO development_qa_run(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      base_sha, head_sha, qa_version, qa_policy_fingerprint, input_fingerprint, status, final_result,
      attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', 'deadbeef', 'cafebabe', 'qa-v1', 'pol', ?, 'completed', 'PASS', 0, 3, ?, ?, 1)
  `).run(issueId, taskId, authId, propId, `fp-qa-${fingerprint}`, ts, ts).lastInsertRowid);
  const depId = Number(db.prepare(`
    INSERT INTO development_staging_deployment(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      qa_run_id, base_sha, head_sha, staging_policy_version, staging_policy_fingerprint, input_fingerprint,
      status, validation_result, attempt_count, max_attempts, next_attempt_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', ?, 'deadbeef', 'cafebabe', 'stg-v1', 'spf', ?, 'ready', 'PASS', 0, 3, ?, ?, 1)
  `).run(issueId, taskId, authId, propId, qaId, `fp-stg-${fingerprint}`, ts, ts).lastInsertRowid);
  const rcId = Number(db.prepare(`
    INSERT INTO development_release_candidate(
      issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
      qa_run_id, staging_deployment_id, manifest_version, release_manifest_version, release_policy_version,
      base_sha, head_sha, artifact_digest, release_policy_fingerprint, release_input_fingerprint,
      manifest_hash, manifest_content, source_base_drift, status, generated_at, created_at, subscription_generation)
    VALUES (?, ?, ?, ?, 1, 'hash-1', ?, ?, 1, 'rm-v1', 'rp-v1', 'deadbeef', 'cafebabe', 'sha256:aa', 'rpf', ?, 'mh-gate2', '{}', 0, 'completed', ?, ?, 1)
  `).run(issueId, taskId, authId, propId, qaId, depId, `fp-rc-${fingerprint}`, ts, ts).lastInsertRowid);
  db.prepare(`
    INSERT INTO development_release_current(coding_task_id, release_manifest_id, manifest_version, manifest_hash, updated_at)
    VALUES (?, ?, 1, 'mh-gate2', ?)
  `).run(taskId, rcId, ts);
  return { taskId, qaId, depId, rcId };
}

test("pending list offers Gate #2 for a never-reviewed current release candidate", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const { rcId, taskId } = insertWaitingReleaseCandidate(db, { issueId, authId, propId });
  const offer = describeGate2Offer(db, taskId);
  assert.equal(offer.offered, true);
  assert.equal(offer.release_candidate_id, rcId);
  assert.equal(offer.manifest_hash, "mh-gate2");
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "release_candidate" && it.id === rcId);
  assert.ok(item);
  assert.equal(item.state, "waiting_approval");
  assert.equal(item.blocking, false);
  assert.equal(item.gate2.offered, true);
  assert.equal(item.gate2.coding_task_id, taskId);
  assert.match(item.note, /核准只寫授權/);
  assert.match(item.note, /要求修改必須寫原因/);
  assert.match(item.note, /Owner 直達不經這個門/);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "release_candidate").length, 0);
  db.close();
});

test("REQUEST_CHANGES requires a written reason and drops the candidate from the pending list", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const { rcId, taskId } = insertWaitingReleaseCandidate(db, { issueId, authId, propId, fingerprint: "fp-rc-reason" });
  assert.throws(
    () => submitOwnerReleaseDecision(db, {
      codingTaskId: taskId, action: "REQUEST_CHANGES",
      manifestId: rcId, manifestVersion: 1, manifestHash: "mh-gate2",
    }),
    (err) => err.status === 400 && /written reason/.test(err.message),
  );
  const out = submitOwnerReleaseDecision(db, {
    codingTaskId: taskId, action: "REQUEST_CHANGES",
    manifestId: rcId, manifestVersion: 1, manifestHash: "mh-gate2",
    reason: "請補上遷移說明",
  });
  assert.equal(out.changes_requested, true);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "release_candidate" && it.id === rcId).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_authorization").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_run").get().n, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.release.changes_requested'").get().n >= 1);
  db.close();
});

test("CANCEL_RELEASE leaves the pending list and does not deploy", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const { rcId, taskId } = insertWaitingReleaseCandidate(db, { issueId, authId, propId, fingerprint: "fp-rc-cancel" });
  const out = submitOwnerReleaseDecision(db, {
    codingTaskId: taskId, action: "CANCEL_RELEASE",
    manifestId: rcId, manifestVersion: 1, manifestHash: "mh-gate2",
    reason: "owner_console",
  });
  assert.equal(out.cancelled, true);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "release_candidate" && it.id === rcId).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_run").get().n, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.release.cancelled'").get().n >= 1);
  db.close();
});

test("stale manifest binding and owner_direct spoof cannot mint Gate #2 from the pending offer", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, authId, propId } = seedApprovedIssue(db, "shop");
  const { rcId, taskId } = insertWaitingReleaseCandidate(db, { issueId, authId, propId, fingerprint: "fp-rc-bind" });
  assert.throws(
    () => submitOwnerReleaseDecision(db, {
      codingTaskId: taskId, action: "APPROVE_RELEASE",
      manifestId: rcId, manifestVersion: 1, manifestHash: "old-hash",
      artifactDigest: "sha256:aa", headSha: "cafebabe",
    }),
    (err) => err.status === 409 && /manifest_hash mismatch/.test(err.message),
  );
  assert.throws(
    () => submitOwnerReleaseDecision(db, {
      codingTaskId: taskId, action: "APPROVE_RELEASE",
      manifestId: rcId, manifestVersion: 1, manifestHash: "mh-gate2",
      artifactDigest: "sha256:aa", headSha: "cafebabe",
      owner_direct: true,
    }),
    (err) => err.status === 403,
  );
  assert.equal(describeGate2Offer(db, taskId).offered, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_authorization").get().n, 0);
  db.close();
});

test("already-decided or cancelled coding tasks are not offered on the pending list", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const first = seedApprovedIssue(db, "shop", "已決策");
  const decided = insertWaitingReleaseCandidate(db, { ...first, fingerprint: "fp-decided" });
  submitOwnerReleaseDecision(db, {
    codingTaskId: decided.taskId, action: "CANCEL_RELEASE",
    manifestId: decided.rcId, manifestVersion: 1, manifestHash: "mh-gate2",
    reason: "done",
  });
  assert.equal(describeGate2Offer(db, decided.taskId).offered, false);

  const second = seedApprovedIssue(db, "shop", "已取消製作");
  const cancelled = insertWaitingReleaseCandidate(db, { ...second, fingerprint: "fp-cancelled", codingStatus: "cancelled" });
  assert.equal(describeGate2Offer(db, cancelled.taskId).offered, false);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "release_candidate").length, 0);
  db.close();
});

test("console exposes pending-list Gate #2 without opening a deploy path", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /待核准的發行候選可從未決清單核准、要求修改或取消/);
  assert.match(html, /核准只寫授權，不會部署正式機/);
  assert.match(html, /要求修改必須寫原因/);
  assert.match(html, /已授權 Owner 直達不經這個門/);
  assert.match(html, /console\.js\?v=20260913-pkg34/);
  assert.match(js, /PENDING_GATE2/);
  assert.match(js, /核准發布授權/);
  assert.match(js, /REQUEST_CHANGES requires a written reason|請說明要改什麼/);
  assert.match(js, /\/ops\/api\/coding-tasks\/\$\{btn\.dataset\.taskId\}\/release\/decision/);
  assert.doesNotMatch(js, /\/ops\/api\/production-releases\/\$\{id\}\/(execute|retry|reconcile)/);
  assert.doesNotMatch(js, /owner_direct:\s*true/);
});
