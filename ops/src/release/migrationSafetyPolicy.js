import { createHash } from "node:crypto";
import {
  MIGRATION_CLASSIFICATIONS,
  normalizeMigrationEvidence,
  statementsHaveAdditiveShape,
} from "../qa/migrationEvidence.js";

// Phase 14：版本化、決定性、fail-closed 的 Production DB migration safety 政策。
// AI/LLM 不得做 PASS 決策。證據不足 → UNKNOWN / BLOCKED，不得猜安全。
// 不新增第三個人工 Gate；Owner Gate #2 仍是最後的人工作業核准。
// v3：缺失/截斷/ORM/動態 SQL 不得當成 NONE；本期沒有可信 deterministic verifier，
// additive 維持 BLOCKED_UNKNOWN（不接受自填 verified=true / 任意 method）。

export const MIGRATION_SAFETY_POLICY_VERSION = "migration-safety-policy-v3";
export const ROLLBACK_PROOF_SCHEMA_VERSION = "migration-rollback-proof-v1";
export const COMPAT_PROOF_SCHEMA_VERSION = "migration-compat-proof-v1";
export const TRUSTED_PROOF_VERIFIER = null;
const ALLOWED_PROOF_METHODS = Object.freeze([]);
export { MIGRATION_CLASSIFICATIONS };

export const CLEARANCE_RESULTS = Object.freeze({
  CLEARED_NO_MIGRATION: "CLEARED_NO_MIGRATION",
  CLEARED_ADDITIVE: "CLEARED_ADDITIVE",
  BLOCKED_DATA_MIGRATION_UNPROVEN: "BLOCKED_DATA_MIGRATION_UNPROVEN",
  BLOCKED_DESTRUCTIVE: "BLOCKED_DESTRUCTIVE",
  BLOCKED_UNKNOWN: "BLOCKED_UNKNOWN",
});

export const CLEARED_CLEARANCE_RESULTS = Object.freeze([
  CLEARANCE_RESULTS.CLEARED_NO_MIGRATION,
  CLEARANCE_RESULTS.CLEARED_ADDITIVE,
]);

export function migrationSafetyConfigFromEnv(env = process.env) {
  void env;
  return {
    policyVersion: MIGRATION_SAFETY_POLICY_VERSION,
    allowDataMigrationClearance: false,
    allowDestructiveClearance: false,
    allowUnknownClearance: false,
    additiveRequiresRollbackProof: true,
    additiveRequiresOldCodeCompatProof: true,
    noLlmDecision: true,
    noThirdHumanGate: true,
    consumeExistingEvidenceOnly: true,
  };
}

export function buildMigrationSafetyPolicy(cfg = migrationSafetyConfigFromEnv()) {
  void cfg;
  return {
    policy_version: MIGRATION_SAFETY_POLICY_VERSION,
    allow_data_migration_clearance: false,
    allow_destructive_clearance: false,
    allow_unknown_clearance: false,
    additive_requires_rollback_proof: true,
    additive_requires_old_code_compat_proof: true,
    no_llm_decision: true,
    no_third_human_gate: true,
    consume_existing_evidence_only: true,
    cleared_results: [...CLEARED_CLEARANCE_RESULTS],
    required_binding: [
      "release_authorization_id",
      "release_manifest_id",
      "release_manifest_version",
      "manifest_hash",
      "coding_task_id",
      "qa_run_id",
      "staging_deployment_id",
      "head_sha",
      "artifact_digest",
    ].sort(),
    rollback_proof_schema_version: ROLLBACK_PROOF_SCHEMA_VERSION,
    compat_proof_schema_version: COMPAT_PROOF_SCHEMA_VERSION,
    trusted_proof_verifier: TRUSTED_PROOF_VERIFIER,
    allowed_proof_methods: [...ALLOWED_PROOF_METHODS],
    additive_clearance_requires_trusted_verifier: true,
  };
}

function fp(obj) {
  return createHash("sha256").update(JSON.stringify(Object.entries(obj).map(([k, v]) => `${k}:${JSON.stringify(v)}`).sort())).digest("hex");
}
export function migrationSafetyPolicyFingerprint(policy) { return fp(policy); }
export function effectiveMigrationSafetyPolicyFingerprint(env = process.env) {
  return fp(buildMigrationSafetyPolicy(migrationSafetyConfigFromEnv(env)));
}

function same(a, b) { return String(a ?? "") === String(b ?? ""); }
function sameNum(a, b) { return Number(a) === Number(b); }

export function validBoundProofShape(proof, schemaVersion) {
  if (!TRUSTED_PROOF_VERIFIER) return false;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  if (proof.schema_version !== schemaVersion) return false;
  if (proof.verified !== true) return false;
  if (!proof.bound_artifact_digest || String(proof.bound_artifact_digest) === "latest") return false;
  if (proof.bound_qa_run_id == null || Number(proof.bound_qa_run_id) <= 0) return false;
  if (proof.bound_staging_deployment_id == null || Number(proof.bound_staging_deployment_id) <= 0) return false;
  if (!ALLOWED_PROOF_METHODS.includes(String(proof.method || ""))) return false;
  if (!proof.outcome || proof.outcome.passed !== true) return false;
  if (!proof.source_record_hash || !/^[a-f0-9]{32,}$/i.test(String(proof.source_record_hash))) return false;
  if (!proof.content_hash || !/^[a-f0-9]{32,}$/i.test(String(proof.content_hash))) return false;
  if (!proof.verifier || proof.verifier !== TRUSTED_PROOF_VERIFIER) return false;
  return true;
}

export function boundProofMatches(proof, binding) {
  if (!binding) return false;
  return same(proof.bound_artifact_digest, binding.artifactDigest)
    && sameNum(proof.bound_qa_run_id, binding.qaRunId)
    && sameNum(proof.bound_staging_deployment_id, binding.stagingDeploymentId);
}

function proofProven(proof, schemaVersion, binding) {
  return validBoundProofShape(proof, schemaVersion) && boundProofMatches(proof, binding);
}

export function classifyMigration({ qaCheck = null, stagingMigration = null } = {}) {
  if (!qaCheck) {
    return { classification: MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN, reason: "database_migration_check_missing" };
  }
  if (qaCheck.evidence == null || typeof qaCheck.evidence !== "object" || Array.isArray(qaCheck.evidence)) {
    return {
      classification: MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN,
      reason: "migration_evidence_missing",
      evidence: normalizeMigrationEvidence(null),
    };
  }
  const ev = normalizeMigrationEvidence({
    ...qaCheck.evidence,
    qa_status: qaCheck.status,
    qa_finding: qaCheck.finding,
    staging_migration_status: stagingMigration?.status || null,
  });

  if (!ev.evidence_present) {
    return { classification: MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN, reason: "migration_evidence_missing", evidence: ev };
  }
  if (!ev.evidence_complete) {
    if (ev.destructive || ev.statement_counts.destructive > 0 || ev.classified_statements.some((c) => c.kind === "DESTRUCTIVE")) {
      return { classification: MIGRATION_CLASSIFICATIONS.DESTRUCTIVE_OR_IRREVERSIBLE, reason: "destructive_or_irreversible_sql", evidence: ev };
    }
    if (ev.data_rewrite || ev.statement_counts.data > 0 || ev.classified_statements.some((c) => c.kind === "DATA")) {
      return { classification: MIGRATION_CLASSIFICATIONS.DATA_MIGRATION, reason: "data_rewrite_or_backfill", evidence: ev };
    }
    return { classification: MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN, reason: "migration_evidence_incomplete_or_legacy", evidence: ev };
  }

  if (ev.destructive || ev.statement_counts.destructive > 0 || ev.classified_statements.some((c) => c.kind === "DESTRUCTIVE")) {
    return { classification: MIGRATION_CLASSIFICATIONS.DESTRUCTIVE_OR_IRREVERSIBLE, reason: "destructive_or_irreversible_sql", evidence: ev };
  }
  if (ev.data_rewrite || ev.statement_counts.data > 0 || ev.classified_statements.some((c) => c.kind === "DATA")) {
    return { classification: MIGRATION_CLASSIFICATIONS.DATA_MIGRATION, reason: "data_rewrite_or_backfill", evidence: ev };
  }
  if (ev.statement_counts.unknown > 0 || ev.classified_statements.some((c) => c.kind === "UNKNOWN") || (ev.runtime_files || []).length) {
    return { classification: MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN, reason: "unclassified_runtime_or_incompatible_ddl", evidence: ev };
  }

  const noSignal = !ev.schema && !ev.files.length && !(ev.runtime_files || []).length
    && !ev.additive_only && !ev.proven_additive
    && ev.statement_counts.additive === 0 && ev.statement_counts.data === 0
    && ev.statement_counts.destructive === 0 && ev.statement_counts.unknown === 0;
  if (ev.evidence_complete && ev.scan_complete && ev.analysis_complete && !ev.unanalyzable && noSignal) {
    return { classification: MIGRATION_CLASSIFICATIONS.NONE, reason: "complete_no_migration_scan", evidence: ev };
  }

  if (statementsHaveAdditiveShape(ev)) {
    return { classification: MIGRATION_CLASSIFICATIONS.ADDITIVE_BACKWARD_COMPATIBLE, reason: "additive_statement_shape_only", evidence: ev };
  }

  return { classification: MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN, reason: "insufficient_phase11_evidence", evidence: ev };
}

export function assessRollback(classification, ev = {}, binding = null) {
  if (classification === MIGRATION_CLASSIFICATIONS.NONE) {
    return { status: "NOT_APPLICABLE", proven: true, reason: "no_migration" };
  }
  if (classification === MIGRATION_CLASSIFICATIONS.DESTRUCTIVE_OR_IRREVERSIBLE) {
    return { status: "IRREVERSIBLE", proven: false, reason: "destructive_sql" };
  }
  if (classification === MIGRATION_CLASSIFICATIONS.DATA_MIGRATION) {
    return { status: "UNPROVEN_DATA_REWRITE", proven: false, reason: "no_versioned_data_rollback_mechanism" };
  }
  if (classification === MIGRATION_CLASSIFICATIONS.ADDITIVE_BACKWARD_COMPATIBLE) {
    const proven = proofProven(ev.rollback_proof, ROLLBACK_PROOF_SCHEMA_VERSION, binding);
    return {
      status: proven ? "BOUND_ROLLBACK_PROOF_VERIFIED" : "UNPROVEN",
      proven,
      reason: proven ? "versioned_bound_rollback_proof" : "no_trusted_rollback_verifier_this_phase",
    };
  }
  return { status: "UNPROVEN", proven: false, reason: "classification_unproven" };
}

export function assessCompatibility(classification, ev = {}, binding = null) {
  if (classification === MIGRATION_CLASSIFICATIONS.NONE) {
    return { status: "NOT_APPLICABLE", proven: true, reason: "no_migration" };
  }
  if (classification === MIGRATION_CLASSIFICATIONS.DESTRUCTIVE_OR_IRREVERSIBLE) {
    return { status: "INCOMPATIBLE", proven: false, reason: "destructive_breaks_old_or_new_code" };
  }
  if (classification === MIGRATION_CLASSIFICATIONS.DATA_MIGRATION) {
    return { status: "UNPROVEN", proven: false, reason: "data_rewrite_compat_unproven" };
  }
  if (classification === MIGRATION_CLASSIFICATIONS.ADDITIVE_BACKWARD_COMPATIBLE) {
    const proven = proofProven(ev.old_code_compat_proof, COMPAT_PROOF_SCHEMA_VERSION, binding);
    return {
      status: proven ? "BOUND_COMPAT_PROOF_VERIFIED" : "UNPROVEN",
      proven,
      reason: proven ? "versioned_bound_old_code_compat_proof" : "no_trusted_compat_verifier_this_phase",
    };
  }
  return { status: "UNPROVEN", proven: false, reason: "classification_unproven" };
}

export function decideClearance({ classification, rollback, compatibility }) {
  if (classification === MIGRATION_CLASSIFICATIONS.NONE) {
    return { clearance: CLEARANCE_RESULTS.CLEARED_NO_MIGRATION, reason: "no_migration" };
  }
  if (classification === MIGRATION_CLASSIFICATIONS.DESTRUCTIVE_OR_IRREVERSIBLE) {
    return { clearance: CLEARANCE_RESULTS.BLOCKED_DESTRUCTIVE, reason: "destructive_blocked" };
  }
  if (classification === MIGRATION_CLASSIFICATIONS.DATA_MIGRATION) {
    return { clearance: CLEARANCE_RESULTS.BLOCKED_DATA_MIGRATION_UNPROVEN, reason: "data_migration_fail_closed" };
  }
  if (classification === MIGRATION_CLASSIFICATIONS.ADDITIVE_BACKWARD_COMPATIBLE) {
    if (!TRUSTED_PROOF_VERIFIER) {
      return { clearance: CLEARANCE_RESULTS.BLOCKED_UNKNOWN, reason: "additive_blocked_no_trusted_verifier" };
    }
    if (rollback?.proven === true && compatibility?.proven === true) {
      return { clearance: CLEARANCE_RESULTS.CLEARED_ADDITIVE, reason: "additive_bound_rollback_and_compat_proven" };
    }
    return { clearance: CLEARANCE_RESULTS.BLOCKED_UNKNOWN, reason: "additive_unproven_rollback_or_compat" };
  }
  return { clearance: CLEARANCE_RESULTS.BLOCKED_UNKNOWN, reason: "unknown_or_unproven" };
}

export function evaluateMigrationSafety({ qaCheck = null, stagingMigration = null, policy = null, binding = null } = {}) {
  const pol = policy || buildMigrationSafetyPolicy();
  const classified = classifyMigration({ qaCheck, stagingMigration });
  const ev = classified.evidence || normalizeMigrationEvidence(null);
  const rollback = assessRollback(classified.classification, ev, binding);
  const compatibility = assessCompatibility(classified.classification, ev, binding);
  const decided = decideClearance({ classification: classified.classification, rollback, compatibility });
  return {
    classification: classified.classification,
    classification_reason: classified.reason,
    clearance: decided.clearance,
    clearance_reason: decided.reason,
    rollback_assessment: rollback,
    compatibility_assessment: compatibility,
    evidence: ev,
    policy_version: pol.policy_version,
  };
}

export function migrationSafetyInputFingerprint(p) {
  const parts = [
    `release_authorization_id:${p.releaseAuthorizationId}`,
    `release_manifest_id:${p.releaseManifestId}`,
    `release_manifest_version:${p.releaseManifestVersion}`,
    `manifest_hash:${p.manifestHash}`,
    `coding_task_id:${p.codingTaskId}`,
    `qa_run_id:${p.qaRunId}`,
    `staging_deployment_id:${p.stagingDeploymentId}`,
    `head_sha:${p.headSha}`,
    `artifact_digest:${p.artifactDigest}`,
    `authorization_hash:${p.authorizationHash ?? ""}`,
    `qa_input_fp:${p.qaInputFp ?? ""}`,
    `staging_input_fp:${p.stagingInputFp ?? ""}`,
    `release_input_fp:${p.releaseInputFp ?? ""}`,
    `evidence_fp:${p.evidenceFingerprint}`,
    `policy_version:${p.policyVersion}`,
    `policy_fp:${p.policyFingerprint}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function evidenceFingerprint(snapshot) {
  return createHash("sha256").update(JSON.stringify(canonical(snapshot))).digest("hex");
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.keys(v).sort().reduce((o, k) => { o[k] = canonical(v[k]); return o; }, {});
  return v;
}
