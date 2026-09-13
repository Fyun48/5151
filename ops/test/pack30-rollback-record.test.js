import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import {
  describeCodeRollbackOffer,
  seedProductionStable,
} from "../src/release/productionRelease.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));
const PREV_SHA = "b".repeat(40);
const CUR_SHA = "a".repeat(40);
const PREV_DIGEST = `sha256:${"22".repeat(32)}`;
const CUR_DIGEST = `sha256:${"11".repeat(32)}`;
const TREE = "c".repeat(64);
const PREV_TREE = "d".repeat(64);

function insertReleaseRun(db, {
  productId,
  issueId = 1,
  authId = 1,
  fingerprint = "fp-rec-1",
  status = "SUCCEEDED",
  prevSchema = "compatible",
  prevTree = PREV_TREE,
  provenance = { kind: "prior_release", compose_version: "compose-v3.57", config_version: "cfg-abc" },
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
    issueId, authId, authId, CUR_SHA, CUR_DIGEST, fingerprint, `pol-${fingerprint}`, ts, productId,
    PREV_SHA, PREV_DIGEST, "77030", JSON.stringify(provenance), prevTree, prevSchema,
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO production_release_run_event(release_run_id, to_status, event_type, created_at)
    VALUES (?, ?, 'seed', ?)
  `).run(runId, status, ts);
  return runId;
}

function pointCurrentStable(db, runId, productId = "shop", provenance = { kind: "succeeded_release", release_run_id: runId, compose_version: "compose-v3.57", config_version: "cfg-abc" }) {
  seedProductionStable(db, {
    productId,
    sourceSha: CUR_SHA,
    artifactDigest: CUR_DIGEST,
    workflowRunId: "88030",
    releaseRunId: runId,
    staticTreeHash: TREE,
    schemaCompat: "compatible",
    provenance,
  });
}

test("pending list exposes current and previous rollback identity without claiming bind-mount restore", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop" });
  pointCurrentStable(db, runId);
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "production_release" && it.id === runId);
  assert.ok(item);
  assert.equal(item.blocking, false);
  assert.equal(item.rollback.contract_complete, true);
  assert.equal(item.record.current.source_sha, CUR_SHA);
  assert.equal(item.record.current.artifact_digest, CUR_DIGEST);
  assert.equal(item.record.current.static_tree_hash, TREE);
  assert.equal(item.record.current.schema_compat, "compatible");
  assert.equal(item.record.previous.source_sha, PREV_SHA);
  assert.equal(item.record.previous.artifact_digest, PREV_DIGEST);
  assert.equal(item.record.previous.static_tree_hash, PREV_TREE);
  assert.equal(item.record.previous.schema_compat, "compatible");
  assert.equal(item.record.compose_version, "compose-v3.57");
  assert.equal(item.record.config_version, "cfg-abc");
  assert.equal(item.record.bind_mount_restore, false);
  assert.match(item.note, /程式退回上一版/);
  assert.match(item.note, /bind-mount 不會在這一步還原/);
  const offer = describeCodeRollbackOffer(db, runId);
  assert.equal(offer.record.bind_mount_restore, false);
  db.close();
});

test("incompatible previous schema stays listed but cannot claim an image swap will recover", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop", fingerprint: "fp-rec-bad", prevSchema: "incompatible" });
  pointCurrentStable(db, runId, "shop", { kind: "succeeded_release", release_run_id: runId });
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "production_release" && it.id === runId);
  assert.ok(item);
  assert.equal(item.rollback.contract_complete, false);
  assert.equal(item.record.schema_compatible, false);
  assert.equal(item.record.previous.schema_compat, "incompatible");
  assert.equal(item.record.bind_mount_restore, false);
  assert.match(item.note, /不能宣稱直接換映像可救回/);
  assert.equal(describeCodeRollbackOffer(db, runId).rollback.contract_complete, false);
  db.close();
});

test("missing compose or config versions are recorded as absent, not invented", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop", fingerprint: "fp-rec-empty", provenance: { kind: "prior_release" } });
  pointCurrentStable(db, runId, "shop", { kind: "succeeded_release", release_run_id: runId });
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "production_release" && it.id === runId);
  assert.equal(item.record.compose_version, null);
  assert.equal(item.record.config_version, null);
  assert.equal(item.record.bind_mount_restore, false);
  assert.equal(item.rollback.contract_complete, true);
  db.close();
});

test("console exposes rollback identity on the pending list", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /未決清單會列出目前版與上一可用版的 SHA、digest、靜態樹與 schema/);
  assert.match(html, /bind-mount 不會在這一步還原/);
  assert.match(html, /不能宣稱直接換映像可救回/);
  assert.match(html, /console\.js\?v=20260913-pkg32/);
  assert.match(js, /function rollbackRecordHtml/);
  assert.match(js, /上一可用版 SHA/);
  assert.match(js, /Compose／設定/);
  assert.match(js, /bind-mount 不會在這一步還原/);
  assert.doesNotMatch(js, /\/ops\/api\/production-releases\/\$\{id\}\/(execute|retry|reconcile)/);
});
