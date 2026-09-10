import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openOpsDb, applyOpsSchema, upgradeProductIsolation } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { ingestFeedback, countIngested } from "../src/ingest.js";
import { getFeedbackForProduct } from "../src/products.js";
import { getProductionStable as getStable } from "../src/release/productionRelease.js";
import { signIngestRequest } from "../../v3/src/opsSignature.js";

const AUTH = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
const V3_SECRET = "ops-ingest-secret";
const PATH = "/ops/api/ingest/feedback";

async function withServer(run, { ingestSecret = V3_SECRET } = {}) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(AUTH);
  const server = createApp({ db, auth, ingestSecret }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, db });
  } finally {
    server.close();
    db.close();
  }
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

function postIngest(base, { deliveryId, payload, secret = V3_SECRET }) {
  const raw = JSON.stringify(payload);
  const signed = signIngestRequest({ method: "POST", path: PATH, deliveryId, rawBody: raw, secret });
  return fetch(`${base}${PATH}`, { method: "POST", headers: signed.headers, body: raw });
}

function payloadFor(deliveryId, extra = {}) {
  return { delivery_id: deliveryId, idempotency_key: `feedback:${deliveryId}`, source: "v3", content: "hello", kind: "bug", ...extra };
}

test("default product v3 is seeded and listed", async () => {
  await withServer(async ({ base }) => {
    const { cookie } = await login(base);
    const data = await (await fetch(`${base}/ops/api/products`, { headers: { cookie } })).json();
    assert.equal(data.items.length >= 1, true);
    assert.equal(data.items[0].id, "v3");
    assert.equal(data.items[0].status, "active");
    assert.equal(data.items[0].subscription.status, "connected");
  });
});

test("A and B can each ingest feedback:1 without collision", async () => {
  await withServer(async ({ base, db }) => {
    const { cookie, csrf } = await login(base);
    const created = await (await fetch(`${base}/ops/api/products`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ id: "shop", display_name: "商店站" }),
    })).json();
    assert.equal(created.ok, true);
    const shopSecret = created.ingest_secret;
    assert.ok(shopSecret);

    const a = await postIngest(base, {
      deliveryId: "da",
      payload: { delivery_id: "da", idempotency_key: "feedback:1", source: "v3", content: "from-a", kind: "bug" },
      secret: V3_SECRET,
    });
    const b = await postIngest(base, {
      deliveryId: "db",
      payload: { delivery_id: "db", idempotency_key: "feedback:1", source: "shop", content: "from-b", kind: "bug", product_id: "shop" },
      secret: shopSecret,
    });
    assert.equal(a.status, 200, await a.clone().text());
    assert.equal(b.status, 200, await b.clone().text());
    assert.equal(countIngested(db), 2);
    assert.equal(countIngested(db, { productId: "v3" }), 1);
    assert.equal(countIngested(db, { productId: "shop" }), 1);
    const rowA = db.prepare("SELECT * FROM ingested_feedback WHERE product_id='v3' AND idempotency_key='feedback:1'").get();
    const rowB = db.prepare("SELECT * FROM ingested_feedback WHERE product_id='shop' AND idempotency_key='feedback:1'").get();
    assert.equal(rowA.content, "from-a");
    assert.equal(rowB.content, "from-b");
  });
});

test("credential of A claiming product B still stores as A", async () => {
  await withServer(async ({ base, db }) => {
    const { cookie, csrf } = await login(base);
    await fetch(`${base}/ops/api/products`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ id: "shop", display_name: "商店站" }),
    });
    const res = await postIngest(base, {
      deliveryId: "dx",
      payload: {
        delivery_id: "dx",
        idempotency_key: "feedback:spoof",
        source: "v3",
        content: "spoof",
        product_id: "shop",
      },
      secret: V3_SECRET,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.product_id, "v3");
    const row = db.prepare("SELECT product_id FROM ingested_feedback WHERE delivery_id='dx'").get();
    assert.equal(row.product_id, "v3");
    assert.equal(countIngested(db, { productId: "shop" }), 0);
  });
});

test("looking up B feedback with productId=A returns the same 404 as missing", async () => {
  await withServer(async ({ base, db }) => {
    const r = ingestFeedback(db, {
      deliveryId: "d-b",
      payloadHash: "h",
      productId: "v3",
      payload: { delivery_id: "d-b", idempotency_key: "feedback:b", content: "secret-b" },
    });
    const { cookie } = await login(base);
    const miss = await fetch(`${base}/ops/api/feedback/${r.id}/analysis?productId=shop`, { headers: { cookie } });
    const gone = await fetch(`${base}/ops/api/feedback/999999/analysis?productId=shop`, { headers: { cookie } });
    assert.equal(miss.status, 404);
    assert.equal(gone.status, 404);
    const missBody = await miss.text();
    assert.doesNotMatch(missBody, /secret-b/);
    assert.doesNotMatch(missBody, /v3/);
    assert.equal(getFeedbackForProduct(db, r.id, "shop"), null);
    assert.equal(getFeedbackForProduct(db, r.id, "v3").content, "secret-b");
  });
});

test("pause rejects ingest; resume accepts again", async () => {
  await withServer(async ({ base, db }) => {
    const { cookie, csrf } = await login(base);
    const paused = await fetch(`${base}/ops/api/products/v3/pause`, {
      method: "POST",
      headers: { cookie, "X-CSRF-Token": csrf, Origin: base },
    });
    assert.equal(paused.status, 200);
    const denied = await postIngest(base, { deliveryId: "dp", payload: payloadFor("dp") });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "subscription_inactive");
    assert.equal(countIngested(db), 0);

    const resumed = await fetch(`${base}/ops/api/products/v3/resume`, {
      method: "POST",
      headers: { cookie, "X-CSRF-Token": csrf, Origin: base },
    });
    assert.equal(resumed.status, 200);
    const ok = await postIngest(base, { deliveryId: "dp2", payload: payloadFor("dp2") });
    assert.equal(ok.status, 200);
    assert.equal(countIngested(db), 1);
  });
});

test("unsubscribe revokes credential; reconnect issues a new generation", async () => {
  await withServer(async ({ base, db }) => {
    const { cookie, csrf } = await login(base);
    const un = await fetch(`${base}/ops/api/products/v3/unsubscribe`, {
      method: "POST",
      headers: { cookie, "X-CSRF-Token": csrf, Origin: base },
    });
    assert.equal(un.status, 200);
    const denied = await postIngest(base, { deliveryId: "du", payload: payloadFor("du") });
    assert.ok(denied.status === 401 || denied.status === 403);
    assert.equal(countIngested(db), 0);

    const rec = await (await fetch(`${base}/ops/api/products/v3/reconnect`, {
      method: "POST",
      headers: { cookie, "X-CSRF-Token": csrf, Origin: base },
    })).json();
    assert.equal(rec.product.subscription.generation, 2);
    assert.ok(rec.ingest_secret);
    const ok = await postIngest(base, {
      deliveryId: "du2",
      payload: payloadFor("du2"),
      secret: rec.ingest_secret,
    });
    assert.equal(ok.status, 200);
    const old = await postIngest(base, { deliveryId: "du3", payload: payloadFor("du3"), secret: V3_SECRET });
    assert.ok(old.status === 401 || old.status === 403);
  });
});

test("legacy ingested_feedback rows migrate to product v3", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE ingested_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'unknown',
      external_feedback_id TEXT,
      user_ref TEXT,
      kind TEXT,
      content TEXT,
      contact TEXT,
      context TEXT,
      app_version TEXT,
      submitted_at TEXT,
      trust_level TEXT NOT NULL DEFAULT 'untrusted',
      payload_hash TEXT,
      received_at TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, received_at) VALUES ('d-old','feedback:1','v3','bug','legacy',?)",
  ).run(new Date().toISOString());
  applyOpsSchema(db);
  upgradeProductIsolation(db);
  const row = db.prepare("SELECT product_id, content FROM ingested_feedback WHERE delivery_id='d-old'").get();
  assert.equal(row.product_id, "v3");
  assert.equal(row.content, "legacy");
  const product = db.prepare("SELECT id, status FROM ops_product WHERE id='v3'").get();
  assert.equal(product.status, "active");
  ingestFeedback(db, {
    deliveryId: "d-new",
    productId: "shop-x",
    payloadHash: "n",
    payload: { delivery_id: "d-new", idempotency_key: "feedback:1", content: "other-site" },
  });
  assert.equal(countIngested(db), 2);
  db.close();
});

test("production stable is keyed by product_id not id=1", () => {
  const db = openOpsDb(":memory:");
  assert.equal(getStable(db), null);
  db.prepare(`
    INSERT INTO production_stable_current(product_id, source_sha, artifact_digest, updated_at)
    VALUES ('v3', 'aaa', 'sha256:old', ?)
  `).run(new Date().toISOString());
  const cur = getStable(db, "v3");
  assert.equal(cur.source_sha, "aaa");
  assert.equal(getStable(db, "shop"), null);
  db.close();
});
