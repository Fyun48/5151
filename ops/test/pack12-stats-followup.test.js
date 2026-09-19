import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { ingestFeedback } from "../src/ingest.js";
import {
  createProduct,
  DEFAULT_CAPABILITIES,
  getProduct,
  updateProductCapabilities,
  unsubscribeProduct,
} from "../src/products.js";
import { analysisStats, enqueueAnalysisRow } from "../src/feedbackAnalysis.js";
import { getDashboard } from "../src/dashboard.js";
import { productAllowsFollowup, productAllowsStats, countIngestedForStats } from "../src/usageConsent.js";
import { listPurgeEvents, reapplyPurgeLedger, reapplyProductPurge } from "../src/purgeLedger.js";
import { purgeReplica } from "../src/exitDrill.js";

function seedFeedback(db, productId, suffix) {
  const deliveryId = `d-${productId}-${suffix}`;
  return ingestFeedback(db, {
    deliveryId,
    payloadHash: `h-${deliveryId}`,
    productId,
    payload: {
      delivery_id: deliveryId,
      idempotency_key: `feedback:${suffix}`,
      source: productId,
      kind: "bug",
      content: "統計與後續服務驗收用的回饋內容要夠長",
    },
  }).id;
}

test("stats and followup_service default off and need feedback_copy", () => {
  assert.equal(DEFAULT_CAPABILITIES.stats, false);
  assert.equal(DEFAULT_CAPABILITIES.followup_service, false);
  const db = openOpsDb(":memory:");
  const v3 = getProduct(db, "v3");
  assert.equal(JSON.parse(v3.capabilities).stats, false);
  assert.equal(productAllowsStats(v3), false);
  assert.equal(productAllowsFollowup(v3), false);
  createProduct(db, { id: "shop", displayName: "商店站" });
  assert.throws(() => updateProductCapabilities(db, "shop", { stats: true, feedback_copy: false }), /統計指標/);
  assert.throws(() => updateProductCapabilities(db, "shop", { followup_service: true, feedback_copy: false }), /後續服務/);
  updateProductCapabilities(db, "shop", { stats: true });
  assert.equal(productAllowsStats(getProduct(db, "shop")), true);
  unsubscribeProduct(db, "shop");
  assert.equal(productAllowsStats(getProduct(db, "shop")), false);
  assert.equal(productAllowsFollowup(getProduct(db, "shop")), false);
  db.close();
});

test("unlabeled stats omit sites without consent; inbox counts stay operational", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  seedFeedback(db, "v3", "a");
  seedFeedback(db, "shop", "b");
  const dash = getDashboard(db, {});
  assert.equal(dash.feedback_total, 2);
  assert.equal(dash.stats_consented_feedback_total, 0);
  assert.ok(dash.stats_withheld_product_ids.includes("v3"));
  assert.ok(dash.stats_withheld_product_ids.includes("shop"));
  assert.equal(countIngestedForStats(db), 0);

  updateProductCapabilities(db, "shop", { stats: true });
  const after = getDashboard(db, {});
  assert.equal(after.feedback_total, 2);
  assert.equal(after.stats_consented_feedback_total, 1);
  assert.equal(after.stats_withheld_product_ids.includes("shop"), false);
  assert.equal(getDashboard(db, {}, { productId: "shop" }).stats_consent, true);
  assert.equal(getDashboard(db, {}, { productId: "v3" }).stats_consent, false);
  db.close();
});

test("analysis stats keep operational totals and split consented counts", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  updateProductCapabilities(db, "shop", { cross_site_insight: true });
  const id = seedFeedback(db, "shop", "c");
  enqueueAnalysisRow(db, { feedbackId: id });
  const raw = analysisStats(db);
  assert.ok(raw.pending >= 1);
  assert.equal(raw.stats_consented.pending, 0);
  updateProductCapabilities(db, "shop", { stats: true });
  const granted = analysisStats(db);
  assert.ok(granted.stats_consented.pending >= 1);
  db.close();
});

test("purge writes a ledger and reapply redacts restored copies", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const id = seedFeedback(db, "shop", "d");
  db.prepare(`
    INSERT INTO issue_candidate(title, summary, clustering_version, status, created_at, updated_at)
    VALUES ('要清的議題', '摘要', 't', 'open', ?, ?)
  `).run(new Date().toISOString(), new Date().toISOString());
  const issueId = Number(db.prepare("SELECT id FROM issue_candidate ORDER BY id DESC LIMIT 1").get().id);
  db.prepare(`
    INSERT INTO issue_feedback_link(issue_id, feedback_id, added_by, membership_status, active, created_at)
    VALUES (?, ?, 'system', 'active', 1, ?)
  `).run(issueId, id, new Date().toISOString());

  const purged = purgeReplica(db, "shop", { confirm: "PURGE-shop" });
  assert.equal(purged.issues, 1);
  assert.equal(listPurgeEvents(db, "shop").length, 1);
  assert.equal(db.prepare("SELECT title FROM issue_candidate WHERE id=?").get(issueId).title, "[purged]");

  db.prepare("UPDATE ingested_feedback SET content='restored secret' WHERE id=?").run(id);
  db.prepare("UPDATE issue_candidate SET title='restored issue' WHERE id=?").run(issueId);
  reapplyPurgeLedger(db);
  assert.equal(db.prepare("SELECT content FROM ingested_feedback WHERE id=?").get(id).content, "[purged]");
  assert.equal(db.prepare("SELECT title FROM issue_candidate WHERE id=?").get(issueId).title, "[purged]");
  assert.equal(reapplyProductPurge(db, "shop").product_id, "shop");
  db.close();
});
