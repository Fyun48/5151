import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { transitionRow } from "./stateMachine.js";
import { classifyChangedPaths } from "./coding/pathPolicy.js";
import {
  TRUSTED_REPOSITORY,
  isExactGitSha,
  isTrustedRepository,
} from "./coding/githubRead.js";
import {
  validateAuthorizationForCoding,
  buildApprovedSnapshot,
  publicCodingTask,
} from "./codingTask.js";

// Existing Candidate Adoption：把既有 GitHub PR / exact commit 納入 Ops 治理。
// 不假裝 Ops 寫過 code、不開 ai-dev 分支、不跳過 QA / Staging / Release / Phase 15。
// 與 createCodingTask() 分離；兩條路只在 downstream QA 匯流。

export const ADOPTED_PENDING_QA = "adopted_pending_qa";
export const NEXT_REQUIRED_GATE = "independent_qa";
export const SOURCE_TYPES = new Set(["existing_pr", "existing_commit"]);
const CODING_STARTED_STATE = "DEVELOPING";
const DEV_ELIGIBLE_STATES = new Set(["APPROVED_FOR_DEVELOPMENT", "DEVELOPING"]);

function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }
function issueEntityId(issueId) { return `issue:${Number(issueId)}`; }
function parseJson(v) { try { return v ? JSON.parse(v) : null; } catch { return null; } }

function isUniqueConstraint(err) {
  const msg = String(err?.message || "");
  return /UNIQUE/i.test(msg) || /idx_existing_candidate_repo_sha/i.test(msg);
}

function resultHash({ headSha, diff, changedFiles }) {
  return createHash("sha256").update(JSON.stringify({
    headSha,
    changedFiles: [...changedFiles].sort(),
    ins: diff.insertions,
    del: diff.deletions,
  })).digest("hex");
}

export function computeAdoptFingerprint({
  authorizationId, authorizationHash, proposalId, proposalVersion, proposalHash,
  repository, sourceType, sourceSha,
}) {
  const parts = [
    "adopt:v1",
    `auth_id:${authorizationId}`, `auth_hash:${authorizationHash}`,
    `proposal_id:${proposalId}`, `proposal_version:${proposalVersion}`, `proposal_hash:${proposalHash}`,
    `repository:${repository}`, `source_type:${sourceType}`, `source_sha:${sourceSha}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function publicExistingCandidate(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    coding_task_id: Number(row.coding_task_id),
    issue_id: Number(row.issue_id),
    development_authorization_id: Number(row.development_authorization_id),
    proposal_id: Number(row.proposal_id),
    proposal_version: Number(row.proposal_version),
    proposal_hash: row.proposal_hash,
    repository: row.repository,
    source_type: row.source_type,
    source_sha: row.source_sha,
    source_tree_sha: row.source_tree_sha,
    pr_number: row.pr_number == null ? null : Number(row.pr_number),
    pr_head_sha: row.pr_head_sha,
    pr_base_branch: row.pr_base_branch,
    pr_base_sha: row.pr_base_sha,
    pr_state: row.pr_state,
    pr_merged: row.pr_merged == null ? null : Number(row.pr_merged) === 1,
    pr_url: row.pr_url,
    adopted_by: row.adopted_by,
    adopted_at: row.adopted_at,
    provenance: parseJson(row.provenance_json),
    created_at: row.created_at,
  };
}

export function getExistingCandidateForIssue(db, issueId) {
  const row = db.prepare("SELECT * FROM development_existing_candidate WHERE issue_id=? ORDER BY id DESC LIMIT 1").get(Number(issueId));
  return publicExistingCandidate(row);
}

export function getExistingCandidateBySha(db, sourceSha, repository = TRUSTED_REPOSITORY) {
  const row = db.prepare("SELECT * FROM development_existing_candidate WHERE repository=? AND source_sha=?").get(repository, String(sourceSha).toLowerCase());
  return row || null;
}

function assertGithubAvailable(githubRead) {
  if (!githubRead || !githubRead.available) {
    throw httpError("github evidence unavailable", 503);
  }
}

function assertRepoAvailable(repo) {
  if (!repo || !repo.available) {
    throw httpError("coding repository gateway unavailable", 503);
  }
}

function ensureObjectPresent(repo, sha, { pullNumber = null } = {}) {
  if (typeof repo.fetchSha === "function") {
    repo.fetchSha(sha, { pullNumber });
  }
  if (typeof repo.objectExists === "function") {
    if (!repo.objectExists(sha)) throw httpError("source SHA does not exist in the trusted repository clone", 409);
    return;
  }
  if (typeof repo.resolveRef === "function" && repo.resolveRef(sha)) return;
  throw httpError("source SHA does not exist in the trusted repository clone", 409);
}

function assertMasterAncestry(repo, sha) {
  // 受信任 master = origin/master（若 adapter 提供 remote 檢查）。遠端證明失敗則 fail-closed，不退回本地 tip。
  if (typeof repo.isRemoteAncestor === "function") {
    if (!repo.isRemoteAncestor(sha, "master")) {
      throw httpError("source SHA is not an ancestor of trusted master", 409);
    }
    return;
  }
  if (typeof repo.isAncestor === "function" && repo.isAncestor(sha, "master")) return;
  throw httpError("source SHA is not an ancestor of trusted master", 409);
}

function compatibleAdoption(existing, auth) {
  return Number(existing.issue_id) === Number(auth.issue_id)
    && Number(existing.proposal_id) === Number(auth.proposal_id)
    && Number(existing.proposal_version) === Number(auth.proposal_version)
    && String(existing.proposal_hash) === String(auth.proposal_hash)
    && Number(existing.development_authorization_id) === Number(auth.id);
}

function idempotentResult(db, existing) {
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(existing.coding_task_id));
  if (!task || task.status === "cancelled") {
    throw httpError("existing candidate was adopted then cancelled; history is preserved", 409);
  }
  return {
    idempotent: true,
    candidate: publicExistingCandidate(existing),
    coding_task: publicCodingTask(task),
    provenance: parseJson(existing.provenance_json),
    state: task.status,
    next_required_gate: NEXT_REQUIRED_GATE,
  };
}

async function verifyExistingPr({ githubRead, repo, prNumber, clientSha }) {
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n < 1) throw httpError("invalid pr_number", 400);
  let pr;
  try { pr = await githubRead.getPull(n); } catch (err) {
    if (err?.status) throw err;
    throw httpError("github evidence unavailable", 503);
  }
  if (!pr) throw httpError("pull request not found", 404);
  if (!isTrustedRepository(pr.repository)) throw httpError("pull request is not in the trusted repository", 409);
  if (!isExactGitSha(pr.head_sha)) throw httpError("github PR head SHA is not an exact 40-char SHA", 502);
  if (clientSha != null && String(clientSha) !== "") {
    if (!isExactGitSha(clientSha)) throw httpError("source_sha must be a complete 40-char git SHA", 400);
    if (String(clientSha).toLowerCase() !== pr.head_sha) throw httpError("client source_sha does not match verified PR head SHA", 409);
  }

  let commit;
  try { commit = await githubRead.getCommit(pr.head_sha); } catch (err) {
    if (err?.status) throw err;
    throw httpError("github evidence unavailable", 503);
  }
  if (!commit) throw httpError("PR head SHA does not exist on GitHub", 409);

  ensureObjectPresent(repo, pr.head_sha, { pullNumber: n });

  const requiresMasterAncestry = pr.merged === true;
  if (requiresMasterAncestry) assertMasterAncestry(repo, pr.head_sha);

  const baseSha = pr.base_sha && isExactGitSha(pr.base_sha)
    ? pr.base_sha
    : (typeof repo.parentSha === "function" ? repo.parentSha(pr.head_sha) : null);
  if (!isExactGitSha(baseSha)) throw httpError("unable to resolve immutable base SHA for candidate", 409);

  return {
    source_type: "existing_pr",
    source_sha: pr.head_sha,
    source_tree_sha: (typeof repo.treeHash === "function" && repo.treeHash(pr.head_sha)) || commit.tree_sha || null,
    base_sha: baseSha,
    base_branch: pr.base_branch || "master",
    requires_master_ancestry: requiresMasterAncestry,
    pr_number: n,
    pr_head_sha: pr.head_sha,
    pr_base_branch: pr.base_branch || null,
    pr_base_sha: pr.base_sha || null,
    pr_state: pr.state || null,
    pr_merged: pr.merged === true,
    pr_url: pr.html_url || null,
    github_commit_url: commit.html_url || null,
    head_ref: pr.head_ref || null,
    title: pr.title || null,
  };
}

async function verifyExistingCommit({ githubRead, repo, sourceSha }) {
  if (!isExactGitSha(sourceSha)) {
    throw httpError("source_sha must be a complete 40-char git SHA", 400);
  }
  const sha = String(sourceSha).toLowerCase();
  let commit;
  try { commit = await githubRead.getCommit(sha); } catch (err) {
    if (err?.status) throw err;
    throw httpError("github evidence unavailable", 503);
  }
  if (!commit) throw httpError("commit not found in the trusted repository", 404);
  if (!isTrustedRepository(commit.repository)) throw httpError("commit is not in the trusted repository", 409);
  if (commit.sha !== sha) throw httpError("github commit SHA is not an exact match", 409);

  ensureObjectPresent(repo, sha);
  assertMasterAncestry(repo, sha);

  const parent = (typeof repo.parentSha === "function" ? repo.parentSha(sha) : null)
    || (commit.parents && commit.parents[0])
    || null;
  if (!isExactGitSha(parent)) throw httpError("unable to resolve immutable base SHA for candidate", 409);

  return {
    source_type: "existing_commit",
    source_sha: sha,
    source_tree_sha: (typeof repo.treeHash === "function" && repo.treeHash(sha)) || commit.tree_sha || null,
    base_sha: parent,
    base_branch: "master",
    requires_master_ancestry: true,
    pr_number: null,
    pr_head_sha: null,
    pr_base_branch: null,
    pr_base_sha: null,
    pr_state: null,
    pr_merged: null,
    pr_url: null,
    github_commit_url: commit.html_url || null,
    head_ref: null,
    title: null,
  };
}

function adoptResult(db, { candidateId, taskId, provenance }) {
  const candidate = publicExistingCandidate(db.prepare("SELECT * FROM development_existing_candidate WHERE id=?").get(candidateId));
  const task = publicCodingTask(db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(taskId));
  return {
    idempotent: false,
    candidate,
    coding_task: task,
    provenance,
    state: ADOPTED_PENDING_QA,
    next_required_gate: NEXT_REQUIRED_GATE,
  };
}

// 將既有 PR 或 exact commit 登記為 Ops Existing Candidate。只接受最少 client 輸入。
export async function adoptExistingCandidate(db, {
  issueId,
  authorizationId = null,
  sourceType,
  prNumber = null,
  sourceSha = null,
  actor,
  githubRead,
  repo,
  now = new Date(),
} = {}) {
  if (!actor) throw httpError("adoption requires an authorized actor", 403);
  if (!SOURCE_TYPES.has(sourceType)) throw httpError("source_type must be existing_pr or existing_commit", 400);
  assertGithubAvailable(githubRead);
  assertRepoAvailable(repo);

  const { auth, proposal, entity } = validateAuthorizationForCoding(db, { issueId, authorizationId, now });
  if (!entity || !DEV_ELIGIBLE_STATES.has(entity.state)) {
    throw httpError(`issue lifecycle does not permit development (state=${entity ? entity.state : "none"})`, 409);
  }

  const provenance = sourceType === "existing_pr"
    ? await verifyExistingPr({ githubRead, repo, prNumber, clientSha: sourceSha })
    : await verifyExistingCommit({ githubRead, repo, sourceSha });

  if (provenance.repository && !isTrustedRepository(provenance.repository)) {
    throw httpError("candidate is not in the trusted repository", 409);
  }
  provenance.repository = TRUSTED_REPOSITORY;

  let diff;
  try { diff = repo.numstatRange(provenance.base_sha, provenance.source_sha); } catch {
    throw httpError("unable to compute git diff for adopted SHA", 409);
  }
  const changedFiles = (diff.files || []).map((f) => f.path);
  const protectedFlags = classifyChangedPaths(changedFiles);
  const rhash = resultHash({ headSha: provenance.source_sha, diff, changedFiles });
  const fingerprint = computeAdoptFingerprint({
    authorizationId: Number(auth.id),
    authorizationHash: String(auth.authorization_hash),
    proposalId: Number(auth.proposal_id),
    proposalVersion: Number(auth.proposal_version),
    proposalHash: String(auth.proposal_hash),
    repository: TRUSTED_REPOSITORY,
    sourceType: provenance.source_type,
    sourceSha: provenance.source_sha,
  });
  const snapshot = buildApprovedSnapshot(proposal);
  const ts = iso(now);
  const branch = `existing/${provenance.source_sha.slice(0, 12)}`;
  const priorState = entity.state;

  try {
    return withImmediateTx(db, () => {
    const { auth: auth2, entity: entity2 } = validateAuthorizationForCoding(db, {
      issueId: auth.issue_id, authorizationId: auth.id, now,
    });

    const bySha = db.prepare("SELECT * FROM development_existing_candidate WHERE repository=? AND source_sha=?")
      .get(TRUSTED_REPOSITORY, provenance.source_sha);
    if (bySha) {
      if (!compatibleAdoption(bySha, auth2)) {
        throw httpError("existing candidate already adopted under a conflicting proposal or authorization", 409);
      }
      return idempotentResult(db, bySha);
    }

    const existingTask = db.prepare(
      "SELECT * FROM development_coding_task WHERE development_authorization_id=? AND status!='cancelled' ORDER BY id DESC LIMIT 1",
    ).get(Number(auth2.id));
    if (existingTask) {
      if (existingTask.status === ADOPTED_PENDING_QA && String(existingTask.head_sha) === provenance.source_sha) {
        const linked = db.prepare("SELECT * FROM development_existing_candidate WHERE coding_task_id=?").get(Number(existingTask.id));
        if (linked && compatibleAdoption(linked, auth2)) return idempotentResult(db, linked);
      }
      throw httpError("authorization already has an active coding task; cannot adopt a different candidate", 409);
    }

    const taskIns = db.prepare(
      `INSERT INTO development_coding_task(
        issue_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, task_fingerprint,
        provider, model, repository, base_branch, base_sha, coding_branch, head_sha, approved_scope_snapshot,
        changed_files, diff_insertions, diff_deletions, protected_flags, selftest_results, warnings, result_hash,
        pr_number, pr_url, status, attempt_count, max_attempts, next_attempt_at, started_at, completed_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, '${ADOPTED_PENDING_QA}', 0, 1, ?, ?, ?, ?)`,
    ).run(
      Number(auth2.issue_id), Number(auth2.id), Number(auth2.proposal_id), Number(auth2.proposal_version), String(auth2.proposal_hash), fingerprint,
      "existing_candidate", null, TRUSTED_REPOSITORY, provenance.base_branch, provenance.base_sha, branch, provenance.source_sha, JSON.stringify(snapshot),
      JSON.stringify(diff.files || []), diff.insertions ?? 0, diff.deletions ?? 0, JSON.stringify(protectedFlags),
      JSON.stringify({ ran: false, reason: "existing_candidate_not_ops_coded" }), JSON.stringify([]), rhash,
      provenance.pr_number, provenance.pr_url, ts, ts, ts, ts,
    );
    const taskId = Number(taskIns.lastInsertRowid);

    const evidence = {
      repository: TRUSTED_REPOSITORY,
      source_type: provenance.source_type,
      source_sha: provenance.source_sha,
      source_tree_sha: provenance.source_tree_sha,
      base_sha: provenance.base_sha,
      base_branch: provenance.base_branch,
      pr_number: provenance.pr_number,
      pr_head_sha: provenance.pr_head_sha,
      pr_base_branch: provenance.pr_base_branch,
      pr_base_sha: provenance.pr_base_sha,
      pr_state: provenance.pr_state,
      pr_merged: provenance.pr_merged,
      requires_master_ancestry: provenance.requires_master_ancestry,
      github_commit_url: provenance.github_commit_url,
      verified_by: githubRead.name || "github",
      identity: "source_sha",
    };

    let candidateId;
    try {
      const cres = db.prepare(
        `INSERT INTO development_existing_candidate(
          coding_task_id, issue_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
          repository, source_type, source_sha, source_tree_sha, pr_number, pr_head_sha, pr_base_branch, pr_base_sha,
          pr_state, pr_merged, pr_url, adopted_by, adopted_at, provenance_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        taskId, Number(auth2.issue_id), Number(auth2.id), Number(auth2.proposal_id), Number(auth2.proposal_version), String(auth2.proposal_hash),
        TRUSTED_REPOSITORY, provenance.source_type, provenance.source_sha, provenance.source_tree_sha,
        provenance.pr_number, provenance.pr_head_sha, provenance.pr_base_branch, provenance.pr_base_sha,
        provenance.pr_state, provenance.pr_merged == null ? null : (provenance.pr_merged ? 1 : 0),
        provenance.pr_url, String(actor), ts, JSON.stringify(evidence), ts,
      );
      candidateId = Number(cres.lastInsertRowid);
    } catch (err) {
      if (!isUniqueConstraint(err)) throw err;
      throw Object.assign(new Error("existing_candidate_unique"), { code: "existing_candidate_unique" });
    }

    if (entity2 && entity2.state === "APPROVED_FOR_DEVELOPMENT") {
      transitionRow(db, {
        id: issueEntityId(auth2.issue_id),
        to: CODING_STARTED_STATE,
        actor,
        data: { coding_task_id: taskId, existing_candidate_id: candidateId, source_sha: provenance.source_sha },
        now,
      });
    }

    appendAuditRow(db, {
      actor: String(actor),
      action: "issue.coding.existing_candidate_adopted",
      entityType: "development_existing_candidate",
      entityId: String(candidateId),
      data: {
        issue_id: Number(auth2.issue_id),
        coding_task_id: taskId,
        existing_candidate_id: candidateId,
        authorization_id: Number(auth2.id),
        proposal_id: Number(auth2.proposal_id),
        repository: TRUSTED_REPOSITORY,
        source_type: provenance.source_type,
        source_sha: provenance.source_sha,
        pr_number: provenance.pr_number,
        prior_state: priorState,
        resulting_state: ADOPTED_PENDING_QA,
        github_provenance: "verified",
        next_required_gate: NEXT_REQUIRED_GATE,
        reason: "adopt_existing_candidate",
      },
      now,
    });

    return adoptResult(db, { candidateId, taskId, provenance: evidence });
    });
  } catch (err) {
    if (err?.code !== "existing_candidate_unique") throw err;
    const raced = db.prepare("SELECT * FROM development_existing_candidate WHERE repository=? AND source_sha=?")
      .get(TRUSTED_REPOSITORY, provenance.source_sha);
    if (!raced) throw httpError("existing candidate already adopted under a conflicting proposal or authorization", 409);
    if (!compatibleAdoption(raced, auth)) {
      throw httpError("existing candidate already adopted under a conflicting proposal or authorization", 409);
    }
    return idempotentResult(db, raced);
  }
}
