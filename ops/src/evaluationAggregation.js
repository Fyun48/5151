import { riskAtLeast } from "./evaluationSchema.js";
import { ESCALATION_ROLES } from "./evaluationRoles.js";

// Phase 7 最終建議「不是」再一次不透明的 LLM 意見，而是對結構化角色票的決定性、版本化聚合。
export const EVALUATION_VERSION = "evaluation-v1";
export const AGGREGATION_VERSION = "evaluation-aggregation-v1";

// 權重/門檻集中且可設定（版本化）。不散落魔法數字。
export function aggregationConfig(env = process.env) {
  const roleWeight = (role, dflt = 1) => {
    const v = Number(env[`EVAL_WEIGHT_${role}`]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    version: AGGREGATION_VERSION,
    evaluationVersion: EVALUATION_VERSION,
    weights: {
      PRODUCT: roleWeight("PRODUCT"),
      ENGINEERING: roleWeight("ENGINEERING"),
      SECURITY: roleWeight("SECURITY"),
      COMPLIANCE: roleWeight("COMPLIANCE"),
      OPERATIONS: roleWeight("OPERATIONS"),
    },
    proposeSupermajority: numOr(env.EVAL_PROPOSE_SUPERMAJORITY, 0.6),
    ignoreSupermajority: numOr(env.EVAL_IGNORE_SUPERMAJORITY, 0.6),
    // 需要多少個「已完成角色票」才視為足夠 quorum。預設：全部要求的角色都要有票。
    minQuorumFraction: numOr(env.EVAL_MIN_QUORUM_FRACTION, 1.0),
    // 有多少比例的角色回報 material missing_evidence 時，保守退回 WAIT（除非觸發 escalation）。
    missingEvidenceWaitFraction: numOr(env.EVAL_MISSING_EVIDENCE_WAIT_FRACTION, 0.5),
    // 阻擋式升級：SECURITY/COMPLIANCE 足夠有信心的 ESCALATE 可壓過一般 PROPOSE 多數。
    escalate: {
      roles: ESCALATION_ROLES,
      minConfidence: numOr(env.EVAL_ESCALATE_MIN_CONFIDENCE, 0.6),
      minRisk: String(env.EVAL_ESCALATE_MIN_RISK || "HIGH").toUpperCase(),
    },
  };
}

function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function weightOf(config, role) {
  const w = config.weights[String(role || "").toUpperCase()];
  return Number.isFinite(w) && w > 0 ? w : 1;
}

function avg(nums) {
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000;
}

// 決定性聚合。輸入：每角色「最終一輪」的票 [{role, recommendation, confidence, risk_level, missing_evidence?}]。
// 步驟：1) 阻擋式升級 → 2) quorum → 3) 加權 PROPOSE/IGNORE supermajority → 4) 否則 WAIT（安全預設）。
export function aggregateVotes(votes, { requiredRoles, config = aggregationConfig() } = {}) {
  const list = Array.isArray(votes) ? votes.filter((v) => v && v.recommendation) : [];
  const required = Array.isArray(requiredRoles) && requiredRoles.length
    ? requiredRoles
    : [...new Set(list.map((v) => String(v.role || "").toUpperCase()))];

  // 1) 阻擋式升級（SECURITY/COMPLIANCE 足夠有信心 + 風險 >= 門檻）。
  const escalators = list.filter((v) =>
    config.escalate.roles.includes(String(v.role || "").toUpperCase())
    && String(v.recommendation).toUpperCase() === "ESCALATE"
    && Number(v.confidence) >= config.escalate.minConfidence
    && riskAtLeast(v.risk_level, config.escalate.minRisk),
  );
  if (escalators.length) {
    return {
      final_recommendation: "ESCALATE",
      agreement: 1,
      aggregate_confidence: avg(escalators.map((v) => Number(v.confidence))),
      details: {
        aggregation_version: config.version,
        evaluation_version: config.evaluationVersion,
        rule: "blocking_escalation",
        escalation_triggered_by: escalators.map((v) => ({ role: String(v.role).toUpperCase(), confidence: Number(v.confidence), risk_level: String(v.risk_level).toUpperCase() })),
        weights: config.weights,
        quorum: { required: required.length, present: list.length },
      },
    };
  }

  // 2) quorum：完成票數不足 → WAIT。
  const requiredQuorum = Math.ceil(required.length * config.minQuorumFraction);
  if (list.length < requiredQuorum) {
    return waitResult(config, required, list, "incomplete_quorum", { required: requiredQuorum, present: list.length });
  }

  // 3) material missing evidence → 保守 WAIT。
  const missingCount = list.filter((v) => Array.isArray(v.missing_evidence) && v.missing_evidence.length > 0).length;
  if (list.length > 0 && missingCount / list.length >= config.missingEvidenceWaitFraction) {
    return waitResult(config, required, list, "material_missing_evidence", { missing: missingCount, total: list.length });
  }

  // 4) 加權多數。
  let totalWeight = 0;
  let proposeWeight = 0;
  let ignoreWeight = 0;
  for (const v of list) {
    const w = weightOf(config, v.role);
    totalWeight += w;
    const rec = String(v.recommendation).toUpperCase();
    if (rec === "PROPOSE") proposeWeight += w;
    else if (rec === "IGNORE") ignoreWeight += w;
  }
  const proposeFrac = totalWeight > 0 ? proposeWeight / totalWeight : 0;
  const ignoreFrac = totalWeight > 0 ? ignoreWeight / totalWeight : 0;

  if (proposeFrac >= config.proposeSupermajority) {
    const supporters = list.filter((v) => String(v.recommendation).toUpperCase() === "PROPOSE");
    return finalResult("PROPOSE", proposeFrac, supporters, config, required, list, { proposeFrac, ignoreFrac });
  }
  if (ignoreFrac >= config.ignoreSupermajority) {
    const supporters = list.filter((v) => String(v.recommendation).toUpperCase() === "IGNORE");
    return finalResult("IGNORE", ignoreFrac, supporters, config, required, list, { proposeFrac, ignoreFrac });
  }
  return waitResult(config, required, list, "insufficient_agreement", { proposeFrac, ignoreFrac });
}

function finalResult(rec, agreement, supporters, config, required, list, tallies) {
  return {
    final_recommendation: rec,
    agreement: Math.round(agreement * 1000) / 1000,
    aggregate_confidence: avg(supporters.map((v) => Number(v.confidence))),
    details: {
      aggregation_version: config.version,
      evaluation_version: config.evaluationVersion,
      rule: "weighted_supermajority",
      tallies,
      weights: config.weights,
      quorum: { required: required.length, present: list.length },
    },
  };
}

function waitResult(config, required, list, reason, extra) {
  return {
    final_recommendation: "WAIT",
    agreement: null,
    aggregate_confidence: avg(list.map((v) => Number(v.confidence))),
    details: {
      aggregation_version: config.version,
      evaluation_version: config.evaluationVersion,
      rule: "wait_fallback",
      reason,
      ...extra,
      weights: config.weights,
      quorum: { required: required.length, present: list.length },
    },
  };
}
