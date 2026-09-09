import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";

import { openOpsDb, applyOpsSchema, upgradeCodingTaskProvenanceImmutability } from "../src/opsDb.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { runProposalOnce } from "../src/proposalWorker.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";
import { getCurrentIssueProposal, submitOwnerDecision } from "../src/proposal.js";
import { makeGitRepo } from "../src/coding/gitRepo.js";
import { makeStubCodingProvider } from "../src/coding/provider.js";
import { makeStubGithubRead, makeUnavailableGithubRead, TRUSTED_REPOSITORY } from "../src/coding/githubRead.js";
import {
  createCodingTask, claimCodingTaskBatch, executeCodingTask,
} from "../src/codingTask.js";
import {
  adoptExistingCandidate, ADOPTED_PENDING_QA, NEXT_REQUIRED_GATE,
} from "../src/adoptExistingCandidate.js";
import { createQaRun, validateCodingTaskForQa } from "../src/qaRun.js";
import { createStagingDeployment } from "../src/stagingDeploy.js";
import { createReleaseCandidate, submitOwnerReleaseDecision } from "../src/releaseCandidate.js";
import { createProductionReleaseRun } from "../src/release/productionRelease.js";
import { findEntity } from "../src/stateMachine.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
let seq = 1;

function seedProposeIssue(db) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
  for (let k = 0; k < 8; k++) {
    const i = seq++;
    db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, 'leak@example.com', ?, '3.47', ?)").run(`d${i}`, `k${i}`, `content ${i}`, `reporter-${i}`, ts);
    const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
    db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', 'BUG', 'symptom', 'HIGH', 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, ts, ts, ts);
    const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
    db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
    db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, ts);
  }
  calculateAndStoreImpact(db, iid, { now: NOW });
  return iid;
}
async function seedProposalOnly(db) {
  const iid = seedProposeIssue(db);
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  return { iid, current: getCurrentIssueProposal(db, iid, { now: NOW }) };
}
async function approvedIssue(db) {
  const { iid, current } = await seedProposalOnly(db);
  const r = submitOwnerDecision(db, iid, { action: "APPROVE_DEVELOPMENT", proposalId: current.id, proposalVersion: current.proposal_version, proposalHash: current.proposal_hash, now: NOW });
  return { iid, auth: r.authorization, proposal: current };
}

function initGitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adopt-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "adopt-remote-"));
  execFileSync("git", ["init", "-q", "-b", "master", dir]);
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github", "workflows", "test.yml"), "name: Tests\n");
  writeFileSync(path.join(dir, "README.md"), "base\n");
  git(["add", "-A"]); git(["commit", "-q", "-m", "base"]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(["remote", "add", "origin", remote]);
  git(["push", "-q", "origin", "HEAD:master"]);
  return { dir, remote, git, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} try { rmSync(remote, { recursive: true, force: true }); } catch {} } };
}
function addCommit(dir, filename, content, message) {
  const full = path.join(dir, filename);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  execFileSync("git", ["-C", dir, "add", filename]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
function treeSha(dir, sha) {
  return execFileSync("git", ["-C", dir, "rev-parse", `${sha}^{tree}`], { encoding: "utf8" }).trim();
}
function parentSha(dir, sha) {
  return execFileSync("git", ["-C", dir, "rev-parse", `${sha}^`], { encoding: "utf8" }).trim();
}
function ghPull({ number, headSha, baseSha, baseBranch = "master", state = "open", merged = false, repo = TRUSTED_REPOSITORY, title = "external change" }) {
  return {
    number, state, merged, title,
    merge_commit_sha: merged ? headSha : null,
    html_url: `https://github.com/${repo}/pull/${number}`,
    head: { sha: headSha, ref: "feature/x", repo: { full_name: repo } },
    base: { sha: baseSha, ref: baseBranch, repo: { full_name: repo } },
  };
}
function ghCommit({ sha, tree, parents = [] }) {
  return {
    sha,
    html_url: `https://github.com/${TRUSTED_REPOSITORY}/commit/${sha}`,
    commit: { tree: { sha: tree || sha } },
    parents: parents.map((p) => ({ sha: p })),
  };
}

async function setup() {
  const db = openOpsDb(":memory:");
  const { iid, auth, proposal } = await approvedIssue(db);
  const g = initGitRepo();
  const repo = makeGitRepo(g.dir);
  const masterSha = g.git(["rev-parse", "HEAD"]);
  return {
    db, iid, auth, proposal, repo, git: g, masterSha,
    cleanup() { db.close(); g.cleanup(); },
  };
}

function stubFor(g, { pulls = {}, extraCommits = {} } = {}) {
  const master = g.git(["rev-parse", "HEAD"]);
  const commits = {
    [master]: ghCommit({ sha: master, tree: treeSha(g.dir, master), parents: [] }),
    ...extraCommits,
  };
  return makeStubGithubRead({ pulls, commits });
}

test("A. valid existing commit adoption waits for independent QA", async () => {
  const s = setup();
  try {
    const { db, iid, auth, repo, git: g } = await s;
    const sha = addCommit(g.dir, "v3/note.txt", "adopted\n", "existing work");
    g.git(["push", "-q", "origin", "HEAD:master"]);
    const githubRead = makeStubGithubRead({
      commits: {
        [sha]: ghCommit({ sha, tree: treeSha(g.dir, sha), parents: [parentSha(g.dir, sha)] }),
      },
    });
    const out = await adoptExistingCandidate(db, {
      issueId: iid, authorizationId: auth.id, sourceType: "existing_commit", sourceSha: sha,
      actor: "owner:demo@example.com", githubRead, repo, now: NOW,
    });
    assert.equal(out.idempotent, false);
    assert.equal(out.state, ADOPTED_PENDING_QA);
    assert.equal(out.next_required_gate, NEXT_REQUIRED_GATE);
    assert.equal(out.candidate.source_sha, sha);
    assert.equal(out.candidate.repository, TRUSTED_REPOSITORY);
    assert.equal(out.coding_task.status, ADOPTED_PENDING_QA);
    assert.equal(out.coding_task.provider, "existing_candidate");
    assert.equal(out.coding_task.head_sha, sha);
    assert.ok(out.coding_task.result_hash);
    assert.match(out.coding_task.coding_branch, /^existing\//);
    assert.equal(findEntity(db, `issue:${iid}`).state, "DEVELOPING");
    const audits = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'issue.coding.%'").all().map((r) => r.action);
    assert.ok(audits.includes("issue.coding.existing_candidate_adopted"));
    assert.ok(!audits.includes("issue.coding.started"));
    assert.ok(!audits.includes("issue.coding.completed"));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM development_qa_run").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM development_staging_deployment").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_authorization").get().n, 0);
  } finally { (await s).cleanup(); }
});

test("A. valid existing PR adoption uses server-side head SHA", async () => {
  const s = setup();
  try {
    const { db, iid, auth, repo, git: g, masterSha } = await s;
    g.git(["checkout", "-q", "-b", "feature"]);
    const head = addCommit(g.dir, "feat.txt", "pr work\n", "pr head");
    g.git(["checkout", "-q", "master"]);
    const githubRead = makeStubGithubRead({
      pulls: { 42: ghPull({ number: 42, headSha: head, baseSha: masterSha, merged: false }) },
      commits: { [head]: ghCommit({ sha: head, tree: treeSha(g.dir, head), parents: [masterSha] }) },
    });
    const out = await adoptExistingCandidate(db, {
      issueId: iid, sourceType: "existing_pr", prNumber: 42,
      actor: "owner:demo@example.com", githubRead, repo, now: NOW,
    });
    assert.equal(out.candidate.pr_number, 42);
    assert.equal(out.candidate.source_sha, head);
    assert.equal(out.candidate.pr_merged, false);
    assert.equal(out.state, ADOPTED_PENDING_QA);
    assert.equal(out.provenance.source_sha, head);
  } finally { (await s).cleanup(); }
});

test("B. no / inactive authorization and missing actor are rejected", async () => {
  const db = openOpsDb(":memory:");
  const g = initGitRepo();
  const repo = makeGitRepo(g.dir);
  try {
    const { iid } = await seedProposalOnly(db);
    const sha = g.git(["rev-parse", "HEAD"]);
    const githubRead = stubFor(g);
    await assert.rejects(
      () => adoptExistingCandidate(db, { issueId: iid, sourceType: "existing_commit", sourceSha: sha, actor: "owner:x", githubRead, repo, now: NOW }),
      /no active development authorization|does not permit/,
    );
    const approved = await approvedIssue(db);
    db.prepare("UPDATE development_authorization SET status='superseded' WHERE id=?").run(approved.auth.id);
    await assert.rejects(
      () => adoptExistingCandidate(db, { issueId: approved.iid, authorizationId: approved.auth.id, sourceType: "existing_commit", sourceSha: sha, actor: "owner:x", githubRead, repo, now: NOW }),
      /not active|no active/,
    );
    db.prepare("UPDATE development_authorization SET status='active' WHERE id=?").run(approved.auth.id);
    await assert.rejects(
      () => adoptExistingCandidate(db, { issueId: approved.iid, sourceType: "existing_commit", sourceSha: sha, githubRead, repo, now: NOW }),
      /authorized actor/,
    );
  } finally { db.close(); g.cleanup(); }
});

test("C. missing or unapproved proposal is rejected", async () => {
  const db = openOpsDb(":memory:");
  const g = initGitRepo();
  const repo = makeGitRepo(g.dir);
  try {
    const iid = seedProposeIssue(db);
    const sha = g.git(["rev-parse", "HEAD"]);
    const githubRead = stubFor(g);
    await assert.rejects(
      () => adoptExistingCandidate(db, { issueId: iid, sourceType: "existing_commit", sourceSha: sha, actor: "owner:x", githubRead, repo, now: NOW }),
      /no active development authorization|does not permit/,
    );
    const { iid: iid2, auth } = await approvedIssue(db);
    const ts = NOW.toISOString();
    db.prepare("UPDATE development_authorization SET status='superseded' WHERE id=?").run(auth.id);
    const pendingId = Number(db.prepare(
      `INSERT INTO issue_proposal(issue_id, proposal_version, generation_version, proposal_hash, title, proposed_change, status, next_attempt_at, created_at)
       VALUES (?, ?, 'gen', 'PENDHASH', 'p', 'c', 'pending', ?, ?)`,
    ).run(iid2, Number(auth.proposal_version) + 1, ts, ts).lastInsertRowid);
    const pendingAuthId = Number(db.prepare(
      `INSERT INTO development_authorization(issue_id, proposal_id, proposal_version, proposal_hash, authorization_hash, approved_by, approved_at, status, created_at)
       VALUES (?, ?, ?, 'PENDHASH', 'ah-pending', 'owner', ?, 'active', ?)`,
    ).run(iid2, pendingId, Number(auth.proposal_version) + 1, ts, ts).lastInsertRowid);
    await assert.rejects(
      () => adoptExistingCandidate(db, { issueId: iid2, authorizationId: pendingAuthId, sourceType: "existing_commit", sourceSha: sha, actor: "owner:x", githubRead, repo, now: NOW }),
      /not completed/,
    );
  } finally { db.close(); g.cleanup(); }
});

test("D. SHA format, unknown, and non-ancestor master candidates fail closed", async () => {
  const { db, iid, auth, repo, git: g, cleanup } = await setup();
  try {
    const githubRead = stubFor(g);
    const args = { issueId: iid, authorizationId: auth.id, sourceType: "existing_commit", actor: "owner:x", githubRead, repo, now: NOW };
    await assert.rejects(() => adoptExistingCandidate(db, { ...args, sourceSha: "not-a-sha" }), /40-char/);
    await assert.rejects(() => adoptExistingCandidate(db, { ...args, sourceSha: "abc" }), /40-char/);
    await assert.rejects(() => adoptExistingCandidate(db, { ...args, sourceSha: "latest" }), /40-char/);
    await assert.rejects(() => adoptExistingCandidate(db, { ...args, sourceSha: "master" }), /40-char/);
    const unknown = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await assert.rejects(
      () => adoptExistingCandidate(db, { ...args, sourceSha: unknown, githubRead: makeStubGithubRead({ commits: {} }) }),
      /not found|does not exist/,
    );
    g.git(["checkout", "-q", "-b", "side"]);
    const side = addCommit(g.dir, "side.txt", "side\n", "side");
    g.git(["checkout", "-q", "master"]);
    const sideRead = makeStubGithubRead({
      commits: { [side]: ghCommit({ sha: side, tree: treeSha(g.dir, side), parents: [g.git(["rev-parse", "HEAD"])] }) },
    });
    await assert.rejects(
      () => adoptExistingCandidate(db, { ...args, sourceSha: side, githubRead: sideRead }),
      /not an ancestor of trusted master/,
    );
  } finally { cleanup(); }
});

test("E. PR must be in trusted repo, exist, and match verified head SHA", async () => {
  const { db, iid, auth, repo, git: g, masterSha, cleanup } = await setup();
  try {
    g.git(["checkout", "-q", "-b", "feature"]);
    const head = addCommit(g.dir, "feat.txt", "x\n", "pr");
    g.git(["checkout", "-q", "master"]);
    const baseArgs = { issueId: iid, authorizationId: auth.id, sourceType: "existing_pr", actor: "owner:x", repo, now: NOW };

    await assert.rejects(
      () => adoptExistingCandidate(db, { ...baseArgs, prNumber: 99, githubRead: makeStubGithubRead({ pulls: {}, commits: {} }) }),
      /not found/,
    );
    await assert.rejects(
      () => adoptExistingCandidate(db, {
        ...baseArgs, prNumber: 7,
        githubRead: makeStubGithubRead({
          pulls: { 7: ghPull({ number: 7, headSha: head, baseSha: masterSha, repo: "evil/other" }) },
          commits: { [head]: ghCommit({ sha: head, tree: treeSha(g.dir, head), parents: [masterSha] }) },
        }),
      }),
      /trusted repository/,
    );
    const good = makeStubGithubRead({
      pulls: { 8: ghPull({ number: 8, headSha: head, baseSha: masterSha }) },
      commits: { [head]: ghCommit({ sha: head, tree: treeSha(g.dir, head), parents: [masterSha] }) },
    });
    await assert.rejects(
      () => adoptExistingCandidate(db, { ...baseArgs, prNumber: 8, sourceSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", githubRead: good }),
      /does not match verified PR head SHA/,
    );
    const mergedNonAncestor = makeStubGithubRead({
      pulls: { 9: ghPull({ number: 9, headSha: head, baseSha: masterSha, merged: true }) },
      commits: { [head]: ghCommit({ sha: head, tree: treeSha(g.dir, head), parents: [masterSha] }) },
    });
    await assert.rejects(
      () => adoptExistingCandidate(db, { ...baseArgs, prNumber: 9, githubRead: mergedNonAncestor }),
      /not an ancestor of trusted master/,
    );
    await assert.rejects(
      () => adoptExistingCandidate(db, { ...baseArgs, prNumber: 8, githubRead: makeUnavailableGithubRead() }),
      /github evidence unavailable/,
    );
  } finally { cleanup(); }
});

test("E. client-spoofed PR metadata is ignored; server evidence wins", async () => {
  const { db, iid, auth, repo, git: g, masterSha, cleanup } = await setup();
  try {
    g.git(["checkout", "-q", "-b", "feature"]);
    const head = addCommit(g.dir, "feat.txt", "x\n", "pr");
    g.git(["checkout", "-q", "master"]);
    const githubRead = makeStubGithubRead({
      pulls: { 11: ghPull({ number: 11, headSha: head, baseSha: masterSha, title: "REAL TITLE", merged: false }) },
      commits: { [head]: ghCommit({ sha: head, tree: treeSha(g.dir, head), parents: [masterSha] }) },
    });
    const out = await adoptExistingCandidate(db, {
      issueId: iid, authorizationId: auth.id, sourceType: "existing_pr", prNumber: 11,
      sourceSha: head,
      actor: "owner:x", githubRead, repo, now: NOW,
      // spoofed fields must be ignored even if a caller stuffed them on the object
      title: "SPOOFED", head_sha: "cccccccccccccccccccccccccccccccccccccccc",
      merged: true, repository: "evil/other", qa_passed: true, staging_passed: true,
    });
    assert.equal(out.candidate.source_sha, head);
    assert.equal(out.candidate.pr_merged, false);
    assert.equal(out.candidate.repository, TRUSTED_REPOSITORY);
    assert.equal(out.state, ADOPTED_PENDING_QA);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM development_qa_current").get().n, 0);
  } finally { cleanup(); }
});

test("F. same repo+SHA is idempotent; conflicting context is a conflict", async () => {
  const { db, iid, auth, repo, git: g, cleanup } = await setup();
  try {
    const sha = addCommit(g.dir, "v3/note.txt", "x\n", "work");
    g.git(["push", "-q", "origin", "HEAD:master"]);
    const githubRead = makeStubGithubRead({
      commits: { [sha]: ghCommit({ sha, tree: treeSha(g.dir, sha), parents: [parentSha(g.dir, sha)] }) },
    });
    const a = await adoptExistingCandidate(db, {
      issueId: iid, authorizationId: auth.id, sourceType: "existing_commit", sourceSha: sha,
      actor: "owner:x", githubRead, repo, now: NOW,
    });
    const b = await adoptExistingCandidate(db, {
      issueId: iid, authorizationId: auth.id, sourceType: "existing_commit", sourceSha: sha,
      actor: "owner:x", githubRead, repo, now: NOW,
    });
    assert.equal(b.idempotent, true);
    assert.equal(a.candidate.id, b.candidate.id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM development_existing_candidate").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.coding.existing_candidate_adopted'").get().n, 1);

    const other = await approvedIssue(db);
    await assert.rejects(
      () => adoptExistingCandidate(db, {
        issueId: other.iid, authorizationId: other.auth.id, sourceType: "existing_commit", sourceSha: sha,
        actor: "owner:x", githubRead, repo, now: NOW,
      }),
      /conflicting proposal or authorization/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM development_existing_candidate").get().n, 1);
  } finally { cleanup(); }
});

test("G. adoption cannot skip QA / staging / release / Phase 15", async () => {
  const { db, iid, auth, repo, git: g, cleanup } = await setup();
  try {
    const sha = addCommit(g.dir, "v3/note.txt", "x\n", "work");
    g.git(["push", "-q", "origin", "HEAD:master"]);
    const githubRead = makeStubGithubRead({
      commits: { [sha]: ghCommit({ sha, tree: treeSha(g.dir, sha), parents: [parentSha(g.dir, sha)] }) },
    });
    const out = await adoptExistingCandidate(db, {
      issueId: iid, authorizationId: auth.id, sourceType: "existing_commit", sourceSha: sha,
      actor: "owner:x", githubRead, repo, now: NOW,
    });
    const codingTaskId = out.coding_task.id;
    assert.ok(validateCodingTaskForQa(db, codingTaskId).task);
    const qa = createQaRun(db, { codingTaskId, repo, now: NOW });
    assert.equal(qa.run.status, "pending");
    assert.equal(qa.run.final_result, null);
    assert.throws(() => createStagingDeployment(db, { codingTaskId, repo, now: NOW }), /no current QA|not PASS/);
    assert.throws(() => createReleaseCandidate(db, { codingTaskId, repo, now: NOW }), /no current QA|not PASS/);
    assert.throws(
      () => submitOwnerReleaseDecision(db, { codingTaskId, action: "APPROVE_RELEASE", manifestId: 1, manifestVersion: 1, manifestHash: "x", artifactDigest: "sha256:aa", headSha: sha, actor: "owner:x", repo }),
      /no current release candidate/,
    );
    assert.throws(() => createProductionReleaseRun(db, {
      codingTaskId,
      releaseAuthorizationId: 1,
      releaseAuthorizationHash: "x".repeat(64),
      migrationSafetyAssessmentId: 1,
      migrationSafetyPolicyFingerprint: "x",
      migrationSafetyInputFingerprint: "x",
      clearanceResult: "CLEARED",
      qaRunId: 1,
      stagingDeploymentId: 1,
      manifestId: 1,
      manifestVersion: 1,
      manifestHash: "x",
      headSha: sha,
      artifactDigest: "sha256:" + "a".repeat(64),
      targetEnvironment: "production",
      workflowRef: "refs/heads/master",
      githubActor: "Fyun48",
    }, { repo }));
    const exec = await executeCodingTask(db, out.coding_task, { repo, now: NOW });
    assert.equal(exec.skipped, true);
    assert.equal(exec.reason, "existing_candidate_not_executable");
    assert.equal(claimCodingTaskBatch(db, { now: NOW, limit: 5 }).length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM production_release_run").get().n, 0);
  } finally { cleanup(); }
});

test("H. createCodingTask still works; adopted auth cannot start a second coding path", async () => {
  const { db, iid, auth, repo, git: g, cleanup } = await setup();
  try {
    const other = await approvedIssue(db);
    const created = createCodingTask(db, { issueId: other.iid, provider: makeStubCodingProvider(), repo, now: NOW });
    assert.ok(created.task.id > 0);
    assert.equal(created.task.status, "pending");
    assert.match(created.task.coding_branch, /^ai-dev\//);

    const sha = addCommit(g.dir, "v3/note.txt", "x\n", "work");
    g.git(["push", "-q", "origin", "HEAD:master"]);
    const githubRead = makeStubGithubRead({
      commits: { [sha]: ghCommit({ sha, tree: treeSha(g.dir, sha), parents: [parentSha(g.dir, sha)] }) },
    });
    await adoptExistingCandidate(db, {
      issueId: iid, authorizationId: auth.id, sourceType: "existing_commit", sourceSha: sha,
      actor: "owner:x", githubRead, repo, now: NOW,
    });
    assert.throws(
      () => createCodingTask(db, { issueId: iid, authorizationId: auth.id, provider: makeStubCodingProvider(), repo, now: NOW }),
      /adopted existing candidate/,
    );
  } finally { cleanup(); }
});

test("schema is additive on existing file DB; candidate rows are append-only; adopted provenance is locked", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adopt-db-"));
  const file = path.join(dir, "ops.db");
  const db1 = openOpsDb(file);
  assert.ok(db1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='development_existing_candidate'").get());
  db1.close();
  const db2 = openOpsDb(file);
  applyOpsSchema(db2);
  upgradeCodingTaskProvenanceImmutability(db2);
  const { iid, auth } = await approvedIssue(db2);
  const g = initGitRepo();
  try {
    const sha = addCommit(g.dir, "v3/note.txt", "x\n", "work");
    g.git(["push", "-q", "origin", "HEAD:master"]);
    const repo = makeGitRepo(g.dir);
    const githubRead = makeStubGithubRead({
      commits: { [sha]: ghCommit({ sha, tree: treeSha(g.dir, sha), parents: [parentSha(g.dir, sha)] }) },
    });
    const out = await adoptExistingCandidate(db2, {
      issueId: iid, authorizationId: auth.id, sourceType: "existing_commit", sourceSha: sha,
      actor: "owner:x", githubRead, repo, now: NOW,
    });
    const cid = out.candidate.id;
    assert.throws(
      () => db2.prepare("UPDATE development_existing_candidate SET source_sha=? WHERE id=?").run("d".repeat(40), cid),
      /append-only/,
    );
    assert.throws(
      () => db2.prepare("DELETE FROM development_existing_candidate WHERE id=?").run(cid),
      /append-only/,
    );
    assert.throws(
      () => db2.prepare("UPDATE development_coding_task SET head_sha=? WHERE id=?").run("e".repeat(40), out.coding_task.id),
      /immutable/,
    );
    const auditId = db2.prepare("SELECT id FROM audit_log WHERE action='issue.coding.existing_candidate_adopted'").get().id;
    assert.throws(
      () => db2.prepare("UPDATE audit_log SET action='issue.coding.completed' WHERE id=?").run(auditId),
      /append-only/,
    );
  } finally {
    g.cleanup();
    db2.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
