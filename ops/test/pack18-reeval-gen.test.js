import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";

import { openOpsDb } from "../src/opsDb.js";
import { createProduct, reconnectProduct, unsubscribeProduct } from "../src/products.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { runProposalOnce } from "../src/proposalWorker.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";
import { getCurrentIssueProposal, submitOwnerDecision } from "../src/proposal.js";
import { findEntity } from "../src/stateMachine.js";
import { reevaluationConfig } from "../src/reevaluationPolicy.js";
import { assessReevaluation, authorizeAndReopen, autoReevaluationDecision, ownerManualReevaluate } from "../src/reevaluation.js";
import { runReevaluationOnce } from "../src/reevaluationWorker.js";
import { inferIssueProductId, issueWriteDecision } from "../src/insightConsent.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-06-01T00:00:00.000Z");
const CFG0 = reevaluationConfig({ REEVAL_COOLDOWN_MS: "0" });
let seq = 1;
const state = (db, iid) => findEntity(db, `issue:${iid}`)?.state;

function link(db, iid, fid, aid) {
  db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, NOW.toISOString());
}

function seedFeedback(db, { severity = "HIGH", category = "BUG", productId = null } = {}) {
  const i = seq++;
  const ts = NOW.toISOString();
  if (productId) {
    db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at, product_id) VALUES (?, ?, 'v3', 'bug', ?, 'leak@example.com', ?, '3.47', ?, ?)").run(`d${i}`, `k${i}`, `c${i}`, `reporter-${i}`, ts, productId);
  } else {
    db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, 'leak@example.com', ?, '3.47', ?)").run(`d${i}`, `k${i}`, `c${i}`, `reporter-${i}`, ts);
  }
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', ?, 's', ?, 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, category, severity, ts, ts, ts);
  const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
  return { fid, aid };
}

function seedIssue(db, { members = 8, severity = "HIGH", category = "BUG", productId = null } = {}) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,product_id,created_at,updated_at) VALUES('t','s',?,'cluster-v1','open',?,?,?)").run(category, productId, ts, ts).lastInsertRowid);
  for (let k = 0; k < members; k++) {
    const f = seedFeedback(db, { severity, category, productId });
    link(db, iid, f.fid, f.aid);
  }
  calculateAndStoreImpact(db, iid, { now: NOW });
  return iid;
}

function grow(db, iid, { count = 4, severity = "HIGH", productId = null } = {}) {
  for (let k = 0; k < count; k++) {
    const f = seedFeedback(db, { severity, productId });
    link(db, iid, f.fid, f.aid);
  }
  calculateAndStoreImpact(db, iid, { now: NOW });
}

async function decideIssue(db, { members = 8, category = "BUG", decision, productId = null } = {}) {
  const iid = seedIssue(db, { members, category, productId });
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  submitOwnerDecision(db, iid, { action: decision, proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
  return { iid, proposal: cur };
}

test("Owner defer on a product stamps the current subscription generation", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { iid } = await decideIssue(db, { decision: "DEFER", productId: "shop" });
  const row = db.prepare("SELECT subscription_generation FROM proposal_owner_decision WHERE issue_id=? AND action='DEFER'").get(iid);
  assert.equal(row.subscription_generation, 1);
  db.close();
});

test("auto reopen still works while the subscription is connected", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { iid } = await decideIssue(db, { decision: "DEFER", productId: "shop" });
  grow(db, iid, { count: 4, productId: "shop" });
  assert.equal(assessReevaluation(db, iid, { now: NOW, config: CFG0 }).eligible, true);
  const r = authorizeAndReopen(db, iid, { now: NOW, config: CFG0 });
  assert.equal(r.reopened, true);
  assert.equal(state(db, iid), "EVALUATING");
  assert.equal(r.authorization.subscription_generation, 1);
  db.close();
});

test("unsubscribe blocks auto reopen and does not write authorization", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { iid } = await decideIssue(db, { decision: "DEFER", productId: "shop" });
  grow(db, iid, { count: 4, productId: "shop" });
  unsubscribeProduct(db, "shop");
  assert.equal(issueWriteDecision(db, iid, { expectedGeneration: 1 }).ok, false);
  const a = assessReevaluation(db, iid, { now: NOW, config: CFG0 });
  assert.equal(a.eligible, false);
  assert.equal(a.reason, "subscription_revoked");
  assert.throws(() => authorizeAndReopen(db, iid, { now: NOW, config: CFG0 }), /subscription_revoked/);
  const s = runReevaluationOnce(db, { now: () => NOW, config: CFG0 });
  assert.equal(s.reopened, 0);
  assert.equal(state(db, iid), "DEFERRED");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM issue_reevaluation_authorization WHERE issue_id=?").get(iid).n, 0);
  db.close();
});

test("reconnect makes previous-generation auto reopen fail without writing", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { iid } = await decideIssue(db, { decision: "DEFER", productId: "shop" });
  grow(db, iid, { count: 4, productId: "shop" });
  unsubscribeProduct(db, "shop");
  reconnectProduct(db, "shop");
  const a = assessReevaluation(db, iid, { now: NOW, config: CFG0 });
  assert.equal(a.eligible, false);
  assert.equal(a.reason, "stale_generation");
  assert.throws(() => authorizeAndReopen(db, iid, { now: NOW, config: CFG0 }), /stale_generation/);
  assert.equal(state(db, iid), "DEFERRED");
  db.close();
});

test("issues without issue.product_id still auto-reopen via inferred feedback product", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await decideIssue(db, { decision: "DEFER" });
  grow(db, iid, { count: 4 });
  assert.equal(inferIssueProductId(db, iid), "v3");
  assert.equal(issueWriteDecision(db, iid).ok, true);
  const s = runReevaluationOnce(db, { now: () => NOW, config: CFG0 });
  assert.equal(s.reopened, 1);
  assert.equal(state(db, iid), "EVALUATING");
  db.close();
});

test("issues with no inferable product stay compatible (unbound gate allows auto)", () => {
  const db = openOpsDb(":memory:");
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
  assert.equal(inferIssueProductId(db, iid), null);
  assert.equal(issueWriteDecision(db, iid).unbound, true);
  assert.equal(autoReevaluationDecision(db, iid, { subscription_generation: null }).ok, true);
  db.close();
});

test("Owner manual reevaluate still works after unsubscribe", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { iid } = await decideIssue(db, { decision: "DEFER", productId: "shop" });
  calculateAndStoreImpact(db, iid, { now: NOW });
  unsubscribeProduct(db, "shop");
  const r = ownerManualReevaluate(db, iid, { actor: "owner:x", now: NOW, config: CFG0 });
  assert.equal(r.reopened, true);
  assert.equal(state(db, iid), "EVALUATING");
  db.close();
});

test("pending list marks blocked auto reevaluation after unsubscribe", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const { iid } = await decideIssue(db, { decision: "DEFER", productId: "shop" });
  unsubscribeProduct(db, "shop");
  const pending = listPendingWork(db, "shop");
  const item = pending.items.find((it) => it.kind === "reevaluation");
  assert.ok(item);
  assert.equal(item.id, iid);
  assert.equal(item.state, "subscription_revoked");
  assert.equal(item.blocking, false);
  assert.match(item.note, /不會把舊議題重開/);
  const other = listPendingWork(db, "other");
  assert.equal(other.items.filter((it) => it.kind === "reevaluation").length, 0);
  db.close();
});

test("console explains auto reevaluation will not reopen after generation change", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /自動重評/);
  assert.match(html, /把舊議題重開/);
  assert.match(js, /自動重評不會把舊議題重開/);
  assert.match(html, /console\.js\?v=20260912-pkg18/);
});
