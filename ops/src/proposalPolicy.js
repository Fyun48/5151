import { createHash } from "node:crypto";
import { PROPOSAL_SCHEMA_VERSION } from "./proposalSchema.js";
import { PROPOSAL_PROMPT_VERSION } from "./proposalPrompt.js";
import { makeProposalProvider } from "./ai/proposalProvider.js";

// Phase 8 提案政策/設定 provenance：只要「會影響提案結果」的設定變了（schema/template 版本、prompt 版本、
// provider/model/model_version），舊提案就必須對「新的審批」變 stale。快照一律不含機密（金鑰/密碼/URL）。

export const PROPOSAL_GENERATION_VERSION = "proposal-gen-v1";

export function buildProposalPolicy({ provider = null, schemaVersion = PROPOSAL_SCHEMA_VERSION, promptVersion = PROPOSAL_PROMPT_VERSION, generationVersion = PROPOSAL_GENERATION_VERSION } = {}) {
  return {
    generation_version: generationVersion,
    schema_version: schemaVersion,
    prompt_version: promptVersion,
    provider: provider?.name || "none",
    model: provider?.model ?? null,
    model_version: provider?.model_version ?? null,
  };
}

export function proposalPolicyFingerprint(policy) {
  const lines = [
    `generation_version=${policy.generation_version}`,
    `schema_version=${policy.schema_version}`,
    `prompt_version=${policy.prompt_version}`,
    `provider=${policy.provider}`,
    `model=${policy.model ?? ""}`,
    `model_version=${policy.model_version ?? ""}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(lines)).digest("hex");
}

// 目前「有效」提案政策：預設從 env 推導；可用參數覆寫以保持與實際執行一致（worker / tests）。
export function effectiveProposalPolicy(env = process.env, { provider, schemaVersion, promptVersion, generationVersion } = {}) {
  return buildProposalPolicy({
    provider: provider || makeProposalProvider(env),
    schemaVersion: schemaVersion || env.PROPOSAL_SCHEMA_VERSION || PROPOSAL_SCHEMA_VERSION,
    promptVersion: promptVersion || env.PROPOSAL_PROMPT_VERSION || PROPOSAL_PROMPT_VERSION,
    generationVersion: generationVersion || env.PROPOSAL_GENERATION_VERSION || PROPOSAL_GENERATION_VERSION,
  });
}

export function effectiveProposalPolicyFingerprint(env = process.env, opts = {}) {
  return proposalPolicyFingerprint(effectiveProposalPolicy(env, opts));
}
