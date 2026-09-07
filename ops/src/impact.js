import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { getCurrentIssueMembers } from "./clustering.js";
import { getCurrentFeedbackAnalysis } from "./feedbackAnalysis.js";

// Phase 6：決定性、可解釋、版本化的 Issue 影響力/頻率評估。
// 純本地計算（不需外部 AI）。不投票、不建 proposal、不觸發開發/發布。
export const IMPACT_SCORING_VERSION = "impact-v1";

// 權重/上限/門檻集中管理且可設定（版本化）。分數 0..100，元件值保留以供解釋。
export function impactConfig(env = process.env) {
  return {
    version: IMPACT_SCORING_VERSION,
    weights: {
      frequency: Number(env.IMPACT_W_FREQUENCY || 0.4),
      reporters: Number(env.IMPACT_W_REPORTERS || 0.25),
      recency: Number(env.IMPACT_W_RECENCY || 0.2),
      severity: Number(env.IMPACT_W_SEVERITY || 0.15),
    },
    caps: {
      frequency: Number(env.IMPACT_CAP_FREQUENCY || 20),
      reporters: Number(env.IMPACT_CAP_REPORTERS || 10),
      recency: Number(env.IMPACT_CAP_RECENCY || 10),
    },
    levels: {
      critical: Number(env.IMPACT_LEVEL_CRITICAL || 75),
      high: Number(env.IMPACT_LEVEL_HIGH || 50),
      medium: Number(env.IMPACT_LEVEL_MEDIUM || 25),
    },
    // 時間新鮮度：即使成員/分析未變，超過此年齡也視為 stale（時間窗數值會過時）。預設 6 小時。
    maxAgeMs: Number(env.IMPACT_MAX_AGE_MS || 6 * 60 * 60 * 1000),
  };
}

const SEVERITY_WEIGHT = { CRITICAL: 1, HIGH: 0.75, MEDIUM: 0.5, LOW: 0.25, UNKNOWN: 0.25 };

function ms(v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }

// 只用 canonical 當前成員（getCurrentIssueMembers）：排除 auto stale / review_required；含 owner 權威成員。
export function computeImpactSignals(db, issueId, { now = new Date() } = {}) {
  const members = getCurrentIssueMembers(db, issueId);
  const nowMs = now instanceof Date ? now.getTime() : now;
  const reporters = new Set();
  let anonymous = 0;
  let firstSeen = null;
  let lastSeen = null;
  let c24 = 0, c7 = 0, c30 = 0;
  const sevDist = {};
  const catDist = {};
  const verDist = {};
  const srcDist = {};
  for (const m of members) {
    const fb = db.prepare("SELECT received_at, submitted_at, user_ref, app_version, source, kind FROM ingested_feedback WHERE id=?").get(Number(m.feedback_id));
    if (!fb) continue;
    const ref = String(fb.user_ref || "").trim();
    if (ref) reporters.add(ref); else anonymous += 1;
    const seen = ms(fb.received_at) ?? ms(fb.submitted_at);
    if (seen != null) {
      if (firstSeen == null || seen < firstSeen) firstSeen = seen;
      if (lastSeen == null || seen > lastSeen) lastSeen = seen;
      const age = nowMs - seen;
      if (age <= 24 * 3600e3) c24 += 1;
      if (age <= 7 * 24 * 3600e3) c7 += 1;
      if (age <= 30 * 24 * 3600e3) c30 += 1;
    }
    const ca = getCurrentFeedbackAnalysis(db, m.feedback_id);
    const sev = (ca?.severity_hint || "UNKNOWN");
    const cat = (ca?.category || "OTHER");
    sevDist[sev] = (sevDist[sev] || 0) + 1;
    catDist[cat] = (catDist[cat] || 0) + 1;
    const ver = String(fb.app_version || "unknown");
    verDist[ver] = (verDist[ver] || 0) + 1;
    const src = String(fb.source || "unknown");
    srcDist[src] = (srcDist[src] || 0) + 1;
  }
  return {
    membership_count: members.length,
    current_feedback_count: members.length,
    distinct_reporter_count: reporters.size,
    anonymous_feedback_count: anonymous,
    first_seen_at: firstSeen != null ? new Date(firstSeen).toISOString() : null,
    last_seen_at: lastSeen != null ? new Date(lastSeen).toISOString() : null,
    feedback_count_24h: c24,
    feedback_count_7d: c7,
    feedback_count_30d: c30,
    recent_velocity: c7,
    severity_distribution: sevDist,
    category_distribution: catDist,
    app_version_distribution: verDist,
    source_distribution: srcDist,
    membership_fingerprint: membershipFingerprint(members),
  };
}

// 決定性 fingerprint：以確切當前成員/證據身分排序後雜湊。成員實質變更 → fingerprint 變 → 舊評估 stale。
export function membershipFingerprint(members) {
  const parts = members
    .map((m) => `${Number(m.feedback_id)}:${Number(m.id)}:${m.analysis_id ?? ""}:${m.embedding_id ?? ""}:${m.membership_status}`)
    .sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// 當前分析 provenance：用「每個成員的 Phase-4 CURRENT 分析」（非 link 上舊的 analysis_id）排序後雜湊。
// 成員未變但某成員的 CURRENT 分析改變（含 Owner 權威成員）→ analysis_fingerprint 變 → 舊評估 stale。
export function analysisFingerprint(db, members) {
  const parts = members
    .map((m) => {
      const ca = getCurrentFeedbackAnalysis(db, m.feedback_id);
      return `${Number(m.feedback_id)}:${ca ? ca.id : ""}`;
    })
    .sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// 決定性、可解釋分數（0..100）；保留元件值。
export function scoreImpact(signals, config = impactConfig()) {
  const w = config.weights;
  const caps = config.caps;
  let maxSev = 0;
  for (const [sev, n] of Object.entries(signals.severity_distribution || {})) {
    if (n > 0) maxSev = Math.max(maxSev, SEVERITY_WEIGHT[sev] ?? 0.25);
  }
  const components = {
    frequency: Math.min(signals.current_feedback_count, caps.frequency) / caps.frequency,
    reporters: Math.min(signals.distinct_reporter_count, caps.reporters) / caps.reporters,
    recency: Math.min(signals.recent_velocity, caps.recency) / caps.recency,
    severity: maxSev,
  };
  const weighted = {
    frequency: w.frequency * components.frequency,
    reporters: w.reporters * components.reporters,
    recency: w.recency * components.recency,
    severity: w.severity * components.severity,
  };
  const total = Math.round((weighted.frequency + weighted.reporters + weighted.recency + weighted.severity) * 100 * 1000) / 1000;
  return { components, weighted, weights: w, caps, total };
}

export function levelForScore(total, config = impactConfig()) {
  const L = config.levels;
  if (total >= L.critical) return "CRITICAL";
  if (total >= L.high) return "HIGH";
  if (total >= L.medium) return "MEDIUM";
  return "LOW";
}

// 計算 + 寫入歷史評估 + 原子 promote CURRENT 指標（同一交易）。
export function calculateAndStoreImpact(db, issueId, { now = new Date(), config = impactConfig(), actor = "system" } = {}) {
  const issue = db.prepare("SELECT id FROM issue_candidate WHERE id=?").get(Number(issueId));
  if (!issue) throw httpError("issue not found", 404);
  // 單一計算錨點（as_of_at）：所有 24h/7d/30d/recency 都相對於它；不在計算中各自讀時鐘。
  const asOf = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const ts = asOf.toISOString();
  const signals = computeImpactSignals(db, issueId, { now: asOf });
  const anaFp = analysisFingerprint(db, getCurrentIssueMembers(db, issueId));
  const scored = scoreImpact(signals, config);
  const level = levelForScore(scored.total, config);
  return withImmediateTx(db, () => {
    const res = db.prepare(
      `INSERT INTO issue_impact_assessment
        (issue_id, scoring_version, membership_fingerprint, membership_count, current_feedback_count, distinct_reporter_count, anonymous_feedback_count,
         first_seen_at, last_seen_at, feedback_count_24h, feedback_count_7d, feedback_count_30d, recent_velocity,
         severity_distribution, category_distribution, app_version_distribution, source_distribution, components, impact_score, impact_level, as_of_at, analysis_fingerprint, calculated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(issueId), config.version, signals.membership_fingerprint, signals.membership_count, signals.current_feedback_count,
      signals.distinct_reporter_count, signals.anonymous_feedback_count, signals.first_seen_at, signals.last_seen_at,
      signals.feedback_count_24h, signals.feedback_count_7d, signals.feedback_count_30d, signals.recent_velocity,
      JSON.stringify(signals.severity_distribution), JSON.stringify(signals.category_distribution), JSON.stringify(signals.app_version_distribution), JSON.stringify(signals.source_distribution),
      JSON.stringify(scored), scored.total, level, ts, anaFp, ts,
    );
    const assessmentId = Number(res.lastInsertRowid);
    const prev = db.prepare("SELECT assessment_id FROM issue_impact_current WHERE issue_id=?").get(Number(issueId));
    db.prepare(
      `INSERT INTO issue_impact_current(issue_id, assessment_id, membership_fingerprint, analysis_fingerprint, as_of_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET assessment_id=excluded.assessment_id, membership_fingerprint=excluded.membership_fingerprint, analysis_fingerprint=excluded.analysis_fingerprint, as_of_at=excluded.as_of_at, updated_at=excluded.updated_at`,
    ).run(Number(issueId), assessmentId, signals.membership_fingerprint, anaFp, ts, ts);
    appendAuditRow(db, { actor, action: "issue.impact.calculated", entityType: "issue_impact_assessment", entityId: String(assessmentId), data: { issue_id: Number(issueId), scoring_version: config.version, membership_fingerprint: signals.membership_fingerprint, analysis_fingerprint: anaFp, as_of_at: ts, score: scored.total, level, membership_count: signals.membership_count } });
    appendAuditRow(db, { actor, action: "issue.impact.current_changed", entityType: "issue_impact_current", entityId: String(issueId), data: { issue_id: Number(issueId), from_assessment_id: prev ? Number(prev.assessment_id) : null, to_assessment_id: assessmentId, score: scored.total, level } });
    return { assessmentId, score: scored.total, level, fingerprint: signals.membership_fingerprint, analysisFingerprint: anaFp, asOfAt: ts };
  });
}

export function getAssessment(db, id) {
  return db.prepare("SELECT * FROM issue_impact_assessment WHERE id=?").get(Number(id) || 0) || null;
}

export function currentImpactId(db, issueId) {
  const r = db.prepare("SELECT assessment_id FROM issue_impact_current WHERE issue_id=?").get(Number(issueId));
  return r ? Number(r.assessment_id) : null;
}

// 新鮮度原因：成員變、當前分析變、超過年齡、或尚無評估。回傳原因陣列（空=fresh）。
export function impactStaleReasons(db, issueId, { now = new Date(), config = impactConfig() } = {}) {
  const cur = db.prepare("SELECT membership_fingerprint, analysis_fingerprint, as_of_at FROM issue_impact_current WHERE issue_id=?").get(Number(issueId));
  if (!cur) return ["no_current_assessment"];
  const members = getCurrentIssueMembers(db, issueId);
  const reasons = [];
  if (membershipFingerprint(members) !== cur.membership_fingerprint) reasons.push("membership_changed");
  if (analysisFingerprint(db, members) !== cur.analysis_fingerprint) reasons.push("analysis_changed");
  const nowMs = now instanceof Date ? now.getTime() : now;
  const asOf = Date.parse(cur.as_of_at);
  if (Number.isFinite(asOf) && nowMs - asOf > config.maxAgeMs) reasons.push("age_exceeded");
  return reasons;
}

export function isImpactStale(db, issueId, opts = {}) {
  return impactStaleReasons(db, issueId, opts).length > 0;
}

// 下游 Phase 7 唯一入口：回傳評估並「明示新鮮度」，避免誤將 stale 當 fresh。
export function getCurrentIssueImpact(db, issueId, { now = new Date(), config = impactConfig() } = {}) {
  const id = currentImpactId(db, issueId);
  if (!id) return null;
  const row = getAssessment(db, id);
  if (!row || Number(row.issue_id) !== Number(issueId)) return null;
  const reasons = impactStaleReasons(db, issueId, { now, config });
  return { ...publicImpact(row), stale: reasons.length > 0, fresh: reasons.length === 0, stale_reasons: reasons };
}

export function listAssessments(db, { issueId, limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
  return db.prepare("SELECT * FROM issue_impact_assessment WHERE issue_id=? ORDER BY id DESC LIMIT ?").all(Number(issueId), cap).map(publicImpact);
}

function parseJson(v) { try { return JSON.parse(v); } catch { return null; } }

// 對外只露聚合值（無 email/phone/contact/session/原始內容/向量）。
export function publicImpact(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    issue_id: Number(row.issue_id),
    scoring_version: row.scoring_version,
    membership_fingerprint: row.membership_fingerprint,
    membership_count: Number(row.membership_count),
    current_feedback_count: Number(row.current_feedback_count),
    distinct_reporter_count: Number(row.distinct_reporter_count),
    anonymous_feedback_count: Number(row.anonymous_feedback_count),
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    feedback_count_24h: Number(row.feedback_count_24h),
    feedback_count_7d: Number(row.feedback_count_7d),
    feedback_count_30d: Number(row.feedback_count_30d),
    recent_velocity: row.recent_velocity == null ? null : Number(row.recent_velocity),
    severity_distribution: parseJson(row.severity_distribution),
    category_distribution: parseJson(row.category_distribution),
    app_version_distribution: parseJson(row.app_version_distribution),
    source_distribution: parseJson(row.source_distribution),
    components: parseJson(row.components),
    impact_score: Number(row.impact_score),
    impact_level: row.impact_level,
    as_of_at: row.as_of_at,
    analysis_fingerprint: row.analysis_fingerprint,
    calculated_at: row.calculated_at,
  };
}
