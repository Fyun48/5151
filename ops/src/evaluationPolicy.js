import { createHash } from "node:crypto";
import { aggregationConfig, EVALUATION_VERSION, AGGREGATION_VERSION } from "./evaluationAggregation.js";
import { evaluationRolesConfig, ROLE_SET_VERSION, ROLE_PROMPT_VERSION } from "./evaluationRoles.js";
import { makeEvaluationProvider } from "./ai/evaluationProvider.js";

// Phase 7 政策/設定 provenance：input fingerprint 綁定「證據」，policy fingerprint 綁定「產生決策的政策/模型設定」。
// 目的：即使 evaluation_version / aggregation_version 意外沒改，只要任何「會影響結果」的設定變了
//（角色集、權重、quorum、propose/ignore 門檻、escalation 門檻、deliberation、prompt/provider/model 版本…），
// 舊的 canonical 評估就必須變 stale，Phase 8 不得誤用。快照一律不含 API 金鑰/密碼/token/URL 等機密。

// 從「本次實際使用的設定」建立正規化政策物件（可存為 sanitized 快照）。
export function buildEvaluationPolicy({
  aggConfig = aggregationConfig(),
  roles = evaluationRolesConfig().roles,
  deliberationEnabled = false,
  provider = null,
  rolePromptVersion = ROLE_PROMPT_VERSION,
  roleSetVersion = ROLE_SET_VERSION,
} = {}) {
  const roleList = [...roles].map((r) => String(r).toUpperCase()).sort();
  const weights = {};
  for (const r of roleList) weights[r] = Number(aggConfig.weights?.[r] ?? 1);
  return {
    evaluation_version: aggConfig.evaluationVersion || EVALUATION_VERSION,
    aggregation_version: aggConfig.version || AGGREGATION_VERSION,
    role_set_version: roleSetVersion,
    roles: roleList,
    weights,
    propose_supermajority: Number(aggConfig.proposeSupermajority),
    ignore_supermajority: Number(aggConfig.ignoreSupermajority),
    min_quorum_fraction: Number(aggConfig.minQuorumFraction),
    missing_evidence_wait_fraction: Number(aggConfig.missingEvidenceWaitFraction),
    escalate_roles: [...(aggConfig.escalate?.roles || [])].map((r) => String(r).toUpperCase()).sort(),
    escalate_min_confidence: Number(aggConfig.escalate?.minConfidence),
    escalate_min_risk: String(aggConfig.escalate?.minRisk || "").toUpperCase(),
    deliberation_enabled: Boolean(deliberationEnabled),
    max_deliberation_round: 2,
    role_prompt_version: rolePromptVersion,
    provider: provider?.name || "none",
    model: provider?.model ?? null,
    model_version: provider?.model_version ?? null,
  };
}

// 決定性指紋：把所有 result-affecting 欄位攤平成 key=value、排序後雜湊。不含任何機密。
export function evaluationPolicyFingerprint(policy) {
  const p = policy;
  const lines = [
    `evaluation_version=${p.evaluation_version}`,
    `aggregation_version=${p.aggregation_version}`,
    `role_set_version=${p.role_set_version}`,
    `roles=${[...p.roles].sort().join(",")}`,
    ...Object.entries(p.weights).map(([k, v]) => `weight.${k}=${v}`),
    `propose_supermajority=${p.propose_supermajority}`,
    `ignore_supermajority=${p.ignore_supermajority}`,
    `min_quorum_fraction=${p.min_quorum_fraction}`,
    `missing_evidence_wait_fraction=${p.missing_evidence_wait_fraction}`,
    `escalate_roles=${[...p.escalate_roles].sort().join(",")}`,
    `escalate_min_confidence=${p.escalate_min_confidence}`,
    `escalate_min_risk=${p.escalate_min_risk}`,
    `deliberation_enabled=${p.deliberation_enabled}`,
    `max_deliberation_round=${p.max_deliberation_round}`,
    `role_prompt_version=${p.role_prompt_version}`,
    `provider=${p.provider}`,
    `model=${p.model ?? ""}`,
    `model_version=${p.model_version ?? ""}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(lines)).digest("hex");
}

// 目前「有效」政策：預設從 env 推導（server GET / worker 皆可用），可用參數覆寫以保持與實際執行一致。
// 只讀非機密設定與 provider 身分（name/model/model_version）；不讀 base URL / 金鑰。
export function effectiveEvaluationPolicy(env = process.env, { provider, aggConfig, roles, deliberationEnabled, rolePromptVersion } = {}) {
  const rc = evaluationRolesConfig(env);
  return buildEvaluationPolicy({
    aggConfig: aggConfig || aggregationConfig(env),
    roles: roles || rc.roles,
    deliberationEnabled: deliberationEnabled ?? (env.EVALUATION_DELIBERATION_ENABLED === "1"),
    provider: provider || makeEvaluationProvider(env),
    rolePromptVersion: rolePromptVersion || env.ROLE_PROMPT_VERSION || ROLE_PROMPT_VERSION,
    roleSetVersion: rc.roleSetVersion,
  });
}

export function effectiveEvaluationPolicyFingerprint(env = process.env, opts = {}) {
  return evaluationPolicyFingerprint(effectiveEvaluationPolicy(env, opts));
}
