import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct, updateProductCapabilities, ensureDefaultProduct } from "../src/products.js";
import {
  ingestCrmSnapshot,
  listCrmViews,
  setCrmModule,
  upsertOwnerNote,
  redactCrmReplicas,
} from "../src/crmReplica.js";

function seed(db) {
  ensureDefaultProduct(db);
  updateProductCapabilities(db, "v3", { crm_sync: true });
}

function snap(deliveryId, extra = {}) {
  return {
    delivery_id: deliveryId,
    idempotency_key: `crm:1:${deliveryId}`,
    external_contact_id: 1,
    synced_at: "2026-09-10T13:00:00.000Z",
    snapshot: {
      contact: { id: 1, display_name: "林小姐", company_name: "吉比", email: "a@example.com", tags: ["vip"] },
      cases: [{ id: 3, title: "漏水", handling_state: "doing", feedback_id: 12 }],
      notes: [{ id: 4, body: "已回電", created_at: "2026-09-10T12:00:00.000Z" }],
      todos: [{ id: 5, title: "回訪" }],
      feedback_handling: [{ feedback_id: 12, handling_state: "doing" }],
    },
    ...extra,
  };
}

test("OPS CRM four columns stay separate and close is not DROP", () => {
  const db = openOpsDb(":memory:");
  seed(db);
  ingestCrmSnapshot(db, { deliveryId: "d1", payload: snap("d1"), productId: "v3" });
  const views = listCrmViews(db, { productId: "v3" });
  assert.equal(views.length, 1);
  const cols = views[0].columns;
  assert.equal(cols.site_crm.source, "site_replica");
  assert.equal(cols.site_crm.contact.display_name, "林小姐");
  assert.equal(cols.site_handling.label, "站方處理進度");
  assert.equal(cols.site_handling.handling_state, "doing");
  assert.equal(cols.ops_progress.label, "OPS 開發進度");
  assert.equal(cols.owner_notes.source, "ops_owner");
  assert.equal(cols.owner_notes.not_site_replica, true);
  assert.notEqual(cols.site_handling.label, cols.ops_progress.label);

  upsertOwnerNote(db, { productId: "v3", subjectKind: "contact", subjectKey: "1", body: "合作續約要談" });
  const afterNote = listCrmViews(db, { productId: "v3" })[0];
  assert.match(afterNote.columns.owner_notes.body, /續約/);
  assert.equal(afterNote.columns.site_crm.contact.display_name, "林小姐");

  setCrmModule(db, "v3", { enabled: false });
  assert.throws(
    () => ingestCrmSnapshot(db, { deliveryId: "d2", payload: snap("d2"), productId: "v3" }),
    /已關閉/,
  );
  assert.equal(listCrmViews(db, { productId: "v3" })[0].columns.site_crm.contact.display_name, "林小姐");

  redactCrmReplicas(db, "v3");
  assert.equal(listCrmViews(db, { productId: "v3" })[0].columns.site_crm.contact.display_name, "[purged]");
  db.close();
});

test("crm_sync capability is not implied by feedback_copy", () => {
  const db = openOpsDb(":memory:");
  const created = createProduct(db, { id: "shop", displayName: "商店" });
  assert.equal(created.product.subscription.capabilities.feedback_copy, true);
  assert.equal(created.product.subscription.capabilities.crm_sync, false);
  assert.throws(
    () => ingestCrmSnapshot(db, { deliveryId: "x", payload: snap("x"), productId: "shop" }),
    /crm_sync not granted/,
  );
  db.close();
});
