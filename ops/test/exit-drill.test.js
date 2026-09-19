import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { ingestFeedback } from "../src/ingest.js";
import { createProduct } from "../src/products.js";
import { exportHandoff, pendingForHandoff } from "../src/exitDrill.js";

const AUTH = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };

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

test("unsubscribe writes an exit record and pending list", async () => {
  await withServer(async ({ base }) => {
    const { cookie, csrf } = await login(base);
    const created = await (await fetch(`${base}/ops/api/products`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ id: "drill", display_name: "演練站" }),
    })).json();
    assert.equal(created.ok, true);
    const un = await (await fetch(`${base}/ops/api/products/drill/unsubscribe`, {
      method: "POST",
      headers: { cookie, "X-CSRF-Token": csrf, Origin: base },
    })).json();
    assert.equal(un.ok, true);
    assert.equal(un.product.status, "exited");
    assert.equal(un.exit.action, "unsubscribe");
    assert.ok(Array.isArray(un.pending.items));
    assert.equal(un.site_delivery_unconfirmed, true);
  });
});

test("handoff export is scoped to one product and has a stable hash", async () => {
  await withServer(async ({ base, db }) => {
    createProduct(db, { id: "drill", displayName: "演練站" });
    ingestFeedback(db, {
      deliveryId: "d-drill",
      payloadHash: "h-drill",
      productId: "drill",
      payload: { delivery_id: "d-drill", idempotency_key: "feedback:d-drill", source: "drill", kind: "bug", content: "演練回饋內容夠長", contact: "secret@x.com" },
    });
    ingestFeedback(db, {
      deliveryId: "d-v3",
      payloadHash: "h-v3",
      productId: "v3",
      payload: { delivery_id: "d-v3", idempotency_key: "feedback:d-v3", source: "v3", kind: "bug", content: "v3 only" },
    });
    const { cookie, csrf } = await login(base);
    const pack = await (await fetch(`${base}/ops/api/products/drill/handoff`, {
      method: "POST",
      headers: { cookie, "X-CSRF-Token": csrf, Origin: base },
    })).json();
    assert.equal(pack.ok, true);
    assert.equal(pack.manifest.product_id, "drill");
    assert.equal(pack.manifest.feedback_count, 1);
    assert.match(pack.sha256, /^[0-9a-f]{64}$/);
    assert.equal(pack.payload.feedback[0].content, "演練回饋內容夠長");
    assert.equal(JSON.stringify(pack.payload).includes("secret@x.com"), false);
    assert.equal(pack.payload.feedback.some((r) => r.product_id === "v3"), false);
  });
});

test("purge replica redacts OPS copies and leaves the product card", async () => {
  await withServer(async ({ base, db }) => {
    createProduct(db, { id: "drill", displayName: "演練站" });
    ingestFeedback(db, {
      deliveryId: "d-purge",
      payloadHash: "h-purge",
      productId: "drill",
      payload: { delivery_id: "d-purge", idempotency_key: "feedback:d-purge", source: "drill", kind: "idea", content: "要被清掉的複本" },
    });
    const { cookie, csrf } = await login(base);
    const bad = await fetch(`${base}/ops/api/products/drill/purge-replica`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ confirm: "nope" }),
    });
    assert.equal(bad.status, 400);
    const ok = await (await fetch(`${base}/ops/api/products/drill/purge-replica`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ confirm: "PURGE-drill" }),
    })).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.purged, 1);
    const row = db.prepare("SELECT content, contact FROM ingested_feedback WHERE product_id='drill'").get();
    assert.equal(row.content, "[purged]");
    assert.equal(row.contact, null);
    const card = db.prepare("SELECT id FROM ops_product WHERE id='drill'").get();
    assert.ok(card);
  });
});

test("handoff pending omits unscoped coding tasks from other work", () => {
  const filtered = pendingForHandoff({
    items: [
      { kind: "credential", id: 1 },
      { kind: "coding", id: 2, unscoped: true, state: "pending" },
      { kind: "release_notification", id: 3, unscoped: true, state: "pending" },
    ],
    blocking: [{ kind: "coding", id: 2, unscoped: true, state: "running" }],
  });
  assert.deepEqual(filtered.items.map((item) => item.kind), ["credential"]);
  assert.equal(filtered.blocking.length, 0);
  assert.equal(filtered.omitted_unscoped, 2);

  const db = openOpsDb(":memory:");
  createProduct(db, { id: "drill", displayName: "演練站" });
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(`
    INSERT INTO development_coding_task(
      issue_id, development_authorization_id, proposal_id, proposal_version,
      proposal_hash, task_fingerprint, base_branch, base_sha, status,
      next_attempt_at, created_at
    ) VALUES (1, 1, 1, 1, 'hash', 'fp-handoff-unscoped', 'master', 'deadbeef', 'pending', 't', 't')
  `).run();
  const pack = exportHandoff(db, "drill", { actor: "test" });
  assert.equal(pack.payload.pending.items.some((item) => item.kind === "coding"), false);
  assert.equal(pack.payload.pending.items.every((item) => !item.unscoped), true);
  assert.ok(pack.payload.pending.omitted_unscoped >= 1);
  db.close();
});
