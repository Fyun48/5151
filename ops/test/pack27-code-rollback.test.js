import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import {
  describeCodeRollbackOffer,
  requestCodeRollback,
  seedProductionStable,
} from "../src/release/productionRelease.js";
import { makeStubProductionReleaseProvider } from "../src/release/productionReleaseProvider.js";
import { listPendingWork } from "../src/exitDrill.js";

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
  fingerprint = "fp-rb-1",
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
    workflowRunId: "88027",
    releaseRunId: runId,
    staticTreeHash: TREE,
    schemaCompat: "compatible",
    provenance: { kind: "succeeded_release", release_run_id: runId },
  });
}

test("succeeded current-stable release appears as a non-blocking known result", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const runId = insertReleaseRun(db, { productId: "shop" });
  pointCurrentStable(db, runId);
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "production_release" && it.id === runId);
  assert.ok(item);
  assert.equal(item.state, "SUCCEEDED");
  assert.equal(item.blocking, false);
  assert.equal(item.rollback.contract_complete, true);
  assert.equal(item.rollback.previous_stable_sha, PREV_SHA);
  assert.equal(item.rollback.previous_stable_digest, PREV_DIGEST);
  assert.equal(item.rollback.previous_stable_workflow_run_id, "77001");
  assert.match(item.note, /程式退回上一版/);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "production_release").length, 0);
  const offer = describeCodeRollbackOffer(db, runId);
  assert.equal(offer.offered, true);
  db.close();
});

test("accepted current-stable rollback uses the existing execute path and never restores the database", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop", fingerprint: "fp-rb-ok" });
  pointCurrentStable(db, runId);
  const provider = makeStubProductionReleaseProvider();
  await assert.rejects(
    () => requestCodeRollback(db, {
      releaseRunId: runId,
      previousStableSha: PREV_SHA,
      previousStableDigest: PREV_DIGEST,
      previousStableWorkflowRunId: "77001",
      actor: "owner",
      provider,
    }),
    (err) => err.status === 409
      && /Phase 15 eligibility failed|previous stable|rollback/.test(err.message)
      && !/取消 runner|取消未送出|狀態不明|database restore/.test(err.message),
  );
  assert.equal(provider.restoreCallCount, 0);
  assert.equal(db.prepare("SELECT to_status FROM production_release_run_event WHERE release_run_id=? ORDER BY id DESC LIMIT 1").get(runId).to_status, "SUCCEEDED");
  db.close();
});

test("wrong door, wrong identity, and DB restore confirmation are 409", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const provider = makeStubProductionReleaseProvider();
  const okId = insertReleaseRun(db, { productId: "shop", fingerprint: "fp-ok" });
  pointCurrentStable(db, okId);
  const inflight = insertReleaseRun(db, { productId: "shop", authId: 2, fingerprint: "fp-fly", status: "BUILD_DISPATCHED" });
  const unsent = insertReleaseRun(db, { productId: "shop", authId: 3, fingerprint: "fp-unsent", status: "CREATED" });
  const unknown = insertReleaseRun(db, { productId: "shop", authId: 4, fingerprint: "fp-unk", status: "PRODUCTION_STATE_UNKNOWN" });

  await assert.rejects(
    () => requestCodeRollback(db, {
      releaseRunId: inflight, previousStableSha: PREV_SHA, previousStableDigest: PREV_DIGEST,
      previousStableWorkflowRunId: "77001", actor: "owner", provider,
    }),
    (err) => err.status === 409 && /取消 runner/.test(err.message),
  );
  await assert.rejects(
    () => requestCodeRollback(db, {
      releaseRunId: unsent, previousStableSha: PREV_SHA, previousStableDigest: PREV_DIGEST,
      previousStableWorkflowRunId: "77001", actor: "owner", provider,
    }),
    (err) => err.status === 409 && /取消未送出/.test(err.message),
  );
  await assert.rejects(
    () => requestCodeRollback(db, {
      releaseRunId: unknown, previousStableSha: PREV_SHA, previousStableDigest: PREV_DIGEST,
      previousStableWorkflowRunId: "77001", actor: "owner", provider,
    }),
    (err) => err.status === 409 && /狀態不明/.test(err.message),
  );
  await assert.rejects(
    () => requestCodeRollback(db, {
      releaseRunId: okId, previousStableSha: PREV_SHA, previousStableDigest: PREV_DIGEST,
      previousStableWorkflowRunId: "77001", actor: "owner", provider,
      confirmDbRestore: "RESTORE-PRODUCTION-DB",
    }),
    (err) => err.status === 409 && /database restore is a separate confirmation/.test(err.message),
  );
  await assert.rejects(
    () => requestCodeRollback(db, {
      releaseRunId: okId, previousStableSha: "d".repeat(40), previousStableDigest: PREV_DIGEST,
      previousStableWorkflowRunId: "77001", actor: "owner", provider,
    }),
    (err) => err.status === 409 && /previous stable identity mismatch/.test(err.message),
  );
  assert.equal(describeCodeRollbackOffer(db, inflight).offered, false);
  db.close();
});

test("console exposes pending-list code rollback as a distinct door", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /已成功且為目前正式版的發布可程式退回上一版/);
  assert.match(html, /這不是取消 runner，也不是 DB 還原/);
  assert.match(html, /console\.js\?v=20260913-pkg27/);
  assert.match(js, /\/ops\/api\/production-releases\/\$\{id\}\/rollback/);
  assert.match(js, /程式退回上一版/);
  assert.match(js, /RESTORE-PRODUCTION-DB/);
  assert.match(js, /previous_stable_sha/);
  assert.doesNotMatch(js, /\/ops\/api\/production-releases\/\$\{id\}\/(execute|retry|reconcile)/);
});
