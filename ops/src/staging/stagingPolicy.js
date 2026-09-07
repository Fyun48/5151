import { createHash } from "node:crypto";

// Phase 12 Staging 政策 + sanitized 設定清單（configuration manifest）。所有「影響結果」設定進 fingerprint；不含密鑰。
export const STAGING_POLICY_VERSION = "staging-v1";
export const STAGING_ISOLATION_POLICY_VERSION = "staging-iso-v1";
export const STAGING_BUILD_STRATEGY = "immutable-artifact-v1";

export function stagingConfigFromEnv(env = process.env) {
  return {
    enabled: env.STAGING_WORKER_ENABLED !== "0",
    concurrency: Math.max(1, Number(env.STAGING_CONCURRENCY) || 1),
    claimStaleMs: Math.max(60000, Number(env.STAGING_CLAIM_STALE_MS) || 15 * 60 * 1000),
    maxAttempts: Math.max(1, Number(env.STAGING_MAX_ATTEMPTS) || 3),
    intervalMs: Math.max(2000, Number(env.STAGING_WORKER_INTERVAL_MS) || 30000),
    ttlMs: Math.max(0, Number(env.STAGING_TTL_MS) || 24 * 60 * 60 * 1000),
    requiredHealthChecks: ["process_up", "http_health"],
    requiredSmokeChecks: ["app_responds"],
    policyVersion: STAGING_POLICY_VERSION,
    isolationPolicyVersion: STAGING_ISOLATION_POLICY_VERSION,
    buildStrategy: STAGING_BUILD_STRATEGY,
    provider: env.STAGING_PROVIDER || "none",
  };
}

// sanitized Staging 環境設定清單（不含任何密鑰/連線字串；只有 class/mode/reference 類別）。
export function stagingEnvironmentConfig(env = process.env) {
  return {
    environment_class: (env.STAGING_ENV_CLASS || "staging").toLowerCase(),
    environment_id: env.STAGING_ENV_ID || "staging-ephemeral",
    db_class: env.STAGING_DB_CLASS || null,           // e.g. staging|disposable|isolated（非連線字串）
    db_ref: env.STAGING_DB_REF || null,               // sanitized 參照，不含帳密
    db_required: env.STAGING_DB_REQUIRED !== "0",
    storage_mode: env.STAGING_STORAGE_MODE || "isolated",
    integration_mode: env.STAGING_INTEGRATION_MODE || "sandbox", // sandbox|disabled|mock|test|live
    migration_mode: env.STAGING_MIGRATION_MODE || "isolated",
    runtime_version: env.STAGING_RUNTIME || `node-${process.version}`,
    app_mode: env.STAGING_APP_MODE || "staging",
    feature_flags: env.STAGING_FEATURE_FLAGS || "",
  };
}

export function buildStagingPolicy(cfg = stagingConfigFromEnv()) {
  return {
    policy_version: cfg.policyVersion,
    isolation_policy_version: cfg.isolationPolicyVersion,
    build_strategy: cfg.buildStrategy,
    provider: cfg.provider,
    required_health_checks: [...cfg.requiredHealthChecks].sort(),
    required_smoke_checks: [...cfg.requiredSmokeChecks].sort(),
    ttl_ms: cfg.ttlMs,
  };
}
function fp(obj) {
  const parts = Object.entries(obj).map(([k, v]) => `${k}:${JSON.stringify(v)}`).sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
export function stagingPolicyFingerprint(policy) { return fp(policy); }
export function effectiveStagingPolicyFingerprint(env = process.env) { return fp(buildStagingPolicy(stagingConfigFromEnv(env))); }

// 只把「影響結果」的非密鑰設定納入 config fingerprint。
export function configFingerprint(cfg) {
  const { db_required, ...rest } = cfg;
  return fp(rest);
}
