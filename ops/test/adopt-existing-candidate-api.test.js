import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";

import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { runProposalOnce } from "../src/proposalWorker.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";
import { getCurrentIssueProposal, submitOwnerDecision } from "../src/proposal.js";
import { makeGitRepo } from "../src/coding/gitRepo.js";
import { makeStubGithubRead, TRUSTED_REPOSITORY } from "../src/coding/githubRead.js";
import { createCodingTask } from "../src/codingTask.js";
import { makeStubCodingProvider } from "../src/coding/provider.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
const NOW = new Date();
let seq = 1;

function initGitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adopt-api-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "adopt-api-remote-"));
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

function seedApprovable(db) {
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
async function approveIssue(db) {
  const iid = seedApprovable(db);
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  submitOwnerDecision(db, iid, { action: "APPROVE_DEVELOPMENT", proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
  return iid;
}

async function withServer(run, { githubRead, codingRepo } = {}) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(CFG);
  const server = createApp({ db, auth, githubRead, codingRepo }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db }); } finally { server.close(); db.close(); }
}
async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.com", password: "pw" }) });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

test("adopt API requires owner + CSRF; client cannot set gate flags", async () => {
  const g = initGitRepo();
  try {
    const sha = addCommit(g.dir, "v3/note.txt", "x\n", "work");
    g.git(["push", "-q", "origin", "HEAD:master"]);
    const githubRead = makeStubGithubRead({
      commits: {
        [sha]: {
          sha,
          html_url: `https://github.com/${TRUSTED_REPOSITORY}/commit/${sha}`,
          commit: { tree: { sha: treeSha(g.dir, sha) } },
          parents: [{ sha: parentSha(g.dir, sha) }],
        },
      },
    });
    await withServer(async ({ base, db }) => {
      const iid = await approveIssue(db);
      const url = `${base}/ops/api/issues/${iid}/coding/adopt`;
      const body = {
        source_type: "existing_commit",
        source_sha: sha,
        qa_passed: true,
        staging_passed: true,
        release_authorized: true,
        production_approved: true,
        repository: "evil/other",
        title: "spoof",
      };
      assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 401);
      const { cookie, csrf } = await login(base);
      assert.equal((await fetch(url, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 403);
      const ok = await fetch(url, {
        method: "POST",
        headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
        body: JSON.stringify(body),
      });
      assert.equal(ok.status, 201);
      const out = await ok.json();
      assert.equal(out.state, "adopted_pending_qa");
      assert.equal(out.next_required_gate, "independent_qa");
      assert.equal(out.source_sha, sha);
      assert.equal(out.verified_provenance.repository, TRUSTED_REPOSITORY);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM development_qa_run").get().n, 0);
      const view = await (await fetch(`${base}/ops/api/issues/${iid}/coding`, { headers: { cookie } })).json();
      assert.equal(view.existing_candidate.source_sha, sha);
      assert.equal(view.latest_task.status, "adopted_pending_qa");
    }, { githubRead, codingRepo: makeGitRepo(g.dir) });
  } finally { g.cleanup(); }
});

test("adopt API PR path and createCodingTask regression via same server", async () => {
  const g = initGitRepo();
  try {
    const master = g.git(["rev-parse", "HEAD"]);
    g.git(["checkout", "-q", "-b", "feature"]);
    const head = addCommit(g.dir, "feat.txt", "pr\n", "pr");
    g.git(["checkout", "-q", "master"]);
    const githubRead = makeStubGithubRead({
      pulls: {
        21: {
          number: 21, state: "open", merged: false, title: "real",
          html_url: `https://github.com/${TRUSTED_REPOSITORY}/pull/21`,
          head: { sha: head, ref: "feature", repo: { full_name: TRUSTED_REPOSITORY } },
          base: { sha: master, ref: "master", repo: { full_name: TRUSTED_REPOSITORY } },
        },
      },
      commits: {
        [head]: {
          sha: head,
          html_url: `https://github.com/${TRUSTED_REPOSITORY}/commit/${head}`,
          commit: { tree: { sha: treeSha(g.dir, head) } },
          parents: [{ sha: master }],
        },
      },
    });
    await withServer(async ({ base, db }) => {
      const iid = await approveIssue(db);
      const other = await approveIssue(db);
      const created = createCodingTask(db, { issueId: other, provider: makeStubCodingProvider(), repo: makeGitRepo(g.dir), now: NOW });
      assert.equal(created.task.status, "pending");
      const { cookie, csrf } = await login(base);
      const res = await fetch(`${base}/ops/api/issues/${iid}/coding/adopt`, {
        method: "POST",
        headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
        body: JSON.stringify({ source_type: "existing_pr", pr_number: 21, head_sha: "ffffffffffffffffffffffffffffffffffffffff", merged: true }),
      });
      assert.equal(res.status, 201);
      const out = await res.json();
      assert.equal(out.source_sha, head);
      assert.equal(out.verified_provenance.pr_merged, false);
      assert.equal(out.next_required_gate, "independent_qa");
    }, { githubRead, codingRepo: makeGitRepo(g.dir) });
  } finally { g.cleanup(); }
});
