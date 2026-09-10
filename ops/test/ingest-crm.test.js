import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { updateProductCapabilities } from "../src/products.js";
import { signIngestRequest } from "../../v3/src/opsSignature.js";

const INGEST_SECRET = "ops-ingest-secret";
const AUTH = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
const PATH = "/ops/api/ingest/crm";

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

function post(base, { deliveryId, payload, secret = INGEST_SECRET }) {
  const raw = JSON.stringify(payload);
  const signed = signIngestRequest({ method: "POST", path: PATH, deliveryId, rawBody: raw, secret });
  return fetch(`${base}${PATH}`, { method: "POST", headers: signed.headers, body: raw });
}

function payloadFor(deliveryId) {
  return {
    delivery_id: deliveryId,
    idempotency_key: `crm:1:${deliveryId}`,
    external_contact_id: 1,
    snapshot: {
      contact: { id: 1, display_name: "林小姐" },
      cases: [{ id: 2, title: "漏水", handling_state: "new" }],
    },
  };
}

test("CRM ingest is refused until crm_sync is granted", async () => {
  await withServer(async ({ base, db }) => {
    const denied = await post(base, { deliveryId: "c1", payload: payloadFor("c1") });
    assert.equal(denied.status, 403);
    updateProductCapabilities(db, "v3", { crm_sync: true });
    const ok = await post(base, { deliveryId: "c1", payload: payloadFor("c1") });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.product_id, "v3");
  });
});
