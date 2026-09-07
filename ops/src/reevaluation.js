import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAudit, appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { getCurrentIssueImpact, getAssessment, publicImpact } from "./impact.js";
import { getActiveAuthorization } from "./proposal.js";
import { findEntity, getEntity, transitionRow } from "./stateMachine.js";
import {
  reevaluationConfig, reevaluationPolicyFingerprint, assessMaterialChange,
  REEVALUATION_POLICY_VERSION, REASON,
} from "./reevaluationPolicy.js";

const REASON_MAX = 1000;
const REOPENABLE = new Set(["DEFERRED", "REJECTED"]);
const DECISION_FOR_STATE = { DEFERRED: "DEFER", REJECTED: "REJECT" };

function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }
function issueEntityId(issueId) { return `issue:${Number(issueId)}`; }
function ms(v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
function sevCount(dist, key) { return dist && typeof dist === "object" ? Number(dist[key] || 0) || 0 : 0; }

// 從「最後一次 DEFER/REJECT 的 Owner 決策」推導不可變基準（決策當下的 Proposal 與其來源 Impact 評估）。
export function getReevaluationBaseline(db, issueId, decisionType) {
  const decision = db.prepare(
    "SELECT * FROM proposal_owner_decision WHERE issue_id=? AND action=? ORDER BY id DESC LIMIT 1",
  ).get(Number(issueId), String(decisionType).toUpperCase());
  if (!decision) return null;
  const proposal = db.prepare("SELECT source_impact_assessment_id FROM issue_proposal WHERE id=?").get(Number(decision.proposal_id));
  const impact = proposal?.source_impact_assessment_id ? publicImpact(getAssessment(db, proposal.source_impact_assessment_id)) : null;
  return {
    issue_id: Number(issueId),
    owner_decision_id: Number(decision.id),
    decision_type: decision.action,
    proposal_id: Number(decision.proposal_id),
    proposal_version: Number(decision.proposal_version),
    proposal_hash: decision.proposal_hash,
    decision_at: decision.created_at,
    source_impact_assessment_id: impact ? impact.id : null,
    membership_fingerprint: impact ? impact.membership_fingerprint : null,
    analysis_fingerprint: impact ? impact.analysis_fingerprint : null,
    impact_score: impact ? impact.impact_score : 0,
    impact_level: impact ? impact.impact_level : "LOW",
    current_feedback_count: impact ? impact.current_feedback_count : 0,
    distinct_reporter_count: impact ? impact.distinct_reporter_count : 0,
    recent_velocity: impact ? (impact.recent_velocity || 0) : 0,
    severity_distribution: impact ? (impact.severity_distribution || {}) : {},
  };
}

export function baselineFingerprint(b) {
  if (!b) return "";
  const parts = [
    `issue_id:${b.issue_id}`,
    `owner_decision_id:${b.owner_decision_id}`,
    `decision_type:${b.decision_type}`,
    `proposal_id:${b.proposal_id}`,
    `proposal_version:${b.proposal_version}`,
    `proposal_hash:${b.proposal_hash ?? ""}`,
    `source_impact_assessment_id:${b.source_impact_assessment_id ?? ""}`,
    `membership_fp:${b.membership_fingerprint ?? ""}`,
    `analysis_fp:${b.analysis_fingerprint ?? ""}`,
    `impact_score:${b.impact_score}`,
    `impact_level:${b.impact_level}`,
    `feedback_count:${b.current_feedback_count}`,
    `reporter_count:${b.distinct_reporter_count}`,
    `critical:${sevCount(b.severity_distribution, "CRITICAL")}`,
    `high:${sevCount(b.severity_distribution, "HIGH")}`,
    `decision_at:${b.decision_at ?? ""}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function evidenceFingerprint(ev, policyVersion = REEVALUATION_POLICY_VERSION) {
  const parts = [
    `membership_fp:${ev.membership_fingerprint ?? ""}`,
    `impact_assessment_id:${ev.id ?? ""}`,
    `impact_analysis_fp:${ev.analysis_fingerprint ?? ""}`,
    `impact_scoring_version:${ev.scoring_version ?? ""}`,
    `impact_score:${ev.impact_score ?? ""}`,
    `impact_level:${ev.impact_level ?? ""}`,
    `feedback_count:${ev.current_feedback_count ?? ""}`,
    `reporter_count:${ev.distinct_reporter_count ?? ""}`,
    `critical:${sevCount(ev.severity_distribution, "CRITICAL")}`,
    `high:${sevCount(ev.severity_distribution, "HIGH")}`,
    `policy_version:${policyVersion}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// 決定性重評評估（不呼叫任何 AI）。回傳結構化、可解釋結果。
export function assessReevaluation(db, issueId, { now = new Date(), config = reevaluationConfig() } = {}) {
  const issue = db.prepare("SELECT status FROM issue_candidate WHERE id=?").get(Number(issueId));
  const entity = findEntity(db, issueEntityId(issueId));
  const state = entity ? entity.state : null;
  const policyFp = reevaluationPolicyFingerprint(config);
  const base = { issue_id: Number(issueId), state, policy_version: config.version, policy_fingerprint: policyFp, evaluated_at: iso(now) };
  if (!issue || issue.status !== "open") return { ...base, applicable: false, eligible: false, reason: "issue_inactive" };
  if (!state || !REOPENABLE.has(state)) return { ...base, applicable: false, eligible: false, reason: state === "BLOCKED" ? "blocked_requires_owner_unblock" : "not_reopenable_state" };
  const decisionType = DECISION_FOR_STATE[state];
  const baseline = getReevaluationBaseline(db, issueId, decisionType);
  if (!baseline) return { ...base, applicable: true, eligible: false, reason: "no_baseline" };
  const baselineFp = baselineFingerprint(baseline);
  const nowMs = now instanceof Date ? now.getTime() : now;
  const decisionAt = ms(baseline.decision_at);
  if (decisionAt != null && nowMs - decisionAt < config.cooldownMs) {
    return { ...base, applicable: true, eligible: false, reason: "cooldown", cooldown: true, cooldown_until: iso(new Date(decisionAt + config.cooldownMs)), baseline_fingerprint: baselineFp };
  }
  const impact = getCurrentIssueImpact(db, issueId, { now });
  if (!impact) return { ...base, applicable: true, eligible: false, reason: "impact_unavailable", baseline_fingerprint: baselineFp };
  if (impact.stale) return { ...base, applicable: true, eligible: false, reason: "impact_stale", baseline_fingerprint: baselineFp };
  const evidenceFp = evidenceFingerprint(impact, config.version);
  const material = assessMaterialChange({ decisionType, baseline, current: impact, config });
  return {
    ...base,
    applicable: true,
    decision_type: decisionType,
    baseline_fingerprint: baselineFp,
    current_evidence_fingerprint: evidenceFp,
    eligible: material.eligible,
    triggered: material.triggered,
    deltas: material.deltas,
    cooldown: false,
  };
}

function existingAuthorization(db, issueId, baselineFp, evidenceFp, policyFp) {
  return db.prepare(
    "SELECT * FROM issue_reevaluation_authorization WHERE issue_id=? AND IFNULL(baseline_fingerprint,'')=? AND current_evidence_fingerprint=? AND policy_fingerprint=? ORDER BY id DESC LIMIT 1",
  ).get(Number(issueId), baselineFp || "", evidenceFp, policyFp);
}

// 核心：授權 + 中央狀態機轉移 + 稽核，單一交易。requireMaterial=false 供 Owner 手動重評（略過門檻，但仍需 DEFERRED/REJECTED + fresh impact）。
export function authorizeAndReopen(db, issueId, { triggerType = "auto", authorizedBy = "policy", actor = "system", reason = null, requireMaterial = true, now = new Date(), config = reevaluationConfig() } = {}) {
  return withImmediateTx(db, () => {
    const entity = getEntity(db, issueEntityId(issueId));
    if (!REOPENABLE.has(entity.state)) throw httpError(`issue is not reopenable (state=${entity.state})`, 409);
    const issue = db.prepare("SELECT status FROM issue_candidate WHERE id=?").get(Number(issueId));
    if (!issue || issue.status !== "open") throw httpError("issue is not active", 409);
    if (getActiveAuthorization(db, issueId)) throw httpError("issue has an active development authorization", 409);
    const decisionType = DECISION_FOR_STATE[entity.state];
    const baseline = getReevaluationBaseline(db, issueId, decisionType);
    if (!baseline) throw httpError("no owner decision baseline", 409);
    const impact = getCurrentIssueImpact(db, issueId, { now });
    if (!impact) throw httpError("current impact unavailable", 409);
    if (impact.stale) throw httpError("current impact is stale; wait for recalculation", 409);
    const material = assessMaterialChange({ decisionType, baseline, current: impact, config });
    if (requireMaterial && !material.eligible) throw httpError("no material change", 409);
    const baselineFp = baselineFingerprint(baseline);
    const evidenceFp = evidenceFingerprint(impact, config.version);
    const policyFp = reevaluationPolicyFingerprint(config);
    // 冪等：同 issue+baseline+evidence+policy 已授權 → 回傳現有，不重複。
    const existing = existingAuthorization(db, issueId, baselineFp, evidenceFp, policyFp);
    if (existing) return { idempotent: true, authorization: publicAuthorization(existing) };
    const reasonCodes = triggerType === "owner_manual" ? [REASON.OWNER_MANUAL] : material.triggered;
    const ts = iso(now);
    const res = db.prepare(
      `INSERT INTO issue_reevaluation_authorization
        (issue_id, trigger_type, authorized_by, from_state, source_owner_decision_id, baseline_fingerprint, current_evidence_fingerprint,
         policy_version, policy_fingerprint, reason_codes, observed_deltas, actor, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(issueId), triggerType, authorizedBy, entity.state, baseline.owner_decision_id, baselineFp, evidenceFp,
      config.version, policyFp, JSON.stringify(reasonCodes), JSON.stringify(material.deltas), actor, reason ? String(reason).slice(0, REASON_MAX) : null, ts,
    );
    const authId = Number(res.lastInsertRowid);
    appendAuditRow(db, { actor, action: "issue.reevaluation.authorized", entityType: "issue_reevaluation_authorization", entityId: String(authId), data: { issue_id: Number(issueId), trigger_type: triggerType, authorized_by: authorizedBy, from_state: entity.state, baseline_fingerprint: baselineFp, current_evidence_fingerprint: evidenceFp, policy_version: config.version, reason_codes: reasonCodes } });
    transitionRow(db, { id: issueEntityId(issueId), to: "EVALUATING", authorization: "reevaluation", actor, data: { reason: "reevaluation", trigger_type: triggerType, authorization_id: authId }, now });
    appendAuditRow(db, { actor, action: "issue.reevaluation.reopened", entityType: "issue_candidate", entityId: String(issueId), data: { issue_id: Number(issueId), from_state: entity.state, to_state: "EVALUATING", authorization_id: authId } });
    return { reopened: true, authorization: publicAuthorization(db.prepare("SELECT * FROM issue_reevaluation_authorization WHERE id=?").get(authId)) };
  });
}

// Owner 手動重評（DEFERRED/REJECTED）：略過門檻，但不可用於 BLOCKED（狀態檢查會擋）。
export function ownerManualReevaluate(db, issueId, { actor = "owner", reason = null, now = new Date(), config = reevaluationConfig() } = {}) {
  return authorizeAndReopen(db, issueId, { triggerType: "owner_manual", authorizedBy: "owner", actor, reason, requireMaterial: false, now, config });
}

// Owner 解除 BLOCK：唯一能讓 BLOCKED 離開的路徑。AI/worker 不得呼叫（僅由已認證 Owner 路由呼叫）。
export function ownerUnblock(db, issueId, { actor = "owner", reason = null, now = new Date(), config = reevaluationConfig() } = {}) {
  return withImmediateTx(db, () => {
    const entity = getEntity(db, issueEntityId(issueId));
    if (entity.state !== "BLOCKED") throw httpError(`issue is not blocked (state=${entity.state})`, 409);
    const impact = getCurrentIssueImpact(db, issueId, { now });
    const evidenceFp = impact ? evidenceFingerprint(impact, config.version) : `no_impact:${config.version}`;
    const policyFp = reevaluationPolicyFingerprint(config);
    const ts = iso(now);
    const res = db.prepare(
      `INSERT INTO issue_reevaluation_authorization
        (issue_id, trigger_type, authorized_by, from_state, source_owner_decision_id, baseline_fingerprint, current_evidence_fingerprint,
         policy_version, policy_fingerprint, reason_codes, observed_deltas, actor, reason, created_at)
       VALUES (?, 'owner_unblock', 'owner', 'BLOCKED', NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(Number(issueId), evidenceFp, config.version, policyFp, JSON.stringify([REASON.OWNER_UNBLOCK]), actor, reason ? String(reason).slice(0, REASON_MAX) : null, ts);
    const authId = Number(res.lastInsertRowid);
    appendAuditRow(db, { actor, action: "issue.unblocked", entityType: "issue_candidate", entityId: String(issueId), data: { issue_id: Number(issueId), authorization_id: authId } });
    transitionRow(db, { id: issueEntityId(issueId), to: "EVALUATING", authorization: "owner_unblock", actor, data: { reason: "owner_unblock", authorization_id: authId }, now });
    appendAuditRow(db, { actor, action: "issue.reevaluation.reopened", entityType: "issue_candidate", entityId: String(issueId), data: { issue_id: Number(issueId), from_state: "BLOCKED", to_state: "EVALUATING", authorization_id: authId, unblocked: true } });
    return { unblocked: true, authorization: publicAuthorization(db.prepare("SELECT * FROM issue_reevaluation_authorization WHERE id=?").get(authId)) };
  });
}

function parseJson(v) { try { return JSON.parse(v); } catch { return null; } }
export function publicAuthorization(row) {
  if (!row) return null;
  return {
    id: Number(row.id), issue_id: Number(row.issue_id), trigger_type: row.trigger_type, authorized_by: row.authorized_by,
    from_state: row.from_state, source_owner_decision_id: row.source_owner_decision_id == null ? null : Number(row.source_owner_decision_id),
    baseline_fingerprint: row.baseline_fingerprint, current_evidence_fingerprint: row.current_evidence_fingerprint,
    policy_version: row.policy_version, policy_fingerprint: row.policy_fingerprint,
    reason_codes: parseJson(row.reason_codes), observed_deltas: parseJson(row.observed_deltas),
    actor: row.actor, reason: row.reason, created_at: row.created_at,
  };
}
export function listReevaluationAuthorizations(db, { issueId, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  return db.prepare("SELECT * FROM issue_reevaluation_authorization WHERE issue_id=? ORDER BY id DESC LIMIT ?").all(Number(issueId), cap).map(publicAuthorization);
}

// Owner 檢視：目前狀態、最後決策、基準、當前證據、deltas、是否符合自動重評、reason codes、cooldown、歷史。
export function getReevaluationView(db, issueId, { now = new Date(), config = reevaluationConfig() } = {}) {
  const assessment = assessReevaluation(db, issueId, { now, config });
  const lastDecision = db.prepare("SELECT id, action, proposal_version, created_at FROM proposal_owner_decision WHERE issue_id=? AND action IN ('DEFER','REJECT','BLOCK') ORDER BY id DESC LIMIT 1").get(Number(issueId)) || null;
  const impact = getCurrentIssueImpact(db, issueId, { now });
  return {
    issue_id: Number(issueId),
    ...assessment,
    last_owner_decision: lastDecision ? { id: Number(lastDecision.id), action: lastDecision.action, proposal_version: Number(lastDecision.proposal_version), created_at: lastDecision.created_at } : null,
    current_evidence: impact ? { impact_score: impact.impact_score, impact_level: impact.impact_level, current_feedback_count: impact.current_feedback_count, distinct_reporter_count: impact.distinct_reporter_count, recent_velocity: impact.recent_velocity, severity_distribution: impact.severity_distribution, stale: impact.stale, as_of_at: impact.as_of_at } : null,
    history: listReevaluationAuthorizations(db, { issueId }),
  };
}
