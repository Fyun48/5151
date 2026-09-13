import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import { exportHandoff, listPendingWork, listUnknownProductionRuns } from "../src/exitDrill.js";
import {
  confirmUnknownProductionResult,
  describeUnknownProductionOffer,
} from "../src/release/productionRelease.js";

const root = dirname(fileURLToPath(import.meta.url));

function insertReleaseRun(db, { productId, issueId = 1, status = "PRODUCTION_STATE_UNKNOWN", eventType = "deploy_unknown" }) {
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
  `).run(issueId, issueId, `fp-unk-${productId || "none"}-${issueId}-${status}`, `pol-${productId || "none"}`, ts, productId).lastInsertRowid);
  db.prepare(`
    INSERT INTO production_release_run_event(release_run_id, to_status, event_type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(runId, status, eventType, ts);
  return runId;
}

test("pending list offers unknown-state confirmation without rewriting status", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const runId = insertReleaseRun(db, { productId: "shop" });
  const offer = describeUnknownProductionOffer(db, runId);
  assert.equal(offer.offered, true);
  assert.equal(offer.rewrite_status, false);
  assert.equal(offer.deploy_not_withdrawn, true);
  assert.deepEqual(offer.observed_results, ["succeeded", "failed", "rolled_back"]);
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "production_release" && it.id === runId);
  assert.ok(item);
  assert.equal(item.state, "unknown");
  assert.equal(item.blocking, true);
  assert.equal(item.unknown_confirm.offered, true);
  assert.match(item.note, /先確認該環境實際結果/);
  assert.match(item.note, /可從未決清單確認/);
  assert.equal(listUnknownProductionRuns(db, "shop").map((r) => r.id).join(","), String(runId));
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "production_release").length, 0);
  assert.throws(() => exportHandoff(db, "shop"), /正式部署狀態不明/);
  db.close();
});

test("confirming observed failure writes evidence only and unblocks handoff", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop" });
  let providerCalls = 0;
  const out = confirmUnknownProductionResult(db, runId, {
    actor: "owner",
    reason: "CasaOS 上容器已停，workflow 也失敗",
    observedResult: "failed",
    provider: {
      execute() { providerCalls += 1; throw new Error("must not execute"); },
      dispatch() { providerCalls += 1; throw new Error("must not dispatch"); },
    },
  });
  assert.equal(out.confirmed, true);
  assert.equal(out.rewrite_status, false);
  assert.equal(out.deploy_not_withdrawn, true);
  assert.equal(out.observed_result, "failed");
  assert.equal(out.current_status, "PRODUCTION_STATE_UNKNOWN");
  assert.equal(providerCalls, 0);
  const events = db.prepare("SELECT to_status, event_type FROM production_release_run_event WHERE release_run_id=? ORDER BY id").all(runId);
  assert.equal(events.length, 1);
  assert.equal(events[0].to_status, "PRODUCTION_STATE_UNKNOWN");
  const evidence = db.prepare("SELECT evidence_kind FROM production_release_evidence WHERE release_run_id=? ORDER BY id DESC LIMIT 1").get(runId);
  assert.equal(evidence.evidence_kind, "production_state_confirmed");
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.production_release.state_confirmed'").get().n >= 1);
  assert.equal(describeUnknownProductionOffer(db, runId).offered, false);
  assert.equal(describeUnknownProductionOffer(db, runId).reason, "already_confirmed");
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "production_release" && it.id === runId).length, 0);
  assert.equal(listUnknownProductionRuns(db, "shop").length, 0);
  const pack = exportHandoff(db, "shop");
  assert.equal(pack.manifest.product_id, "shop");
  const again = confirmUnknownProductionResult(db, runId, {
    reason: "再按一次",
    observedResult: "failed",
  });
  assert.equal(again.idempotent, true);
  assert.equal(again.rewrite_status, false);
  assert.equal(events.length, db.prepare("SELECT COUNT(*) n FROM production_release_run_event WHERE release_run_id=?").get(runId).n);
  db.close();
});

test("confirm requires reason and observed_result", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop" });
  assert.throws(
    () => confirmUnknownProductionResult(db, runId, { observedResult: "failed" }),
    (err) => err.status === 400,
  );
  assert.throws(
    () => confirmUnknownProductionResult(db, runId, { reason: "看到失敗了" }),
    (err) => err.status === 400,
  );
  assert.throws(
    () => confirmUnknownProductionResult(db, runId, { reason: "看到失敗了", observedResult: "maybe" }),
    (err) => err.status === 400,
  );
  assert.equal(describeUnknownProductionOffer(db, runId).offered, true);
  db.close();
});

test("owner_direct spoof cannot confirm unknown production from the pending offer", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop" });
  assert.throws(
    () => confirmUnknownProductionResult(db, runId, {
      reason: "x",
      observedResult: "succeeded",
      owner_direct: true,
    }),
    (err) => err.status === 403,
  );
  assert.equal(describeUnknownProductionOffer(db, runId).offered, true);
  assert.equal(listUnknownProductionRuns(db, "shop").length, 1);
  db.close();
});

test("non-unknown production cannot use the confirm-state door", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const succeeded = insertReleaseRun(db, { productId: "shop", issueId: 2, status: "SUCCEEDED", eventType: "deploy_succeeded" });
  assert.equal(describeUnknownProductionOffer(db, succeeded).offered, false);
  assert.equal(describeUnknownProductionOffer(db, succeeded).reason, "not_unknown");
  assert.throws(
    () => confirmUnknownProductionResult(db, succeeded, { reason: "其實失敗", observedResult: "failed" }),
    (err) => err.status === 409 && /只有狀態不明/.test(err.message),
  );
  db.close();
});

test("console exposes pending-list unknown confirm without opening a coding or deploy path", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /正式部署狀態不明時，先確認該環境實際結果，再完成移交/);
  assert.match(html, /狀態不明可從未決清單確認已成功、已失敗或已退回/);
  assert.match(html, /確認只寫觀察，不改寫終態，也不宣稱撤回/);
  assert.match(html, /console\.js\?v=20260913-pkg34/);
  assert.match(js, /PENDING_UNKNOWN_CONFIRM/);
  assert.match(js, /確認已成功/);
  assert.match(js, /確認已失敗/);
  assert.match(js, /確認已退回/);
  assert.match(js, /\/ops\/api\/production-releases\/\$\{itemId\}\/confirm-state/);
  assert.match(js, /observed_result: spec\.observedResult/);
  assert.doesNotMatch(js, /\/ops\/api\/coding-tasks\/\$\{itemId\}\/(execute|claim)/);
  assert.doesNotMatch(js, /owner_direct:\s*true/);
});
