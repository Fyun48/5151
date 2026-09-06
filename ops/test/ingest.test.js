import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { countIngested } from "../src/ingest.js";
import { signIngestRequest } from "../../v3/src/opsSignature.js";

const INGEST_SECRET = "ops-ingest-secret";
const AUTH = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
const PATH = "/ops/api/ingest/feedback";

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(AUTH);
  const server = createApp({ db, auth, ingestSecret: INGEST_SECRET }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, db });
  } finally {
    server.close();
    db.close();
  }
}

function post(base, { deliveryId, payload, secret = INGEST_SECRET, tamper = null, now }) {
  const raw = JSON.stringify(payload);
  const signed = signIngestRequest({ method: "POST", path: PATH, deliveryId, rawBody: raw, secret, now });
  const body = tamper ? JSON.stringify(tamper) : raw;
  return fetch(`${base}${PATH}`, { method: "POST", headers: signed.headers, body });
}

function payloadFor(deliveryId, extra = {}) {
  return { delivery_id: deliveryId, idempotency_key: `feedback:${deliveryId}`, source: "v3", content: "hello", kind: "bug", ...extra };
}

test("valid signed delivery is stored once", async () => {
  await withServer(async ({ base, db }) => {
    const res = await post(base, { deliveryId: "d1", payload: payloadFor("d1") });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.duplicate, false);
    assert.equal(countIngested(db), 1);
    const row = db.prepare("SELECT * FROM ingested_feedback WHERE delivery_id='d1'").get();
    assert.equal(row.trust_level, "untrusted");
    assert.equal(row.content, "hello");
  });
});

test("duplicate delivery is idempotent (exactly one record)", async () => {
  await withServer(async ({ base, db }) => {
    await post(base, { deliveryId: "d2", payload: payloadFor("d2") });
    const again = await post(base, { deliveryId: "d2", payload: payloadFor("d2") });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).duplicate, true);
    assert.equal(countIngested(db), 1);
  });
});

test("concurrent duplicate requests → exactly one logical record", async () => {
  await withServer(async ({ base, db }) => {
    const results = await Promise.all([
      post(base, { deliveryId: "d3", payload: payloadFor("d3") }),
      post(base, { deliveryId: "d3", payload: payloadFor("d3") }),
      post(base, { deliveryId: "d3", payload: payloadFor("d3") }),
    ]);
    for (const r of results) assert.equal(r.status, 200);
    assert.equal(countIngested(db), 1);
  });
});

test("invalid HMAC is rejected", async () => {
  await withServer(async ({ base, db }) => {
    const res = await post(base, { deliveryId: "d4", payload: payloadFor("d4"), secret: "wrong-secret" });
    assert.equal(res.status, 401);
    assert.equal(countIngested(db), 0);
  });
});

test("expired timestamp is rejected", async () => {
  await withServer(async ({ base, db }) => {
    const res = await post(base, { deliveryId: "d5", payload: payloadFor("d5"), now: Date.now() - 10 * 60 * 1000 });
    assert.equal(res.status, 401);
    assert.equal(countIngested(db), 0);
  });
});

test("modified body after signing is rejected", async () => {
  await withServer(async ({ base, db }) => {
    const res = await post(base, {
      deliveryId: "d6",
      payload: payloadFor("d6", { content: "orig" }),
      tamper: payloadFor("d6", { content: "HACKED" }),
    });
    assert.equal(res.status, 401);
    assert.equal(countIngested(db), 0);
  });
});

test("delivery_id mismatch between header and body is rejected", async () => {
  await withServer(async ({ base, db }) => {
    // 用 d7 簽名，但 body 內 delivery_id 是 d8（body-hash 一致，因為簽的就是這個 body）
    const raw = JSON.stringify(payloadFor("d8"));
    const signed = signIngestRequest({ method: "POST", path: PATH, deliveryId: "d7", rawBody: raw, secret: INGEST_SECRET });
    const res = await fetch(`${base}${PATH}`, { method: "POST", headers: signed.headers, body: raw });
    assert.equal(res.status, 400);
    assert.equal(countIngested(db), 0);
  });
});

// ── Phase 2.1 item 2：idempotency / delivery 衝突 ──

test("same delivery + same body → idempotent success (one record)", async () => {
  await withServer(async ({ base, db }) => {
    const p = payloadFor("c1", { content: "same body" });
    const r1 = await post(base, { deliveryId: "c1", payload: p });
    const r2 = await post(base, { deliveryId: "c1", payload: p });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).duplicate, true);
    assert.equal(countIngested(db), 1);
  });
});

test("same delivery + changed body → 409 conflict, original unchanged", async () => {
  await withServer(async ({ base, db }) => {
    await post(base, { deliveryId: "c2", payload: payloadFor("c2", { content: "original" }) });
    const before = db.prepare("SELECT content, payload_hash FROM ingested_feedback WHERE delivery_id='c2'").get();
    // 用有效簽章送同一 delivery_id 但不同 body
    const res = await post(base, { deliveryId: "c2", payload: payloadFor("c2", { content: "DIFFERENT" }) });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, "delivery_conflict");
    assert.equal(countIngested(db), 1);
    const after = db.prepare("SELECT content, payload_hash FROM ingested_feedback WHERE delivery_id='c2'").get();
    assert.equal(after.content, before.content); // 未被覆寫
    assert.equal(after.payload_hash, before.payload_hash);
    const audit = db.prepare("SELECT * FROM audit_log WHERE action='feedback.ingest.conflict'").get();
    assert.ok(audit);
    assert.doesNotMatch(audit.data || "", /DIFFERENT/); // 只記中繼資料
  });
});

test("same idempotency key + conflicting payload → 409 conflict", async () => {
  await withServer(async ({ base, db }) => {
    // 兩個不同 delivery_id，但相同 idempotency_key，內容不同
    const p1 = { delivery_id: "c3a", idempotency_key: "feedback:shared", source: "v3", content: "first", kind: "bug" };
    const p2 = { delivery_id: "c3b", idempotency_key: "feedback:shared", source: "v3", content: "second", kind: "bug" };
    const r1 = await post(base, { deliveryId: "c3a", payload: p1 });
    assert.equal(r1.status, 200);
    const r2 = await post(base, { deliveryId: "c3b", payload: p2 });
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).reason, "idempotency_conflict");
    assert.equal(countIngested(db), 1);
  });
});

test("audit records ingestion without full content", async () => {
  await withServer(async ({ base, db }) => {
    await post(base, { deliveryId: "d9", payload: payloadFor("d9", { content: "super secret feedback text" }) });
    const audit = db.prepare("SELECT * FROM audit_log WHERE action='feedback.ingested'").get();
    assert.ok(audit);
    assert.doesNotMatch(audit.data || "", /super secret feedback text/);
  });
});
