import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import { exportHandoff, listPendingWork, listUnknownProductionRuns } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function insertUnknownRun(db, { productId, issueId = 1 }) {
  const ts = new Date().toISOString();
  db.exec("PRAGMA foreign_keys = OFF");
  const runId = Number(db.prepare(`
    INSERT INTO production_release_run(
      issue_id, coding_task_id, release_authorization_id, release_authorization_hash,
      release_manifest_id, release_manifest_version, manifest_hash,
      migration_safety_assessment_id, migration_safety_policy_fingerprint, migration_safety_input_fingerprint,
      clearance_result, proposal_id, qa_run_id, staging_deployment_id, authorized_head_sha, artifact_digest,
      target_environment, workflow_file, workflow_ref, input_fingerprint, policy_fingerprint, run_version,
      authorized_github_actor, created_by, created_at, product_id)
    VALUES (?,?,1,'hash',1,1,'mh',1,'pf','if','CLEARED',1,1,1,'deadbeef','sha256:aa',
      'production','deploy-v3.yml','refs/heads/master',?,?,1,'actor','owner',?,?)
  `).run(issueId, issueId, `fp-unk-${productId}-${issueId}`, `pol-${productId}`, ts, productId).lastInsertRowid);
  db.prepare(`
    INSERT INTO production_release_run_event(release_run_id, to_status, event_type, created_at)
    VALUES (?, 'PRODUCTION_STATE_UNKNOWN', 'deploy_unknown', ?)
  `).run(runId, ts);
  return runId;
}

test("unknown production blocks handoff for that product only", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const runId = insertUnknownRun(db, { productId: "shop" });
  assert.equal(listUnknownProductionRuns(db, "shop").map((r) => r.id).join(","), String(runId));
  assert.equal(listUnknownProductionRuns(db, "other").length, 0);
  assert.throws(() => exportHandoff(db, "shop"), /正式部署狀態不明/);
  const other = exportHandoff(db, "other");
  assert.equal(other.manifest.product_id, "other");
  db.close();
});

test("pending list marks unknown production as blocking", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  insertUnknownRun(db, { productId: "shop" });
  const pending = listPendingWork(db, "shop");
  const item = pending.items.find((it) => it.kind === "production_release");
  assert.ok(item);
  assert.equal(item.state, "unknown");
  assert.equal(item.blocking, true);
  assert.equal(item.unscoped, false);
  assert.match(item.note, /先確認該環境實際結果/);
  db.close();
});

test("unscoped unknown production does not block another product handoff", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  insertUnknownRun(db, { productId: null, issueId: 99 });
  assert.equal(listUnknownProductionRuns(db, "shop").length, 0);
  const pack = exportHandoff(db, "shop");
  assert.equal(pack.manifest.product_id, "shop");
  db.close();
});

test("console explains unknown production blocks handoff", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /正式部署狀態不明時，先確認該環境實際結果，再完成移交/);
  assert.match(js, /正式部署狀態不明時會拒絕移交/);
  assert.match(html, /console\.js\?v=20260913-pkg27/);
});
