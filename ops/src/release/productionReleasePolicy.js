import { createHash } from "node:crypto";
import { MIGRATION_CLASSIFICATIONS } from "../qa/migrationEvidence.js";
import { CLEARED_CLEARANCE_RESULTS } from "./migrationSafetyPolicy.js";

// Phase 15：版本化、決定性、fail-closed 的 Production release / code-rollback 政策。
// AI/LLM 不得核准 release、migration 或 rollback，也不得判 PASS。
// 不新增第三個人工作業 Gate；只消費 Owner Gate #2 已建立的 exact authorization。
// Production workflow 維持 manual-only；Ops 不持 Production secrets、不直接 SSH。

export const PRODUCTION_RELEASE_POLICY_VERSION = "production-release-policy-v1";
export const PRODUCTION_RELEASE_PROVIDER_VERSION = "production-release-provider-v1";

export const PRODUCTION_WORKFLOWS = Object.freeze({
  BUILD: ".github/workflows/build-production-image.yml",
  PREDEPLOY: ".github/workflows/production-predeploy-check.yml",
  DEPLOY: ".github/workflows/deploy-v3.yml",
});

export const REQUIRED_WORKFLOW_REF = "refs/heads/master";
export const REQUIRED_TARGET_ENVIRONMENT = "production";
export const REQUIRED_OCI_SOURCE = "https://github.com/Fyun48/5151";
export const REQUIRED_BASE_BRANCH = "master";

export const RELEASE_STATUSES = Object.freeze({
  CREATED: "CREATED",
  ELIGIBILITY_VERIFIED: "ELIGIBILITY_VERIFIED",
  MERGED: "MERGED",
  BUILD_DISPATCHED: "BUILD_DISPATCHED",
  BUILD_RECONCILED: "BUILD_RECONCILED",
  PREDEPLOY_DISPATCHED: "PREDEPLOY_DISPATCHED",
  PREDEPLOY_RECONCILED: "PREDEPLOY_RECONCILED",
  DEPLOY_DISPATCHED: "DEPLOY_DISPATCHED",
  DEPLOY_RECONCILED: "DEPLOY_RECONCILED",
  HEALTH_VERIFIED: "HEALTH_VERIFIED",
  SUCCEEDED: "SUCCEEDED",
  HEALTH_FAILED: "HEALTH_FAILED",
  CODE_ROLLBACK_DISPATCHED: "CODE_ROLLBACK_DISPATCHED",
  CODE_ROLLBACK_RECONCILED: "CODE_ROLLBACK_RECONCILED",
  ROLLED_BACK: "ROLLED_BACK",
  DB_ROLLBACK_MANUAL_REQUIRED: "DB_ROLLBACK_MANUAL_REQUIRED",
  BLOCKED: "BLOCKED",
  PRODUCTION_STATE_UNKNOWN: "PRODUCTION_STATE_UNKNOWN",
});

export const WORKFLOW_KINDS = Object.freeze({
  BUILD: "build",
  PREDEPLOY: "predeploy",
  DEPLOY: "deploy",
  ROLLBACK: "rollback",
});

export const BINDING_STATUSES = Object.freeze({
  RESERVED: "reserved",
  CLAIMED: "claimed",
  DISPATCHED: "dispatched",
  RECONCILED: "reconciled",
  UNKNOWN: "unknown",
});

export const TERMINAL_RELEASE_STATUSES = Object.freeze([
  RELEASE_STATUSES.SUCCEEDED,
  RELEASE_STATUSES.ROLLED_BACK,
  RELEASE_STATUSES.BLOCKED,
]);

// UNKNOWN freezes Production mutations / redispatches but is not reconcile-terminal.
export const FROZEN_RELEASE_STATUSES = Object.freeze([
  RELEASE_STATUSES.PRODUCTION_STATE_UNKNOWN,
]);

export const HAPPY_PATH_STATUSES = Object.freeze([
  RELEASE_STATUSES.CREATED,
  RELEASE_STATUSES.ELIGIBILITY_VERIFIED,
  RELEASE_STATUSES.MERGED,
  RELEASE_STATUSES.BUILD_DISPATCHED,
  RELEASE_STATUSES.BUILD_RECONCILED,
  RELEASE_STATUSES.PREDEPLOY_DISPATCHED,
  RELEASE_STATUSES.PREDEPLOY_RECONCILED,
  RELEASE_STATUSES.DEPLOY_DISPATCHED,
  RELEASE_STATUSES.DEPLOY_RECONCILED,
  RELEASE_STATUSES.HEALTH_VERIFIED,
  RELEASE_STATUSES.SUCCEEDED,
]);

export const ROLLBACK_PATH_STATUSES = Object.freeze([
  RELEASE_STATUSES.HEALTH_FAILED,
  RELEASE_STATUSES.CODE_ROLLBACK_DISPATCHED,
  RELEASE_STATUSES.CODE_ROLLBACK_RECONCILED,
  RELEASE_STATUSES.ROLLED_BACK,
]);

export const ALLOWED_RELEASE_TRANSITIONS = Object.freeze({
  "": [RELEASE_STATUSES.CREATED],
  [RELEASE_STATUSES.CREATED]: [RELEASE_STATUSES.ELIGIBILITY_VERIFIED, RELEASE_STATUSES.BLOCKED],
  [RELEASE_STATUSES.ELIGIBILITY_VERIFIED]: [RELEASE_STATUSES.MERGED, RELEASE_STATUSES.BUILD_DISPATCHED, RELEASE_STATUSES.BLOCKED],
  [RELEASE_STATUSES.MERGED]: [RELEASE_STATUSES.BUILD_DISPATCHED, RELEASE_STATUSES.BLOCKED],
  [RELEASE_STATUSES.BUILD_DISPATCHED]: [RELEASE_STATUSES.BUILD_RECONCILED, RELEASE_STATUSES.BLOCKED],
  [RELEASE_STATUSES.BUILD_RECONCILED]: [RELEASE_STATUSES.PREDEPLOY_DISPATCHED, RELEASE_STATUSES.BLOCKED],
  [RELEASE_STATUSES.PREDEPLOY_DISPATCHED]: [RELEASE_STATUSES.PREDEPLOY_RECONCILED, RELEASE_STATUSES.BLOCKED],
  [RELEASE_STATUSES.PREDEPLOY_RECONCILED]: [RELEASE_STATUSES.DEPLOY_DISPATCHED, RELEASE_STATUSES.BLOCKED],
  [RELEASE_STATUSES.DEPLOY_DISPATCHED]: [RELEASE_STATUSES.DEPLOY_RECONCILED, RELEASE_STATUSES.BLOCKED, RELEASE_STATUSES.PRODUCTION_STATE_UNKNOWN],
  [RELEASE_STATUSES.DEPLOY_RECONCILED]: [RELEASE_STATUSES.HEALTH_VERIFIED, RELEASE_STATUSES.HEALTH_FAILED, RELEASE_STATUSES.BLOCKED, RELEASE_STATUSES.PRODUCTION_STATE_UNKNOWN],
  [RELEASE_STATUSES.HEALTH_VERIFIED]: [RELEASE_STATUSES.SUCCEEDED, RELEASE_STATUSES.BLOCKED, RELEASE_STATUSES.PRODUCTION_STATE_UNKNOWN],
  [RELEASE_STATUSES.SUCCEEDED]: [],
  [RELEASE_STATUSES.HEALTH_FAILED]: [RELEASE_STATUSES.CODE_ROLLBACK_DISPATCHED, RELEASE_STATUSES.BLOCKED, RELEASE_STATUSES.PRODUCTION_STATE_UNKNOWN],
  [RELEASE_STATUSES.CODE_ROLLBACK_DISPATCHED]: [RELEASE_STATUSES.CODE_ROLLBACK_RECONCILED, RELEASE_STATUSES.BLOCKED, RELEASE_STATUSES.PRODUCTION_STATE_UNKNOWN],
  [RELEASE_STATUSES.CODE_ROLLBACK_RECONCILED]: [RELEASE_STATUSES.ROLLED_BACK, RELEASE_STATUSES.BLOCKED, RELEASE_STATUSES.PRODUCTION_STATE_UNKNOWN],
  [RELEASE_STATUSES.ROLLED_BACK]: [],
  [RELEASE_STATUSES.DB_ROLLBACK_MANUAL_REQUIRED]: [],
  [RELEASE_STATUSES.BLOCKED]: [],
  [RELEASE_STATUSES.PRODUCTION_STATE_UNKNOWN]: [
    RELEASE_STATUSES.DEPLOY_RECONCILED,
    RELEASE_STATUSES.CODE_ROLLBACK_RECONCILED,
    RELEASE_STATUSES.BLOCKED,
  ],
});

export const DB_ROLLBACK_DISPOSITIONS = Object.freeze({
  NONE: "NONE",
  NO_DB_ROLLBACK: "NO_DB_ROLLBACK",
  MANUAL_REQUIRED: "MANUAL_REQUIRED",
  BLOCKED: "BLOCKED",
});

export const SUCCESS_CONCLUSIONS = Object.freeze(["success"]);
export const NON_SUCCESS_CONCLUSIONS = Object.freeze([
  "failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", "stale", "",
]);
export const NON_TERMINAL_RUN_STATUSES = Object.freeze([
  "queued", "in_progress", "pending", "waiting", "requested", "waiting_for_review",
]);

export function productionReleaseConfigFromEnv(env = process.env) {
  void env;
  return {
    policyVersion: PRODUCTION_RELEASE_POLICY_VERSION,
    providerVersion: PRODUCTION_RELEASE_PROVIDER_VERSION,
    requiredWorkflowRef: REQUIRED_WORKFLOW_REF,
    requiredTargetEnvironment: REQUIRED_TARGET_ENVIRONMENT,
    requiredOciSource: REQUIRED_OCI_SOURCE,
    requiredBaseBranch: REQUIRED_BASE_BRANCH,
    workflows: { ...PRODUCTION_WORKFLOWS },
    noLlmDecision: true,
    noThirdHumanGate: true,
    noAutoProductionDispatch: true,
    noDirectSsh: true,
    noAutoDbRestore: true,
    mergePushDoesNotDeploy: true,
    consumeExactAuthorizationOnly: true,
    providerApiSuccessIsNotDeploySuccess: true,
  };
}

export function buildProductionReleasePolicy(cfg = productionReleaseConfigFromEnv()) {
  void cfg;
  return {
    policy_version: PRODUCTION_RELEASE_POLICY_VERSION,
    provider_version: PRODUCTION_RELEASE_PROVIDER_VERSION,
    required_workflow_ref: REQUIRED_WORKFLOW_REF,
    required_target_environment: REQUIRED_TARGET_ENVIRONMENT,
    required_oci_source: REQUIRED_OCI_SOURCE,
    required_base_branch: REQUIRED_BASE_BRANCH,
    workflows: { ...PRODUCTION_WORKFLOWS },
    no_llm_decision: true,
    no_third_human_gate: true,
    no_auto_production_dispatch: true,
    no_direct_ssh: true,
    no_auto_db_restore: true,
    merge_push_does_not_deploy: true,
    consume_exact_authorization_only: true,
    provider_api_success_is_not_deploy_success: true,
    success_conclusions: [...SUCCESS_CONCLUSIONS],
    cleared_clearance_results: [...CLEARED_CLEARANCE_RESULTS],
    required_identities: [
      "coding_task_id",
      "release_authorization_id",
      "release_authorization_hash",
      "manifest_id",
      "manifest_version",
      "manifest_hash",
      "migration_safety_assessment_id",
      "migration_safety_policy_fingerprint",
      "migration_safety_input_fingerprint",
      "clearance_result",
      "qa_run_id",
      "staging_deployment_id",
      "head_sha",
      "artifact_digest",
      "target_environment",
      "workflow_ref",
      "authorized_github_actor",
    ].sort(),
  };
}

function fp(obj) {
  return createHash("sha256").update(JSON.stringify(Object.entries(obj).map(([k, v]) => `${k}:${JSON.stringify(v)}`).sort())).digest("hex");
}
export function productionReleasePolicyFingerprint(policy) { return fp(policy); }
export function effectiveProductionReleasePolicyFingerprint(env = process.env) {
  return fp(buildProductionReleasePolicy(productionReleaseConfigFromEnv(env)));
}

export function productionReleaseInputFingerprint(p) {
  const parts = [
    `coding_task_id:${p.codingTaskId}`,
    `release_authorization_id:${p.releaseAuthorizationId}`,
    `release_authorization_hash:${p.releaseAuthorizationHash}`,
    `manifest_id:${p.manifestId}`,
    `manifest_version:${p.manifestVersion}`,
    `manifest_hash:${p.manifestHash}`,
    `migration_safety_assessment_id:${p.migrationSafetyAssessmentId}`,
    `migration_safety_policy_fp:${p.migrationSafetyPolicyFingerprint}`,
    `migration_safety_input_fp:${p.migrationSafetyInputFingerprint}`,
    `clearance_result:${p.clearanceResult}`,
    `qa_run_id:${p.qaRunId}`,
    `staging_deployment_id:${p.stagingDeploymentId}`,
    `head_sha:${p.headSha}`,
    `artifact_digest:${p.artifactDigest}`,
    `target_environment:${p.targetEnvironment}`,
    `workflow_ref:${p.workflowRef}`,
    `policy_fp:${p.policyFingerprint}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function workflowIdempotencyKey({
  releaseAuthorizationId, targetEnvironment = REQUIRED_TARGET_ENVIRONMENT, workflowKind, releaseRunId, inputFingerprint,
}) {
  if (releaseAuthorizationId != null) {
    return createHash("sha256").update(`phase15-auth:${releaseAuthorizationId}:${targetEnvironment}:${workflowKind}`).digest("hex");
  }
  return createHash("sha256").update(`phase15:${releaseRunId}:${workflowKind}:${inputFingerprint}`).digest("hex");
}

export function isSuccessfulConclusion(conclusion, runStatus) {
  if (String(runStatus || "") !== "completed") return false;
  return SUCCESS_CONCLUSIONS.includes(String(conclusion || ""));
}

export function isNonTerminalWorkflowStatus(runStatus) {
  return NON_TERMINAL_RUN_STATUSES.includes(String(runStatus || ""));
}

export const AUTHORIZED_GITHUB_ACTOR = "Fyun48";

export function isAuthorizedGithubActor(login) {
  return String(login || "") === AUTHORIZED_GITHUB_ACTOR;
}

export function authorizedGithubActorFromEnv(env = process.env) {
  const fromEnv = String(env.PRODUCTION_RELEASE_GITHUB_ACTOR || "").trim();
  if (fromEnv && isAuthorizedGithubActor(fromEnv)) return fromEnv;
  return AUTHORIZED_GITHUB_ACTOR;
}

export function stableProvenanceFingerprint(provenance) {
  const p = provenance && typeof provenance === "object" ? provenance : {};
  const parts = Object.entries(p).map(([k, v]) => `${k}:${JSON.stringify(v)}`).sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function isTerminalReleaseStatus(status) {
  return TERMINAL_RELEASE_STATUSES.includes(String(status || ""));
}

export function isFrozenReleaseStatus(status) {
  return FROZEN_RELEASE_STATUSES.includes(String(status || ""));
}

export function isAllowedReleaseTransition(fromStatus, toStatus) {
  const from = fromStatus == null || fromStatus === "" ? "" : String(fromStatus);
  const allowed = ALLOWED_RELEASE_TRANSITIONS[from] || [];
  return allowed.includes(String(toStatus));
}

function missing(v) {
  return v == null || v === "";
}

export function validateExactWorkflowEvidence(wf, expected = {}) {
  const problems = [];
  if (!wf || missing(wf.id)) problems.push("id");
  else if (expected.workflow_run_id != null && String(wf.id) !== String(expected.workflow_run_id)) problems.push("id_mismatch");
  if (wf?.attempt == null || wf.attempt === "" || !Number.isInteger(Number(wf.attempt)) || Number(wf.attempt) < 1) {
    problems.push("attempt");
  } else if (expected.attempt != null && Number(wf.attempt) !== Number(expected.attempt)) {
    problems.push("attempt_mismatch");
  }
  if (missing(wf?.status)) problems.push("status");
  else if (String(wf.status) !== "completed") problems.push("status_mismatch");
  if (missing(wf?.conclusion)) problems.push("conclusion");
  else if (!SUCCESS_CONCLUSIONS.includes(String(wf.conclusion))) problems.push("conclusion_mismatch");
  if (missing(wf?.workflow_file)) problems.push("workflow_file");
  else if (expected.workflow_file && wf.workflow_file !== expected.workflow_file) problems.push("workflow_file_mismatch");
  if (missing(wf?.workflow_ref)) problems.push("workflow_ref");
  else if (expected.workflow_ref && wf.workflow_ref !== expected.workflow_ref) problems.push("workflow_ref_mismatch");
  const outputs = wf?.outputs || {};
  if (missing(wf?.head_sha)) problems.push("head_sha");
  else if (expected.head_sha) {
    const observedSha = outputs.source_sha || wf.head_sha;
    if (String(observedSha) !== String(expected.head_sha)) problems.push("head_sha_mismatch");
  }
  if (missing(wf?.actor)) problems.push("actor");
  else if (expected.actor && String(wf.actor) !== String(expected.actor)) problems.push("actor_mismatch");
  if (missing(wf?.triggering_actor)) problems.push("triggering_actor");
  else if (expected.triggering_actor && String(wf.triggering_actor) !== String(expected.triggering_actor)) {
    problems.push("triggering_actor_mismatch");
  }
  if (expected.environment) {
    if (missing(wf?.environment)) problems.push("environment");
    else if (String(wf.environment) !== String(expected.environment)) problems.push("environment_mismatch");
  } else if (!missing(wf?.environment)) {
    problems.push("environment_mismatch");
  }
  if (expected.image_digest) {
    if (missing(outputs.image_digest)) problems.push("image_digest");
    else if (String(outputs.image_digest) !== String(expected.image_digest)) problems.push("image_digest_mismatch");
  }
  if (expected.oci_revision) {
    if (missing(outputs.oci_revision)) problems.push("oci_revision");
    else if (String(outputs.oci_revision) !== String(expected.oci_revision)) problems.push("oci_revision_mismatch");
  }
  if (expected.oci_source) {
    if (missing(outputs.oci_source)) problems.push("oci_source");
    else if (String(outputs.oci_source).toLowerCase() !== String(expected.oci_source).toLowerCase()) problems.push("oci_source_mismatch");
  }
  return { ok: problems.length === 0, problems };
}

export function classifyWorkflowRun(wf, expected = {}) {
  if (!wf || missing(wf.id)) return { kind: "unbound", problems: ["id"] };
  const status = String(wf.status || "");
  if (isNonTerminalWorkflowStatus(status)) return { kind: "waiting", problems: [] };
  if (!status) return { kind: "unbound", problems: ["status"] };
  if (status !== "completed") return { kind: "waiting", problems: [] };
  if (!SUCCESS_CONCLUSIONS.includes(String(wf.conclusion || ""))) {
    return { kind: "failed", problems: ["conclusion"], conclusion: wf.conclusion, status };
  }
  const exact = validateExactWorkflowEvidence(wf, expected);
  if (!exact.ok) return { kind: "unbound", problems: exact.problems };
  return { kind: "success", problems: [] };
}

export function decideDbRollbackDisposition(classification) {
  if (classification === MIGRATION_CLASSIFICATIONS.NONE) {
    return { disposition: DB_ROLLBACK_DISPOSITIONS.NO_DB_ROLLBACK, auto_restore: false, reason: "no_migration" };
  }
  if ([
    MIGRATION_CLASSIFICATIONS.ADDITIVE_BACKWARD_COMPATIBLE,
    MIGRATION_CLASSIFICATIONS.DATA_MIGRATION,
    MIGRATION_CLASSIFICATIONS.DESTRUCTIVE_OR_IRREVERSIBLE,
    MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN,
  ].includes(classification)) {
    return {
      disposition: DB_ROLLBACK_DISPOSITIONS.MANUAL_REQUIRED,
      auto_restore: false,
      reason: "no_trusted_exact_db_rollback_plan",
    };
  }
  return { disposition: DB_ROLLBACK_DISPOSITIONS.BLOCKED, auto_restore: false, reason: "unknown_classification" };
}

export function previousStableComplete(prev) {
  if (!prev) return false;
  const sha = String(prev.source_sha || prev.previous_stable_sha || "");
  const digest = String(prev.artifact_digest || prev.previous_stable_digest || "");
  const runId = String(prev.workflow_run_id || prev.previous_stable_workflow_run_id || "");
  if (!/^[a-f0-9]{40}$/i.test(sha)) return false;
  if (!digestLooksImmutable(digest)) return false;
  if (!runId || runId === "latest") return false;
  const provenance = prev.provenance || prev.previous_stable_provenance;
  if (provenance == null || provenance === "") return false;
  return true;
}

export function digestLooksImmutable(digest) {
  const d = String(digest || "");
  if (!d || d === "latest" || /:latest$/.test(d)) return false;
  return /^sha256:[a-f0-9]{64}$/.test(d);
}
