import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { createProduct, pauseProduct, reconnectProduct } from "../src/products.js";
import {
  confirmUnknownProductionResult,
} from "../src/release/productionRelease.js";
import {
  describeExitRetryOffer,
  retryBlockedExit,
} from "../src/exitRetry.js";
import { beginUnsubscribeExit, listPendingWork, pendingForHandoff } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));
const AUTH = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };

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
  `).run(issueId, issueId, `fp-retry-${productId || "none"}-${issueId}-${status}`, `pol-${productId || "none"}`, ts, productId).lastInsertRowid);
  db.prepare(`
    INSERT INTO production_release_run_event(release_run_id, to_status, event_type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(runId, status, eventType, ts);
  return runId;
}

function retry(db, productId, opts = {}) {
  return retryBlockedExit(db, productId, { listPendingWork, ...opts });
}

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(AUTH);
  const server = createApp({ db, auth, ingestSecret: "secret" }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db }); } finally { server.close(); db.close(); }
}

async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: AUTH.ownerEmail, password: AUTH.ownerPassword }),
  });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

test("connected products do not offer exit-record retry", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const offer = describeExitRetryOffer(db, "shop");
  assert.equal(offer.offered, false);
  assert.equal(offer.reason, "subscription_active");
  const pending = listPendingWork(db, "shop");
  assert.equal(pending.exit_retry_blocked, false);
  assert.equal(pending.items.filter((it) => it.kind === "exit_record").length, 0);
  db.close();
});

test("unsubscribe without blocking completes and does not offer retry", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const un = beginUnsubscribeExit(db, "shop", { actor: "owner" });
  assert.equal(un.exit.exit_status, "completed");
  assert.equal(un.exit_retry_blocked, false);
  assert.equal(describeExitRetryOffer(db, "shop").offered, false);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "exit_record").length, 0);
  db.close();
});

test("pending list offers exit retry after blocked unsubscribe without rewriting state", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  insertReleaseRun(db, { productId: "shop" });
  const un = beginUnsubscribeExit(db, "shop", { actor: "owner" });
  assert.equal(un.exit.exit_status, "blocked");
  assert.equal(un.exit_retry_blocked, true);
  const offer = describeExitRetryOffer(db, "shop");
  assert.equal(offer.offered, true);
  assert.equal(offer.rewrite_subscription, false);
  assert.equal(offer.pending_not_claimed, true);
  assert.equal(offer.exit_record_id, un.exit.id);
  const item = un.pending.items.find((it) => it.kind === "exit_record");
  assert.ok(item);
  assert.equal(item.state, "exit_blocked");
  assert.equal(item.blocking, false);
  assert.equal(item.exit_retry.offered, true);
  assert.match(item.note, /退出紀錄被未決工作擋住/);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "exit_record").length, 0);
  assert.equal(listPendingWork(db, "other").exit_retry_blocked, false);
  db.close();
});

test("retry while still blocking refreshes snapshot and leaves subscription exited", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  insertReleaseRun(db, { productId: "shop" });
  const un = beginUnsubscribeExit(db, "shop", { actor: "owner" });
  const prevStatus = db.prepare("SELECT status FROM ops_product WHERE id='shop'").get().status;
  const out = retry(db, "shop", { actor: "owner", reason: "正式發布仍狀態不明，先記下未決" });
  assert.equal(out.retried, true);
  assert.equal(out.completed, false);
  assert.equal(out.still_blocked, true);
  assert.equal(out.rewrite_subscription, false);
  assert.equal(out.pending_not_claimed, true);
  assert.ok(out.blocking_count >= 1);
  assert.equal(out.exit.exit_status, "blocked");
  assert.equal(out.product.status, prevStatus);
  assert.match(out.exit.notes, /仍有 .* 項阻擋/);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='product.exit.retry'").get().n >= 1);
  assert.equal(describeExitRetryOffer(db, "shop").offered, true);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "exit_record").length, 1);
  db.close();
});

test("retry after unknown production is confirmed completes without rewriting subscription", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const runId = insertReleaseRun(db, { productId: "shop" });
  beginUnsubscribeExit(db, "shop", { actor: "owner" });
  confirmUnknownProductionResult(db, runId, {
    actor: "owner",
    reason: "CasaOS 上容器已停，workflow 也失敗",
    observedResult: "failed",
  });
  const out = retry(db, "shop", { actor: "owner", reason: "狀態不明已確認失敗，未決不再擋退出" });
  assert.equal(out.completed, true);
  assert.equal(out.still_blocked, false);
  assert.equal(out.rewrite_subscription, false);
  assert.equal(out.pending_not_claimed, true);
  assert.equal(out.exit.exit_status, "completed");
  assert.ok(out.exit.completed_at);
  assert.equal(out.product.status, "exited");
  assert.equal(describeExitRetryOffer(db, "shop").offered, false);
  assert.equal(listPendingWork(db, "shop").exit_retry_blocked, false);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "exit_record").length, 0);
  const again = retry(db, "shop", { reason: "再按一次" });
  assert.equal(again.idempotent, true);
  assert.equal(again.rewrite_subscription, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_exit_record WHERE product_id='shop' AND action='unsubscribe'").get().n, 1);
  db.close();
});

test("retry requires reason and rejects owner_direct spoof", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  insertReleaseRun(db, { productId: "shop" });
  beginUnsubscribeExit(db, "shop", { actor: "owner" });
  assert.throws(() => retry(db, "shop", { actor: "owner" }), (err) => err.status === 400);
  assert.throws(
    () => retry(db, "shop", { actor: "owner", reason: "x", owner_direct: true }),
    (err) => err.status === 403,
  );
  assert.equal(describeExitRetryOffer(db, "shop").offered, true);
  db.close();
});

test("paused or connected products cannot use the retry-exit door", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  pauseProduct(db, "shop", { actor: "owner" });
  assert.equal(describeExitRetryOffer(db, "shop").reason, "subscription_active");
  assert.throws(
    () => retry(db, "shop", { reason: "暫停不該重試退出" }),
    (err) => err.status === 409 && /訂閱仍接通/.test(err.message),
  );
  db.close();
});

test("reconnect new generation does not retry the old blocked exit", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  insertReleaseRun(db, { productId: "shop" });
  beginUnsubscribeExit(db, "shop", { actor: "owner" });
  reconnectProduct(db, "shop", { actor: "owner" });
  assert.equal(describeExitRetryOffer(db, "shop").offered, false);
  assert.equal(describeExitRetryOffer(db, "shop").reason, "subscription_active");
  assert.throws(
    () => retry(db, "shop", { reason: "舊世代不該重試" }),
    (err) => err.status === 409,
  );
  db.close();
});

test("handoff pending copies the computed retry flag instead of forcing blocked", () => {
  const filtered = pendingForHandoff({
    items: [{ kind: "credential", id: 1 }],
    blocking: [],
    exit_retry_blocked: false,
  });
  assert.equal(filtered.exit_retry_blocked, false);
  const blocked = pendingForHandoff({
    items: [{ kind: "exit_record", id: 3, state: "exit_blocked" }],
    blocking: [],
    exit_retry_blocked: true,
  });
  assert.equal(blocked.exit_retry_blocked, true);
});

test("retry-exit API refreshes a blocked unsubscribe without rewriting subscription", async () => {
  await withServer(async ({ base, db }) => {
    createProduct(db, { id: "shop", displayName: "商店站" });
    insertReleaseRun(db, { productId: "shop" });
    const { cookie, csrf } = await login(base);
    const un = await (await fetch(`${base}/ops/api/products/shop/unsubscribe`, {
      method: "POST",
      headers: { cookie, "X-CSRF-Token": csrf, Origin: base },
    })).json();
    assert.equal(un.exit.exit_status, "blocked");
    assert.equal(un.exit_retry_blocked, true);
    const pending = await (await fetch(`${base}/ops/api/products/shop/pending`, {
      headers: { cookie },
    })).json();
    assert.equal(pending.exit_retry_blocked, true);
    assert.ok(pending.pending.items.some((it) => it.kind === "exit_record"));
    const spoof = await fetch(`${base}/ops/api/products/shop/retry-exit`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ reason: "x", owner_direct: true }),
    });
    assert.equal(spoof.status, 403);
    const ok = await (await fetch(`${base}/ops/api/products/shop/retry-exit`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ reason: "正式發布仍狀態不明" }),
    })).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.retried, true);
    assert.equal(ok.still_blocked, true);
    assert.equal(ok.rewrite_subscription, false);
    assert.equal(ok.pending_not_claimed, true);
    assert.equal(ok.product.status, "exited");
    const after = await (await fetch(`${base}/ops/api/products/shop/pending`, {
      headers: { cookie },
    })).json();
    assert.equal(after.exit_retry_blocked, true);
    assert.equal(after.pending.items.filter((it) => it.kind === "exit_record").length, 1);
  });
});

test("console exposes pending-list exit retry without opening a coding or deploy path", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /解除訂閱時若未決工作擋住退出紀錄，未決清單可重試/);
  assert.match(html, /重試只重拍未決快照，阻擋解除才標完成/);
  assert.match(html, /不改寫訂閱終態，也不假裝未決已消失/);
  assert.match(html, /console\.js\?v=20260915-pkg37/);
  assert.match(js, /PENDING_EXIT_RETRY/);
  assert.match(js, /exit_blocked:\s*"退出已阻擋"/);
  assert.match(js, /重試退出紀錄/);
  assert.match(js, /已重試退出紀錄，未決阻擋已解除/);
  assert.match(js, /已重試退出紀錄，仍有未決阻擋/);
  assert.match(js, /\/ops\/api\/products\/\$\{encodeURIComponent\(pid\)\}\/retry-exit/);
  assert.doesNotMatch(js, /\/ops\/api\/coding-tasks\/\$\{itemId\}\/(execute|claim)/);
  assert.doesNotMatch(js, /owner_direct:\s*true/);
});
