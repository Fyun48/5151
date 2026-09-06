import { test } from "node:test";
import assert from "node:assert/strict";
// Contract 測試：Product 的簽名（v3/src/opsSignature.js）必須能被 Ops 的驗證（ops/src/ingestSignature.js）通過。
import { signIngestRequest } from "../../v3/src/opsSignature.js";
import { verifyIngestRequest } from "../src/ingestSignature.js";

const SECRET = "shared-ingest-secret";
const PATH = "/ops/api/ingest/feedback";

test("product signature verifies on ops side", () => {
  const raw = JSON.stringify({ delivery_id: "d1", idempotency_key: "feedback:1", content: "hi" });
  const signed = signIngestRequest({ method: "POST", path: PATH, deliveryId: "d1", rawBody: raw, secret: SECRET });
  const headers = {
    "x-ops-signature": signed.headers["X-Ops-Signature"],
    "x-ops-timestamp": signed.headers["X-Ops-Timestamp"],
    "x-ops-delivery": signed.headers["X-Ops-Delivery"],
  };
  const res = verifyIngestRequest({ method: "POST", path: PATH, headers, rawBody: raw, secret: SECRET });
  assert.equal(res.ok, true);
  assert.equal(res.deliveryId, "d1");
});

test("wrong secret fails verification", () => {
  const raw = JSON.stringify({ delivery_id: "d1", idempotency_key: "k" });
  const signed = signIngestRequest({ method: "POST", path: PATH, deliveryId: "d1", rawBody: raw, secret: SECRET });
  const headers = {
    "x-ops-signature": signed.headers["X-Ops-Signature"],
    "x-ops-timestamp": signed.headers["X-Ops-Timestamp"],
    "x-ops-delivery": signed.headers["X-Ops-Delivery"],
  };
  assert.equal(verifyIngestRequest({ method: "POST", path: PATH, headers, rawBody: raw, secret: "other" }).ok, false);
});

test("modified body fails verification (body-hash covered)", () => {
  const raw = JSON.stringify({ delivery_id: "d1", idempotency_key: "k", content: "orig" });
  const signed = signIngestRequest({ method: "POST", path: PATH, deliveryId: "d1", rawBody: raw, secret: SECRET });
  const headers = {
    "x-ops-signature": signed.headers["X-Ops-Signature"],
    "x-ops-timestamp": signed.headers["X-Ops-Timestamp"],
    "x-ops-delivery": signed.headers["X-Ops-Delivery"],
  };
  const tampered = JSON.stringify({ delivery_id: "d1", idempotency_key: "k", content: "HACKED" });
  assert.equal(verifyIngestRequest({ method: "POST", path: PATH, headers, rawBody: tampered, secret: SECRET }).ok, false);
});

test("expired timestamp is rejected", () => {
  const raw = JSON.stringify({ delivery_id: "d1", idempotency_key: "k" });
  const old = Date.now() - 10 * 60 * 1000; // 10 分鐘前，超過 ±5 分鐘
  const signed = signIngestRequest({ method: "POST", path: PATH, deliveryId: "d1", rawBody: raw, secret: SECRET, now: old });
  const headers = {
    "x-ops-signature": signed.headers["X-Ops-Signature"],
    "x-ops-timestamp": signed.headers["X-Ops-Timestamp"],
    "x-ops-delivery": signed.headers["X-Ops-Delivery"],
  };
  const res = verifyIngestRequest({ method: "POST", path: PATH, headers, rawBody: raw, secret: SECRET });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "expired_timestamp");
});

test("malformed/missing signature is rejected", () => {
  const raw = "{}";
  assert.equal(verifyIngestRequest({ method: "POST", path: PATH, headers: {}, rawBody: raw, secret: SECRET }).ok, false);
  assert.equal(
    verifyIngestRequest({ method: "POST", path: PATH, headers: { "x-ops-signature": "garbage", "x-ops-timestamp": String(Date.now()), "x-ops-delivery": "d1" }, rawBody: raw, secret: SECRET }).ok,
    false,
  );
});
