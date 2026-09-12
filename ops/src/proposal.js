import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAudit, appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { getCurrentIssueMembers } from "./clustering.js";
import { getCurrentIssueImpact } from "./impact.js";
import { getCurrentIssueEvaluation } from "./evaluation.js";
import { getCurrentFeedbackAnalysis } from "./feedbackAnalysis.js";
import { buildProposalPrompt, PROPOSAL_PROMPT_VERSION } from "./proposalPrompt.js";
import { parseAndValidateProposal, canonicalProposalContent, PROPOSAL_SCHEMA_VERSION } from "./proposalSchema.js";
import { buildProposalPolicy, proposalPolicyFingerprint, effectiveProposalPolicyFingerprint, PROPOSAL_GENERATION_VERSION } from "./proposalPolicy.js";
import { createEntityRow, transitionRow, findEntity, getEntity } from "./stateMachine.js";
import { issueWriteDecision } from "./insightConsent.js";

export const PROPOSAL_MAX_RETRIES = 5;
export const PROPOSAL_SCHEMA_MAX_RETRIES = 2;
export const PROPOSAL_CLAIM_STALE_MS = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;
const MAX_EVIDENCE_SUMMARIES = 20;
const SUMMARY_CAP = 300;
const REASON_MAX = 1000;

export const OWNER_ACTIONS = ["APPROVE_DEVELOPMENT", "REQUEST_CHANGES", "DEFER", "REJECT", "BLOCK"];

function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }
function issueEntityId(issueId) { return `issue:${Number(issueId)}`; }

export function proposalBackoffMs(retries, { base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS, random = Math.random } = {}) {
  const raw = Math.min(base * 2 ** Math.max(0, retries - 1), cap);
  return Math.round(raw * (0.5 + 0.5 * random()));
}

// 決定性 input fingerprint：綁定「本提案所依據的確切 canonical 證據 + 生成版本 + 政策」。
export function proposalInputFingerprint({
  issueId, issueStatus, issueUpdatedAt,
  membershipFingerprint, impactAssessmentId, impactMembershipFingerprint, impactAnalysisFingerprint, impactScoringVersion,
  evaluationRunId, evaluationInputFingerprint, evaluationPolicyFingerprint, finalRecommendation,
  generationVersion = PROPOSAL_GENERATION_VERSION, proposalPolicyFingerprint: policyFp,
}) {
  const parts = [
    `issue_id:${issueId}`,
    `issue_status:${issueStatus ?? ""}`,
    `issue_updated_at:${issueUpdatedAt ?? ""}`,
    `membership_fp:${membershipFingerprint ?? ""}`,
    `impact_assessment_id:${impactAssessmentId ?? ""}`,
    `impact_membership_fp:${impactMembershipFingerprint ?? ""}`,
    `impact_analysis_fp:${impactAnalysisFingerprint ?? ""}`,
    `impact_scoring_version:${impactScoringVersion ?? ""}`,
    `evaluation_run_id:${evaluationRunId ?? ""}`,
    `evaluation_input_fp:${evaluationInputFingerprint ?? ""}`,
    `evaluation_policy_fp:${evaluationPolicyFingerprint ?? ""}`,
    `final_recommendation:${finalRecommendation ?? ""}`,
    `generation_version:${generationVersion}`,
    `proposal_policy_fp:${policyFp ?? ""}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// 決定性 proposal hash：正規化「審批相關內容」+ issue_id + version，供 Owner Gate 綁定確切內容。
export function computeProposalHash(content, { issueId, proposalVersion }) {
  const canonical = { issue_id: Number(issueId), proposal_version: Number(proposalVersion), ...canonicalProposalContent(content) };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function evidenceSummaries(db, issueId) {
  const members = getCurrentIssueMembers(db, issueId);
  const out = [];
  for (const m of members.slice(0, MAX_EVIDENCE_SUMMARIES)) {
    const ca = getCurrentFeedbackAnalysis(db, m.feedback_id);
    if (!ca) continue;
    out.push({ category: ca.category, severity_hint: ca.severity_hint, summary: String(ca.summary || "").slice(0, SUMMARY_CAP) });
  }
  return out;
}

// 只用 canonical helpers 計算提案輸入；issue 非 active / evaluation 或 impact 不 fresh / 建議非 PROPOSE → 不自動生成。
export function computeProposalInput(db, issueId, { now = new Date(), env = process.env, provider } = {}) {
  const issue = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(issueId));
  if (!issue) return { ok: false, reason: "issue_not_found" };
  if (issue.status !== "open") return { ok: false, reason: "issue_inactive", issue };
  // 評估新鮮度用「評估」provider（env 推導），不是提案 provider。
  const evaluation = getCurrentIssueEvaluation(db, issueId, { now, env });
  if (!evaluation) return { ok: false, defer: true, reason: "evaluation_unavailable", issue };
  if (evaluation.stale) return { ok: false, defer: true, reason: "evaluation_stale", issue, staleReasons: evaluation.stale_reasons };
  if (evaluation.final_recommendation !== "PROPOSE") return { ok: false, reason: `recommendation_${evaluation.final_recommendation}`, issue, evaluation };
  const impact = getCurrentIssueImpact(db, issueId, { now });
  if (!impact) return { ok: false, defer: true, reason: "impact_unavailable", issue };
  if (impact.stale) return { ok: false, defer: true, reason: "impact_stale", issue, staleReasons: impact.stale_reasons };
  const policyFp = effectiveProposalPolicyFingerprint(env, { provider });
  const fingerprint = proposalInputFingerprint({
    issueId: Number(issue.id), issueStatus: issue.status, issueUpdatedAt: issue.updated_at,
    membershipFingerprint: impact.membership_fingerprint, impactAssessmentId: impact.id,
    impactMembershipFingerprint: impact.membership_fingerprint, impactAnalysisFingerprint: impact.analysis_fingerprint,
    impactScoringVersion: impact.scoring_version,
    evaluationRunId: evaluation.id, evaluationInputFingerprint: evaluation.input_fingerprint,
    evaluationPolicyFingerprint: evaluation.policy_fingerprint, finalRecommendation: evaluation.final_recommendation,
    generationVersion: PROPOSAL_GENERATION_VERSION, proposalPolicyFingerprint: policyFp,
  });
  const evidenceInput = {
    issue: { id: Number(issue.id), title: String(issue.title || "").slice(0, 200), category: issue.category || "OTHER", status: issue.status },
    impact: {
      impact_level: impact.impact_level, impact_score: impact.impact_score,
      current_feedback_count: impact.current_feedback_count, distinct_reporter_count: impact.distinct_reporter_count,
      severity_distribution: impact.severity_distribution, category_distribution: impact.category_distribution,
      feedback_count_7d: impact.feedback_count_7d, feedback_count_30d: impact.feedback_count_30d, as_of_at: impact.as_of_at,
    },
    evaluation: { final_recommendation: evaluation.final_recommendation, aggregate_confidence: evaluation.aggregate_confidence, run_id: evaluation.id },
    evidence_summaries: evidenceSummaries(db, issueId),
  };
  return {
    ok: true, issue, impact, evaluation, evidenceInput, fingerprint, policyFingerprint: policyFp,
    sourceEvaluationRunId: evaluation.id, sourceImpactAssessmentId: impact.id, finalRecommendation: evaluation.final_recommendation,
  };
}

// 建立一個 pending 生成 job（新的 proposal_version）。無自帶交易版本供交易內組合。
export function enqueueProposalRow(db, { issueId, revisionInstruction = null, now = new Date() }) {
  const gate = issueWriteDecision(db, issueId);
  if (!gate.ok) {
    const err = httpError(gate.reason === "stale_generation" ? "訂閱世代已換，晚到提案不入隊。" : "訂閱已退出，晚到提案不入隊。", 409);
    err.code = gate.reason || "subscription_revoked";
    throw err;
  }
  const prev = db.prepare("SELECT MAX(proposal_version) AS m FROM issue_proposal WHERE issue_id=?").get(Number(issueId));
  const version = (Number(prev?.m) || 0) + 1;
  const ts = iso(now);
  const generation = gate.unbound ? null : gate.generation;
  const res = db.prepare(
    `INSERT INTO issue_proposal(issue_id, proposal_version, generation_version, revision_instruction, status, retry_count, max_retries, next_attempt_at, created_at, subscription_generation)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
  ).run(Number(issueId), version, PROPOSAL_GENERATION_VERSION, revisionInstruction ? String(revisionInstruction).slice(0, REASON_MAX) : null, PROPOSAL_MAX_RETRIES, ts, ts, generation);
  return { id: Number(res.lastInsertRowid), version, subscription_generation: generation };
}
export function enqueueProposalGeneration(db, opts) {
  return withImmediateTx(db, () => enqueueProposalRow(db, opts));
}

function abandonProposalRow(db, row, reason) {
  db.prepare("UPDATE issue_proposal SET status='failed', error_code=? WHERE id=? AND status IN ('pending','failed_retry','processing')")
    .run(String(reason || "subscription_revoked").slice(0, 64), row.id);
}

export function claimProposalBatch(db, { limit = 5, now = new Date(), staleMs = PROPOSAL_CLAIM_STALE_MS } = {}) {
  const nowIso = iso(now);
  const staleBefore = iso(new Date((now instanceof Date ? now.getTime() : now) - staleMs));
  const inflight = db.prepare("SELECT * FROM issue_proposal WHERE status IN ('pending','failed_retry','processing')").all();
  for (const row of inflight) {
    const decision = issueWriteDecision(db, row.issue_id, { expectedGeneration: row.subscription_generation });
    if (!decision.ok) abandonProposalRow(db, row, decision.reason);
  }
  const candidates = db.prepare(
    `SELECT * FROM issue_proposal
     WHERE (status IN ('pending','failed_retry') AND next_attempt_at <= ?)
        OR (status = 'processing' AND (claimed_at IS NULL OR claimed_at <= ?))
     ORDER BY id ASC LIMIT ?`,
  ).all(nowIso, staleBefore, Math.max(1, Math.min(Number(limit) || 5, 50)));
  const claimed = [];
  for (const row of candidates) {
    const decision = issueWriteDecision(db, row.issue_id, { expectedGeneration: row.subscription_generation });
    if (!decision.ok) {
      abandonProposalRow(db, row, decision.reason);
      continue;
    }
    let res;
    if (row.status === "processing") {
      res = db.prepare("UPDATE issue_proposal SET claimed_at=? WHERE id=? AND status='processing' AND (claimed_at IS NULL OR claimed_at <= ?)").run(nowIso, row.id, staleBefore);
    } else {
      res = db.prepare("UPDATE issue_proposal SET status='processing', claimed_at=? WHERE id=? AND status=?").run(nowIso, row.id, row.status);
    }
    if (res.changes === 1) claimed.push({ ...row, status: "processing", claimed_at: nowIso });
  }
  return claimed;
}

function deferRow(db, row, { errorCode, now = new Date(), random = Math.random }) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const next = iso(new Date(nowMs + proposalBackoffMs(1, { random })));
  db.prepare("UPDATE issue_proposal SET status='failed_retry', next_attempt_at=?, error_code=? WHERE id=?").run(next, String(errorCode).slice(0, 64), row.id);
  return { status: "deferred", errorCode };
}

export function failProposal(db, row, { errorCode, transient = true, now = new Date(), random = Math.random }) {
  const retries = Number(row.retry_count) + 1;
  const cap = transient ? Number(row.max_retries || PROPOSAL_MAX_RETRIES) : PROPOSAL_SCHEMA_MAX_RETRIES;
  const code = String(errorCode || "error").slice(0, 64);
  if (retries >= cap) {
    db.prepare("UPDATE issue_proposal SET status='failed', retry_count=?, error_code=? WHERE id=?").run(retries, code, row.id);
    return { status: "failed", retry_count: retries };
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const next = iso(new Date(nowMs + proposalBackoffMs(retries, { random })));
  db.prepare("UPDATE issue_proposal SET status='failed_retry', retry_count=?, next_attempt_at=?, error_code=? WHERE id=?").run(retries, next, code, row.id);
  return { status: "failed_retry", retry_count: retries, next_attempt_at: next };
}

// 提案改版後：作廢其它版本的 active 授權（保留歷史），並在已核准狀態下把 lifecycle 打回 APPROVAL_INVALIDATED。
function supersedeOtherVersionAuthorizations(db, issueId, newVersion, { actor = "system", now = new Date() }) {
  const ts = iso(now);
  const active = db.prepare("SELECT * FROM development_authorization WHERE issue_id=? AND status='active'").all(Number(issueId));
  for (const a of active) {
    if (Number(a.proposal_version) === Number(newVersion)) continue;
    db.prepare("UPDATE development_authorization SET status='superseded', superseded_at=?, superseded_reason=? WHERE id=?").run(ts, "new_proposal_version", a.id);
    appendAuditRow(db, { actor, action: "issue.development.authorization_superseded", entityType: "development_authorization", entityId: String(a.id), data: { issue_id: Number(issueId), proposal_id: Number(a.proposal_id), proposal_version: Number(a.proposal_version), superseded_by_version: Number(newVersion) } });
    const entity = findEntity(db, issueEntityId(issueId));
    if (entity && entity.state === "APPROVED_FOR_DEVELOPMENT") {
      transitionRow(db, { id: issueEntityId(issueId), to: "APPROVAL_INVALIDATED", actor, data: { reason: "proposal_revised" }, now });
    }
  }
}

// 讓 issue lifecycle 進入 WAITING_OWNER_APPROVAL（走合法路徑；已在該狀態則 no-op）。
function ensureWaitingApproval(db, issueId, { actor = "system", now = new Date() }) {
  createEntityRow(db, { entityType: "issue", id: issueEntityId(issueId), actor, now });
  const entity = getEntity(db, issueEntityId(issueId));
  const paths = {
    COLLECTING: ["EVALUATING", "WAITING_OWNER_APPROVAL"],
    EVALUATING: ["WAITING_OWNER_APPROVAL"],
    PROPOSAL_CHANGES_REQUESTED: ["WAITING_OWNER_APPROVAL"],
    APPROVAL_INVALIDATED: ["WAITING_OWNER_APPROVAL"],
  };
  if (entity.state === "WAITING_OWNER_APPROVAL") return;
  const path = paths[entity.state];
  if (!path) return;
  for (const to of path) transitionRow(db, { id: issueEntityId(issueId), to, actor, now });
}

// 執行一個已 claim 的提案生成：provider 呼叫在交易外；完成 + promote current + lifecycle 轉移在單一交易。
export async function executeProposalGeneration(db, row, { provider, now = () => new Date(), timeoutMs = 30000, env = process.env, random = Math.random } = {}) {
  const nowDate = now();
  const gate = issueWriteDecision(db, row.issue_id, { expectedGeneration: row.subscription_generation });
  if (!gate.ok) {
    withImmediateTx(db, () => abandonProposalRow(db, row, gate.reason));
    return "failed";
  }
  const input = computeProposalInput(db, row.issue_id, { now: nowDate, env, provider });
  if (!input.ok) {
    if (input.defer) {
      let out; withImmediateTx(db, () => { out = deferRow(db, row, { errorCode: input.reason, now: nowDate, random }); });
      return out.status;
    }
    let out;
    withImmediateTx(db, () => {
      out = failProposal(db, row, { errorCode: input.reason, transient: false, now: nowDate, random });
      appendAuditRow(db, { actor: "system", action: "issue.proposal.stale", entityType: "issue_proposal", entityId: String(row.id), data: { issue_id: Number(row.issue_id), reason: input.reason, status: out.status } });
    });
    return out.status;
  }

  appendAudit(db, { actor: "system", action: "issue.proposal.generation_started", entityType: "issue_proposal", entityId: String(row.id), data: { issue_id: Number(row.issue_id), proposal_version: Number(row.proposal_version), provider: provider.name, input_fingerprint: input.fingerprint } });

  let content;
  try {
    const { system, user, promptVersion } = buildProposalPrompt({ input: input.evidenceInput, revisionInstruction: row.revision_instruction });
    const { rawText } = await provider.analyze({ system, user, timeoutMs });
    content = parseAndValidateProposal(rawText);
    content.source_evaluation_run_id = input.sourceEvaluationRunId;
    content.source_impact_assessment_id = input.sourceImpactAssessmentId;
    void promptVersion;
  } catch (err) {
    const isSchema = err?.status === 422;
    const code = isSchema ? "schema_invalid" : (err?.name === "AbortError" ? "timeout" : (err?.name || "provider_error"));
    let out;
    withImmediateTx(db, () => {
      out = failProposal(db, row, { errorCode: code, transient: !isSchema, now: nowDate, random });
      appendAuditRow(db, { actor: "system", action: "issue.proposal.generation_failed", entityType: "issue_proposal", entityId: String(row.id), data: { issue_id: Number(row.issue_id), error_code: code, status: out.status } });
    });
    return out.status;
  }

  const proposalHash = computeProposalHash(content, { issueId: row.issue_id, proposalVersion: row.proposal_version });
  const ts = iso(nowDate);
  return withImmediateTx(db, () => {
    const again = issueWriteDecision(db, row.issue_id, { expectedGeneration: row.subscription_generation });
    if (!again.ok) {
      abandonProposalRow(db, row, again.reason);
      return "failed";
    }
    db.prepare(
      `UPDATE issue_proposal SET status='completed', input_fingerprint=?, policy_fingerprint=?, proposal_hash=?,
        source_evaluation_run_id=?, source_impact_assessment_id=?, final_recommendation=?,
        title=?, problem_statement=?, proposed_change=?, intended_outcome=?, scope=?, non_goals=?, acceptance_criteria=?,
        known_risks=?, security_considerations=?, compliance_considerations=?, operational_considerations=?, rollback_considerations=?,
        evidence_summary=?, provider=?, model=?, error_code=NULL, generated_at=? WHERE id=?`,
    ).run(
      input.fingerprint, input.policyFingerprint, proposalHash,
      input.sourceEvaluationRunId, input.sourceImpactAssessmentId, input.finalRecommendation,
      content.title, content.problem_statement, content.proposed_change, content.intended_outcome,
      JSON.stringify(content.scope), JSON.stringify(content.non_goals), JSON.stringify(content.acceptance_criteria),
      JSON.stringify(content.known_risks), content.security_considerations, content.compliance_considerations,
      content.operational_considerations, content.rollback_considerations, content.evidence_summary,
      provider.name, provider.model || null, ts, row.id,
    );
    const prev = db.prepare("SELECT proposal_id FROM issue_proposal_current WHERE issue_id=?").get(Number(row.issue_id));
    db.prepare(
      `INSERT INTO issue_proposal_current(issue_id, proposal_id, proposal_version, proposal_hash, input_fingerprint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET proposal_id=excluded.proposal_id, proposal_version=excluded.proposal_version, proposal_hash=excluded.proposal_hash, input_fingerprint=excluded.input_fingerprint, updated_at=excluded.updated_at`,
    ).run(Number(row.issue_id), Number(row.id), Number(row.proposal_version), proposalHash, input.fingerprint, ts);
    // 提案改版 → 作廢舊授權（可能將已核准 lifecycle 打回 invalidated），再進入等待審批。
    supersedeOtherVersionAuthorizations(db, row.issue_id, row.proposal_version, { actor: "system", now: nowDate });
    ensureWaitingApproval(db, row.issue_id, { actor: "system", now: nowDate });
    appendAuditRow(db, { actor: "system", action: "issue.proposal.created", entityType: "issue_proposal", entityId: String(row.id), data: { issue_id: Number(row.issue_id), proposal_version: Number(row.proposal_version), proposal_hash: proposalHash, source_evaluation_run_id: input.sourceEvaluationRunId, input_fingerprint: input.fingerprint } });
    appendAuditRow(db, { actor: "system", action: "issue.proposal.current_changed", entityType: "issue_proposal_current", entityId: String(row.issue_id), data: { issue_id: Number(row.issue_id), from_proposal_id: prev ? Number(prev.proposal_id) : null, to_proposal_id: Number(row.id), proposal_version: Number(row.proposal_version), proposal_hash: proposalHash } });
    return "completed";
  });
}

export function currentProposalId(db, issueId) {
  const r = db.prepare("SELECT proposal_id FROM issue_proposal_current WHERE issue_id=?").get(Number(issueId));
  return r ? Number(r.proposal_id) : null;
}

// 新鮮度：無 current、政策改變、issue 非 active、evaluation 不可用/stale/非 PROPOSE、impact stale、或 input fingerprint 改變。
export function proposalStaleReasons(db, issueId, { now = new Date(), env = process.env, provider } = {}) {
  const cur = db.prepare("SELECT proposal_id, proposal_version, proposal_hash, input_fingerprint FROM issue_proposal_current WHERE issue_id=?").get(Number(issueId));
  if (!cur) return ["no_current_proposal"];
  const proposal = db.prepare("SELECT * FROM issue_proposal WHERE id=?").get(Number(cur.proposal_id));
  if (!proposal || proposal.status !== "completed") return ["no_current_proposal"];
  const issue = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(issueId));
  if (!issue) return ["issue_not_found"];
  const reasons = [];
  const effPolicyFp = effectiveProposalPolicyFingerprint(env, { provider });
  if (proposal.policy_fingerprint !== effPolicyFp) reasons.push("proposal_policy_changed");
  if (issue.status !== "open") reasons.push("issue_inactive");
  const evaluation = getCurrentIssueEvaluation(db, issueId, { now, env });
  if (!evaluation) { reasons.push("evaluation_unavailable"); return reasons; }
  if (evaluation.stale) { reasons.push("evaluation_stale"); for (const r of evaluation.stale_reasons || []) reasons.push(`evaluation:${r}`); return reasons; }
  if (evaluation.final_recommendation !== "PROPOSE") { reasons.push("recommendation_changed"); return reasons; }
  const impact = getCurrentIssueImpact(db, issueId, { now });
  if (!impact) { reasons.push("impact_unavailable"); return reasons; }
  if (impact.stale) { reasons.push("impact_stale"); return reasons; }
  const fp = proposalInputFingerprint({
    issueId: Number(issue.id), issueStatus: issue.status, issueUpdatedAt: issue.updated_at,
    membershipFingerprint: impact.membership_fingerprint, impactAssessmentId: impact.id,
    impactMembershipFingerprint: impact.membership_fingerprint, impactAnalysisFingerprint: impact.analysis_fingerprint,
    impactScoringVersion: impact.scoring_version,
    evaluationRunId: evaluation.id, evaluationInputFingerprint: evaluation.input_fingerprint,
    evaluationPolicyFingerprint: evaluation.policy_fingerprint, finalRecommendation: evaluation.final_recommendation,
    generationVersion: PROPOSAL_GENERATION_VERSION, proposalPolicyFingerprint: effPolicyFp,
  });
  if (fp !== cur.input_fingerprint) reasons.push("input_changed");
  return reasons;
}

export function isProposalStale(db, issueId, opts = {}) {
  return proposalStaleReasons(db, issueId, opts).length > 0;
}

function parseJson(v) { try { return JSON.parse(v); } catch { return null; } }

export function publicProposal(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    issue_id: Number(row.issue_id),
    proposal_version: Number(row.proposal_version),
    generation_version: row.generation_version,
    status: row.status,
    proposal_hash: row.proposal_hash,
    input_fingerprint: row.input_fingerprint,
    policy_fingerprint: row.policy_fingerprint,
    source_evaluation_run_id: row.source_evaluation_run_id == null ? null : Number(row.source_evaluation_run_id),
    source_impact_assessment_id: row.source_impact_assessment_id == null ? null : Number(row.source_impact_assessment_id),
    final_recommendation: row.final_recommendation,
    title: row.title,
    problem_statement: row.problem_statement,
    proposed_change: row.proposed_change,
    intended_outcome: row.intended_outcome,
    scope: parseJson(row.scope),
    non_goals: parseJson(row.non_goals),
    acceptance_criteria: parseJson(row.acceptance_criteria),
    known_risks: parseJson(row.known_risks),
    security_considerations: row.security_considerations,
    compliance_considerations: row.compliance_considerations,
    operational_considerations: row.operational_considerations,
    rollback_considerations: row.rollback_considerations,
    evidence_summary: row.evidence_summary,
    provider: row.provider,
    model: row.model,
    error_code: row.error_code,
    generated_at: row.generated_at,
    created_at: row.created_at,
  };
}

// 有效當前 Owner 決策（供 Phase 10 判斷；不用任意最新列猜測）。
export function currentOwnerDecision(db, issueId) {
  const entity = findEntity(db, issueEntityId(issueId));
  const state = entity ? entity.state : null;
  const latest = db.prepare("SELECT * FROM proposal_owner_decision WHERE issue_id=? ORDER BY id DESC LIMIT 1").get(Number(issueId)) || null;
  const map = {
    APPROVED_FOR_DEVELOPMENT: "approved",
    PROPOSAL_CHANGES_REQUESTED: "changes_requested",
    DEFERRED: "deferred",
    REJECTED: "rejected",
    BLOCKED: "blocked",
    APPROVAL_INVALIDATED: "superseded_approval",
    WAITING_OWNER_APPROVAL: "pending_review",
  };
  const label = state && map[state] ? map[state] : (latest ? "pending_review" : "never_reviewed");
  return { lifecycle_state: state, label, latest_decision: latest ? publicDecision(latest) : null };
}

export function publicDecision(row) {
  if (!row) return null;
  return {
    id: Number(row.id), issue_id: Number(row.issue_id), proposal_id: Number(row.proposal_id),
    proposal_version: Number(row.proposal_version), proposal_hash: row.proposal_hash,
    action: row.action, actor: row.actor, reason: row.reason, created_at: row.created_at,
    subscription_generation: row.subscription_generation == null ? null : Number(row.subscription_generation),
  };
}

export function listProposals(db, { issueId, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  return db.prepare("SELECT * FROM issue_proposal WHERE issue_id=? ORDER BY id DESC LIMIT ?").all(Number(issueId), cap).map(publicProposal);
}
export function listOwnerDecisions(db, { issueId, limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
  return db.prepare("SELECT * FROM proposal_owner_decision WHERE issue_id=? ORDER BY id DESC LIMIT ?").all(Number(issueId), cap).map(publicDecision);
}
export function getActiveAuthorization(db, issueId) {
  const row = db.prepare("SELECT * FROM development_authorization WHERE issue_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(Number(issueId));
  return row ? publicAuthorization(row) : null;
}
export function publicAuthorization(row) {
  if (!row) return null;
  return {
    id: Number(row.id), issue_id: Number(row.issue_id), proposal_id: Number(row.proposal_id),
    proposal_version: Number(row.proposal_version), proposal_hash: row.proposal_hash,
    source_evaluation_run_id: row.source_evaluation_run_id == null ? null : Number(row.source_evaluation_run_id),
    authorization_hash: row.authorization_hash, approved_by: row.approved_by, approved_at: row.approved_at,
    status: row.status, superseded_at: row.superseded_at, superseded_reason: row.superseded_reason,
  };
}

// Phase 8 唯一入口：回傳 current 提案 + 明示新鮮度 + 當前 Owner 決策。
export function getCurrentIssueProposal(db, issueId, opts = {}) {
  const id = currentProposalId(db, issueId);
  if (!id) return null;
  const row = db.prepare("SELECT * FROM issue_proposal WHERE id=?").get(Number(id));
  if (!row || Number(row.issue_id) !== Number(issueId) || row.status !== "completed") return null;
  const reasons = proposalStaleReasons(db, issueId, opts);
  return { ...publicProposal(row), stale: reasons.length > 0, fresh: reasons.length === 0, stale_reasons: reasons, current_decision: currentOwnerDecision(db, issueId) };
}

// ── Owner Approval Gate #1（TOCTOU-safe，單一交易） ──
export function submitOwnerDecision(db, issueId, { action, proposalId, proposalVersion, proposalHash, actor = "owner", reason = null, now = new Date(), env = process.env, provider } = {}) {
  const act = String(action || "").toUpperCase();
  if (!OWNER_ACTIONS.includes(act)) throw httpError(`invalid action: ${action}`, 400);
  const ts = iso(now);
  return withImmediateTx(db, () => {
    const cur = db.prepare("SELECT * FROM issue_proposal_current WHERE issue_id=?").get(Number(issueId));
    if (!cur) throw httpError("no current proposal for issue", 404);
    // 綁定確切 proposal_id + version + hash（絕不以 issue id 審批；擋 TOCTOU/錯版）。
    if (Number(proposalId) !== Number(cur.proposal_id)) throw httpError("proposal is not current (stale/superseded)", 409);
    if (Number(proposalVersion) !== Number(cur.proposal_version)) throw httpError("proposal_version mismatch", 409);
    if (String(proposalHash) !== String(cur.proposal_hash)) throw httpError("proposal_hash mismatch", 409);
    // 冪等（需在狀態檢查之前）：相同 proposal 已有 active 授權 → 回傳現有，不因已是 APPROVED 而報錯。
    if (act === "APPROVE_DEVELOPMENT") {
      const existing = db.prepare("SELECT * FROM development_authorization WHERE proposal_id=? AND proposal_hash=? AND status='active'").get(Number(cur.proposal_id), String(cur.proposal_hash));
      if (existing) return { idempotent: true, authorization: publicAuthorization(existing) };
    }
    const entity = findEntity(db, issueEntityId(issueId));
    if (!entity || entity.state !== "WAITING_OWNER_APPROVAL") {
      throw httpError(`issue is not awaiting owner approval (state=${entity ? entity.state : "none"})`, 409);
    }

    if (act === "APPROVE_DEVELOPMENT") {
      // 只有 APPROVE 需「新鮮」；其它決策對 stale 提案也允許（Owner 明確處置）。
      const reasons = proposalStaleReasons(db, issueId, { now, env, provider });
      if (reasons.length) throw httpError(`cannot approve a stale proposal: ${reasons.join(",")}`, 409);
      const authHash = createHash("sha256").update(JSON.stringify({ issue_id: Number(issueId), proposal_id: Number(cur.proposal_id), proposal_version: Number(cur.proposal_version), proposal_hash: String(cur.proposal_hash) })).digest("hex");
      appendAuditRow(db, { actor, action: "issue.proposal.decision", entityType: "issue_proposal", entityId: String(cur.proposal_id), data: { issue_id: Number(issueId), decision: act, proposal_version: Number(cur.proposal_version), proposal_hash: String(cur.proposal_hash) } });
      recordDecision(db, { issueId, cur, action: act, actor, reason, ts });
      transitionRow(db, { id: issueEntityId(issueId), to: "APPROVED_FOR_DEVELOPMENT", actor, data: { proposal_hash: cur.proposal_hash }, now });
      const proposalRow = db.prepare("SELECT source_evaluation_run_id FROM issue_proposal WHERE id=?").get(Number(cur.proposal_id));
      const res = db.prepare(
        `INSERT INTO development_authorization(issue_id, proposal_id, proposal_version, proposal_hash, source_evaluation_run_id, authorization_hash, approved_by, approved_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(Number(issueId), Number(cur.proposal_id), Number(cur.proposal_version), String(cur.proposal_hash), proposalRow?.source_evaluation_run_id ?? null, authHash, actor, ts, ts);
      const authId = Number(res.lastInsertRowid);
      appendAuditRow(db, { actor, action: "issue.development.approved", entityType: "development_authorization", entityId: String(authId), data: { issue_id: Number(issueId), proposal_id: Number(cur.proposal_id), proposal_version: Number(cur.proposal_version), proposal_hash: String(cur.proposal_hash), source_evaluation_run_id: proposalRow?.source_evaluation_run_id ?? null } });
      return { authorization: publicAuthorization(db.prepare("SELECT * FROM development_authorization WHERE id=?").get(authId)) };
    }

    // 非授權決策：記錄 + 轉移；REQUEST_CHANGES 另排新版本（不修改舊提案）。
    recordDecision(db, { issueId, cur, action: act, actor, reason, ts });
    appendAuditRow(db, { actor, action: "issue.proposal.decision", entityType: "issue_proposal", entityId: String(cur.proposal_id), data: { issue_id: Number(issueId), decision: act, proposal_version: Number(cur.proposal_version), proposal_hash: String(cur.proposal_hash) } });
    if (act === "REQUEST_CHANGES") {
      transitionRow(db, { id: issueEntityId(issueId), to: "PROPOSAL_CHANGES_REQUESTED", actor, now });
      appendAuditRow(db, { actor, action: "issue.proposal.changes_requested", entityType: "issue_proposal", entityId: String(cur.proposal_id), data: { issue_id: Number(issueId), proposal_version: Number(cur.proposal_version) } });
      const nextRow = enqueueProposalRow(db, { issueId, revisionInstruction: reason, now });
      return { changes_requested: true, next_proposal_id: nextRow.id, next_version: nextRow.version };
    }
    if (act === "DEFER") {
      transitionRow(db, { id: issueEntityId(issueId), to: "DEFERRED", actor, now });
      appendAuditRow(db, { actor, action: "issue.proposal.deferred", entityType: "issue_candidate", entityId: String(issueId), data: { issue_id: Number(issueId), proposal_version: Number(cur.proposal_version) } });
      return { deferred: true };
    }
    if (act === "REJECT") {
      transitionRow(db, { id: issueEntityId(issueId), to: "REJECTED", actor, now });
      appendAuditRow(db, { actor, action: "issue.proposal.rejected", entityType: "issue_candidate", entityId: String(issueId), data: { issue_id: Number(issueId), proposal_version: Number(cur.proposal_version) } });
      return { rejected: true };
    }
    // BLOCK
    transitionRow(db, { id: issueEntityId(issueId), to: "BLOCKED", actor, now });
    appendAuditRow(db, { actor, action: "issue.proposal.blocked", entityType: "issue_candidate", entityId: String(issueId), data: { issue_id: Number(issueId), proposal_version: Number(cur.proposal_version) } });
    return { blocked: true };
  });
}

function recordDecision(db, { issueId, cur, action, actor, reason, ts }) {
  const gate = issueWriteDecision(db, issueId);
  const generation = gate.unbound ? null : Number(gate.generation ?? gate.current_generation ?? 1);
  db.prepare(
    `INSERT INTO proposal_owner_decision(issue_id, proposal_id, proposal_version, proposal_hash, action, actor, reason, created_at, subscription_generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(Number(issueId), Number(cur.proposal_id), Number(cur.proposal_version), String(cur.proposal_hash), action, actor, reason ? String(reason).slice(0, REASON_MAX) : null, ts, generation);
}

// Owner 手動請求生成／重生成提案（僅排入 job；不建授權、不寫程式）。
export function requestProposalGeneration(db, issueId, { actor = "owner", now = new Date() } = {}) {
  const issue = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(issueId));
  if (!issue) throw httpError("issue not found", 404);
  if (issue.status !== "open") throw httpError("issue is not active", 409);
  return withImmediateTx(db, () => {
    const row = enqueueProposalRow(db, { issueId, now });
    appendAuditRow(db, { actor, action: "issue.proposal.generation_requested", entityType: "issue_candidate", entityId: String(issueId), data: { issue_id: Number(issueId), proposal_id: row.id } });
    return { proposal_id: row.id, version: row.version };
  });
}
