import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import {
  describeDbRestoreOffer,
  requestCodeRollback,
  requestProductionDbRestore,
  seedProductionStable,
} from "../src/release/productionRelease.js";
import { makeStubProductionReleaseProvider } from "../src/release/productionReleaseProvider.js";
import { listPendingWork } from "../src/exitDrill.js";
import { DB_RESTORE_CONFIRMATION } from "../src/release/rollbackContract.js";

const root = dirname(fileURLToPath(import.meta.url));
const PREV_SHA = "b".repeat(40);
const CUR_SHA = "a".repeat(40);
const PREV_DIGEST = `sha256:${"22".repeat(32)}`;
const CUR_DIGEST = `sha256:${"11".repeat(32)}`;
const TREE = "c".repeat(64);

function insertReleaseRun(db, {
  productId,
  issueId = 1,
  authId = 1,
  fingerprint = "fp-db-1",
  status = "SUCCEEDED",
  authorizedSha = CUR_SHA,
  artifactDigest = CUR_DIGEST,
} = {}) {
  const ts = new Date().toISOString();
  db.exec("PRAGMA foreign_keys = OFF");
  const runId = Number(db.prepare(`
    INSERT INTO production_release_run(
      issue_id, coding_task_id, release_authorization_id, release_authorization_hash,
      release_manifest_id, release_manifest_version, manifest_hash,
      migration_safety_assessment_id, migration_safety_policy_fingerprint, migration_safety_input_fingerprint,
      clearance_result, proposal_id, qa_run_id, staging_deployment_id, authorized_head_sha, artifact_digest,
      target_environment, workflow_file, workflow_ref, input_fingerprint, policy_fingerprint, run_version,
      authorized_github_actor, created_by, created_at, product_id,
      previous_stable_sha, previous_stable_digest, previous_stable_workflow_run_id,
      previous_stable_provenance, previous_stable_static_tree_hash, previous_stable_schema_compat)
    VALUES (?,?,?,'hash',1,1,'mh',1,'pf','if','CLEARED',1,1,1,?,?,'production','deploy-v3.yml','refs/heads/master',?,?,1,'actor','owner',?, ?,?,?,?,?,?,?)
  `).run(
    issueId, authId, authId, authorizedSha, artifactDigest, fingerprint, `pol-${fingerprint}`, ts, productId,
    PREV_SHA, PREV_DIGEST, "77001", JSON.stringify({ kind: "prior_release" }), TREE, "compatible",
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO production_release_run_event(release_run_id, to_status, event_type, created_at)
    VALUES (?, ?, 'seed', ?)
  `).run(runId, status, ts);
  return runId;
}

function pointCurrentStable(db, runId, productId = "shop") {
  seedProductionStable(db, {
    productId,
    sourceSha: CUR_SHA,
    artifactDigest: CUR_DIGEST,
    workflowRunId: "88028",
    releaseRunId: runId,
    staticTreeHash: TREE,
    schemaCompat: "compatible",
    provenance: { kind: "succeeded_release", release_run_id: runId },
  });
}

test("succeeded current-stable release offers a non-blocking DB restore door", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const runId = insertReleaseRun(db, { productId: "shop" });
  pointCurrentStable(db, runId);
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "production_release" && it.id === runId);
  assert.ok(item);
  assert.equal(item.blocking, false);
  assert.equal(item.db_restore.offered, true);
  assert.equal(item.db_restore.auto_restore, false);
  assert.equal(item.db_restore.confirmation, DB_RESTORE_CONFIRMATION);
  assert.match(item.note, /DB 還原要求/);
  assert.match(item.note, /自動還原不會執行/);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "production_release").length, 0);
  assert.equal(describeDbRestoreOffer(db, runId).offered, true);
  db.close();
});

test("exact confirmation records observation and never restores the database", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop", fingerprint: "fp-db-ok" });
  pointCurrentStable(db, runId);
  const provider = makeStubProductionReleaseProvider();
  const out = requestProductionDbRestore(db, runId, {
    actor: "owner",
    confirmDbRestore: DB_RESTORE_CONFIRMATION,
    provider,
  });
  assert.equal(out.db_restore, false);
  assert.equal(out.auto_restore, false);
  assert.equal(out.manual_required, true);
  assert.equal(out.restore_not_performed, true);
  assert.equal(out.run.current_status, "SUCCEEDED");
  assert.equal(provider.restoreCallCount, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM production_release_evidence WHERE release_run_id=? AND evidence_kind='db_restore_request'").get(runId).n >= 1);
  const replay = requestProductionDbRestore(db, runId, {
    actor: "owner",
    confirmDbRestore: DB_RESTORE_CONFIRMATION,
    provider,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.db_restore, false);
  assert.equal(provider.restoreCallCount, 0);
  assert.equal(db.prepare("SELECT to_status FROM production_release_run_event WHERE release_run_id=? ORDER BY id DESC LIMIT 1").get(runId).to_status, "SUCCEEDED");
  db.close();
});

test("wrong door, missing confirmation, and rollback-with-restore stay 409", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const provider = makeStubProductionReleaseProvider();
  const okId = insertReleaseRun(db, { productId: "shop", fingerprint: "fp-ok" });
  pointCurrentStable(db, okId);
  const inflight = insertReleaseRun(db, { productId: "shop", authId: 2, fingerprint: "fp-fly", status: "BUILD_DISPATCHED" });
  const unsent = insertReleaseRun(db, { productId: "shop", authId: 3, fingerprint: "fp-unsent", status: "CREATED" });
  const unknown = insertReleaseRun(db, { productId: "shop", authId: 4, fingerprint: "fp-unk", status: "PRODUCTION_STATE_UNKNOWN" });

  assert.throws(
    () => requestProductionDbRestore(db, okId, { actor: "owner", confirmDbRestore: "yes", provider }),
    (err) => err.status === 409 && /RESTORE-PRODUCTION-DB/.test(err.message),
  );
  assert.throws(
    () => requestProductionDbRestore(db, okId, { actor: "owner", provider }),
    (err) => err.status === 409 && /RESTORE-PRODUCTION-DB/.test(err.message),
  );
  assert.throws(
    () => requestProductionDbRestore(db, inflight, { actor: "owner", confirmDbRestore: DB_RESTORE_CONFIRMATION, provider }),
    (err) => err.status === 409 && /取消 runner/.test(err.message),
  );
  assert.throws(
    () => requestProductionDbRestore(db, unsent, { actor: "owner", confirmDbRestore: DB_RESTORE_CONFIRMATION, provider }),
    (err) => err.status === 409 && /取消未送出/.test(err.message),
  );
  assert.throws(
    () => requestProductionDbRestore(db, unknown, { actor: "owner", confirmDbRestore: DB_RESTORE_CONFIRMATION, provider }),
    (err) => err.status === 409 && /狀態不明/.test(err.message),
  );
  await assert.rejects(
    () => requestCodeRollback(db, {
      releaseRunId: okId, previousStableSha: PREV_SHA, previousStableDigest: PREV_DIGEST,
      previousStableWorkflowRunId: "77001", actor: "owner", provider,
      confirmDbRestore: DB_RESTORE_CONFIRMATION,
    }),
    (err) => err.status === 409 && /database restore is a separate confirmation/.test(err.message),
  );
  assert.equal(describeDbRestoreOffer(db, inflight).offered, false);
  assert.equal(provider.restoreCallCount, 0);
  db.close();
});

test("console exposes pending-list DB restore as a distinct exact-confirm door", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /可另送 DB 還原要求/);
  assert.match(html, /必須輸入確認字 RESTORE-PRODUCTION-DB/);
  assert.match(html, /console\.js\?v=20260913-pkg28/);
  assert.match(js, /\/ops\/api\/production-releases\/\$\{id\}\/restore-db/);
  assert.match(js, /記錄 DB 還原要求/);
  assert.match(js, /reasonExact: "RESTORE-PRODUCTION-DB"/);
  assert.match(js, /confirm_db_restore: note/);
  assert.match(js, /confirmReasonWrap"\)\.hidden = !confirmNeedsReason/);
  assert.doesNotMatch(js, /\/ops\/api\/production-releases\/\$\{id\}\/(execute|retry|reconcile)/);
});
