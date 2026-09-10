import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openOpsDb } from "../../ops/src/opsDb.js";
import { createProduct } from "../../ops/src/products.js";
import { ingestFeedback } from "../../ops/src/ingest.js";
import { exportHandoff } from "../../ops/src/exitDrill.js";
import { ensureFeedbackSchema, createFeedbackWithOutbox, listFeedback } from "../src/feedback.js";
import { ensureFeedbackOutboxSchema, outboxStats } from "../src/feedbackOutbox.js";
import { importHandoffFeedback } from "../src/handoffImport.js";
import { deliveryControl } from "../src/opsDelivery.js";

function openLocal() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
  ensureFeedbackSchema(db);
  ensureFeedbackOutboxSchema(db);
  return db;
}

test("example station restores from handoff with OPS unreachable", () => {
  const ops = openOpsDb(":memory:");
  createProduct(ops, { id: "drill", displayName: "演練站" });
  ingestFeedback(ops, {
    deliveryId: "d1",
    payloadHash: "h1",
    productId: "drill",
    payload: { delivery_id: "d1", idempotency_key: "feedback:d1", source: "drill", kind: "bug", content: "還原後仍看得到這則" },
  });
  const pack = exportHandoff(ops, "drill", { actor: "test" });
  ops.close();

  const local = openLocal();
  const env = { OPS_FEEDBACK_DELIVERY: "0", OPS_INGEST_URL: "", OPS_INGEST_SECRET: "" };
  const ctrl = deliveryControl(local, env);
  assert.equal(ctrl.effective, false);

  const imported = importHandoffFeedback(local, pack.payload);
  assert.equal(imported.imported, 1);
  assert.equal(imported.product_id, "drill");

  const items = listFeedback(local);
  assert.equal(items.length, 1);
  assert.match(items[0].body, /還原後仍看得到這則/);
  assert.equal(outboxStats(local).pending, 1);

  const extra = createFeedbackWithOutbox(local, 0, { kind: "idea", body: "沒有 OPS 也能新收回饋" }, { now: new Date(Date.now() + 30_000) });
  assert.ok(extra.id > 0);
  assert.equal(outboxStats(local).pending, 2);
  local.close();
});
