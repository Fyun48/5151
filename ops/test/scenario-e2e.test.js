import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import "./secretAtRestKey.js";

process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";
Object.assign(process.env, { STAGING_PROVIDER: "stub", STAGING_ENV_CLASS: "staging", STAGING_ENV_ID: "staging-1", STAGING_DB_CLASS: "disposable", STAGING_STORAGE_MODE: "isolated", STAGING_INTEGRATION_MODE: "sandbox", STAGING_MIGRATION_MODE: "isolated" });

import { openOpsDb } from "../src/opsDb.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { ingestFeedback } from "../src/ingest.js";
import { claimAnalysisBatch, completeAnalysis } from "../src/feedbackAnalysis.js";
import { createIssue, linkFeedback } from "../src/clustering.js";
import { ensureDefaultProduct, updateProductCapabilities } from "../src/products.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { runProposalOnce } from "../src/proposalWorker.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";
import { getCurrentIssueProposal, submitOwnerDecision } from "../src/proposal.js";
import { makeGitRepo } from "../src/coding/gitRepo.js";
import { makeStubCodingProvider } from "../src/coding/provider.js";
import { makeStubPrGateway } from "../src/coding/prGateway.js";
import { createCodingTask, claimCodingTaskBatch, executeCodingTask, cancelCodingTask } from "../src/codingTask.js";
import { createQaRun, executeQaRun } from "../src/qaRun.js";
import { createStagingDeployment, claimStagingBatch, executeStagingDeployment } from "../src/stagingDeploy.js";
import { makeStubStagingProvider } from "../src/staging/provider.js";
import { createReleaseCandidate, submitOwnerReleaseDecision } from "../src/releaseCandidate.js";
import { listUnknownProductionRuns } from "../src/exitDrill.js";

const NOW = new Date();
let seq = 1;

function seedProposeIssue(db) {
  // 走真實公開 helper：ingest → 分析（claim/complete）→ clustering（createIssue/linkFeedback）→ impact。
  ensureDefaultProduct(db, { now: NOW });
  updateProductCapabilities(db, "v3", { cross_site_insight: true }, { actor: "owner", now: NOW });
  const fids = [];
  for (let k = 0; k < 8; k++) {
    const i = seq++;
    const r = ingestFeedback(db, {
      deliveryId: `d${i}`, payload: { idempotency_key: `k${i}`, kind: "bug", content: `content ${i}`, contact: "a@b.c", user_ref: `reporter-${i}`, app_version: "3.47" },
      payloadHash: `h${i}`, productId: "v3", now: NOW,
    });
    assert.ok(!r.duplicate && !r.conflict);
    fids.push(Number(r.id));
  }
  const batch = claimAnalysisBatch(db, { limit: 20, now: NOW });
  assert.ok(batch.length >= 8);
  let issueId = null;
  for (const a of batch.slice(0, 8)) {
    completeAnalysis(db, a.id, { provider: "stub", model: "m", result: { category: "BUG", summary: "symptom", severity_hint: "HIGH", confidence: 0.8, language: "zh-TW" }, rawOutputHash: "h", now: NOW });
    if (issueId == null) {
      const analysisRow = db.prepare("SELECT * FROM feedback_analysis WHERE id=?").get(a.id);
      issueId = createIssue(db, { analysis: analysisRow, actor: "system", now: NOW });
    }
    linkFeedback(db, { issueId, feedbackId: Number(a.feedback_id), analysisId: a.id, addedBy: "auto", membershipStatus: "active", now: NOW });
  }
  calculateAndStoreImpact(db, issueId, { now: NOW });
  return issueId;
}

function initGitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "scn-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "scn-remote-"));
  execFileSync("git", ["init", "-q", "-b", "master", dir]);
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github", "workflows", "test.yml"), "name: Tests\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: 'node -e "process.exit(0)"' } }) + "\n");
  writeFileSync(path.join(dir, "README.md"), "base\n");
  git(["add", "-A"]); git(["commit", "-q", "-m", "base"]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(["remote", "add", "origin", remote]);
  return { dir, remote, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} try { rmSync(remote, { recursive: true, force: true }); } catch {} } };
}

async function evaluateProposeApprove(db, iid, action = "APPROVE_DEVELOPMENT") {
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  const out = submitOwnerDecision(db, iid, { action, proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
  return { cur, out };
}

async function chainToStaging(db, iid) {
  const g = initGitRepo(); const repo = makeGitRepo(g.dir); const prov = makeStubCodingProvider();
  const { task } = createCodingTask(db, { issueId: iid, provider: prov, repo, now: NOW });
  const [c] = claimCodingTaskBatch(db, { now: NOW, limit: 5 });
  await executeCodingTask(db, c, { provider: prov, repo, pr: makeStubPrGateway(), selfTest: async () => ({ ran: true, passed: true }), now: NOW });
  const { run } = createQaRun(db, { codingTaskId: task.id, repo, now: NOW });
  await executeQaRun(db, run, { repo, now: NOW });
  createStagingDeployment(db, { codingTaskId: task.id, repo, now: NOW });
  const [d] = claimStagingBatch(db, { now: NOW, limit: 5 });
  await executeStagingDeployment(db, d, { repo, provider: makeStubStagingProvider(), now: NOW });
  return { g, task };
}

// Scenario A — chained flow stops at the release request; Production dispatch is NOT called.
test("Scenario A: chained flow reaches release request without dispatching Production", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedProposeIssue(db);
  await evaluateProposeApprove(db, iid, "APPROVE_DEVELOPMENT");
  const { g, task } = await chainToStaging(db, iid);
  const repo = makeGitRepo(g.dir);
  const { candidate } = createReleaseCandidate(db, { codingTaskId: task.id, repo, now: NOW });
  const decided = submitOwnerReleaseDecision(db, {
    codingTaskId: task.id, action: "APPROVE_RELEASE", manifestId: candidate.id, manifestVersion: candidate.manifest_version,
    manifestHash: candidate.manifest_hash, artifactDigest: candidate.artifact_digest, headSha: candidate.head_sha, repo, now: NOW,
  });
  assert.ok(decided.authorization?.id);
  // 負向斷言：只產生 release 請求，不真正 dispatch Production。
  const runs = db.prepare("SELECT COUNT(*) AS n FROM production_release_run").get().n;
  assert.equal(Number(runs), 0);
  g.cleanup(); db.close();
});

// Scenario B — Owner reject archives; no coding/release is created.
test("Scenario B: Owner reject archives the issue and creates no coding or release", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedProposeIssue(db);
  await evaluateProposeApprove(db, iid, "REJECT");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM development_coding_task WHERE issue_id=?").get(iid).n), 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM development_release_candidate WHERE coding_task_id IS NOT NULL").get().n), 0);
  // 決策仍保留在 append-only 決策史。
  const decision = db.prepare("SELECT action FROM proposal_owner_decision WHERE issue_id=? ORDER BY id DESC LIMIT 1").get(iid);
  assert.equal(decision.action, "REJECT");
  // 生命週期推進到 REJECTED（終端，不再可開發生產）。
  const entity = db.prepare("SELECT state FROM state_entity WHERE id=?").get(`issue:${iid}`);
  assert.equal(entity?.state, "REJECTED");
  db.close();
});

// Scenario C — request changes drives a revised proposal (v2); v1 stays immutable.
test("Scenario C: request changes generates proposal v2 and preserves immutable v1", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedProposeIssue(db);
  const { cur } = await evaluateProposeApprove(db, iid, "REQUEST_CHANGES");
  assert.equal(Number(cur.proposal_version), 1);
  // 生命週期推進到 PROPOSAL_CHANGES_REQUESTED。
  let entity = db.prepare("SELECT state FROM state_entity WHERE id=?").get(`issue:${iid}`);
  assert.equal(entity?.state, "PROPOSAL_CHANGES_REQUESTED");

  // 材料變更：新增一筆回饋並完成分析／連結到議題。
  const nf = ingestFeedback(db, {
    deliveryId: `d-new-${seq++}`, payload: { idempotency_key: `k-new-${seq}`, kind: "bug", content: "new material change", contact: "a@b.c", user_ref: "reporter-new", app_version: "3.48" },
    payloadHash: "h-new", productId: "v3", now: NOW,
  });
  const nb = claimAnalysisBatch(db, { limit: 1, now: NOW });
  const na = nb[0];
  completeAnalysis(db, na.id, { provider: "stub", model: "m", result: { category: "BUG", summary: "new symptom", severity_hint: "HIGH", confidence: 0.9, language: "zh-TW" }, rawOutputHash: "h-new", now: NOW });
  linkFeedback(db, { issueId: iid, feedbackId: Number(nf.id), analysisId: na.id, addedBy: "auto", membershipStatus: "active", now: NOW });
  calculateAndStoreImpact(db, iid, { now: NOW });

  // 重評（材料變更使評估 stale）＋重新提案 → v2。
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });

  const v1 = db.prepare("SELECT * FROM issue_proposal WHERE issue_id=? AND proposal_version=1").get(iid);
  const v2 = db.prepare("SELECT * FROM issue_proposal WHERE issue_id=? AND proposal_version=2").get(iid);
  assert.ok(v1, "v1 must remain immutable");
  assert.ok(v2, "revised proposal v2 must be generated");
  assert.equal(v1.proposal_hash, cur.proposal_hash); // v1 內容未變
  const current = db.prepare("SELECT proposal_version FROM issue_proposal_current WHERE issue_id=?").get(iid);
  assert.equal(Number(current.proposal_version), 2); // current 指標移到 v2
  // 尚未核准開發 → 無 coding。
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM development_coding_task WHERE issue_id=?").get(iid).n), 0);
  db.close();
});

// Scenario D — worker claims/開始後 Owner 取消；晚到的結果被拒絕、workflow 保持取消。
test("Scenario D: owner cancel during worker claim rejects the late coding result", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedProposeIssue(db);
  await evaluateProposeApprove(db, iid, "APPROVE_DEVELOPMENT");
  const g = initGitRepo(); const repo = makeGitRepo(g.dir); const prov = makeStubCodingProvider();
  const { task } = createCodingTask(db, { issueId: iid, provider: prov, repo, now: NOW });
  const [c] = claimCodingTaskBatch(db, { now: NOW, limit: 5 });
  assert.equal(c.status, "claimed"); // worker 已 claim／開始
  cancelCodingTask(db, task.id, { actor: "owner", reason: "stop", now: NOW });
  const late = await executeCodingTask(db, c, { provider: prov, repo, pr: makeStubPrGateway(), selfTest: async () => ({ ran: true, passed: true }), now: NOW });
  assert.equal(late.skipped, true);
  assert.equal(late.reason, "cancelled");
  const fresh = db.prepare("SELECT status FROM development_coding_task WHERE id=?").get(task.id);
  assert.equal(fresh.status, "cancelled");
  // 不得進入 QA / staging / release。
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM development_qa_run WHERE coding_task_id=?").get(task.id).n), 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM development_staging_deployment WHERE coding_task_id=?").get(task.id).n), 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM development_release_candidate WHERE coding_task_id=?").get(task.id).n), 0);
  g.cleanup(); db.close();
});

