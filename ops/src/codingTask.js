import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { findEntity, transitionRow } from "./stateMachine.js";
import { classifyChangedPaths } from "./coding/pathPolicy.js";
import { CODING_PROVIDER_POLICY_VERSION } from "./coding/provider.js";
import { CODING_PATH_POLICY_VERSION } from "./coding/pathPolicy.js";

// ── Phase 10：授權後的 Coding Task 引擎 ──
// 唯一授權來源＝ACTIVE development_authorization；消費「確切」核准的 Proposal 快照；
// 隔離 worktree → coding provider → git diff（唯一真相）→ 守門 → self-test → 推分支 → 開 Draft PR → STOP。
// 絕不 auto-merge、不部署、不動 master、不建 Release Candidate。

export const CODING_MAX_ATTEMPTS = 3;
export const CODING_CLAIM_STALE_MS = 15 * 60 * 1000;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;
const CODING_STARTED_STATE = "DEVELOPING";
const DEV_ELIGIBLE_STATES = new Set(["APPROVED_FOR_DEVELOPMENT", "DEVELOPING"]);

function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }
function issueEntityId(issueId) { return `issue:${Number(issueId)}`; }
function backoffMs(attempt) { return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS); }

export function codingConfigFromEnv(env = process.env) {
  return {
    enabled: env.CODING_WORKER_ENABLED !== "0",
    concurrency: Math.max(1, Number(env.CODING_CONCURRENCY) || 1),
    maxAttempts: Math.max(1, Number(env.CODING_MAX_ATTEMPTS) || CODING_MAX_ATTEMPTS),
    claimStaleMs: Math.max(60000, Number(env.CODING_CLAIM_STALE_MS) || CODING_CLAIM_STALE_MS),
    maxChangedFiles: Math.max(1, Number(env.CODING_MAX_CHANGED_FILES) || 50),
    maxDiffLines: Math.max(1, Number(env.CODING_MAX_DIFF_LINES) || 2000),
    baseBranch: env.CODING_BASE_BRANCH || "master",
    repository: env.OPS_CODING_REPO || "local",
    timeoutMs: Math.max(1000, Number(env.CODING_TIMEOUT_MS) || 10 * 60 * 1000),
  };
}

// coding-provider policy fingerprint（版本 + provider + model）→ 供 task fingerprint 綁定。
export function codingProviderPolicy(provider, env = process.env) {
  return {
    policy_version: CODING_PROVIDER_POLICY_VERSION,
    path_policy_version: CODING_PATH_POLICY_VERSION,
    provider: provider?.name || "none",
    model: provider?.model || null,
  };
}
export function codingProviderPolicyFingerprint(provider, env = process.env) {
  const p = codingProviderPolicy(provider, env);
  return createHash("sha256").update(JSON.stringify([
    `policy:${p.policy_version}`, `path:${p.path_policy_version}`, `provider:${p.provider}`, `model:${p.model ?? ""}`,
  ].sort())).digest("hex");
}

// 決定性 Coding Task fingerprint：綁定授權 + 確切 proposal + repo + base + provider policy。
export function computeTaskFingerprint({ authorizationId, authorizationHash, proposalId, proposalVersion, proposalHash, repository, baseBranch, baseSha, providerPolicyFingerprint }) {
  const parts = [
    `auth_id:${authorizationId}`, `auth_hash:${authorizationHash}`,
    `proposal_id:${proposalId}`, `proposal_version:${proposalVersion}`, `proposal_hash:${proposalHash}`,
    `repository:${repository}`, `base_branch:${baseBranch}`, `base_sha:${baseSha}`,
    `provider_policy_fp:${providerPolicyFingerprint}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// 建立僅供 Coding Provider 消費的「Approved Proposal Snapshot」（sanitized；不含 raw feedback/PII）。
export function buildApprovedSnapshot(proposal) {
  const arr = (v) => { try { const p = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(p) ? p : []; } catch { return []; } };
  return {
    proposal_id: Number(proposal.id),
    proposal_version: Number(proposal.proposal_version),
    proposal_hash: String(proposal.proposal_hash),
    title: proposal.title || "",
    problem_statement: proposal.problem_statement || "",
    proposed_change: proposal.proposed_change || "",
    intended_outcome: proposal.intended_outcome || "",
    scope: arr(proposal.scope),
    non_goals: arr(proposal.non_goals),
    acceptance_criteria: arr(proposal.acceptance_criteria),
    known_risks: arr(proposal.known_risks),
    security_considerations: proposal.security_considerations || "",
    compliance_considerations: proposal.compliance_considerations || "",
    operational_considerations: proposal.operational_considerations || "",
    rollback_considerations: proposal.rollback_considerations || "",
  };
}

// 驗證「唯一授權來源」：ACTIVE development_authorization 且綁定確切 proposal 快照、issue 生命週期允許開發。
export function validateAuthorizationForCoding(db, { issueId, authorizationId = null, now = new Date() } = {}) {
  let auth;
  if (authorizationId != null) {
    auth = db.prepare("SELECT * FROM development_authorization WHERE id=?").get(Number(authorizationId));
    if (!auth) throw httpError("authorization not found", 404);
    if (issueId != null && Number(auth.issue_id) !== Number(issueId)) throw httpError("authorization issue mismatch", 409);
  } else {
    auth = db.prepare("SELECT * FROM development_authorization WHERE issue_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(Number(issueId));
    if (!auth) throw httpError("no active development authorization", 409);
  }
  if (auth.status !== "active") throw httpError("authorization is not active (superseded/revoked)", 409);

  const proposal = db.prepare("SELECT * FROM issue_proposal WHERE id=?").get(Number(auth.proposal_id));
  if (!proposal) throw httpError("authorized proposal not found", 404);
  if (proposal.status !== "completed") throw httpError("authorized proposal is not completed/immutable", 409);
  // 綁定確切 proposal id/version/hash（絕不代換較新未核准版本）。
  if (Number(proposal.id) !== Number(auth.proposal_id)) throw httpError("proposal id mismatch", 409);
  if (Number(proposal.proposal_version) !== Number(auth.proposal_version)) throw httpError("proposal version mismatch", 409);
  if (String(proposal.proposal_hash) !== String(auth.proposal_hash)) throw httpError("proposal hash mismatch", 409);

  // 該授權必須是「其 proposal 目前唯一 active」授權（未被 supersede）。
  const dupe = db.prepare("SELECT COUNT(*) n FROM development_authorization WHERE proposal_id=? AND proposal_hash=? AND status='active'").get(Number(auth.proposal_id), String(auth.proposal_hash)).n;
  if (Number(dupe) !== 1) throw httpError("authorization is not the sole active authorization", 409);

  const entity = findEntity(db, issueEntityId(auth.issue_id));
  if (!entity || !DEV_ELIGIBLE_STATES.has(entity.state)) throw httpError(`issue lifecycle does not permit development (state=${entity ? entity.state : "none"})`, 409);

  return { auth, proposal, entity };
}

export function publicCodingTask(row) {
  if (!row) return null;
  const arr = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return {
    id: Number(row.id), issue_id: Number(row.issue_id),
    development_authorization_id: Number(row.development_authorization_id),
    proposal_id: Number(row.proposal_id), proposal_version: Number(row.proposal_version), proposal_hash: row.proposal_hash,
    task_fingerprint: row.task_fingerprint, provider: row.provider, provider_task_id: row.provider_task_id, model: row.model,
    repository: row.repository, base_branch: row.base_branch, base_sha: row.base_sha,
    coding_branch: row.coding_branch, head_sha: row.head_sha,
    changed_files: arr(row.changed_files), diff_insertions: row.diff_insertions, diff_deletions: row.diff_deletions,
    protected_flags: arr(row.protected_flags), selftest_results: arr(row.selftest_results), warnings: arr(row.warnings),
    result_hash: row.result_hash, pr_number: row.pr_number == null ? null : Number(row.pr_number), pr_url: row.pr_url,
    status: row.status, attempt_count: Number(row.attempt_count), error_code: row.error_code,
    created_at: row.created_at, started_at: row.started_at, completed_at: row.completed_at,
    approved_scope_snapshot: arr(row.approved_scope_snapshot),
  };
}

// 建立 Coding Task（idempotent）。需要 repo gateway 解析 base SHA；repo 不可用則拒絕（安全預設：不建）。
export function createCodingTask(db, { issueId, authorizationId = null, provider, repo, env = process.env, now = new Date() }) {
  const cfg = codingConfigFromEnv(env);
  if (!repo || !repo.available) throw httpError("coding repository gateway unavailable", 503);
  const baseBranch = cfg.baseBranch;
  const baseSha = repo.resolveBaseSha(baseBranch);
  const providerPolicyFp = codingProviderPolicyFingerprint(provider, env);
  const ts = iso(now);
  return withImmediateTx(db, () => {
    const { auth, proposal } = validateAuthorizationForCoding(db, { issueId, authorizationId, now });
    const fingerprint = computeTaskFingerprint({
      authorizationId: Number(auth.id), authorizationHash: String(auth.authorization_hash),
      proposalId: Number(auth.proposal_id), proposalVersion: Number(auth.proposal_version), proposalHash: String(auth.proposal_hash),
      repository: cfg.repository, baseBranch, baseSha, providerPolicyFingerprint: providerPolicyFp,
    });
    // idempotency：同 fingerprint 已有未取消 task → 回傳現有（不重複建立/推分支）。
    const existing = db.prepare("SELECT * FROM development_coding_task WHERE task_fingerprint=? AND status!='cancelled' ORDER BY id DESC LIMIT 1").get(fingerprint);
    if (existing) return { idempotent: true, task: publicCodingTask(existing) };

    const snapshot = buildApprovedSnapshot(proposal);
    const res = db.prepare(
      `INSERT INTO development_coding_task(
        issue_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, task_fingerprint,
        provider, model, repository, base_branch, base_sha, approved_scope_snapshot, status, attempt_count, max_attempts, next_attempt_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', 0, ?, ?, ?)`,
    ).run(
      Number(auth.issue_id), Number(auth.id), Number(auth.proposal_id), Number(auth.proposal_version), String(auth.proposal_hash), fingerprint,
      provider?.name || "none", provider?.model || null, cfg.repository, baseBranch, baseSha, JSON.stringify(snapshot),
      cfg.maxAttempts, ts, ts,
    );
    const id = Number(res.lastInsertRowid);
    const branch = `ai-dev/${id}-issue-${Number(auth.issue_id)}`;
    db.prepare("UPDATE development_coding_task SET coding_branch=? WHERE id=?").run(branch, id);
    appendAuditRow(db, { actor: "system", action: "issue.coding.task_created", entityType: "development_coding_task", entityId: String(id), data: { issue_id: Number(auth.issue_id), coding_task_id: id, authorization_id: Number(auth.id), proposal_id: Number(auth.proposal_id), proposal_version: Number(auth.proposal_version), proposal_hash: String(auth.proposal_hash), base_branch: baseBranch, base_sha: baseSha, provider: provider?.name || "none" }, now });
    return { task: publicCodingTask(db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(id)) };
  });
}

// 交易式 claim：pending / failed_retry(到期) / stale-claimed|running → claimed。避免重複 worker 同時執行同一 task。
export function claimCodingTaskBatch(db, { now = new Date(), staleMs = CODING_CLAIM_STALE_MS, limit = 1 } = {}) {
  const ts = iso(now);
  const staleBefore = iso(new Date((now instanceof Date ? now.getTime() : Date.parse(iso(now))) - staleMs));
  return withImmediateTx(db, () => {
    const rows = db.prepare(
      `SELECT * FROM development_coding_task
       WHERE ( (status IN ('pending','failed_retry') AND next_attempt_at <= ?)
            OR (status IN ('claimed','running') AND (claimed_at IS NULL OR claimed_at < ?)) )
       ORDER BY id ASC LIMIT ?`,
    ).all(ts, staleBefore, Math.max(1, limit));
    const claimed = [];
    for (const r of rows) {
      const upd = db.prepare("UPDATE development_coding_task SET status='claimed', claimed_at=? WHERE id=? AND status=?").run(ts, r.id, r.status);
      if (upd.changes === 1) claimed.push(db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(r.id));
    }
    return claimed;
  });
}

// TOCTOU 保護：provider 啟動前再驗一次授權/提案/issue 資格/未取消/未被 supersede。
export function recheckBeforeStart(db, task) {
  if (!task) return { ok: false, reason: "task_missing" };
  const fresh = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(task.id));
  if (!fresh || fresh.status === "cancelled") return { ok: false, reason: "task_cancelled" };
  try {
    const { auth } = validateAuthorizationForCoding(db, { issueId: fresh.issue_id, authorizationId: fresh.development_authorization_id });
    if (Number(auth.id) !== Number(fresh.development_authorization_id)) return { ok: false, reason: "authorization_superseded" };
    if (String(auth.proposal_hash) !== String(fresh.proposal_hash)) return { ok: false, reason: "proposal_hash_changed" };
    if (Number(auth.proposal_version) !== Number(fresh.proposal_version)) return { ok: false, reason: "proposal_version_changed" };
    return { ok: true, auth };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function markFailure(db, task, { code, now, cfg }) {
  const attempt = Number(task.attempt_count) || 0;
  const willRetry = attempt < (Number(task.max_attempts) || cfg.maxAttempts);
  const status = willRetry ? "failed_retry" : "failed";
  const next = willRetry ? iso(new Date((now instanceof Date ? now.getTime() : Date.now()) + backoffMs(attempt))) : iso(now);
  db.prepare("UPDATE development_coding_task SET status=?, error_code=?, next_attempt_at=? WHERE id=?").run(status, code, next, Number(task.id));
  appendAuditRow(db, { actor: "system", action: "issue.coding.failed", entityType: "development_coding_task", entityId: String(task.id), data: { issue_id: Number(task.issue_id), coding_task_id: Number(task.id), authorization_id: Number(task.development_authorization_id), error_code: code, status }, now });
  return { failed: true, error_code: code, status };
}

// 執行一個已 claim 的 task：recheck → provider（隔離 worktree）→ git diff(真相) → 守門 → self-test → push → Draft PR。
export async function executeCodingTask(db, taskRow, { provider, repo, pr, selfTest = null, env = process.env, now = new Date() } = {}) {
  const cfg = codingConfigFromEnv(env);
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(taskRow.id));
  if (!task) return { skipped: true, reason: "task_missing" };
  if (task.status === "changes_ready") return { idempotent: true, task: publicCodingTask(task) };
  if (task.status === "cancelled") return { skipped: true, reason: "cancelled" };

  // 授權失效 → 不啟動 coding（記錄 authorization_invalidated，標記需取消）。
  const rc = recheckBeforeStart(db, task);
  if (!rc.ok) {
    return withImmediateTx(db, () => {
      db.prepare("UPDATE development_coding_task SET status='cancelled', error_code=? WHERE id=? AND status!='changes_ready'").run(`authorization_invalidated:${rc.reason}`, Number(task.id));
      appendAuditRow(db, { actor: "system", action: "issue.coding.authorization_invalidated", entityType: "development_coding_task", entityId: String(task.id), data: { issue_id: Number(task.issue_id), coding_task_id: Number(task.id), authorization_id: Number(task.development_authorization_id), reason: rc.reason }, now });
      return { invalidated: true, reason: rc.reason };
    });
  }

  // Provider 不可用 → 不假裝成功：釋放 claim 回 pending，供設定 provider 後再跑。
  if (!provider || !provider.available) {
    withImmediateTx(db, () => {
      db.prepare("UPDATE development_coding_task SET status='pending', error_code='provider_unavailable', claimed_at=NULL, next_attempt_at=? WHERE id=? AND status IN ('claimed','running','failed_retry')").run(iso(new Date((now instanceof Date ? now.getTime() : Date.now()) + backoffMs(1))), Number(task.id));
    });
    return { skipped: true, reason: "provider_unavailable" };
  }

  // 標記 running + 遞增 attempt + issue 生命週期進入 DEVELOPING（若目前為 APPROVED_FOR_DEVELOPMENT）。
  withImmediateTx(db, () => {
    db.prepare("UPDATE development_coding_task SET status='running', started_at=COALESCE(started_at,?), attempt_count=attempt_count+1 WHERE id=?").run(iso(now), Number(task.id));
    const entity = findEntity(db, issueEntityId(task.issue_id));
    if (entity && entity.state === "APPROVED_FOR_DEVELOPMENT") {
      transitionRow(db, { id: issueEntityId(task.issue_id), to: CODING_STARTED_STATE, actor: "system", data: { coding_task_id: Number(task.id) }, now });
    }
    appendAuditRow(db, { actor: "system", action: "issue.coding.started", entityType: "development_coding_task", entityId: String(task.id), data: { issue_id: Number(task.issue_id), coding_task_id: Number(task.id), authorization_id: Number(task.development_authorization_id), provider: provider.name, base_sha: task.base_sha }, now });
  });

  const cur = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(task.id));
  const snapshot = JSON.parse(cur.approved_scope_snapshot || "{}");
  let worktree = null;
  try {
    if (!repo || !repo.available) throw Object.assign(new Error("repo unavailable"), { code: "repo_unavailable" });
    worktree = repo.createWorktree(cur.base_sha, cur.coding_branch);
    appendAudit(db, { action: "issue.coding.branch_created", task: cur, data: { branch: cur.coding_branch }, now });

    const result = await provider.run({ workspace: worktree, snapshot, timeoutMs: cfg.timeoutMs });
    const headSha = repo.commitAll(worktree, buildCommitMessage(cur, snapshot));
    if (!headSha || result?.changed === false) throw Object.assign(new Error("provider produced no changes"), { code: "no_changes" });

    // Git diff 為唯一真相（不採信 provider 描述）。
    const diff = repo.numstat(worktree, cur.base_sha);
    const changedFiles = diff.files.map((f) => f.path);
    const protectedFlags = classifyChangedPaths(changedFiles);

    const warnings = [];
    if (diff.files.length > cfg.maxChangedFiles) warnings.push({ type: "too_many_files", count: diff.files.length, limit: cfg.maxChangedFiles });
    if (diff.insertions + diff.deletions > cfg.maxDiffLines) warnings.push({ type: "too_many_lines", count: diff.insertions + diff.deletions, limit: cfg.maxDiffLines });
    if (diff.files.some((f) => f.binary)) warnings.push({ type: "binary_files", files: diff.files.filter((f) => f.binary).map((f) => f.path) });
    if (protectedFlags.deploy_safety.length) warnings.push({ type: "deploy_safety_paths", files: protectedFlags.deploy_safety });
    if (protectedFlags.sensitive.length) warnings.push({ type: "sensitive_paths", files: protectedFlags.sensitive });

    // Self-test（記錄實際命令/結果；失敗則不開 PR）。
    let selftest = { ran: false };
    if (typeof selfTest === "function") selftest = await selfTest({ workspace: worktree, changedFiles, snapshot });
    if (selftest && selftest.ran && selftest.passed === false) {
      return finalizeFailure(db, cur, { code: "selftest_failed", headSha, diff, changedFiles, protectedFlags, warnings, selftest, providerTaskId: result?.provider_task_id, now, cfg });
    }

    // 推 coding 分支（硬性拒絕 master）。
    repo.pushBranch(worktree, cur.coding_branch, cur.base_branch);

    // 開 Draft PR（base=master）。失敗 → 標記失敗，不假裝完成。
    if (!pr || !pr.available) return finalizeFailure(db, cur, { code: "pr_gateway_unavailable", headSha, diff, changedFiles, protectedFlags, warnings, selftest, providerTaskId: result?.provider_task_id, now, cfg });
    let prResult;
    try {
      prResult = await pr.openDraftPr({ branch: cur.coding_branch, base: "master", title: buildPrTitle(cur, snapshot), body: buildPrBody(cur, snapshot, { headSha, diff, changedFiles, protectedFlags, warnings, selftest, provider }) });
    } catch (err) {
      return finalizeFailure(db, cur, { code: "pr_creation_failed", headSha, diff, changedFiles, protectedFlags, warnings, selftest, providerTaskId: result?.provider_task_id, now, cfg });
    }

    return finalizeSuccess(db, cur, { headSha, diff, changedFiles, protectedFlags, warnings, selftest, providerTaskId: result?.provider_task_id, model: result?.model, pr: prResult, now });
  } catch (err) {
    return withImmediateTx(db, () => markFailure(db, cur, { code: err.code || "coding_error", now, cfg }));
  } finally {
    if (worktree && repo && repo.cleanupWorktree) repo.cleanupWorktree(worktree);
  }
}

function appendAudit(db, { action, task, data, now }) {
  appendAuditRow(db, { actor: "system", action, entityType: "development_coding_task", entityId: String(task.id), data: { issue_id: Number(task.issue_id), coding_task_id: Number(task.id), authorization_id: Number(task.development_authorization_id), ...data }, now });
}

function resultHash({ headSha, diff, changedFiles }) {
  return createHash("sha256").update(JSON.stringify({ headSha, changedFiles: [...changedFiles].sort(), ins: diff.insertions, del: diff.deletions })).digest("hex");
}

function finalizeSuccess(db, task, { headSha, diff, changedFiles, protectedFlags, warnings, selftest, providerTaskId, model, pr, now }) {
  return withImmediateTx(db, () => {
    const rhash = resultHash({ headSha, diff, changedFiles });
    db.prepare(
      `UPDATE development_coding_task SET status='changes_ready', head_sha=?, provider_task_id=?, model=COALESCE(?,model),
        changed_files=?, diff_insertions=?, diff_deletions=?, protected_flags=?, selftest_results=?, warnings=?, result_hash=?,
        pr_number=?, pr_url=?, completed_at=?, error_code=NULL WHERE id=?`,
    ).run(headSha, providerTaskId || null, model || null, JSON.stringify(diff.files), diff.insertions, diff.deletions, JSON.stringify(protectedFlags), JSON.stringify(selftest), JSON.stringify(warnings), rhash, pr?.number ?? null, pr?.url ?? null, iso(now), Number(task.id));
    appendAudit(db, { action: "issue.coding.pr_created", task, data: { branch: task.coding_branch, base_sha: task.base_sha, head_sha: headSha, pr_number: pr?.number ?? null, changed_files: changedFiles.length }, now });
    appendAudit(db, { action: "issue.coding.completed", task, data: { base_sha: task.base_sha, head_sha: headSha, pr_number: pr?.number ?? null, insertions: diff.insertions, deletions: diff.deletions, warnings: warnings.length, protected: protectedFlags.has_protected }, now });
    return { changes_ready: true, task: publicCodingTask(db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(task.id))) };
  });
}

function finalizeFailure(db, task, { code, headSha, diff, changedFiles, protectedFlags, warnings, selftest, providerTaskId, now, cfg }) {
  return withImmediateTx(db, () => {
    db.prepare(
      `UPDATE development_coding_task SET head_sha=COALESCE(?,head_sha), provider_task_id=COALESCE(?,provider_task_id),
        changed_files=?, diff_insertions=?, diff_deletions=?, protected_flags=?, selftest_results=?, warnings=? WHERE id=?`,
    ).run(headSha || null, providerTaskId || null, JSON.stringify(diff?.files || []), diff?.insertions ?? null, diff?.deletions ?? null, JSON.stringify(protectedFlags || {}), JSON.stringify(selftest || {}), JSON.stringify(warnings || []), Number(task.id));
    return markFailure(db, task, { code, now, cfg });
  });
}

function buildCommitMessage(task, snapshot) {
  return [
    `ai-dev: ${snapshot.title || "approved change"}`.slice(0, 120), "",
    `Coding-Task: ${task.id}`, `Issue: ${task.issue_id}`, `Authorization: ${task.development_authorization_id}`,
    `Proposal: ${task.proposal_id} v${task.proposal_version}`, `Proposal-Hash: ${task.proposal_hash}`, `Base-SHA: ${task.base_sha}`,
  ].join("\n");
}
function buildPrTitle(task, snapshot) { return `[ai-dev #${task.id}] ${snapshot.title || "approved change"}`.slice(0, 160); }
function buildPrBody(task, snapshot, { headSha, diff, changedFiles, protectedFlags, warnings, selftest, provider }) {
  const lines = [
    "> Automation-generated Phase-10 coding change. DRAFT. Do NOT auto-merge; Phase 11 handles QA/review.", "",
    "## Provenance",
    `- Coding Task ID: ${task.id}`, `- Issue ID: ${task.issue_id}`, `- Development Authorization ID: ${task.development_authorization_id}`,
    `- Proposal ID/version: ${task.proposal_id} v${task.proposal_version}`, `- Proposal hash: ${task.proposal_hash}`,
    `- Provider: ${provider?.name || "none"}`, `- Base branch/SHA: ${task.base_branch} @ ${task.base_sha}`, `- Head SHA: ${headSha}`,
    "", "## Approved scope", snapshot.proposed_change || "",
    "", "## Acceptance criteria", ...(snapshot.acceptance_criteria || []).map((c) => `- ${c}`),
    "", "## Changed files (git diff = source of truth)", `- files: ${changedFiles.length}, +${diff.insertions}/-${diff.deletions}`,
    ...changedFiles.slice(0, 50).map((f) => `- \`${f}\``),
    "", "## Self-test", "```", JSON.stringify(selftest || { ran: false }), "```",
    "", "## Warnings / protected paths",
    ...(warnings.length ? warnings.map((w) => `- ${w.type}`) : ["- none"]),
    ...(protectedFlags.has_protected ? [`- protected paths present (requires manual/elevated review): deploy_safety=${protectedFlags.deploy_safety.length}, sensitive=${protectedFlags.sensitive.length}`] : []),
  ];
  return lines.join("\n");
}

// ── Owner 取消（保留分支/PR/歷史/授權 provenance） ──
export function cancelCodingTask(db, taskId, { actor = "owner", reason = null, now = new Date() } = {}) {
  return withImmediateTx(db, () => {
    const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(taskId));
    if (!task) throw httpError("coding task not found", 404);
    if (task.status === "cancelled") return { idempotent: true, task: publicCodingTask(task) };
    if (task.status === "changes_ready") {
      // 已產出變更後取消：標記需 superseded review，不刪除 PR/歷史。
      db.prepare("UPDATE development_coding_task SET error_code=? WHERE id=?").run(`owner_cancelled_after_changes:${reason ? String(reason).slice(0, 200) : ""}`, Number(task.id));
    }
    db.prepare("UPDATE development_coding_task SET status='cancelled' WHERE id=?").run(Number(task.id));
    appendAuditRow(db, { actor, action: "issue.coding.cancelled", entityType: "development_coding_task", entityId: String(task.id), data: { issue_id: Number(task.issue_id), coding_task_id: Number(task.id), authorization_id: Number(task.development_authorization_id), prev_status: task.status }, now });
    return { cancelled: true, task: publicCodingTask(db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(task.id))) };
  });
}

// ── Owner 檢視 ──
export function listCodingTasks(db, { issueId, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  return db.prepare("SELECT * FROM development_coding_task WHERE issue_id=? ORDER BY id DESC LIMIT ?").all(Number(issueId), cap).map(publicCodingTask);
}
export function getCodingTask(db, taskId) {
  const row = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(taskId));
  return row ? publicCodingTask(row) : null;
}
export function getIssueCodingView(db, issueId) {
  const auth = db.prepare("SELECT * FROM development_authorization WHERE issue_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(Number(issueId)) || null;
  const tasks = listCodingTasks(db, { issueId });
  const snapshotIdentity = auth ? { proposal_id: Number(auth.proposal_id), proposal_version: Number(auth.proposal_version), proposal_hash: auth.proposal_hash } : null;
  return {
    issue_id: Number(issueId),
    active_authorization: auth ? { id: Number(auth.id), proposal_id: Number(auth.proposal_id), proposal_version: Number(auth.proposal_version), proposal_hash: auth.proposal_hash, status: auth.status, approved_by: auth.approved_by, approved_at: auth.approved_at } : null,
    approved_snapshot_identity: snapshotIdentity,
    tasks,
    latest_task: tasks[0] || null,
  };
}
