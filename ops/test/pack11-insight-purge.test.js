import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { ingestFeedback } from "../src/ingest.js";
import { createProduct, DEFAULT_CAPABILITIES, getProduct, updateProductCapabilities, unsubscribeProduct } from "../src/products.js";
import { enqueueAnalysisRow, claimAnalysisBatch, reprocessAnalysis } from "../src/feedbackAnalysis.js";
import { productAllowsNewInsight, redactInsightDerivatives } from "../src/insightConsent.js";
import { purgeReplica } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function seedFeedback(db, productId, suffix) {
  const deliveryId = `d-${productId}-${suffix}`;
  const result = ingestFeedback(db, {
    deliveryId,
    payloadHash: `h-${deliveryId}`,
    productId,
    payload: {
      delivery_id: deliveryId,
      idempotency_key: `feedback:${suffix}`,
      source: productId,
      kind: "bug",
      content: "跨站洞察驗收用的回饋內容要夠長",
    },
  });
  return result.id;
}

test("cross_site_insight and retain_after_exit default off", () => {
  assert.equal(DEFAULT_CAPABILITIES.cross_site_insight, false);
  assert.equal(DEFAULT_CAPABILITIES.retain_after_exit, false);
  const db = openOpsDb(":memory:");
  const v3 = getProduct(db, "v3");
  assert.equal(JSON.parse(v3.capabilities).cross_site_insight, false);
  assert.equal(productAllowsNewInsight(v3), false);
  db.close();
});

test("ingest does not enqueue analysis until insight is granted", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const id = seedFeedback(db, "shop", "1");
  assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM feedback_analysis WHERE feedback_id=?").get(id).n), 0);
  updateProductCapabilities(db, "shop", { cross_site_insight: true });
  const id2 = seedFeedback(db, "shop", "2");
  assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM feedback_analysis WHERE feedback_id=?").get(id2).n), 1);
  db.close();
});

test("claim and reprocess refuse when insight is off; retain is required after unsubscribe", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  updateProductCapabilities(db, "shop", { cross_site_insight: true });
  const id = seedFeedback(db, "shop", "3");
  enqueueAnalysisRow(db, { feedbackId: id });
  assert.equal(claimAnalysisBatch(db, { limit: 5 }).length >= 1, true);

  updateProductCapabilities(db, "shop", { cross_site_insight: false });
  enqueueAnalysisRow(db, { feedbackId: id });
  assert.equal(claimAnalysisBatch(db, { limit: 5 }).length, 0);
  assert.throws(() => reprocessAnalysis(db, id), /跨站分析未授權/);

  updateProductCapabilities(db, "shop", { cross_site_insight: true });
  unsubscribeProduct(db, "shop");
  assert.throws(() => reprocessAnalysis(db, id), /跨站分析未授權/);

  const db2 = openOpsDb(":memory:");
  createProduct(db2, { id: "keep", displayName: "保留站" });
  updateProductCapabilities(db2, "keep", { cross_site_insight: true, retain_after_exit: true });
  const keepId = seedFeedback(db2, "keep", "4");
  unsubscribeProduct(db2, "keep");
  const row = reprocessAnalysis(db2, keepId);
  assert.ok(row.id);
  db2.close();
  db.close();
});

test("purge redacts analysis, vectors, attachments and export copies; stripping contact is not anonymization", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const id = seedFeedback(db, "shop", "5");
  db.prepare(`
    INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, summary, status, next_attempt_at, created_at)
    VALUES (?, 'classification', 1, 0, 5, 't', '不該留下的摘要', 'completed', ?, ?)
  `).run(id, new Date().toISOString(), new Date().toISOString());
  db.prepare(`
    INSERT INTO embedding(feedback_id, analysis_id, provider, model, dim, normalization_version, vector, text_hash, status, created_at)
    VALUES (?, 1, 'stub', 'm', 2, 'n1', '[1,2]', 'hash', 'active', ?)
  `).run(id, new Date().toISOString());
  db.prepare(`
    INSERT INTO feedback_attachment(feedback_id, object_key, original_filename, mime, bytes, sha256, storage_provider, created_at)
    VALUES (?, 'obj-1', 'secret.png', 'image/png', 12, 'abc', 'local', ?)
  `).run(id, new Date().toISOString());
  db.prepare(`
    INSERT INTO product_handoff_export(product_id, manifest_json, payload_json, sha256, created_at)
    VALUES ('shop', '{"ok":true}', '{"secret":"keep-out"}', 'fff', ?)
  `).run(new Date().toISOString());

  const purged = purgeReplica(db, "shop", { confirm: "PURGE-shop" });
  assert.equal(purged.insight.analysis, 1);
  assert.equal(purged.insight.embeddings, 1);
  assert.equal(purged.insight.attachments, 1);
  assert.equal(purged.insight.exports, 1);
  assert.match(purged.exit.notes, /不是匿名化/);
  assert.equal(db.prepare("SELECT summary FROM feedback_analysis WHERE feedback_id=?").get(id).summary, "[purged]");
  assert.equal(db.prepare("SELECT vector, status FROM embedding WHERE feedback_id=?").get(id).status, "stale");
  assert.equal(db.prepare("SELECT original_filename FROM feedback_attachment WHERE feedback_id=?").get(id).original_filename, "[purged]");
  assert.equal(JSON.parse(db.prepare("SELECT payload_json FROM product_handoff_export WHERE product_id='shop'").get().payload_json).purged, true);
  db.close();
});

test("console exposes grant/revoke insight and retain; legal text excludes LLM", () => {
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  assert.match(js, /grant-insight/);
  assert.match(js, /revoke-insight/);
  assert.match(js, /允許跨站分析/);
  assert.match(js, /退出後保留/);
  assert.match(js, /去掉 email 不是匿名化/);
  assert.match(html, /跨站分析預設關/);
});
