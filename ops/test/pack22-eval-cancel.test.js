import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { ingestFeedback } from "../src/ingest.js";
import { createProduct, updateProductCapabilities } from "../src/products.js";
import {
  cancelAnalysis,
  claimAnalysisBatch,
  completeAnalysis,
  enqueueAnalysisRow,
  failAnalysis,
  getAnalysis,
} from "../src/feedbackAnalysis.js";
import { runAnalysisOnce } from "../src/analysisWorker.js";
import { makeStubProvider } from "../src/ai/provider.js";
import {
  cancelEvaluation,
  claimEvaluationBatch,
  enqueueEvaluationRun,
  executeEvaluationRun,
} from "../src/evaluation.js";
import {
  cancelProposal,
  claimProposalBatch,
  currentProposalId,
  enqueueProposalRow,
  executeProposalGeneration,
} from "../src/proposal.js";
import { listPendingWork } from "../src/exitDrill.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";

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

function seedAnalysisJob(db, productId, suffix) {
  const feedbackId = seedFeedback(db, productId, suffix);
  updateProductCapabilities(db, productId, { cross_site_insight: true });
  return { feedbackId, job: enqueueAnalysisRow(db, { feedbackId }) };
}

function seedIssue(db, productId, title = "取消驗收議題") {
  const ts = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO issue_candidate(title, summary, category, clustering_version, status, product_id, created_at, updated_at)
    VALUES (?, 's', 'BUG', 'cluster-v1', 'open', ?, ?, ?)
  `).run(title, productId, ts, ts).lastInsertRowid);
}

function completePayload() {
  return {
    provider: "stub",
    model: "x",
    result: { category: "BUG", summary: "晚到不該寫入", severity_hint: "LOW", confidence: 0.4, language: "zh-TW" },
    rawOutputHash: "abc",
  };
}

test("cancel pending analysis and drop it from the pending list", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const { job } = seedAnalysisJob(db, "shop", "a1");
  const before = listPendingWork(db, "shop").items.find((it) => it.kind === "analysis");
  assert.ok(before);
  assert.equal(before.id, job.id);
  assert.match(before.note, /可取消/);
  const out = cancelAnalysis(db, job.id, { actor: "owner", reason: "stop_analyze" });
  assert.equal(out.cancelled, true);
  assert.equal(out.in_flight_not_withdrawn, false);
  assert.equal(out.analysis.status, "cancelled");
  assert.equal(out.analysis.error_code, "owner_cancelled:stop_analyze");
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "analysis").length, 0);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "analysis").length, 0);
  assert.equal(claimAnalysisBatch(db, { limit: 5 }).length, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='feedback.analysis.cancelled'").get().n >= 1);
  db.close();
});

test("cancel pending evaluation and proposal and drop them from the pending list", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const issueId = seedIssue(db, "shop");
  const evalJob = enqueueEvaluationRun(db, { issueId });
  const propJob = enqueueProposalRow(db, { issueId });
  const pending = listPendingWork(db, "shop").items;
  assert.ok(pending.find((it) => it.kind === "evaluation" && it.id === evalJob.id));
  assert.ok(pending.find((it) => it.kind === "proposal" && it.id === propJob.id));
  const evalOut = cancelEvaluation(db, evalJob.id, { actor: "owner", reason: "stop_eval" });
  const propOut = cancelProposal(db, propJob.id, { actor: "owner", reason: "stop_prop" });
  assert.equal(evalOut.cancelled, true);
  assert.equal(evalOut.run.status, "cancelled");
  assert.equal(evalOut.run.error_code, "owner_cancelled:stop_eval");
  assert.equal(propOut.cancelled, true);
  assert.equal(propOut.proposal.status, "cancelled");
  assert.equal(propOut.proposal.error_code, "owner_cancelled:stop_prop");
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "evaluation" || it.kind === "proposal").length, 0);
  assert.equal(claimEvaluationBatch(db, { limit: 5 }).length, 0);
  assert.equal(claimProposalBatch(db, { limit: 5 }).length, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.evaluation.cancelled'").get().n >= 1);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.proposal.cancelled'").get().n >= 1);
  db.close();
});

test("cancel is idempotent and does not rewrite a completed result", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { feedbackId, job } = seedAnalysisJob(db, "shop", "a2");
  const first = cancelAnalysis(db, job.id, { actor: "owner" });
  const second = cancelAnalysis(db, job.id, { actor: "owner" });
  assert.equal(first.cancelled, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.analysis.status, "cancelled");

  completeAnalysis(db, job.id, completePayload());
  assert.equal(getAnalysis(db, job.id).status, "cancelled");
  assert.equal(db.prepare("SELECT analysis_id FROM feedback_analysis_current WHERE feedback_id=?").get(feedbackId), undefined);

  const issueId = seedIssue(db, "shop", "已完成不可取消");
  const ts = new Date().toISOString();
  const doneEval = Number(db.prepare(`
    INSERT INTO issue_evaluation_run(issue_id, evaluation_version, aggregation_version, role_set_version, input_fingerprint, status, deliberation_enabled, retry_count, max_retries, next_attempt_at, created_at, final_recommendation)
    VALUES (?, 'eval-v1', 'agg-v1', 'role-v1', 'fp-done', 'completed', 0, 0, 5, ?, ?, 'PROPOSE')
  `).run(issueId, ts, ts).lastInsertRowid);
  db.prepare(`
    INSERT INTO issue_evaluation_current(issue_id, evaluation_run_id, input_fingerprint, policy_fingerprint, final_recommendation, updated_at)
    VALUES (?, ?, 'fp-done', 'pol', 'PROPOSE', ?)
  `).run(issueId, doneEval, ts);
  assert.throws(() => cancelEvaluation(db, doneEval, { actor: "owner" }), (err) => err.status === 409 && /不改寫/.test(err.message));
  assert.equal(db.prepare("SELECT evaluation_run_id FROM issue_evaluation_current WHERE issue_id=?").get(issueId).evaluation_run_id, doneEval);

  const doneProp = Number(db.prepare(`
    INSERT INTO issue_proposal(issue_id, proposal_version, generation_version, proposal_hash, status, retry_count, max_retries, next_attempt_at, created_at, title)
    VALUES (?, 1, 'proposal-v1', 'hash-done', 'completed', 0, 5, ?, ?, '已完成提案')
  `).run(issueId, ts, ts).lastInsertRowid);
  db.prepare(`
    INSERT INTO issue_proposal_current(issue_id, proposal_id, proposal_version, proposal_hash, input_fingerprint, updated_at)
    VALUES (?, ?, 1, 'hash-done', 'fp-prop', ?)
  `).run(issueId, doneProp, ts);
  assert.throws(() => cancelProposal(db, doneProp, { actor: "owner" }), (err) => err.status === 409 && /不改寫/.test(err.message));
  assert.equal(currentProposalId(db, issueId), doneProp);
  db.close();
});

test("late complete after cancel does not write current", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { feedbackId, job } = seedAnalysisJob(db, "shop", "a3");
  cancelAnalysis(db, job.id, { actor: "owner" });
  const promo = completeAnalysis(db, job.id, completePayload());
  assert.equal(promo.skipped, true);
  assert.equal(promo.reason, "cancelled");
  assert.equal(promo.promoted, false);
  assert.equal(getAnalysis(db, job.id).status, "cancelled");
  assert.equal(db.prepare("SELECT analysis_id FROM feedback_analysis_current WHERE feedback_id=?").get(feedbackId), undefined);

  const issueId = seedIssue(db, "shop", "晚到評估提案");
  const evalJob = enqueueEvaluationRun(db, { issueId });
  const propJob = enqueueProposalRow(db, { issueId });
  cancelEvaluation(db, evalJob.id, { actor: "owner" });
  cancelProposal(db, propJob.id, { actor: "owner" });
  const evalStatus = await executeEvaluationRun(db, { ...evalJob, issue_id: issueId, deliberation_enabled: 0, retry_count: 0, max_retries: 5, subscription_generation: 1 }, {
    provider: makeStubEvaluationProvider(),
    now: () => new Date(),
    random: () => 0.5,
  });
  const propStatus = await executeProposalGeneration(db, { ...propJob, issue_id: issueId, proposal_version: 1, retry_count: 0, max_retries: 5, subscription_generation: 1 }, {
    provider: makeStubProposalProvider(),
    now: () => new Date(),
    random: () => 0.5,
  });
  assert.equal(evalStatus, "cancelled");
  assert.equal(propStatus, "cancelled");
  assert.equal(db.prepare("SELECT status FROM issue_evaluation_run WHERE id=?").get(evalJob.id).status, "cancelled");
  assert.equal(db.prepare("SELECT status FROM issue_proposal WHERE id=?").get(propJob.id).status, "cancelled");
  assert.equal(db.prepare("SELECT evaluation_run_id FROM issue_evaluation_current WHERE issue_id=?").get(issueId), undefined);
  assert.equal(currentProposalId(db, issueId), null);
  db.close();
});

test("cancel during analysis does not claim the call was withdrawn", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { feedbackId, job } = seedAnalysisJob(db, "shop", "a4");
  let cancelledMid = null;
  const inner = makeStubProvider();
  const provider = {
    ...inner,
    async analyze(args) {
      cancelledMid = cancelAnalysis(db, job.id, { actor: "owner", reason: "mid_run" });
      return inner.analyze(args);
    },
  };
  const out = await runAnalysisOnce(db, { provider, now: () => new Date(), random: () => 0.5 });
  assert.equal(cancelledMid.cancelled, true);
  assert.equal(cancelledMid.in_flight_not_withdrawn, true);
  assert.equal(out.completed, 0);
  assert.equal(out.cancelled, 1);
  assert.equal(getAnalysis(db, job.id).status, "cancelled");
  assert.equal(db.prepare("SELECT analysis_id FROM feedback_analysis_current WHERE feedback_id=?").get(feedbackId), undefined);
  db.close();
});

test("fail helpers do not overwrite cancelled", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { feedbackId, job } = seedAnalysisJob(db, "shop", "a5");
  const row = getAnalysis(db, job.id);
  cancelAnalysis(db, job.id, { actor: "owner" });
  const failed = failAnalysis(db, row, { errorCode: "timeout", transient: true });
  assert.equal(failed.status, "cancelled");
  assert.equal(failed.skipped, true);
  assert.equal(getAnalysis(db, job.id).status, "cancelled");
  db.close();
});

test("console exposes pending-list cancel for analysis, evaluation, and proposal", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /未送出的分析、評估、提案也可取消/);
  assert.match(html, /console\.js\?v=20260913-pkg25/);
  assert.match(js, /\/ops\/api\/analyses\/\$\{id\}\/cancel/);
  assert.match(js, /\/ops\/api\/evaluation-runs\/\$\{id\}\/cancel/);
  assert.match(js, /\/ops\/api\/proposals\/\$\{id\}\/cancel/);
  assert.match(js, /取消未送出的分析/);
  assert.match(js, /取消未送出的評估/);
  assert.match(js, /取消未送出的提案/);
  assert.match(js, /已在跑的分析不宣稱撤回外部呼叫/);
});
