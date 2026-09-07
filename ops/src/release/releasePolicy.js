import { createHash } from "node:crypto";

// Phase 13 Release 政策：版本化、決定性、sanitized（無密鑰）。所有影響結果的設定進 fingerprint。
export const RELEASE_MANIFEST_VERSION = "release-manifest-v1";
export const RELEASE_POLICY_VERSION = "release-policy-v1";
export const GATE2_POLICY_VERSION = "gate2-v1";

export function releaseConfigFromEnv(env = process.env) {
  return {
    enabled: env.RELEASE_WORKER_ENABLED !== "0",
    concurrency: Math.max(1, Number(env.RELEASE_CONCURRENCY) || 1),
    intervalMs: Math.max(2000, Number(env.RELEASE_WORKER_INTERVAL_MS) || 30000),
    manifestVersion: RELEASE_MANIFEST_VERSION,
    policyVersion: RELEASE_POLICY_VERSION,
    gate2PolicyVersion: GATE2_POLICY_VERSION,
    requiredQaResult: "PASS",
    requiredStagingResult: "PASS",
    // MVP：來源基準漂移一律 fail-closed（沒有已驗證的整合快照機制）。
    sourceBaseDriftPolicy: env.RELEASE_ALLOW_BASE_DRIFT === "1" ? "allow" : "fail_closed",
    baseBranch: env.CODING_BASE_BRANCH || "master",
  };
}

export function buildReleasePolicy(cfg = releaseConfigFromEnv()) {
  return {
    manifest_version: cfg.manifestVersion,
    policy_version: cfg.policyVersion,
    gate2_policy_version: cfg.gate2PolicyVersion,
    required_qa_result: cfg.requiredQaResult,
    required_staging_result: cfg.requiredStagingResult,
    source_base_drift_policy: cfg.sourceBaseDriftPolicy,
    required_evidence: ["coding_task", "development_authorization", "proposal", "qa_pass", "staging_pass", "artifact_digest"].sort(),
  };
}
function fp(obj) { return createHash("sha256").update(JSON.stringify(Object.entries(obj).map(([k, v]) => `${k}:${JSON.stringify(v)}`).sort())).digest("hex"); }
export function releasePolicyFingerprint(policy) { return fp(policy); }
export function effectiveReleasePolicyFingerprint(env = process.env) { return fp(buildReleasePolicy(releaseConfigFromEnv(env))); }
