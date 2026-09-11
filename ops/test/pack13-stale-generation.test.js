import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { ingestFeedback } from "../src/ingest.js";
import {
  createProduct,
  reconnectProduct,
  unsubscribeProduct,
  updateProductCapabilities,
} from "../src/products.js";
import { enqueueAnalysisRow, claimAnalysisBatch, completeAnalysis, getAnalysis } from "../src/feedbackAnalysis.js";
import { autoClusterFeedback } from "../src/clustering.js";
import { workerWriteDecision } from "../src/insightConsent.js";
import { runAnalysisOnce } from "../src/analysisWorker.js";
import { makeStubProvider } from "../src/ai/provider.js";

const root = dirname(fileURLToPath(import.meta.url));

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
      content: "訂閱世代驗收用的回饋內容要夠長才會過",
    },
  }).id;
}

test("analysis job is stamped with the current subscription generation", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  updateProductCapabilities(db, "shop", { cross_site_insight: true });
  const id = seedFeedback(db, "shop", "1");
  const row = enqueueAnalysisRow(db, { feedbackId: id });
  assert.equal(getAnalysis(db, row.id).subscription_generation, 1);
  db.close();
});

test("claim abandons jobs after unsubscribe without retain", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  updateProductCapabilities(db, "shop", { cross_site_insight: true });
  const id = seedFeedback(db, "shop", "2");
  const job = enqueueAnalysisRow(db, { feedbackId: id });
  unsubscribeProduct(db, "shop");
  assert.equal(workerWriteDecision(db, id, { expectedGeneration: 1 }).ok, false);
  assert.equal(claimAnalysisBatch(db, { limit: 5 }).length, 0);
  assert.equal(getAnalysis(db, job.id).status, "failed");
  assert.equal(getAnalysis(db, job.id).error_code, "subscription_revoked");
  db.close();
});

test("reconnect makes previous-generation jobs stale; late complete does not write", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  updateProductCapabilities(db, "shop", { cross_site_insight: true });
  const id = seedFeedback(db, "shop", "3");
  const job = enqueueAnalysisRow(db, { feedbackId: id });
  unsubscribeProduct(db, "shop");
  reconnectProduct(db, "shop");
  updateProductCapabilities(db, "shop", { cross_site_insight: true });
  assert.equal(workerWriteDecision(db, id, { expectedGeneration: 1 }).reason, "stale_generation");
  assert.equal(claimAnalysisBatch(db, { limit: 5 }).length, 0);
  assert.equal(getAnalysis(db, job.id).error_code, "stale_generation");
  assert.throws(
    () => completeAnalysis(db, job.id, {
      provider: "stub",
      model: "x",
      result: { category: "BUG", summary: "晚到不該寫入", severity_hint: "LOW", confidence: 0.4, language: "zh-TW" },
      rawOutputHash: "abc",
    }),
    /訂閱世代/,
  );
  assert.notEqual(getAnalysis(db, job.id).status, "completed");
  assert.equal(autoClusterFeedback(db, { feedbackId: id, currentAnalysis: { subscription_generation: 1 } }).action, "subscription_blocked");
  db.close();
});

test("worker does not complete a stale job even if it was already claimed", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  updateProductCapabilities(db, "shop", { cross_site_insight: true });
  const id = seedFeedback(db, "shop", "4");
  enqueueAnalysisRow(db, { feedbackId: id });
  const claimed = claimAnalysisBatch(db, { limit: 1 });
  assert.equal(claimed.length, 1);
  unsubscribeProduct(db, "shop");
  reconnectProduct(db, "shop");
  updateProductCapabilities(db, "shop", { cross_site_insight: true });
  const out = await runAnalysisOnce(db, { provider: makeStubProvider(), now: () => new Date(), random: () => 0.5 });
  assert.equal(out.completed, 0);
  assert.equal(getAnalysis(db, claimed[0].id).status, "failed");
  db.close();
});

test("console explains stale-generation jobs will not open issues", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  assert.match(html, /晚到的分析若訂閱世代已換，不會開新議題/);
  assert.match(html, /console\.js\?v=20260911-pkg13/);
});
