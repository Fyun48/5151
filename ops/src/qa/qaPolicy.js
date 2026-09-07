import { createHash } from "node:crypto";
import { CODING_PATH_POLICY_VERSION } from "../coding/pathPolicy.js";

// Phase 11 QA 政策：版本化、決定性、可設定。所有「影響結果」的設定都要進 fingerprint。
export const QA_VERSION = "qa-v1";
export const QA_AGGREGATION_VERSION = "qa-agg-v1";

export const FINAL_RESULTS = ["PASS", "FAIL", "REVIEW_REQUIRED"];
export const CHECK_STATUS = ["PASS", "FAIL", "WARN", "REVIEW", "SKIPPED"];
export const SEVERITY = ["none", "low", "medium", "high", "blocking"];
export const CAUTION_ORDER = { PASS: 0, REVIEW_REQUIRED: 1, FAIL: 2 };

// 必要檢核集合（決定性檢核）。AI 審查為 optional，永遠不在此集合。
export const REQUIRED_CHECKS = [
  "AUTHORIZATION_PROVENANCE", "GIT_DIFF", "APPROVED_SCOPE", "PROTECTED_PATH",
  "SECRET_SCAN", "SECURITY_STATIC", "DEPLOYMENT_SAFETY",
  "TESTS", "BUILD", "LINT", "TYPECHECK",
  "DEPENDENCY_CHANGE", "DATABASE_MIGRATION", "CONFIG_CHANGE",
  "GENERATED_BINARY", "CHANGE_SIZE",
];

export function qaConfigFromEnv(env = process.env) {
  return {
    qaVersion: QA_VERSION,
    aggregationVersion: QA_AGGREGATION_VERSION,
    pathPolicyVersion: CODING_PATH_POLICY_VERSION,
    requiredChecks: REQUIRED_CHECKS,
    maxChangedFiles: Math.max(1, Number(env.QA_MAX_CHANGED_FILES) || 50),
    maxDiffLines: Math.max(1, Number(env.QA_MAX_DIFF_LINES) || 2000),
    // 「blocking」嚴重度即擋 PASS；high 以上的 WARN → REVIEW_REQUIRED。
    reviewSeverityThreshold: env.QA_REVIEW_SEVERITY || "high",
    reviewerEnabled: env.QA_REVIEWER === "1" || env.QA_REVIEWER === "on",
    reviewerProvider: env.QA_REVIEW_PROVIDER || null,
    reviewerModel: env.QA_REVIEW_MODEL || null,
    reviewerPromptVersion: env.QA_REVIEW_PROMPT_VERSION || "qa-review-prompt-v1",
    commandTimeoutMs: Math.max(1000, Number(env.QA_COMMAND_TIMEOUT_MS) || 5 * 60 * 1000),
    baseBranch: env.CODING_BASE_BRANCH || "master",
  };
}

// 決定性 QA 政策 fingerprint（sanitized；不含 token/密碼）。
export function buildQaPolicy(cfg = qaConfigFromEnv()) {
  return {
    qa_version: cfg.qaVersion,
    aggregation_version: cfg.aggregationVersion,
    path_policy_version: cfg.pathPolicyVersion,
    required_checks: [...cfg.requiredChecks].sort(),
    max_changed_files: cfg.maxChangedFiles,
    max_diff_lines: cfg.maxDiffLines,
    review_severity_threshold: cfg.reviewSeverityThreshold,
    reviewer_enabled: !!cfg.reviewerEnabled,
    reviewer_provider: cfg.reviewerEnabled ? (cfg.reviewerProvider || "") : "",
    reviewer_model: cfg.reviewerEnabled ? (cfg.reviewerModel || "") : "",
    reviewer_prompt_version: cfg.reviewerEnabled ? cfg.reviewerPromptVersion : "",
  };
}

export function qaPolicyFingerprint(policy) {
  const parts = Object.entries(policy).map(([k, v]) => `${k}:${JSON.stringify(v)}`).sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function effectiveQaPolicyFingerprint(env = process.env) {
  return qaPolicyFingerprint(buildQaPolicy(qaConfigFromEnv(env)));
}
