import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { validateCodingTaskForQa, getCurrentCodingQA, getQaRunDetail } from "./qaRun.js";
import {
  stagingConfigFromEnv, stagingEnvironmentConfig, buildStagingPolicy, stagingPolicyFingerprint,
  effectiveStagingPolicyFingerprint, configFingerprint,
} from "./staging/stagingPolicy.js";
import {
  checkSourceIdentity, checkArtifactIntegrity, checkEnvironmentIsolation, checkDatabaseIsolation,
  checkStorageIsolation, checkExternalSideEffectSafety, checkMigration, checkConfig, checkFromProviderResult,
  aggregateStaging, isProductionIdentity, isStagingClass,
} from "./staging/checks.js";

const BACKOFF_BASE_MS = 5000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;
function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }
function backoffMs(attempt) { return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS); }

export function stagingRunConfigFromEnv(env = process.env) { return stagingConfigFromEnv(env); }

// 只有「fresh Phase-11 QA PASS」的合格 coding task 可建立 Staging。
export function validateCodingTaskForStaging(db, codingTaskId, { env = process.env } = {}) {
  const { task, auth } = validateCodingTaskForQa(db, codingTaskId); // 涵蓋：存在、changes_ready、未取消、授權 active、proposal 相符
  const qa = getCurrentCodingQA(db, codingTaskId, { env });
  if (!qa) throw httpError("no current QA for coding task", 409);
  if (!qa.fresh) throw httpError(`QA is stale (${(qa.stale_reasons || []).join(",")}); re-run QA`, 409);
  if (qa.final_result !== "PASS") throw httpError(`QA result is ${qa.final_result}, not PASS`, 409);
  if (String(qa.head_sha) !== String(task.head_sha)) throw httpError("QA head SHA does not match coding task head SHA", 409);
  return { task, auth, qa };
}

export function stagingInputFingerprint(p) {
  const parts = [
    `coding_task_id:${p.codingTaskId}`, `authorization_id:${p.authorizationId}`,
    `proposal_id:${p.proposalId}`, `proposal_version:${p.proposalVersion}`, `proposal_hash:${p.proposalHash}`,
    `qa_run_id:${p.qaRunId}`, `qa_input_fp:${p.qaInputFp}`, `qa_policy_fp:${p.qaPolicyFp}`,
    `base_sha:${p.baseSha}`, `head_sha:${p.headSha}`, `coding_result_hash:${p.codingResultHash ?? ""}`, `diff_hash:${p.diffHash ?? ""}`,
    `staging_policy_fp:${p.stagingPolicyFp}`, `config_fp:${p.configFp}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function createStagingDeployment(db, { codingTaskId, repo, env = process.env, now = new Date() }) {
  if (!repo || !repo.available) throw httpError("staging repository gateway unavailable", 503);
  const cfg = stagingConfigFromEnv(env);
  const policy = buildStagingPolicy(cfg);
  const policyFp = stagingPolicyFingerprint(policy);
  const config = stagingEnvironmentConfig(env);
  const configFp = configFingerprint(config);
  const ts = iso(now);
  const { task, auth, qa } = validateCodingTaskForStaging(db, codingTaskId, { env });
  const inputFp = stagingInputFingerprint({
    codingTaskId: Number(task.id), authorizationId: Number(auth.id), proposalId: Number(task.proposal_id),
    proposalVersion: Number(task.proposal_version), proposalHash: String(task.proposal_hash),
    qaRunId: Number(qa.id), qaInputFp: qa.input_fingerprint, qaPolicyFp: qa.qa_policy_fingerprint,
    baseSha: task.base_sha, headSha: task.head_sha, codingResultHash: task.result_hash, diffHash: qa.diff_hash,
    stagingPolicyFp: policyFp, configFp,
  });
  return withImmediateTx(db, () => {
    const existing = db.prepare("SELECT * FROM development_staging_deployment WHERE input_fingerprint=? AND status!='cancelled' ORDER BY id DESC LIMIT 1").get(inputFp);
    if (existing) return { idempotent: true, deployment: publicStaging(db, existing) };
    const res = db.prepare(
      `INSERT INTO development_staging_deployment(issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
        qa_run_id, qa_input_fingerprint, qa_policy_fingerprint, base_sha, head_sha, coding_result_hash, diff_hash,
        staging_provider, staging_policy_version, staging_policy_fingerprint, config_fingerprint, config_snapshot, input_fingerprint,
        status, attempt_count, max_attempts, next_attempt_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', 0, ?, ?, ?)`,
    ).run(
      Number(task.issue_id), Number(task.id), Number(auth.id), Number(task.proposal_id), Number(task.proposal_version), String(task.proposal_hash),
      Number(qa.id), qa.input_fingerprint, qa.qa_policy_fingerprint, task.base_sha, task.head_sha, task.result_hash, qa.diff_hash,
      cfg.provider, policy.policy_version, policyFp, configFp, JSON.stringify(config), inputFp,
      cfg.maxAttempts, ts, ts,
    );
    const id = Number(res.lastInsertRowid);
    appendAuditRow(db, { actor: "system", action: "issue.staging.created", entityType: "development_staging_deployment", entityId: String(id), data: { issue_id: Number(task.issue_id), coding_task_id: Number(task.id), qa_run_id: Number(qa.id), staging_deployment_id: id, head_sha: task.head_sha, staging_policy_fingerprint: policyFp }, now });
    return { deployment: publicStaging(db, db.prepare("SELECT * FROM development_staging_deployment WHERE id=?").get(id)) };
  });
}

export function claimStagingBatch(db, { now = new Date(), staleMs = 15 * 60 * 1000, limit = 1 } = {}) {
  const ts = iso(now);
  const staleBefore = iso(new Date((now instanceof Date ? now.getTime() : Date.now()) - staleMs));
  return withImmediateTx(db, () => {
    const rows = db.prepare(
      `SELECT * FROM development_staging_deployment
       WHERE ( (status IN ('pending','failed_retry') AND next_attempt_at <= ?)
            OR (status IN ('claimed','building','deploying','validating') AND (claimed_at IS NULL OR claimed_at < ?)) )
       ORDER BY id ASC LIMIT ?`,
    ).all(ts, staleBefore, Math.max(1, limit));
    const claimed = [];
    for (const r of rows) {
      const upd = db.prepare("UPDATE development_staging_deployment SET status='claimed', claimed_at=? WHERE id=? AND status=?").run(ts, r.id, r.status);
      if (upd.changes === 1) claimed.push(db.prepare("SELECT * FROM development_staging_deployment WHERE id=?").get(r.id));
    }
    return claimed;
  });
}

function markFailure(db, dep, { code, now, cfg }) {
  const attempt = Number(dep.attempt_count) || 0;
  const willRetry = attempt < (Number(dep.max_attempts) || cfg.maxAttempts);
  const status = willRetry ? "failed_retry" : "failed";
  const next = willRetry ? iso(new Date((now instanceof Date ? now.getTime() : Date.now()) + backoffMs(attempt))) : iso(now);
  db.prepare("UPDATE development_staging_deployment SET status=?, error_code=?, next_attempt_at=? WHERE id=?").run(status, code, next, Number(dep.id));
  appendAuditRow(db, { actor: "system", action: "issue.staging.failed", entityType: "development_staging_deployment", entityId: String(dep.id), data: { issue_id: Number(dep.issue_id), coding_task_id: Number(dep.coding_task_id), staging_deployment_id: Number(dep.id), error_code: code, status }, now });
  return { failed: true, error_code: code, status };
}
function audit(db, action, dep, data, now) {
  appendAuditRow(db, { actor: "system", action, entityType: "development_staging_deployment", entityId: String(dep.id), data: { issue_id: Number(dep.issue_id), coding_task_id: Number(dep.coding_task_id), staging_deployment_id: Number(dep.id), ...data }, now });
}

export async function executeStagingDeployment(db, depRow, { repo, provider, env = process.env, now = new Date() } = {}) {
  const cfg = stagingConfigFromEnv(env);
  const dep = db.prepare("SELECT * FROM development_staging_deployment WHERE id=?").get(Number(depRow.id));
  if (!dep) return { skipped: true, reason: "missing" };
  if (dep.status === "ready") return { idempotent: true, deployment: publicStaging(db, dep) };
  if (dep.status === "cancelled") return { skipped: true, reason: "cancelled" };

  // recheck：資格 / fresh QA PASS / head 不變。
  let task, auth, qa;
  try { ({ task, auth, qa } = validateCodingTaskForStaging(db, dep.coding_task_id, { env })); }
  catch (err) {
    return withImmediateTx(db, () => {
      db.prepare("UPDATE development_staging_deployment SET status='superseded', error_code=? WHERE id=? AND status!='ready'").run(`ineligible:${String(err.message).slice(0, 80)}`, Number(dep.id));
      audit(db, "issue.staging.failed", dep, { reason: "ineligible" }, now);
      return { ineligible: true, reason: err.message };
    });
  }
  if (String(task.head_sha) !== String(dep.head_sha) || Number(qa.id) !== Number(dep.qa_run_id)) {
    return withImmediateTx(db, () => { db.prepare("UPDATE development_staging_deployment SET status='superseded', error_code='source_changed' WHERE id=? AND status!='ready'").run(Number(dep.id)); audit(db, "issue.staging.stale", dep, { reason: "source_changed" }, now); return { superseded: true }; });
  }
  if (!provider || !provider.available) {
    withImmediateTx(db, () => db.prepare("UPDATE development_staging_deployment SET status='pending', error_code='provider_unavailable', claimed_at=NULL, next_attempt_at=? WHERE id=? AND status IN ('claimed','building','deploying','validating','failed_retry')").run(iso(new Date((now instanceof Date ? now.getTime() : Date.now()) + backoffMs(1))), Number(dep.id)));
    return { skipped: true, reason: "provider_unavailable" };
  }

  withImmediateTx(db, () => {
    db.prepare("UPDATE development_staging_deployment SET status='building', started_at=COALESCE(started_at,?), attempt_count=attempt_count+1 WHERE id=?").run(iso(now), Number(dep.id));
    audit(db, "issue.staging.build_started", dep, { head_sha: dep.head_sha, provider: provider.name }, now);
  });

  const config = JSON.parse(dep.config_snapshot || "{}");
  let worktree = null;
  const checks = [];
  const meta = { artifact: null, environment_id: null, environment_class: null, url: null, source_tree_hash: null };
  try {
    // 來源身分：QA head === task head === branch 現在的 head。
    const src = checkSourceIdentity({ repo, task, qaHeadSha: qa.head_sha });
    checks.push(stamp(src, now));
    if (src.status === "FAIL") return finalize(db, dep, { checks, meta, provider, now, cfg });

    if (!repo || !repo.available) throw Object.assign(new Error("repo unavailable"), { code: "repo_unavailable" });
    worktree = repo.createDetachedWorktree(dep.head_sha);
    meta.source_tree_hash = repo.treeHash(dep.head_sha);

    // 建置不可變 artifact（由確切 head SHA）。
    let artifact;
    try { artifact = await provider.build({ headSha: dep.head_sha, worktree, sanitizedConfig: config }); }
    catch (err) { return withImmediateTx(db, () => markFailure(db, dep, { code: err.code || "build_failed", now, cfg })); }
    meta.artifact = artifact;
    withImmediateTx(db, () => audit(db, "issue.staging.artifact_created", dep, { artifact_digest: artifact.artifact_digest, source_head_sha: artifact.source_head_sha }, now));
    checks.push(stamp(checkArtifactIntegrity({ artifact, headSha: dep.head_sha }), now));

    // 隔離檢核（fail-closed：blocking 則不部署）。
    checks.push(stamp(checkEnvironmentIsolation(config), now));
    checks.push(stamp(checkDatabaseIsolation(config), now));
    checks.push(stamp(checkStorageIsolation(config), now));
    checks.push(stamp(checkExternalSideEffectSafety(config), now));
    const preBlock = checks.some((c) => c.status === "FAIL" && c.severity === "blocking");
    if (preBlock) return finalize(db, dep, { checks, meta, provider, now, cfg });

    // 部署到隔離環境。
    withImmediateTx(db, () => { db.prepare("UPDATE development_staging_deployment SET status='deploying' WHERE id=?").run(Number(dep.id)); audit(db, "issue.staging.deploy_started", dep, {}, now); });
    const deployRes = await provider.deploy({ artifact, sanitizedConfig: config });
    meta.environment_id = deployRes.environment_id || config.environment_id;
    meta.environment_class = deployRes.environment_class || config.environment_class;
    meta.url = deployRes.endpoint_ref || null;
    checks.push(stamp(checkFromProviderResult("DEPLOY", deployRes), now));
    if (!deployRes.deployed) return finalize(db, dep, { checks, meta, provider, now, cfg });
    withImmediateTx(db, () => audit(db, "issue.staging.deployed", dep, { environment_id: meta.environment_id, artifact_digest: artifact.artifact_digest }, now));

    // 健康 / 冒煙驗證（獨立，不採信 provider 一句「成功」）。
    withImmediateTx(db, () => db.prepare("UPDATE development_staging_deployment SET status='validating', deployed_at=? WHERE id=?").run(iso(now), Number(dep.id)));
    checks.push(stamp(checkFromProviderResult("HEALTH", await provider.health({ endpoint: meta.url })), now));
    checks.push(stamp(checkFromProviderResult("SMOKE", await provider.smoke({ endpoint: meta.url })), now));

    // 遷移（消費 Phase-11 證據；只對隔離 DB）。
    const qaDetail = getQaRunDetail(db, qa.id);
    const qaMigration = (qaDetail?.checks || []).find((c) => c.check_type === "DATABASE_MIGRATION");
    checks.push(stamp(checkMigration({ qaMigration, config }), now));
    checks.push(stamp(checkConfig({ configFingerprint: dep.config_fingerprint, config }), now));

    return finalize(db, dep, { checks, meta, provider, now, cfg });
  } catch (err) {
    return withImmediateTx(db, () => markFailure(db, dep, { code: err.code || "staging_error", now, cfg }));
  } finally {
    if (worktree && repo && repo.cleanupWorktree) repo.cleanupWorktree(worktree);
  }
}

function stamp(check, now) { return { ...check, started_at: iso(now), completed_at: iso(now) }; }

function finalize(db, dep, { checks, meta, provider, now, cfg }) {
  const agg = aggregateStaging(checks);
  return withImmediateTx(db, () => {
    db.prepare("DELETE FROM development_staging_check WHERE staging_deployment_id=?").run(Number(dep.id));
    const ins = db.prepare(`INSERT INTO development_staging_check(staging_deployment_id, issue_id, coding_task_id, check_type, status, severity, finding, evidence, started_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const c of checks) ins.run(Number(dep.id), Number(dep.issue_id), Number(dep.coding_task_id), c.check_type, c.status, c.severity, String(c.finding || "").slice(0, 1000), JSON.stringify(c.evidence || {}), c.started_at, c.completed_at, iso(now));
    const pass = agg.validation_result === "PASS";
    const expires = pass && cfg.ttlMs ? iso(new Date((now instanceof Date ? now.getTime() : Date.now()) + cfg.ttlMs)) : null;
    db.prepare(
      `UPDATE development_staging_deployment SET status=?, validation_result=?, blocking_checks=?, warning_count=?, error_code=?,
        artifact_id=?, artifact_digest=?, source_tree_hash=?, staging_environment_id=?, staging_environment_class=?, staging_url=?,
        completed_at=?, expires_at=? WHERE id=?`,
    ).run(
      pass ? "ready" : "failed", agg.validation_result, JSON.stringify(agg.blocking_checks), agg.warning_count, pass ? null : agg.validation_result,
      meta.artifact?.artifact_id || null, meta.artifact?.artifact_digest || null, meta.source_tree_hash || null,
      meta.environment_id || null, meta.environment_class || null, meta.url || null, iso(now), expires, Number(dep.id),
    );
    audit(db, "issue.staging.validation_completed", dep, { validation_result: agg.validation_result, blocking_checks: agg.blocking_checks, warning_count: agg.warning_count, artifact_digest: meta.artifact?.artifact_digest || null }, now);
    if (pass) {
      db.prepare(`INSERT INTO development_staging_current(coding_task_id, staging_deployment_id, head_sha, input_fingerprint, validation_result, updated_at)
                  VALUES (?,?,?,?,?,?) ON CONFLICT(coding_task_id) DO UPDATE SET staging_deployment_id=excluded.staging_deployment_id, head_sha=excluded.head_sha, input_fingerprint=excluded.input_fingerprint, validation_result=excluded.validation_result, updated_at=excluded.updated_at`)
        .run(Number(dep.coding_task_id), Number(dep.id), dep.head_sha, dep.input_fingerprint, agg.validation_result, iso(now));
      audit(db, "issue.staging.ready", dep, { artifact_digest: meta.artifact?.artifact_digest || null, environment_id: meta.environment_id, validation_result: "PASS" }, now);
    } else {
      audit(db, "issue.staging.failed", dep, { validation_result: agg.validation_result, blocking_checks: agg.blocking_checks }, now);
    }
    return { completed: true, validation_result: agg.validation_result, deployment: publicStaging(db, db.prepare("SELECT * FROM development_staging_deployment WHERE id=?").get(Number(dep.id))) };
  });
}

// ── public / getters ──
export function publicStagingCheck(row) {
  if (!row) return null;
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return { id: Number(row.id), staging_deployment_id: Number(row.staging_deployment_id), check_type: row.check_type, status: row.status, severity: row.severity, finding: row.finding, evidence: parse(row.evidence), started_at: row.started_at, completed_at: row.completed_at };
}
export function publicStaging(db, row, { withChecks = false } = {}) {
  if (!row) return null;
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const out = {
    id: Number(row.id), issue_id: Number(row.issue_id), coding_task_id: Number(row.coding_task_id),
    development_authorization_id: Number(row.development_authorization_id), proposal_id: Number(row.proposal_id),
    proposal_version: Number(row.proposal_version), proposal_hash: row.proposal_hash, qa_run_id: Number(row.qa_run_id),
    base_sha: row.base_sha, head_sha: row.head_sha, coding_result_hash: row.coding_result_hash, diff_hash: row.diff_hash,
    source_tree_hash: row.source_tree_hash, artifact_id: row.artifact_id, artifact_digest: row.artifact_digest,
    staging_provider: row.staging_provider, staging_environment_id: row.staging_environment_id, staging_environment_class: row.staging_environment_class,
    staging_url: row.staging_url, staging_policy_version: row.staging_policy_version, staging_policy_fingerprint: row.staging_policy_fingerprint,
    config_fingerprint: row.config_fingerprint, input_fingerprint: row.input_fingerprint,
    status: row.status, validation_result: row.validation_result, blocking_checks: parse(row.blocking_checks), warning_count: row.warning_count,
    attempt_count: Number(row.attempt_count), error_code: row.error_code, expires_at: row.expires_at, cleanup_status: row.cleanup_status,
    created_at: row.created_at, started_at: row.started_at, deployed_at: row.deployed_at, completed_at: row.completed_at,
  };
  if (withChecks && db) out.checks = db.prepare("SELECT * FROM development_staging_check WHERE staging_deployment_id=? ORDER BY id ASC").all(Number(row.id)).map(publicStagingCheck);
  return out;
}
export function getStagingDeployment(db, id) {
  const row = db.prepare("SELECT * FROM development_staging_deployment WHERE id=?").get(Number(id));
  return row ? publicStaging(db, row, { withChecks: true }) : null;
}
export function listStagingDeployments(db, { codingTaskId, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  return db.prepare("SELECT * FROM development_staging_deployment WHERE coding_task_id=? ORDER BY id DESC LIMIT ?").all(Number(codingTaskId), cap).map((r) => publicStaging(db, r));
}

export function getCurrentCodingStaging(db, codingTaskId, { env = process.env } = {}) {
  const cur = db.prepare("SELECT * FROM development_staging_current WHERE coding_task_id=?").get(Number(codingTaskId));
  if (!cur) return null;
  const dep = db.prepare("SELECT * FROM development_staging_deployment WHERE id=?").get(Number(cur.staging_deployment_id));
  if (!dep || dep.status !== "ready") return null;
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(codingTaskId));
  const reasons = [];
  if (!task) reasons.push("coding_task_missing");
  else {
    if (task.status === "cancelled") reasons.push("coding_task_cancelled");
    if (String(task.head_sha) !== String(dep.head_sha)) reasons.push("head_sha_changed");
    if (String(task.result_hash || "") !== String(dep.coding_result_hash || "")) reasons.push("coding_result_hash_changed");
  }
  const qa = getCurrentCodingQA(db, codingTaskId, { env });
  if (!qa || !qa.fresh || qa.final_result !== "PASS") reasons.push("qa_not_fresh_pass");
  else if (Number(qa.id) !== Number(dep.qa_run_id)) reasons.push("qa_run_changed");
  if (effectiveStagingPolicyFingerprint(env) !== dep.staging_policy_fingerprint) reasons.push("staging_policy_changed");
  if (configFingerprint(stagingEnvironmentConfig(env)) !== dep.config_fingerprint) reasons.push("config_changed");
  return { ...publicStaging(db, dep, { withChecks: true }), fresh: reasons.length === 0, stale: reasons.length > 0, stale_reasons: reasons, validation_result: dep.validation_result, artifact_digest: dep.artifact_digest, endpoint: dep.staging_url };
}

export function getCodingStagingView(db, codingTaskId, { env = process.env } = {}) {
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(codingTaskId));
  if (!task) throw httpError("coding task not found", 404);
  let qa = null; try { qa = getCurrentCodingQA(db, codingTaskId, { env }); } catch { qa = null; }
  return { coding_task_id: Number(codingTaskId), issue_id: Number(task.issue_id), coding_task_status: task.status, current_qa: qa, current: getCurrentCodingStaging(db, codingTaskId, { env }), deployments: listStagingDeployments(db, { codingTaskId }) };
}

// ── Owner mutations ──
export function requestStagingRedeploy(db, codingTaskId, { actor = "owner", now = new Date(), env = process.env } = {}) {
  return withImmediateTx(db, () => {
    const { task } = validateCodingTaskForStaging(db, codingTaskId, { env });
    const dep = db.prepare("SELECT * FROM development_staging_deployment WHERE coding_task_id=? AND head_sha=? AND status!='cancelled' ORDER BY id DESC LIMIT 1").get(Number(codingTaskId), task.head_sha);
    let id = null;
    if (dep && !["pending", "claimed", "building", "deploying", "validating"].includes(dep.status)) {
      db.prepare("UPDATE development_staging_deployment SET status='pending', claimed_at=NULL, next_attempt_at=? WHERE id=?").run(iso(now), Number(dep.id));
      id = Number(dep.id);
    } else if (dep) id = Number(dep.id);
    appendAuditRow(db, { actor, action: "issue.staging.redeploy_requested", entityType: "development_coding_task", entityId: String(codingTaskId), data: { issue_id: Number(task.issue_id), coding_task_id: Number(codingTaskId), staging_deployment_id: id, head_sha: task.head_sha } });
    return { redeploy_requested: true, staging_deployment_id: id };
  });
}
export function cancelStagingDeployment(db, id, { actor = "owner", reason = null, now = new Date() } = {}) {
  return withImmediateTx(db, () => {
    const dep = db.prepare("SELECT * FROM development_staging_deployment WHERE id=?").get(Number(id));
    if (!dep) throw httpError("staging deployment not found", 404);
    if (dep.status === "cancelled") return { idempotent: true, deployment: publicStaging(db, dep) };
    db.prepare("UPDATE development_staging_deployment SET status='cancelled', error_code=COALESCE(error_code, ?) WHERE id=?").run(reason ? `owner_cancelled:${String(reason).slice(0, 120)}` : "owner_cancelled", Number(dep.id));
    audit(db, "issue.staging.cancelled", dep, { prev_status: dep.status }, now);
    return { cancelled: true, deployment: publicStaging(db, db.prepare("SELECT * FROM development_staging_deployment WHERE id=?").get(Number(dep.id))) };
  });
}
// 清理：務必以「明確 staging-class 且非 production」的環境身分護欄，fail-closed。
export function cleanupStagingDeployment(db, id, { actor = "owner", provider = null, now = new Date() } = {}) {
  const dep = db.prepare("SELECT * FROM development_staging_deployment WHERE id=?").get(Number(id));
  if (!dep) throw httpError("staging deployment not found", 404);
  const identity = { environment_class: dep.staging_environment_class, environment_id: dep.staging_environment_id };
  if (isProductionIdentity(identity) || !dep.staging_environment_class || !isStagingClass(identity)) {
    throw httpError("refusing cleanup: environment is not an explicit non-production staging class (fail-closed)", 409);
  }
  return withImmediateTx(db, () => {
    let cleaned = true;
    if (provider && provider.available && provider.cleanup) {
      // provider.cleanup 為同步或非同步；此處僅記錄請求，真正 teardown 由 worker/opt-in 執行。
    }
    db.prepare("UPDATE development_staging_deployment SET cleanup_status='requested' WHERE id=?").run(Number(dep.id));
    appendAuditRow(db, { actor, action: "issue.staging.cleanup_requested", entityType: "development_staging_deployment", entityId: String(dep.id), data: { issue_id: Number(dep.issue_id), coding_task_id: Number(dep.coding_task_id), staging_deployment_id: Number(dep.id), environment_class: dep.staging_environment_class, environment_id: dep.staging_environment_id }, now });
    return { cleanup_requested: true, cleaned };
  });
}
