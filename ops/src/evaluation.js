import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAudit, appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { getCurrentIssueMembers } from "./clustering.js";
import { getCurrentIssueImpact, impactStaleReasons } from "./impact.js";
import { getCurrentFeedbackAnalysis } from "./feedbackAnalysis.js";
import { buildRoleEvaluationPrompt, evaluationRolesConfig, ROLE_SET_VERSION, ROLE_PROMPT_VERSION } from "./evaluationRoles.js";
import { parseAndValidateRole } from "./evaluationSchema.js";
import { aggregateVotes, aggregationConfig, EVALUATION_VERSION, AGGREGATION_VERSION } from "./evaluationAggregation.js";
import { buildEvaluationPolicy, evaluationPolicyFingerprint, effectiveEvaluationPolicyFingerprint } from "./evaluationPolicy.js";
import { issueWriteDecision } from "./insightConsent.js";

export const EVAL_MAX_RETRIES = 5;
export const EVAL_SCHEMA_MAX_RETRIES = 2; // 明顯 schema/設定錯誤不無限重試
export const EVAL_CLAIM_STALE_MS = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;
const MAX_EVIDENCE_SUMMARIES = 30;
const SUMMARY_CAP = 300;

function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }

export function evaluationBackoffMs(retries, { base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS, random = Math.random } = {}) {
  const raw = Math.min(base * 2 ** Math.max(0, retries - 1), cap);
  return Math.round(raw * (0.5 + 0.5 * random()));
}

// 決定性 input fingerprint：綁定「本次評估所使用的確切 canonical 證據」。
// canonical 實質改變 → fingerprint 改變 → 舊評估 stale（但歷史 run 保留）。
export function evaluationInputFingerprint({
  issueId, issueStatus, issueCategory, issueUpdatedAt,
  membershipFingerprint, impactAssessmentId, impactMembershipFingerprint,
  impactAnalysisFingerprint, impactScoringVersion, impactAsOfAt,
  roles, evaluationVersion = EVALUATION_VERSION, aggregationVersion = AGGREGATION_VERSION, roleSetVersion = ROLE_SET_VERSION,
}) {
  const parts = [
    `issue_id:${issueId}`,
    `issue_status:${issueStatus ?? ""}`,
    `issue_category:${issueCategory ?? ""}`,
    `issue_updated_at:${issueUpdatedAt ?? ""}`,
    `membership_fp:${membershipFingerprint ?? ""}`,
    `impact_assessment_id:${impactAssessmentId ?? ""}`,
    `impact_membership_fp:${impactMembershipFingerprint ?? ""}`,
    `impact_analysis_fp:${impactAnalysisFingerprint ?? ""}`,
    `impact_scoring_version:${impactScoringVersion ?? ""}`,
    `impact_as_of_at:${impactAsOfAt ?? ""}`,
    `eval_version:${evaluationVersion}`,
    `agg_version:${aggregationVersion}`,
    `role_set_version:${roleSetVersion}`,
    `roles:${[...(roles || [])].map((r) => String(r).toUpperCase()).sort().join(",")}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// 只用 canonical 當前成員 + 當前分析摘要建立「資料最小化」的評估輸入（無 PII）。
export function buildEvaluatorInput(db, issue, impact) {
  const members = getCurrentIssueMembers(db, issue.id);
  const summaries = [];
  for (const m of members.slice(0, MAX_EVIDENCE_SUMMARIES)) {
    const ca = getCurrentFeedbackAnalysis(db, m.feedback_id);
    if (!ca) continue;
    summaries.push({
      category: ca.category,
      severity_hint: ca.severity_hint,
      summary: String(ca.summary || "").slice(0, SUMMARY_CAP),
    });
  }
  return {
    issue: {
      id: Number(issue.id),
      title: String(issue.title || "").slice(0, 200),
      category: issue.category || "OTHER",
      status: issue.status,
    },
    impact: {
      impact_level: impact.impact_level,
      impact_score: impact.impact_score,
      current_feedback_count: impact.current_feedback_count,
      distinct_reporter_count: impact.distinct_reporter_count,
      recent_velocity: impact.recent_velocity,
      severity_distribution: impact.severity_distribution,
      category_distribution: impact.category_distribution,
      feedback_count_24h: impact.feedback_count_24h,
      feedback_count_7d: impact.feedback_count_7d,
      feedback_count_30d: impact.feedback_count_30d,
      as_of_at: impact.as_of_at,
    },
    evidence_summaries: summaries,
  };
}

// 計算評估輸入 + fingerprint。若 issue 非 active 或 impact 不可用/stale → defer（不產生 canonical 評估）。
export function computeEvaluationInput(db, issueId, { now = new Date(), roles } = {}) {
  const issue = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(issueId));
  if (!issue) return { ok: false, reason: "issue_not_found" };
  if (issue.status !== "open") return { ok: false, reason: "issue_inactive", issue };
  const impact = getCurrentIssueImpact(db, issueId, { now });
  if (!impact) return { ok: false, defer: true, reason: "impact_unavailable", issue };
  if (impact.stale) return { ok: false, defer: true, reason: "impact_stale", issue, impact, staleReasons: impact.stale_reasons };
  const roleList = roles || evaluationRolesConfig().roles;
  const fingerprint = evaluationInputFingerprint({
    issueId: Number(issue.id),
    issueStatus: issue.status,
    issueCategory: issue.category,
    issueUpdatedAt: issue.updated_at,
    membershipFingerprint: impact.membership_fingerprint,
    impactAssessmentId: impact.id,
    impactMembershipFingerprint: impact.membership_fingerprint,
    impactAnalysisFingerprint: impact.analysis_fingerprint,
    impactScoringVersion: impact.scoring_version,
    impactAsOfAt: impact.as_of_at,
    roles: roleList,
  });
  return {
    ok: true,
    issue,
    impact,
    roles: roleList,
    sourceImpactAssessmentId: impact.id,
    fingerprint,
    evaluatorInput: buildEvaluatorInput(db, issue, impact),
  };
}

// 建立一個 pending run（不自帶交易時可直接呼叫；manual 由 requestEvaluationRecalc 包交易）。
export function enqueueEvaluationRun(db, { issueId, roles, deliberationEnabled = false, fingerprint = "pending", sourceImpactAssessmentId = null, now = new Date() }) {
  const roleList = roles || evaluationRolesConfig().roles;
  const ts = iso(now);
  const gate = issueWriteDecision(db, issueId);
  if (!gate.ok) {
    const err = httpError(gate.reason === "stale_generation" ? "訂閱世代已換，晚到評估不入隊。" : "訂閱已退出，晚到評估不入隊。", 409);
    err.code = gate.reason || "subscription_revoked";
    throw err;
  }
  const generation = gate.unbound ? null : gate.generation;
  const res = db.prepare(
    `INSERT INTO issue_evaluation_run
      (issue_id, evaluation_version, aggregation_version, role_set_version, input_fingerprint, source_impact_assessment_id,
       status, deliberation_enabled, retry_count, max_retries, next_attempt_at, created_at, subscription_generation)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`,
  ).run(Number(issueId), EVALUATION_VERSION, AGGREGATION_VERSION, ROLE_SET_VERSION, fingerprint, sourceImpactAssessmentId, deliberationEnabled ? 1 : 0, EVAL_MAX_RETRIES, ts, ts, generation);
  return { id: Number(res.lastInsertRowid), subscription_generation: generation };
}

function abandonEvaluationRun(db, run, reason) {
  db.prepare("UPDATE issue_evaluation_run SET status='failed', error_code=? WHERE id=? AND status IN ('pending','failed_retry','processing')")
    .run(String(reason || "subscription_revoked").slice(0, 64), run.id);
}

export function claimEvaluationBatch(db, { limit = 5, now = new Date(), staleMs = EVAL_CLAIM_STALE_MS } = {}) {
  const nowIso = iso(now);
  const staleBefore = iso(new Date((now instanceof Date ? now.getTime() : now) - staleMs));
  const inflight = db.prepare("SELECT * FROM issue_evaluation_run WHERE status IN ('pending','failed_retry','processing')").all();
  for (const row of inflight) {
    const decision = issueWriteDecision(db, row.issue_id, { expectedGeneration: row.subscription_generation });
    if (!decision.ok) abandonEvaluationRun(db, row, decision.reason);
  }
  const candidates = db.prepare(
    `SELECT * FROM issue_evaluation_run
     WHERE (status IN ('pending','failed_retry') AND next_attempt_at <= ?)
        OR (status = 'processing' AND (claimed_at IS NULL OR claimed_at <= ?))
     ORDER BY id ASC LIMIT ?`,
  ).all(nowIso, staleBefore, Math.max(1, Math.min(Number(limit) || 5, 50)));
  const claimed = [];
  for (const row of candidates) {
    const decision = issueWriteDecision(db, row.issue_id, { expectedGeneration: row.subscription_generation });
    if (!decision.ok) {
      abandonEvaluationRun(db, row, decision.reason);
      continue;
    }
    let res;
    if (row.status === "processing") {
      res = db.prepare("UPDATE issue_evaluation_run SET claimed_at=? WHERE id=? AND status='processing' AND (claimed_at IS NULL OR claimed_at <= ?)").run(nowIso, row.id, staleBefore);
    } else {
      res = db.prepare("UPDATE issue_evaluation_run SET status='processing', claimed_at=? WHERE id=? AND status=?").run(nowIso, row.id, row.status);
    }
    if (res.changes === 1) claimed.push({ ...row, status: "processing", claimed_at: nowIso });
  }
  return claimed;
}

// defer（impact 尚未 fresh 等）：軟性排程重試，不增加 retry_count、不 dead-letter。
function deferRun(db, run, { errorCode, now = new Date(), random = Math.random }) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const next = iso(new Date(nowMs + evaluationBackoffMs(1, { random })));
  db.prepare("UPDATE issue_evaluation_run SET status='failed_retry', next_attempt_at=?, error_code=? WHERE id=?").run(next, String(errorCode).slice(0, 64), run.id);
  return { status: "deferred", errorCode };
}

// 失敗：transient=true 用一般上限；schema/設定錯誤用較低上限。CURRENT 指標不受影響（不 promote）。
export function failRun(db, run, { errorCode, transient = true, now = new Date(), random = Math.random }) {
  const retries = Number(run.retry_count) + 1;
  const cap = transient ? Number(run.max_retries || EVAL_MAX_RETRIES) : EVAL_SCHEMA_MAX_RETRIES;
  const code = String(errorCode || "error").slice(0, 64);
  if (retries >= cap) {
    db.prepare("UPDATE issue_evaluation_run SET status='failed', retry_count=?, error_code=? WHERE id=?").run(retries, code, run.id);
    return { status: "failed", retry_count: retries };
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const next = iso(new Date(nowMs + evaluationBackoffMs(retries, { random })));
  db.prepare("UPDATE issue_evaluation_run SET status='failed_retry', retry_count=?, next_attempt_at=?, error_code=? WHERE id=?").run(retries, next, code, run.id);
  return { status: "failed_retry", retry_count: retries, next_attempt_at: next };
}

function insertRoleEval(db, { runId, issueId, role, round, result, provider, model, promptVersion, rawText, now }) {
  const outputHash = createHash("sha256").update(String(rawText)).digest("hex");
  db.prepare(
    `INSERT INTO issue_role_evaluation
      (evaluation_run_id, issue_id, role, round, recommendation, confidence, risk_level, rationale,
       evidence_refs, missing_evidence, risk_flags, provider, model, model_version, prompt_version, output_hash, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
  ).run(
    Number(runId), Number(issueId), role, round, result.recommendation, result.confidence, result.risk_level, result.rationale,
    JSON.stringify(result.evidence_refs), JSON.stringify(result.missing_evidence), JSON.stringify(result.risk_flags),
    provider, model, null, promptVersion, outputHash, iso(now),
  );
}

// 執行一個已 claim 的 run：round1 獨立評估 → （選配）一次 deliberation → 決定性聚合 → promote。
// provider 呼叫在交易外；promotion（complete + current pointer）在單一交易。
export async function executeEvaluationRun(db, run, { provider, aggConfig = aggregationConfig(), roles, timeoutMs = 20000, now = () => new Date(), random = Math.random } = {}) {
  const nowDate = now();
  const gate = issueWriteDecision(db, run.issue_id, { expectedGeneration: run.subscription_generation });
  if (!gate.ok) {
    withImmediateTx(db, () => abandonEvaluationRun(db, run, gate.reason));
    return "failed";
  }
  const input = computeEvaluationInput(db, run.issue_id, { now: nowDate, roles });
  if (!input.ok) {
    if (input.defer) {
      // impact 未 fresh：軟性延後重試，不動 current（Phase 7 依賴 Phase 6 新鮮度）。
      let out;
      withImmediateTx(db, () => { out = deferRun(db, run, { errorCode: input.reason, now: nowDate, random }); });
      return out.status;
    }
    // issue 非 active / 不存在：非暫時性失敗，不 promote。
    let out;
    withImmediateTx(db, () => {
      out = failRun(db, run, { errorCode: input.reason, transient: false, now: nowDate, random });
      appendAuditRow(db, { actor: "system", action: "issue.evaluation.completed", entityType: "issue_evaluation_run", entityId: String(run.id), data: { issue_id: Number(run.issue_id), status: out.status, error_code: input.reason } });
    });
    return out.status;
  }

  const roleList = input.roles;
  const deliberation = Number(run.deliberation_enabled) === 1;
  // 每次嘗試前清掉本 run 舊的 role 票（重試時避免重複；completed run 不會被清）。
  db.prepare("DELETE FROM issue_role_evaluation WHERE evaluation_run_id=?").run(run.id);
  appendAudit(db, { actor: "system", action: "issue.evaluation.started", entityType: "issue_evaluation_run", entityId: String(run.id), data: { issue_id: Number(run.issue_id), roles: roleList, provider: provider.name, deliberation, input_fingerprint: input.fingerprint } });

  const round1 = new Map();
  try {
    // ── Round 1：各角色獨立評估（不提供其他角色意見）──
    for (const role of roleList) {
      const { system, user, promptVersion } = buildRoleEvaluationPrompt({ role, input: input.evaluatorInput, round: 1 });
      const { rawText } = await provider.analyze({ system, user, timeoutMs });
      const result = parseAndValidateRole(rawText);
      insertRoleEval(db, { runId: run.id, issueId: run.issue_id, role, round: 1, result, provider: provider.name, model: provider.model || null, promptVersion, rawText, now: nowDate });
      appendAudit(db, { actor: "system", action: "issue.role_evaluated", entityType: "issue_evaluation_run", entityId: String(run.id), data: { issue_id: Number(run.issue_id), role, round: 1, recommendation: result.recommendation, risk_level: result.risk_level, confidence: result.confidence } });
      round1.set(role, result);
    }

    // ── Round 2：受限 deliberation（至多一輪修訂）──
    const finalByRole = new Map(round1);
    if (deliberation) {
      const peerSummaries = roleList.map((role) => {
        const r = round1.get(role);
        return { role, recommendation: r.recommendation, risk_level: r.risk_level, rationale: r.rationale, missing_evidence: r.missing_evidence };
      });
      for (const role of roleList) {
        const peers = peerSummaries.filter((p) => p.role !== role);
        const { system, user, promptVersion } = buildRoleEvaluationPrompt({ role, input: input.evaluatorInput, round: 2, peerSummaries: peers });
        const { rawText } = await provider.analyze({ system, user, timeoutMs });
        const result = parseAndValidateRole(rawText);
        insertRoleEval(db, { runId: run.id, issueId: run.issue_id, role, round: 2, result, provider: provider.name, model: provider.model || null, promptVersion, rawText, now: nowDate });
        appendAudit(db, { actor: "system", action: "issue.role_evaluated", entityType: "issue_evaluation_run", entityId: String(run.id), data: { issue_id: Number(run.issue_id), role, round: 2, recommendation: result.recommendation, risk_level: result.risk_level, confidence: result.confidence } });
        finalByRole.set(role, result);
      }
    }

    // ── 決定性聚合 ──
    const finalVotes = roleList.map((role) => {
      const r = finalByRole.get(role);
      return { role, recommendation: r.recommendation, confidence: r.confidence, risk_level: r.risk_level, missing_evidence: r.missing_evidence };
    });
    const agg = aggregateVotes(finalVotes, { requiredRoles: roleList, config: aggConfig });

    // 綁定「本次實際使用的政策/設定」provenance（result-affecting；不含 secrets）。
    const policy = buildEvaluationPolicy({ aggConfig, roles: roleList, deliberationEnabled: deliberation, provider, rolePromptVersion: process.env.ROLE_PROMPT_VERSION || ROLE_PROMPT_VERSION });

    // ── 完成 + promote CURRENT（單一交易）──
    return withImmediateTx(db, () => {
      const again = issueWriteDecision(db, run.issue_id, { expectedGeneration: run.subscription_generation });
      if (!again.ok) {
        abandonEvaluationRun(db, run, again.reason);
        return "failed";
      }
      completeRun(db, run, { input, agg, provider, policy, now: nowDate });
      return "completed";
    });
  } catch (err) {
    const isSchema = err?.status === 422;
    const code = isSchema ? "schema_invalid" : (err?.name === "AbortError" ? "timeout" : (err?.name || "provider_error"));
    let out;
    withImmediateTx(db, () => {
      out = failRun(db, run, { errorCode: code, transient: !isSchema, now: nowDate, random });
      appendAuditRow(db, { actor: "system", action: "issue.evaluation.completed", entityType: "issue_evaluation_run", entityId: String(run.id), data: { issue_id: Number(run.issue_id), status: out.status, error_code: code, retry_count: out.retry_count } });
    });
    return out.status;
  }
}

// 完成 run 並 promote CURRENT（呼叫端需在交易內）。失敗新 run 不會取代既有 valid current（未走到這裡）。
function completeRun(db, run, { input, agg, provider, policy, now = new Date() }) {
  const ts = iso(now);
  const policyFp = evaluationPolicyFingerprint(policy);
  db.prepare(
    `UPDATE issue_evaluation_run SET status='completed', final_recommendation=?, aggregate_confidence=?, agreement=?,
       aggregation_details=?, input_fingerprint=?, policy_fingerprint=?, policy_snapshot=?, source_impact_assessment_id=?, provider=?, model=?, error_code=NULL,
       started_at=COALESCE(started_at, ?), completed_at=? WHERE id=?`,
  ).run(
    agg.final_recommendation, agg.aggregate_confidence, agg.agreement, JSON.stringify(agg.details),
    input.fingerprint, policyFp, JSON.stringify(policy), input.sourceImpactAssessmentId, provider.name, provider.model || null, ts, ts, run.id,
  );
  const prev = db.prepare("SELECT evaluation_run_id FROM issue_evaluation_current WHERE issue_id=?").get(Number(run.issue_id));
  db.prepare(
    `INSERT INTO issue_evaluation_current(issue_id, evaluation_run_id, input_fingerprint, policy_fingerprint, final_recommendation, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET evaluation_run_id=excluded.evaluation_run_id, input_fingerprint=excluded.input_fingerprint, policy_fingerprint=excluded.policy_fingerprint, final_recommendation=excluded.final_recommendation, updated_at=excluded.updated_at`,
  ).run(Number(run.issue_id), Number(run.id), input.fingerprint, policyFp, agg.final_recommendation, ts);
  appendAuditRow(db, { actor: "system", action: "issue.evaluation.completed", entityType: "issue_evaluation_run", entityId: String(run.id), data: { issue_id: Number(run.issue_id), status: "completed", final_recommendation: agg.final_recommendation, aggregation_version: AGGREGATION_VERSION, evaluation_version: EVALUATION_VERSION, input_fingerprint: input.fingerprint, policy_fingerprint: policyFp } });
  appendAuditRow(db, { actor: "system", action: "issue.evaluation.current_changed", entityType: "issue_evaluation_current", entityId: String(run.issue_id), data: { issue_id: Number(run.issue_id), from_run_id: prev ? Number(prev.evaluation_run_id) : null, to_run_id: Number(run.id), final_recommendation: agg.final_recommendation } });
}

export function currentEvaluationRunId(db, issueId) {
  const r = db.prepare("SELECT evaluation_run_id FROM issue_evaluation_current WHERE issue_id=?").get(Number(issueId));
  return r ? Number(r.evaluation_run_id) : null;
}

// 新鮮度：無 current、政策/設定改變（provenance）、issue 非 active、impact 不可用/stale（Phase 6 傳播）、或 input fingerprint 改變。
// 政策指紋比對「與 impact/成員無關」：即使成員/impact 都沒變且 impact 仍 fresh，政策/模型/prompt 變了也必須 stale。
// env / provider / aggConfig / roles / deliberationEnabled 可覆寫，讓 worker 用「它即將實際執行的政策」判斷、tests 可精準模擬設定變更。
export function evaluationStaleReasons(db, issueId, { now = new Date(), roles, provider, aggConfig, deliberationEnabled, env = process.env } = {}) {
  const cur = db.prepare("SELECT evaluation_run_id, input_fingerprint, policy_fingerprint FROM issue_evaluation_current WHERE issue_id=?").get(Number(issueId));
  if (!cur) return ["no_current_evaluation"];
  const issue = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(issueId));
  if (!issue) return ["issue_not_found"];
  const reasons = [];
  // 政策/設定 provenance（獨立於 impact/成員；即使 impact fresh 也要偵測）。
  const effPolicyFp = effectiveEvaluationPolicyFingerprint(env, { provider, aggConfig, roles, deliberationEnabled });
  if (cur.policy_fingerprint !== effPolicyFp) reasons.push("evaluation_policy_changed");
  if (issue.status !== "open") reasons.push("issue_inactive");
  const impact = getCurrentIssueImpact(db, issueId, { now });
  if (!impact) { reasons.push("impact_unavailable"); return reasons; }
  if (impact.stale) {
    reasons.push("impact_stale");
    for (const r of impact.stale_reasons || []) reasons.push(`impact:${r}`);
    return reasons; // impact 未 fresh 時，不宜用 stale 證據重算 input fingerprint 當作 fresh（政策原因已在上面加入）
  }
  const fp = evaluationInputFingerprint({
    issueId: Number(issue.id), issueStatus: issue.status, issueCategory: issue.category, issueUpdatedAt: issue.updated_at,
    membershipFingerprint: impact.membership_fingerprint, impactAssessmentId: impact.id,
    impactMembershipFingerprint: impact.membership_fingerprint, impactAnalysisFingerprint: impact.analysis_fingerprint,
    impactScoringVersion: impact.scoring_version, impactAsOfAt: impact.as_of_at,
    roles: roles || evaluationRolesConfig(env).roles,
  });
  if (fp !== cur.input_fingerprint) reasons.push("input_changed");
  return reasons;
}

export function isEvaluationStale(db, issueId, opts = {}) {
  return evaluationStaleReasons(db, issueId, opts).length > 0;
}

// Phase 8 唯一入口：回傳 current 評估並「明示新鮮度」，避免把 stale 當 fresh。
export function getCurrentIssueEvaluation(db, issueId, opts = {}) {
  const id = currentEvaluationRunId(db, issueId);
  if (!id) return null;
  const row = db.prepare("SELECT * FROM issue_evaluation_run WHERE id=?").get(Number(id));
  if (!row || Number(row.issue_id) !== Number(issueId) || row.status !== "completed") return null;
  const reasons = evaluationStaleReasons(db, issueId, opts);
  return { ...publicRun(row), stale: reasons.length > 0, fresh: reasons.length === 0, stale_reasons: reasons };
}

function parseJson(v) { try { return JSON.parse(v); } catch { return null; } }

// 對外只露結論式資料：不露隱藏推理鏈、不露 PII/secrets/附件內容。
export function publicRun(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    issue_id: Number(row.issue_id),
    evaluation_version: row.evaluation_version,
    aggregation_version: row.aggregation_version,
    role_set_version: row.role_set_version,
    input_fingerprint: row.input_fingerprint,
    source_impact_assessment_id: row.source_impact_assessment_id == null ? null : Number(row.source_impact_assessment_id),
    status: row.status,
    final_recommendation: row.final_recommendation,
    policy_fingerprint: row.policy_fingerprint,
    policy_snapshot: parseJson(row.policy_snapshot),
    aggregate_confidence: row.aggregate_confidence == null ? null : Number(row.aggregate_confidence),
    agreement: row.agreement == null ? null : Number(row.agreement),
    aggregation_details: parseJson(row.aggregation_details),
    deliberation_enabled: Number(row.deliberation_enabled) === 1,
    provider: row.provider,
    model: row.model,
    error_code: row.error_code,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
  };
}

export function publicRoleEval(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    evaluation_run_id: Number(row.evaluation_run_id),
    role: row.role,
    round: Number(row.round),
    recommendation: row.recommendation,
    confidence: row.confidence == null ? null : Number(row.confidence),
    risk_level: row.risk_level,
    rationale: row.rationale,
    evidence_refs: parseJson(row.evidence_refs),
    missing_evidence: parseJson(row.missing_evidence),
    risk_flags: parseJson(row.risk_flags),
    provider: row.provider,
    model: row.model,
    model_version: row.model_version,
    prompt_version: row.prompt_version,
    output_hash: row.output_hash,
    created_at: row.created_at,
  };
}

export function getEvaluationRunDetail(db, runId) {
  const run = db.prepare("SELECT * FROM issue_evaluation_run WHERE id=?").get(Number(runId));
  if (!run) return null;
  const roleEvals = db.prepare("SELECT * FROM issue_role_evaluation WHERE evaluation_run_id=? ORDER BY round ASC, role ASC").all(Number(runId));
  return { run: publicRun(run), role_evaluations: roleEvals.map(publicRoleEval) };
}

export function listEvaluationRuns(db, { issueId, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  return db.prepare("SELECT * FROM issue_evaluation_run WHERE issue_id=? ORDER BY id DESC LIMIT ?").all(Number(issueId), cap).map(publicRun);
}

// Owner 手動要求重評：稽核 + 排入一個新 run（不建 proposal、不核准開發）。
// merged/inactive issue 拒絕（不得把過時 issue 當 active 評估）。
export function requestEvaluationRecalc(db, issueId, { actor = "owner", roles, deliberationEnabled = false, now = new Date() } = {}) {
  const issue = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(issueId));
  if (!issue) throw httpError("issue not found", 404);
  if (issue.status !== "open") throw httpError("issue is not active (merged/closed); cannot evaluate", 409);
  return withImmediateTx(db, () => {
    const input = computeEvaluationInput(db, issueId, { now, roles });
    const row = enqueueEvaluationRun(db, {
      issueId,
      roles,
      deliberationEnabled,
      fingerprint: input.ok ? input.fingerprint : "pending",
      sourceImpactAssessmentId: input.ok ? input.sourceImpactAssessmentId : null,
      now,
    });
    appendAuditRow(db, { actor, action: "issue.evaluation.recalculation_requested", entityType: "issue_candidate", entityId: String(issueId), data: { issue_id: Number(issueId), evaluation_run_id: row.id, deferred: !input.ok, reason: input.ok ? null : input.reason } });
    return { evaluation_run_id: row.id, deferred: !input.ok, reason: input.ok ? null : input.reason };
  });
}
