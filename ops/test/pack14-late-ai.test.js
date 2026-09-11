import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import {
  createProduct,
  reconnectProduct,
  unsubscribeProduct,
} from "../src/products.js";
import { issueWriteDecision, productNotifyDecision } from "../src/insightConsent.js";
import { enqueueEvaluationRun, claimEvaluationBatch, executeEvaluationRun } from "../src/evaluation.js";
import { enqueueProposalRow, claimProposalBatch, executeProposalGeneration, currentProposalId } from "../src/proposal.js";
import { runImpactOnce } from "../src/impactWorker.js";
import { makeStubProvider } from "../src/ai/provider.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function seedIssue(db, productId, title = "世代驗收議題") {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO issue_candidate(title, summary, category, clustering_version, status, product_id, created_at, updated_at)
    VALUES (?, 's', 'BUG', 'cluster-v1', 'open', ?, ?, ?)
  `).run(title, productId, ts, ts).lastInsertRowid);
}

function seedUnboundIssue(db) {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO issue_candidate(title, summary, category, clustering_version, status, created_at, updated_at)
    VALUES ('未綁站議題', 's', 'BUG', 'cluster-v1', 'open', ?, ?)
  `).run(ts, ts).lastInsertRowid);
}

test("evaluation job is stamped with the current subscription generation", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const issueId = seedIssue(db, "shop");
  const row = enqueueEvaluationRun(db, { issueId });
  const stored = db.prepare("SELECT subscription_generation FROM issue_evaluation_run WHERE id=?").get(row.id);
  assert.equal(stored.subscription_generation, 1);
  db.close();
});

test("unbound issues still enqueue evaluation for compatibility", () => {
  const db = openOpsDb(":memory:");
  const issueId = seedUnboundIssue(db);
  assert.equal(issueWriteDecision(db, issueId).unbound, true);
  const row = enqueueEvaluationRun(db, { issueId });
  const stored = db.prepare("SELECT subscription_generation FROM issue_evaluation_run WHERE id=?").get(row.id);
  assert.equal(stored.subscription_generation, null);
  db.close();
});

test("claim abandons evaluation and proposal after unsubscribe", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const issueId = seedIssue(db, "shop");
  const evalJob = enqueueEvaluationRun(db, { issueId });
  const propJob = enqueueProposalRow(db, { issueId });
  unsubscribeProduct(db, "shop");
  assert.equal(issueWriteDecision(db, issueId, { expectedGeneration: 1 }).ok, false);
  assert.equal(claimEvaluationBatch(db, { limit: 5 }).length, 0);
  assert.equal(claimProposalBatch(db, { limit: 5 }).length, 0);
  assert.equal(db.prepare("SELECT status, error_code FROM issue_evaluation_run WHERE id=?").get(evalJob.id).error_code, "subscription_revoked");
  assert.equal(db.prepare("SELECT status, error_code FROM issue_proposal WHERE id=?").get(propJob.id).error_code, "subscription_revoked");
  db.close();
});

test("reconnect makes previous-generation eval/proposal stale; late execute does not write", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const issueId = seedIssue(db, "shop");
  const evalJob = enqueueEvaluationRun(db, { issueId });
  const propJob = enqueueProposalRow(db, { issueId });
  const evalClaimed = claimEvaluationBatch(db, { limit: 1 });
  const propClaimed = claimProposalBatch(db, { limit: 1 });
  assert.equal(evalClaimed.length, 1);
  assert.equal(propClaimed.length, 1);
  unsubscribeProduct(db, "shop");
  reconnectProduct(db, "shop");
  assert.equal(issueWriteDecision(db, issueId, { expectedGeneration: 1 }).reason, "stale_generation");
  const provider = makeStubProvider();
  const evalStatus = await executeEvaluationRun(db, evalClaimed[0], { provider, now: () => new Date(), random: () => 0.5 });
  const propStatus = await executeProposalGeneration(db, propClaimed[0], { provider, now: () => new Date(), random: () => 0.5 });
  assert.equal(evalStatus, "failed");
  assert.equal(propStatus, "failed");
  assert.equal(db.prepare("SELECT status FROM issue_evaluation_run WHERE id=?").get(evalJob.id).status, "failed");
  assert.equal(db.prepare("SELECT status FROM issue_proposal WHERE id=?").get(propJob.id).status, "failed");
  assert.equal(db.prepare("SELECT evaluation_run_id FROM issue_evaluation_current WHERE issue_id=?").get(issueId), undefined);
  assert.equal(currentProposalId(db, issueId), null);
  assert.equal(provider.getUsage().calls, 0);
  db.close();
});

test("impact worker skips bound issues after unsubscribe", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  seedIssue(db, "shop");
  unsubscribeProduct(db, "shop");
  const out = runImpactOnce(db);
  assert.equal(out.recalculated, 0);
  db.close();
});

test("product notify decision rejects stale generation and exited subscription", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  assert.equal(productNotifyDecision(db, "shop", { expectedGeneration: 1 }).ok, true);
  unsubscribeProduct(db, "shop");
  assert.equal(productNotifyDecision(db, "shop", { expectedGeneration: 1 }).ok, false);
  reconnectProduct(db, "shop");
  assert.equal(productNotifyDecision(db, "shop", { expectedGeneration: 1 }).reason, "stale_generation");
  assert.equal(productNotifyDecision(db, "shop", { expectedGeneration: 2 }).ok, true);
  db.close();
});

test("pending list explains late eval and proposal will not write", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const issueId = seedIssue(db, "shop");
  enqueueEvaluationRun(db, { issueId });
  enqueueProposalRow(db, { issueId });
  const pending = listPendingWork(db, "shop");
  assert.ok(pending.items.some((it) => it.kind === "evaluation" && /晚到評估/.test(it.note)));
  assert.ok(pending.items.some((it) => it.kind === "proposal" && /webhook/.test(it.note)));
  db.close();
});

test("console explains late eval proposal and webhook will not notify", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  assert.match(html, /晚到的分析、評估、提案/);
  assert.match(html, /console\.js\?v=20260911-pkg1/);
});
