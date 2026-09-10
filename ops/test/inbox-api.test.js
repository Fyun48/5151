import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { ingestFeedback } from "../src/ingest.js";
import { createProduct } from "../src/products.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(CFG);
  const server = createApp({ db, auth, ingestSecret: "secret" }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db }); } finally { server.close(); db.close(); }
}

async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "pw" }),
  });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

test("feedback inbox and dashboard require owner", async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/ops/api/feedback`)).status, 401);
    assert.equal((await fetch(`${base}/ops/api/dashboard`)).status, 401);
  });
});

test("owner lists ingested feedback without leaking contact by default", async () => {
  await withServer(async ({ base, db }) => {
    ingestFeedback(db, {
      deliveryId: "d-inbox",
      payloadHash: "h1",
      payload: {
        delivery_id: "d-inbox",
        idempotency_key: "feedback:d-inbox",
        source: "v3",
        kind: "bug",
        content: "搜尋框不見了",
        contact: "leak@example.com",
        user_ref: "u-9",
      },
    });
    const { cookie } = await login(base);
    const inbox = await (await fetch(`${base}/ops/api/feedback`, { headers: { cookie } })).json();
    assert.equal(inbox.total, 1);
    assert.equal(inbox.items[0].kind, "bug");
    assert.equal(inbox.items[0].has_contact, true);
    assert.equal(inbox.items[0].contact, undefined);
    const raw = JSON.stringify(inbox);
    assert.doesNotMatch(raw, /leak@example\.com/);

    const dash = await (await fetch(`${base}/ops/api/dashboard`, { headers: { cookie } })).json();
    assert.equal(dash.phase, "15");
    assert.equal(dash.feedback_total, 1);
    assert.equal(dash.selected_product_id, null);
    assert.equal(dash.webhook.configured, false);
  });
});

test("dashboard and inbox accept productId scope", async () => {
  await withServer(async ({ base, db }) => {
    createProduct(db, { id: "shop", displayName: "商店站" });
    ingestFeedback(db, {
      deliveryId: "d-v3",
      payloadHash: "hv3",
      productId: "v3",
      payload: {
        delivery_id: "d-v3",
        idempotency_key: "feedback:d-v3",
        source: "v3",
        kind: "bug",
        content: "v3 only",
      },
    });
    ingestFeedback(db, {
      deliveryId: "d-shop",
      payloadHash: "hshop",
      productId: "shop",
      payload: {
        delivery_id: "d-shop",
        idempotency_key: "feedback:d-shop",
        source: "shop",
        kind: "idea",
        content: "shop only",
      },
    });
    const { cookie } = await login(base);
    const all = await (await fetch(`${base}/ops/api/dashboard`, { headers: { cookie } })).json();
    assert.equal(all.feedback_total, 2);
    const scoped = await (await fetch(`${base}/ops/api/dashboard?productId=shop`, { headers: { cookie } })).json();
    assert.equal(scoped.feedback_total, 1);
    assert.equal(scoped.selected_product_id, "shop");
    const inbox = await (await fetch(`${base}/ops/api/feedback?productId=shop`, { headers: { cookie } })).json();
    assert.equal(inbox.total, 1);
    assert.equal(inbox.items[0].product_id, "shop");
    assert.equal(inbox.items[0].content, "shop only");
  });
});

test("health reports phase 15 and webhook flag", async () => {
  await withServer(async ({ base }) => {
    const data = await (await fetch(`${base}/ops/api/health`)).json();
    assert.equal(data.phase, "15");
    assert.equal(data.webhook, false);
  });
});
