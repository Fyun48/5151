import { createHash } from "node:crypto";

// Phase 9 重評政策：決定性、集中、版本化。DEFER 門檻較低、REJECT 門檻較高。BLOCK 一律不受自動政策影響。
// 只讀非機密設定；快照/指紋不含金鑰/密碼/URL。

export const REEVALUATION_POLICY_VERSION = "reevaluation-policy-v1";

export const IMPACT_LEVEL_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
export function levelRank(level) { return IMPACT_LEVEL_RANK[String(level || "").toUpperCase()] || 0; }

// 穩定 reason codes（配合觀測值一起保存）。
export const REASON = {
  FEEDBACK_COUNT_GROWTH: "FEEDBACK_COUNT_GROWTH",
  REPORTER_COUNT_GROWTH: "REPORTER_COUNT_GROWTH",
  IMPACT_SCORE_INCREASE: "IMPACT_SCORE_INCREASE",
  IMPACT_LEVEL_INCREASE: "IMPACT_LEVEL_INCREASE",
  CRITICAL_SEVERITY_INCREASE: "CRITICAL_SEVERITY_INCREASE",
  HIGH_SEVERITY_INCREASE: "HIGH_SEVERITY_INCREASE",
  VELOCITY_INCREASE: "VELOCITY_INCREASE",
  OWNER_MANUAL: "OWNER_MANUAL",
  OWNER_UNBLOCK: "OWNER_UNBLOCK",
};

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

export function reevaluationConfig(env = process.env) {
  return {
    version: REEVALUATION_POLICY_VERSION,
    cooldownMs: num(env.REEVAL_COOLDOWN_MS, 24 * 60 * 60 * 1000),
    defer: {
      minFeedbackDelta: num(env.REEVAL_DEFER_MIN_FEEDBACK_DELTA, 2),
      minReporterDelta: num(env.REEVAL_DEFER_MIN_REPORTER_DELTA, 1),
      minScoreDelta: num(env.REEVAL_DEFER_MIN_SCORE_DELTA, 10),
      minVelocityDelta: num(env.REEVAL_DEFER_MIN_VELOCITY_DELTA, 3),
      levelIncrease: env.REEVAL_DEFER_LEVEL_INCREASE !== "0",
      criticalSeverityIncrease: env.REEVAL_DEFER_CRITICAL_INCREASE !== "0",
      highSeverityIncrease: env.REEVAL_DEFER_HIGH_INCREASE !== "0",
    },
    reject: {
      minFeedbackDelta: num(env.REEVAL_REJECT_MIN_FEEDBACK_DELTA, 5),
      minReporterDelta: num(env.REEVAL_REJECT_MIN_REPORTER_DELTA, 3),
      minScoreDelta: num(env.REEVAL_REJECT_MIN_SCORE_DELTA, 25),
      minVelocityDelta: num(env.REEVAL_REJECT_MIN_VELOCITY_DELTA, 6),
      levelIncrease: env.REEVAL_REJECT_LEVEL_INCREASE !== "0",
      criticalSeverityIncrease: env.REEVAL_REJECT_CRITICAL_INCREASE !== "0",
      highSeverityIncrease: env.REEVAL_REJECT_HIGH_INCREASE === "1", // REJECT 預設不因 HIGH 增加而重啟（較嚴）
    },
  };
}

export function reevaluationPolicyFingerprint(config) {
  const c = config;
  const lines = [
    `version=${c.version}`,
    `cooldown_ms=${c.cooldownMs}`,
    ...["defer", "reject"].flatMap((k) => [
      `${k}.min_feedback_delta=${c[k].minFeedbackDelta}`,
      `${k}.min_reporter_delta=${c[k].minReporterDelta}`,
      `${k}.min_score_delta=${c[k].minScoreDelta}`,
      `${k}.min_velocity_delta=${c[k].minVelocityDelta}`,
      `${k}.level_increase=${c[k].levelIncrease}`,
      `${k}.critical_severity_increase=${c[k].criticalSeverityIncrease}`,
      `${k}.high_severity_increase=${c[k].highSeverityIncrease}`,
    ]),
  ].sort();
  return createHash("sha256").update(JSON.stringify(lines)).digest("hex");
}

function sevCount(dist, key) {
  if (!dist || typeof dist !== "object") return 0;
  return Number(dist[key] || dist[String(key).toUpperCase()] || 0) || 0;
}

// 決定性 material-change 評估。回傳結構化、可解釋結果（reason codes + 觀測 deltas）。
// decisionType: 'DEFER' | 'REJECT'（對應現行狀態 DEFERRED/REJECTED）。
export function assessMaterialChange({ decisionType, baseline, current, config = reevaluationConfig() }) {
  const th = String(decisionType).toUpperCase() === "REJECT" ? config.reject : config.defer;
  const deltas = {
    feedback_count: num(current.current_feedback_count, 0) - num(baseline.current_feedback_count, 0),
    distinct_reporter_count: num(current.distinct_reporter_count, 0) - num(baseline.distinct_reporter_count, 0),
    impact_score: Math.round((num(current.impact_score, 0) - num(baseline.impact_score, 0)) * 1000) / 1000,
    recent_velocity: num(current.recent_velocity, 0) - num(baseline.recent_velocity, 0),
    baseline_level: baseline.impact_level,
    current_level: current.impact_level,
    critical_severity: sevCount(current.severity_distribution, "CRITICAL") - sevCount(baseline.severity_distribution, "CRITICAL"),
    high_severity: sevCount(current.severity_distribution, "HIGH") - sevCount(baseline.severity_distribution, "HIGH"),
  };
  const triggered = [];
  if (deltas.feedback_count >= th.minFeedbackDelta && th.minFeedbackDelta > 0) triggered.push(REASON.FEEDBACK_COUNT_GROWTH);
  if (deltas.distinct_reporter_count >= th.minReporterDelta && th.minReporterDelta > 0) triggered.push(REASON.REPORTER_COUNT_GROWTH);
  if (deltas.impact_score >= th.minScoreDelta && th.minScoreDelta > 0) triggered.push(REASON.IMPACT_SCORE_INCREASE);
  if (th.levelIncrease && levelRank(current.impact_level) > levelRank(baseline.impact_level)) triggered.push(REASON.IMPACT_LEVEL_INCREASE);
  if (th.criticalSeverityIncrease && deltas.critical_severity >= 1) triggered.push(REASON.CRITICAL_SEVERITY_INCREASE);
  if (th.highSeverityIncrease && deltas.high_severity >= 1) triggered.push(REASON.HIGH_SEVERITY_INCREASE);
  if (deltas.recent_velocity >= th.minVelocityDelta && th.minVelocityDelta > 0) triggered.push(REASON.VELOCITY_INCREASE);
  return { eligible: triggered.length > 0, triggered, deltas };
}
