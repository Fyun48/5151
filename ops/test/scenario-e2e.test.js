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
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { runProposalOnce } from "../src/proposalWorker.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";
import { getCurrentIssueProposal, submitOwnerDecision } from "../src/proposal.js";
import { makeGitRepo } from "../src/coding/gitRepo.js";
import { makeStubCodingProvider } from "../src/coding/provider.js";
import { makeStubPrGateway } from "../src/coding/prGateway.js";
import { createCodingTask, claimCodingTaskBatch, executeCodingTask } from "../src/codingTask.js";
import { createQaRun, executeQaRun } from "../src/qaRun.js";
import { createStagingDeployment, claimStagingBatch, executeStagingDeployment } from "../src/stagingDeploy.js";
import { makeStubStagingProvider } from "../src/staging/provider.js";
import { createReleaseCandidate, submitOwnerReleaseDecision } from "../src/releaseCandidate.js";
import { listUnknownProductionRuns } from "../src/exitDrill.js";

const NOW = new Date();
let seq = 1;

function seedProposeIssue(db) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
  for (let k = 0; k < 8; k++) {
    const i = seq++;
    db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, 'a@b.c', ?, '3.47', ?)").run(`d${i}`, `k${i}`, `content ${i}`, `reporter-${i}`, ts);
    const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
    db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', 'BUG', 'symptom', 'HIGH', 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, ts, ts, ts);
    const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
    db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
    db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, ts);
  }
  calculateAndStoreImpact(db, iid, { now: NOW });
  return iid;
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
  db.close();
});

// Scenario C — request changes triggers a revised proposal; old history is preserved.
test("Scenario C: request changes preserves the old proposal and records a new version", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedProposeIssue(db);
  const { cur } = await evaluateProposeApprove(db, iid, "REQUEST_CHANGES");
  assert.equal(Number(cur.proposal_version), 1);
  // 舊提案仍在（不可變、版本化）。
  const v1 = db.prepare("SELECT * FROM issue_proposal WHERE issue_id=? AND proposal_version=1").get(iid);
  assert.ok(v1);
  const decision = db.prepare("SELECT action FROM proposal_owner_decision WHERE issue_id=? ORDER BY id DESC LIMIT 1").get(iid);
  assert.equal(decision.action, "REQUEST_CHANGES");
  // 未進入 coding。
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM development_coding_task WHERE issue_id=?").get(iid).n), 0);
  db.close();
});

