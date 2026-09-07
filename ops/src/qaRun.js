import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { qaConfigFromEnv, buildQaPolicy, qaPolicyFingerprint, effectiveQaPolicyFingerprint } from "./qa/qaPolicy.js";
import { runAllChecks, diffHash } from "./qa/qaChecks.js";
import { aggregateQa } from "./qa/aggregate.js";
import { makeCommandRunner } from "./qa/commandRunner.js";

export const QA_MAX_ATTEMPTS = 3;
export const QA_CLAIM_STALE_MS = 15 * 60 * 1000;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;
const CODING_READY = "changes_ready";

function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }
function backoffMs(attempt) { return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS); }

export function qaRunConfigFromEnv(env = process.env) {
  const base = qaConfigFromEnv(env);
  return { ...base, enabled: env.QA_WORKER_ENABLED !== "0", concurrency: Math.max(1, Number(env.QA_CONCURRENCY) || 1), claimStaleMs: Math.max(60000, Number(env.QA_CLAIM_STALE_MS) || QA_CLAIM_STALE_MS), maxAttempts: Math.max(1, Number(env.QA_MAX_ATTEMPTS) || QA_MAX_ATTEMPTS), intervalMs: Math.max(2000, Number(env.QA_WORKER_INTERVAL_MS) || 30000) };
}

// 驗證：只有合法、完成、未取消/未失效的 Phase-10 Coding Task 可被 QA。
export function validateCodingTaskForQa(db, codingTaskId) {
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(codingTaskId));
  if (!task) throw httpError("coding task not found", 404);
  if (task.status === "cancelled") throw httpError("coding task cancelled; no fresh QA", 409);
  if (task.status !== CODING_READY) throw httpError(`coding task not eligible for QA (status=${task.status})`, 409);
  for (const f of ["development_authorization_id", "proposal_id", "proposal_version", "proposal_hash", "base_sha", "head_sha", "coding_branch", "result_hash"]) {
    if (task[f] == null || task[f] === "") throw httpError(`coding task missing ${f}`, 409);
  }
  const auth = db.prepare("SELECT * FROM development_authorization WHERE id=?").get(Number(task.development_authorization_id));
  if (!auth) throw httpError("authorization not found", 409);
  if (auth.status !== "active") throw httpError("authorization no longer active; no fresh QA", 409);
  if (String(auth.proposal_hash) !== String(task.proposal_hash) || Number(auth.proposal_version) !== Number(task.proposal_version)) throw httpError("authorization/proposal mismatch for coding task", 409);
  return { task, auth };
}

export function qaInputFingerprint({ codingTaskId, authorizationId, proposalId, proposalVersion, proposalHash, baseSha, headSha, codingResultHash, diffHashValue, policyFingerprint }) {
  const parts = [
    `coding_task_id:${codingTaskId}`, `authorization_id:${authorizationId}`,
    `proposal_id:${proposalId}`, `proposal_version:${proposalVersion}`, `proposal_hash:${proposalHash}`,
    `base_sha:${baseSha}`, `head_sha:${headSha}`, `coding_result_hash:${codingResultHash ?? ""}`,
    `diff_hash:${diffHashValue}`, `qa_policy_fp:${policyFingerprint}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function taskPublicForCtx(task) {
  const arr = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return { ...task, changed_files: arr(task.changed_files) };
}

// 建立 QA run（idempotent，需 repo 以獨立重算 diff hash）。
export function createQaRun(db, { codingTaskId, repo, env = process.env, now = new Date() }) {
  if (!repo || !repo.available) throw httpError("QA repository gateway unavailable", 503);
  const cfg = qaRunConfigFromEnv(env);
  const policy = buildQaPolicy(cfg);
  const policyFp = qaPolicyFingerprint(policy);
  const ts = iso(now);
  const { task, auth } = validateCodingTaskForQa(db, codingTaskId);
  const diff = repo.numstatRange(task.base_sha, task.head_sha);
  const dHash = diffHash(diff);
  const inputFp = qaInputFingerprint({
    codingTaskId: Number(task.id), authorizationId: Number(auth.id), proposalId: Number(task.proposal_id),
    proposalVersion: Number(task.proposal_version), proposalHash: String(task.proposal_hash),
    baseSha: task.base_sha, headSha: task.head_sha, codingResultHash: task.result_hash, diffHashValue: dHash, policyFingerprint: policyFp,
  });
  return withImmediateTx(db, () => {
    const existing = db.prepare("SELECT * FROM development_qa_run WHERE input_fingerprint=? AND status!='cancelled' ORDER BY id DESC LIMIT 1").get(inputFp);
    if (existing) return { idempotent: true, run: publicQaRun(db, existing) };
    const res = db.prepare(
      `INSERT INTO development_qa_run(issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
        base_sha, head_sha, coding_result_hash, diff_hash, qa_version, qa_policy_fingerprint, qa_policy_snapshot, input_fingerprint,
        status, attempt_count, max_attempts, next_attempt_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', 0, ?, ?, ?)`,
    ).run(
      Number(task.issue_id), Number(task.id), Number(auth.id), Number(task.proposal_id), Number(task.proposal_version), String(task.proposal_hash),
      task.base_sha, task.head_sha, task.result_hash, dHash, cfg.qaVersion, policyFp, JSON.stringify(policy), inputFp,
      cfg.maxAttempts, ts, ts,
    );
    const id = Number(res.lastInsertRowid);
    return { run: publicQaRun(db, db.prepare("SELECT * FROM development_qa_run WHERE id=?").get(id)) };
  });
}

export function claimQaBatch(db, { now = new Date(), staleMs = QA_CLAIM_STALE_MS, limit = 1 } = {}) {
  const ts = iso(now);
  const staleBefore = iso(new Date((now instanceof Date ? now.getTime() : Date.now()) - staleMs));
  return withImmediateTx(db, () => {
    const rows = db.prepare(
      `SELECT * FROM development_qa_run
       WHERE ( (status IN ('pending','failed_retry') AND next_attempt_at <= ?)
            OR (status IN ('claimed','running') AND (claimed_at IS NULL OR claimed_at < ?)) )
       ORDER BY id ASC LIMIT ?`,
    ).all(ts, staleBefore, Math.max(1, limit));
    const claimed = [];
    for (const r of rows) {
      const upd = db.prepare("UPDATE development_qa_run SET status='claimed', claimed_at=? WHERE id=? AND status=?").run(ts, r.id, r.status);
      if (upd.changes === 1) claimed.push(db.prepare("SELECT * FROM development_qa_run WHERE id=?").get(r.id));
    }
    return claimed;
  });
}

function markRunFailure(db, run, { code, now, cfg }) {
  const attempt = Number(run.attempt_count) || 0;
  const willRetry = attempt < (Number(run.max_attempts) || cfg.maxAttempts);
  const status = willRetry ? "failed_retry" : "failed";
  const next = willRetry ? iso(new Date((now instanceof Date ? now.getTime() : Date.now()) + backoffMs(attempt))) : iso(now);
  db.prepare("UPDATE development_qa_run SET status=?, error_code=?, next_attempt_at=? WHERE id=?").run(status, code, next, Number(run.id));
  appendAuditRow(db, { actor: "system", action: "issue.qa.failed", entityType: "development_qa_run", entityId: String(run.id), data: { issue_id: Number(run.issue_id), coding_task_id: Number(run.coding_task_id), qa_run_id: Number(run.id), error_code: code, status }, now });
  return { failed: true, error_code: code, status };
}

// 執行一個 QA run：獨立 worktree → 決定性檢核 → optional AI → 彙總 → 保存不可變證據。
export async function executeQaRun(db, runRow, { repo, reviewProvider = null, env = process.env, now = new Date() } = {}) {
  const cfg = qaRunConfigFromEnv(env);
  const run = db.prepare("SELECT * FROM development_qa_run WHERE id=?").get(Number(runRow.id));
  if (!run) return { skipped: true, reason: "run_missing" };
  if (run.status === "completed") return { idempotent: true, run: publicQaRun(db, run) };
  if (run.status === "cancelled") return { skipped: true, reason: "cancelled" };

  // 重新驗證 coding task 仍合格（TOCTOU）。
  let task, auth;
  try { ({ task, auth } = validateCodingTaskForQa(db, run.coding_task_id)); }
  catch (err) {
    return withImmediateTx(db, () => {
      db.prepare("UPDATE development_qa_run SET status='cancelled', error_code=? WHERE id=? AND status!='completed'").run(`coding_task_ineligible:${String(err.message).slice(0, 80)}`, Number(run.id));
      appendAuditRow(db, { actor: "system", action: "issue.qa.failed", entityType: "development_qa_run", entityId: String(run.id), data: { issue_id: Number(run.issue_id), coding_task_id: Number(run.coding_task_id), qa_run_id: Number(run.id), reason: "coding_task_ineligible" }, now });
      return { ineligible: true, reason: err.message };
    });
  }
  // head SHA 若已變動，此 run 綁定的是舊 head → 標記過期失敗，不更新 current。
  if (String(task.head_sha) !== String(run.head_sha)) {
    return withImmediateTx(db, () => markRunFailure(db, run, { code: "head_sha_changed", now, cfg }));
  }

  withImmediateTx(db, () => {
    db.prepare("UPDATE development_qa_run SET status='running', started_at=COALESCE(started_at,?), attempt_count=attempt_count+1 WHERE id=?").run(iso(now), Number(run.id));
    appendAuditRow(db, { actor: "system", action: "issue.qa.started", entityType: "development_qa_run", entityId: String(run.id), data: { issue_id: Number(run.issue_id), coding_task_id: Number(run.coding_task_id), qa_run_id: Number(run.id), base_sha: run.base_sha, head_sha: run.head_sha, qa_policy_fingerprint: run.qa_policy_fingerprint }, now });
  });

  let worktree = null;
  try {
    if (!repo || !repo.available) throw Object.assign(new Error("repo unavailable"), { code: "repo_unavailable" });
    worktree = repo.createDetachedWorktree(run.head_sha);
    let packageScripts = {};
    try { const pj = repo.readFileAt(worktree, "package.json"); if (pj) packageScripts = JSON.parse(pj).scripts || {}; } catch { packageScripts = {}; }
    const hasDeploySafetyTest = repo.readFileAt(worktree, "test/deploy-safety.test.js") != null;
    const diff = repo.numstatRange(run.base_sha, run.head_sha);
    const addedLines = repo.addedLines(run.base_sha, run.head_sha);
    const runCommand = makeCommandRunner({ cwd: worktree, timeoutMs: cfg.commandTimeoutMs, env });
    const ctx = { codingTask: taskPublicForCtx(task), snapshot: safeSnapshot(task), diff, addedLines, policy: cfg, packageScripts, runCommand, hasDeploySafetyTest };

    const checks = runAllChecks(ctx);

    // optional AI 審查（分離授權；不可用不捏造；不能把 FAIL 降為 PASS）。
    let review = null;
    const detPre = aggregateQa(checks, { reviewSeverityThreshold: cfg.reviewSeverityThreshold });
    if (reviewProvider && reviewProvider.available) {
      try {
        review = await reviewProvider.review({
          snapshot: safeSnapshot(task),
          diffSummary: { files: diff.files.length, insertions: diff.insertions, deletions: diff.deletions, changed: checks.find((c) => c.check_type === "GIT_DIFF")?.evidence },
          deterministicFindings: { blocking_checks: detPre.blocking_checks, warning_count: detPre.warning_count, results: checks.map((c) => ({ check_type: c.check_type, status: c.status, severity: c.severity })) },
        });
      } catch { review = null; }
    }
    const agg = aggregateQa(checks, { review, reviewSeverityThreshold: cfg.reviewSeverityThreshold });

    return finalizeQa(db, run, { checks, agg, reviewer: review ? (reviewProvider?.name || null) : null, now });
  } catch (err) {
    return withImmediateTx(db, () => markRunFailure(db, run, { code: err.code || "qa_error", now, cfg }));
  } finally {
    if (worktree && repo && repo.cleanupWorktree) repo.cleanupWorktree(worktree);
  }
}

function safeSnapshot(task) {
  try { return task.approved_scope_snapshot ? JSON.parse(task.approved_scope_snapshot) : {}; } catch { return {}; }
}

function finalizeQa(db, run, { checks, agg, reviewer, now }) {
  return withImmediateTx(db, () => {
    // 冪等/重跑：清掉此 run 既有 checks 再寫入。
    db.prepare("DELETE FROM development_qa_check WHERE qa_run_id=?").run(Number(run.id));
    const ins = db.prepare(`INSERT INTO development_qa_check(qa_run_id, issue_id, coding_task_id, check_type, status, severity, finding, evidence, command, tool, tool_version, started_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const c of checks) {
      ins.run(Number(run.id), Number(run.issue_id), Number(run.coding_task_id), c.check_type, c.status, c.severity, String(c.finding || "").slice(0, 1000), JSON.stringify(c.evidence || {}), c.command || null, c.tool || null, c.tool_version || null, c.started_at || iso(now), c.completed_at || iso(now), iso(now));
    }
    db.prepare("UPDATE development_qa_run SET status='completed', final_result=?, blocking_checks=?, warning_count=?, reviewer=?, completed_at=?, error_code=NULL WHERE id=?")
      .run(agg.final_result, JSON.stringify(agg.blocking_checks), agg.warning_count, reviewer, iso(now), Number(run.id));
    // 更新 canonical current（只指向 completed run）。
    db.prepare(`INSERT INTO development_qa_current(coding_task_id, qa_run_id, head_sha, input_fingerprint, final_result, updated_at)
                VALUES (?,?,?,?,?,?) ON CONFLICT(coding_task_id) DO UPDATE SET qa_run_id=excluded.qa_run_id, head_sha=excluded.head_sha, input_fingerprint=excluded.input_fingerprint, final_result=excluded.final_result, updated_at=excluded.updated_at`)
      .run(Number(run.coding_task_id), Number(run.id), run.head_sha, run.input_fingerprint, agg.final_result, iso(now));
    appendAuditRow(db, { actor: "system", action: "issue.qa.completed", entityType: "development_qa_run", entityId: String(run.id), data: { issue_id: Number(run.issue_id), coding_task_id: Number(run.coding_task_id), qa_run_id: Number(run.id), base_sha: run.base_sha, head_sha: run.head_sha, qa_policy_fingerprint: run.qa_policy_fingerprint, final_result: agg.final_result, blocking_checks: agg.blocking_checks, warning_count: agg.warning_count, reviewer }, now });
    appendAuditRow(db, { actor: "system", action: "issue.qa.current_changed", entityType: "development_qa_current", entityId: String(run.coding_task_id), data: { issue_id: Number(run.issue_id), coding_task_id: Number(run.coding_task_id), qa_run_id: Number(run.id), final_result: agg.final_result }, now });
    return { completed: true, final_result: agg.final_result, run: publicQaRun(db, db.prepare("SELECT * FROM development_qa_run WHERE id=?").get(Number(run.id))) };
  });
}

// ── public / getters ──
export function publicQaCheck(row) {
  if (!row) return null;
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return { id: Number(row.id), qa_run_id: Number(row.qa_run_id), check_type: row.check_type, status: row.status, severity: row.severity, finding: row.finding, evidence: parse(row.evidence), command: row.command, tool: row.tool, tool_version: row.tool_version, started_at: row.started_at, completed_at: row.completed_at };
}
export function publicQaRun(db, row, { withChecks = false } = {}) {
  if (!row) return null;
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const out = {
    id: Number(row.id), issue_id: Number(row.issue_id), coding_task_id: Number(row.coding_task_id),
    development_authorization_id: Number(row.development_authorization_id), proposal_id: Number(row.proposal_id),
    proposal_version: Number(row.proposal_version), proposal_hash: row.proposal_hash,
    base_sha: row.base_sha, head_sha: row.head_sha, coding_result_hash: row.coding_result_hash, diff_hash: row.diff_hash,
    qa_version: row.qa_version, qa_policy_fingerprint: row.qa_policy_fingerprint, input_fingerprint: row.input_fingerprint,
    reviewer: row.reviewer, status: row.status, final_result: row.final_result, blocking_checks: parse(row.blocking_checks),
    warning_count: row.warning_count, attempt_count: Number(row.attempt_count), error_code: row.error_code,
    created_at: row.created_at, started_at: row.started_at, completed_at: row.completed_at,
  };
  if (withChecks && db) out.checks = db.prepare("SELECT * FROM development_qa_check WHERE qa_run_id=? ORDER BY id ASC").all(Number(row.id)).map(publicQaCheck);
  return out;
}

export function getQaRunDetail(db, qaRunId) {
  const row = db.prepare("SELECT * FROM development_qa_run WHERE id=?").get(Number(qaRunId));
  return row ? publicQaRun(db, row, { withChecks: true }) : null;
}
export function listQaRuns(db, { codingTaskId, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  return db.prepare("SELECT * FROM development_qa_run WHERE coding_task_id=? ORDER BY id DESC LIMIT ?").all(Number(codingTaskId), cap).map((r) => publicQaRun(db, r));
}

// canonical current QA + 新鮮度（Phase 12 不需以時間猜測）。
export function getCurrentCodingQA(db, codingTaskId, { env = process.env } = {}) {
  const cur = db.prepare("SELECT * FROM development_qa_current WHERE coding_task_id=?").get(Number(codingTaskId));
  if (!cur) return null;
  const run = db.prepare("SELECT * FROM development_qa_run WHERE id=?").get(Number(cur.qa_run_id));
  if (!run || run.status !== "completed") return null;
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(codingTaskId));
  const reasons = [];
  if (!task) reasons.push("coding_task_missing");
  else {
    if (task.status === "cancelled") reasons.push("coding_task_cancelled");
    if (String(task.head_sha) !== String(run.head_sha)) reasons.push("head_sha_changed");
    if (String(task.base_sha) !== String(run.base_sha)) reasons.push("base_sha_changed");
    if (String(task.result_hash || "") !== String(run.coding_result_hash || "")) reasons.push("coding_result_hash_changed");
    const auth = db.prepare("SELECT status FROM development_authorization WHERE id=?").get(Number(run.development_authorization_id));
    if (!auth || auth.status !== "active") reasons.push("authorization_inactive");
  }
  if (effectiveQaPolicyFingerprint(env) !== run.qa_policy_fingerprint) reasons.push("qa_policy_changed");
  return { ...publicQaRun(db, run, { withChecks: true }), fresh: reasons.length === 0, stale: reasons.length > 0, stale_reasons: reasons, final_result: run.final_result };
}

export function getIssueQaView(db, codingTaskId, { env = process.env } = {}) {
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(codingTaskId));
  if (!task) throw httpError("coding task not found", 404);
  return { coding_task_id: Number(codingTaskId), issue_id: Number(task.issue_id), coding_task_status: task.status, current: getCurrentCodingQA(db, codingTaskId, { env }), runs: listQaRuns(db, { codingTaskId }) };
}

// Owner 手動請求重跑（不 merge/不部署）。重設當前 head 的 run 回 pending；無則交由 worker 新建。
export function requestQaRerun(db, codingTaskId, { actor = "owner", now = new Date(), env = process.env } = {}) {
  return withImmediateTx(db, () => {
    const { task } = validateCodingTaskForQa(db, codingTaskId);
    const run = db.prepare("SELECT * FROM development_qa_run WHERE coding_task_id=? AND head_sha=? AND status!='cancelled' ORDER BY id DESC LIMIT 1").get(Number(codingTaskId), task.head_sha);
    let runId = null;
    if (run && run.status !== "pending" && run.status !== "running" && run.status !== "claimed") {
      db.prepare("UPDATE development_qa_run SET status='pending', claimed_at=NULL, next_attempt_at=? WHERE id=?").run(iso(now), Number(run.id));
      runId = Number(run.id);
    } else if (run) {
      runId = Number(run.id);
    }
    appendAuditRow(db, { actor, action: "issue.qa.rerun_requested", entityType: "development_coding_task", entityId: String(codingTaskId), data: { issue_id: Number(task.issue_id), coding_task_id: Number(codingTaskId), qa_run_id: runId, head_sha: task.head_sha } });
    return { rerun_requested: true, qa_run_id: runId };
  });
}
