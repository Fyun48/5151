import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import {
  cancelProductionReleaseRunner,
  executeProductionRelease,
  observeProductionReleaseProgress,
} from "../src/release/productionRelease.js";
import { makeStubProductionReleaseProvider } from "../src/release/productionReleaseProvider.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function insertReleaseRun(db, { productId, issueId = 1, authId = 1, fingerprint = "fp-obs-1", status = "CREATED" }) {
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

function bindAccepted(db, runId, { kind = "build", workflowRunId = "88001" } = {}) {
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT INTO production_release_workflow_binding(
      release_run_id, workflow_kind, idempotency_key, binding_status, dispatch_submitted_at, workflow_run_id, created_at)
    VALUES (?, ?, ?, 'dispatched', ?, ?, ?)
  `).run(runId, kind, `idem-${runId}-${kind}`, ts, workflowRunId, ts);
}

test("accepted in-flight release shows running observation on the pending list", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const runId = insertReleaseRun(db, { productId: "shop", status: "BUILD_DISPATCHED" });
  bindAccepted(db, runId);
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "production_release" && it.id === runId);
  assert.ok(item);
  assert.equal(item.state, "BUILD_DISPATCHED");
  assert.equal(item.observation.accepted, true);
  assert.equal(item.observation.in_flight, true);
  assert.match(item.note, /執行中/);
  assert.match(item.note, /可取消 runner/);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "production_release").length, 0);
  const obs = observeProductionReleaseProgress(db, runId);
  assert.equal(obs.workflow_run_id, "88001");
  db.close();
});

test("cancel runner records observation and does not rewrite release status", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop", fingerprint: "fp-run", status: "BUILD_DISPATCHED" });
  bindAccepted(db, runId, { workflowRunId: "99001" });
  const provider = makeStubProductionReleaseProvider();
  provider._runsById.set("99001", { id: "99001", status: "in_progress", conclusion: null });
  const out = await cancelProductionReleaseRunner(db, runId, { actor: "owner", reason: "stop_runner", provider });
  assert.equal(out.runner_cancel_requested, true);
  assert.equal(out.deploy_not_withdrawn, true);
  assert.equal(out.provider_cancelled, true);
  assert.equal(out.run.current_status, "BUILD_DISPATCHED");
  assert.equal(db.prepare("SELECT to_status FROM production_release_run_event WHERE release_run_id=? ORDER BY id DESC LIMIT 1").get(runId).to_status, "BUILD_DISPATCHED");
  assert.ok(db.prepare("SELECT COUNT(*) n FROM production_release_evidence WHERE release_run_id=? AND evidence_kind='runner_cancel'").get(runId).n >= 1);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.production_release.runner_cancel_requested'").get().n >= 1);
  const pending = listPendingWork(db, "shop").items.find((it) => it.kind === "production_release" && it.id === runId);
  assert.match(pending.note, /已要求取消/);
  const again = await cancelProductionReleaseRunner(db, runId, { actor: "owner", provider });
  assert.equal(again.idempotent, true);
  assert.equal(again.deploy_not_withdrawn, true);
  db.close();
});

test("succeeded, unknown, and unsent runs cannot use cancel-runner", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const okId = insertReleaseRun(db, { productId: "shop", authId: 21, fingerprint: "fp-ok", status: "SUCCEEDED" });
  const unkId = insertReleaseRun(db, { productId: "shop", authId: 22, fingerprint: "fp-unk", status: "PRODUCTION_STATE_UNKNOWN" });
  const unsentId = insertReleaseRun(db, { productId: "shop", authId: 23, fingerprint: "fp-unsent", status: "CREATED" });
  const reconciledId = insertReleaseRun(db, { productId: "shop", authId: 24, fingerprint: "fp-rec", status: "BUILD_RECONCILED" });
  bindAccepted(db, okId);
  bindAccepted(db, unkId);
  bindAccepted(db, reconciledId);
  await assert.rejects(() => cancelProductionReleaseRunner(db, okId, { actor: "owner" }), (err) => err.status === 409 && /不改寫/.test(err.message));
  await assert.rejects(() => cancelProductionReleaseRunner(db, unkId, { actor: "owner" }), (err) => err.status === 409 && /不宣稱撤回/.test(err.message));
  await assert.rejects(() => cancelProductionReleaseRunner(db, unsentId, { actor: "owner" }), (err) => err.status === 409 && /尚未受理/.test(err.message));
  await assert.rejects(() => cancelProductionReleaseRunner(db, reconciledId, { actor: "owner" }), (err) => err.status === 409 && /已知結果/.test(err.message));
  assert.equal(db.prepare("SELECT to_status FROM production_release_run_event WHERE release_run_id=? ORDER BY id DESC LIMIT 1").get(okId).to_status, "SUCCEEDED");
  db.close();
});

test("late execute after runner cancel does not dispatch or write SUCCEEDED", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop", fingerprint: "fp-late-run", status: "BUILD_DISPATCHED" });
  bindAccepted(db, runId, { workflowRunId: "77001" });
  const provider = makeStubProductionReleaseProvider();
  provider._runsById.set("77001", { id: "77001", status: "in_progress", conclusion: null });
  await cancelProductionReleaseRunner(db, runId, { actor: "owner", provider });
  let dispatched = 0;
  const out = await executeProductionRelease(db, runId, {
    provider: {
      available: true,
      async dispatchWorkflow() { dispatched += 1; return { accepted: true, workflow_run_id: "1" }; },
      async inspectImage() { return { digest: "sha256:aa" }; },
      async cancelWorkflowRun() { return { cancelled: true }; },
    },
    repo: { available: true, isRemoteAncestor() { return true; }, resolveRemoteRef() { return "deadbeef"; } },
  });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, "runner_cancel_requested");
  assert.equal(out.deploy_not_withdrawn, true);
  assert.equal(out.current_status, "BUILD_DISPATCHED");
  assert.equal(dispatched, 0);
  assert.equal(db.prepare("SELECT to_status FROM production_release_run_event WHERE release_run_id=? ORDER BY id DESC LIMIT 1").get(runId).to_status, "BUILD_DISPATCHED");
  db.close();
});

test("reconciled accepted release shows known result without a runner cancel button state", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop", fingerprint: "fp-known", status: "BUILD_RECONCILED" });
  bindAccepted(db, runId);
  db.prepare(`
    INSERT INTO production_release_evidence(release_run_id, evidence_kind, workflow_conclusion, payload_json, created_at)
    VALUES (?, 'workflow', 'success', '{}', ?)
  `).run(runId, new Date().toISOString());
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "production_release" && it.id === runId);
  assert.ok(item);
  assert.equal(item.observation.in_flight, false);
  assert.match(item.note, /已知結果/);
  db.close();
});

test("console exposes pending-list runner cancel for accepted in-flight releases", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /尚未結束的 GitHub runner 可取消/);
  assert.match(html, /程式退回與 DB 還原是不同操作/);
  assert.match(html, /console\.js\?v=20260913-pkg26/);
  assert.match(js, /\/ops\/api\/production-releases\/\$\{id\}\/cancel-runner/);
  assert.match(js, /取消尚未結束的 runner/);
  assert.match(js, /不宣稱撤回已受理的部署/);
});
