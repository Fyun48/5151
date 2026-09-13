import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import { cancelProductionReleaseRun, executeProductionRelease } from "../src/release/productionRelease.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function insertReleaseRun(db, { productId, issueId = 1, authId = 1, fingerprint = "fp-prod-1", status = "CREATED" }) {
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
    VALUES (?,?,?,'hash',1,1,'mh',1,'pf','if','CLEARED',1,1,1,'deadbeef','sha256:aa',
      'production','deploy-v3.yml','refs/heads/master',?,?,1,'actor','owner',?,?)
  `).run(issueId, authId, authId, fingerprint, `pol-${fingerprint}`, ts, productId).lastInsertRowid);
  db.prepare(`
    INSERT INTO production_release_run_event(release_run_id, to_status, event_type, created_at)
    VALUES (?, ?, 'seed', ?)
  `).run(runId, status, ts);
  return runId;
}

test("cancel unsent production release and drop it from the pending list", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const runId = insertReleaseRun(db, { productId: "shop" });
  const pending = listPendingWork(db, "shop").items;
  const item = pending.find((it) => it.kind === "production_release" && it.id === runId);
  assert.ok(item);
  assert.equal(item.state, "CREATED");
  assert.match(item.note, /可取消/);

  const out = cancelProductionReleaseRun(db, runId, { actor: "owner", reason: "stop_prod" });
  assert.equal(out.cancelled, true);
  assert.equal(out.in_flight_not_withdrawn, false);
  assert.equal(out.run.current_status, "BLOCKED");

  const after = listPendingWork(db, "shop").items;
  assert.equal(after.filter((it) => it.kind === "production_release" && it.id === runId).length, 0);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "production_release").length, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.production_release.cancelled'").get().n >= 1);
  const ev = db.prepare("SELECT to_status, event_type FROM production_release_run_event WHERE release_run_id=? ORDER BY id DESC LIMIT 1").get(runId);
  assert.equal(ev.to_status, "BLOCKED");
  assert.equal(ev.event_type, "owner_cancelled");

  const again = cancelProductionReleaseRun(db, runId, { actor: "owner" });
  assert.equal(again.idempotent, true);
  db.close();
});

test("succeeded, unknown, and dispatched runs cannot be rewritten by cancel", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const okId = insertReleaseRun(db, { productId: "shop", authId: 11, fingerprint: "fp-ok", status: "SUCCEEDED" });
  const unkId = insertReleaseRun(db, { productId: "shop", authId: 12, fingerprint: "fp-unk", status: "PRODUCTION_STATE_UNKNOWN" });
  const sentId = insertReleaseRun(db, { productId: "shop", authId: 13, fingerprint: "fp-sent", status: "BUILD_DISPATCHED" });
  db.prepare(`
    INSERT INTO production_release_workflow_binding(release_run_id, workflow_kind, idempotency_key, binding_status, dispatch_submitted_at, workflow_run_id, created_at)
    VALUES (?, 'build', 'idem-sent', 'dispatched', ?, '99', ?)
  `).run(sentId, new Date().toISOString(), new Date().toISOString());

  assert.throws(() => cancelProductionReleaseRun(db, okId, { actor: "owner" }), (err) => err.status === 409 && /不改寫/.test(err.message));
  assert.throws(() => cancelProductionReleaseRun(db, unkId, { actor: "owner" }), (err) => err.status === 409 && /不宣稱撤回/.test(err.message));
  assert.throws(() => cancelProductionReleaseRun(db, sentId, { actor: "owner" }), (err) => err.status === 409 && /不宣稱撤回/.test(err.message));
  assert.equal(db.prepare("SELECT to_status FROM production_release_run_event WHERE release_run_id=? ORDER BY id DESC LIMIT 1").get(okId).to_status, "SUCCEEDED");
  db.close();
});

test("late execute after cancel does not dispatch a workflow", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop", fingerprint: "fp-late" });
  cancelProductionReleaseRun(db, runId, { actor: "owner" });
  let dispatched = 0;
  const out = await executeProductionRelease(db, runId, {
    provider: {
      available: true,
      async dispatchWorkflow() { dispatched += 1; return { accepted: true, workflow_run_id: "1" }; },
      async inspectImage() { return { digest: "sha256:aa" }; },
    },
    repo: { available: true, isRemoteAncestor() { return true; }, resolveRemoteRef() { return "deadbeef"; } },
  });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, "cancelled");
  assert.equal(out.current_status, "BLOCKED");
  assert.equal(dispatched, 0);
  assert.equal(db.prepare("SELECT to_status FROM production_release_run_event WHERE release_run_id=? ORDER BY id DESC LIMIT 1").get(runId).to_status, "BLOCKED");
  db.close();
});

test("cancel during eligibility does not claim the workflow was withdrawn", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop", fingerprint: "fp-mid", status: "ELIGIBILITY_VERIFIED" });
  const mid = cancelProductionReleaseRun(db, runId, { actor: "owner", reason: "mid_exec" });
  assert.equal(mid.cancelled, true);
  assert.equal(mid.in_flight_not_withdrawn, true);
  assert.equal(mid.run.current_status, "BLOCKED");
  db.close();
});

test("console exposes pending-list cancel for unsent production releases", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /未送出的正式發布也可從未決清單取消/);
  assert.match(html, /未送出的製作、QA、隔離 staging 也可從未決清單取消/);
  assert.match(html, /未送出的發布通知也可取消/);
  assert.match(html, /console\.js\?v=20260913-pkg28/);
  assert.match(js, /\/ops\/api\/production-releases\/\$\{id\}\/cancel/);
  assert.match(js, /取消未送出的正式發布/);
  assert.match(js, /已受理的部署不宣稱撤回|未送出的發布不會再開/);
});
