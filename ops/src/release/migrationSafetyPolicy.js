import { createHash } from "node:crypto";
import {
  ADDITIVE_SQL_KINDS,
  MIGRATION_CLASSIFICATIONS,
  normalizeMigrationEvidence,
} from "../qa/migrationEvidence.js";

// Phase 14：版本化、決定性、fail-closed 的 Production DB migration safety 政策。
// AI/LLM 不得做 PASS 決策。證據不足 → UNKNOWN / BLOCKED，不得猜安全。
// 不新增第三個人工 Gate；Owner Gate #2 仍是最後的人工作業核准。

export const MIGRATION_SAFETY_POLICY_VERSION = "migration-safety-policy-v1";
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

const ADDITIVE_KIND_SET = new Set(ADDITIVE_SQL_KINDS);

export function migrationSafetyConfigFromEnv(env = process.env) {
  return {
    policyVersion: env.MIGRATION_SAFETY_POLICY_VERSION || MIGRATION_SAFETY_POLICY_VERSION,
    // 沒有版本化、可驗證的 data-migration/rollback 機制 → 一律 fail-closed。
    allowDataMigrationClearance: false,
    allowDestructiveClearance: false,
    allowUnknownClearance: false,
    additiveRequiresRollbackProof: env.MIGRATION_SAFETY_ADDITIVE_SKIP_ROLLBACK === "1" ? false : true,
    additiveRequiresOldCodeCompatProof: env.MIGRATION_SAFETY_ADDITIVE_SKIP_COMPAT === "1" ? false : true,
    noLlmDecision: true,
    noThirdHumanGate: true,
    consumeExistingEvidenceOnly: true,
  };
}

export function buildMigrationSafetyPolicy(cfg = migrationSafetyConfigFromEnv()) {
  return {
    policy_version: cfg.policyVersion,
    allow_data_migration_clearance: !!cfg.allowDataMigrationClearance,
    allow_destructive_clearance: !!cfg.allowDestructiveClearance,
    allow_unknown_clearance: !!cfg.allowUnknownClearance,
    additive_requires_rollback_proof: cfg.additiveRequiresRollbackProof !== false,
    additive_requires_old_code_compat_proof: cfg.additiveRequiresOldCodeCompatProof !== false,
    no_llm_decision: cfg.noLlmDecision !== false,
    no_third_human_gate: cfg.noThirdHumanGate !== false,
    consume_existing_evidence_only: cfg.consumeExistingEvidenceOnly !== false,
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
  };
}

function fp(obj) {
  return createHash("sha256").update(JSON.stringify(Object.entries(obj).map(([k, v]) => `${k}:${JSON.stringify(v)}`).sort())).digest("hex");
}
export function migrationSafetyPolicyFingerprint(policy) { return fp(policy); }
export function effectiveMigrationSafetyPolicyFingerprint(env = process.env) {
  return fp(buildMigrationSafetyPolicy(migrationSafetyConfigFromEnv(env)));
}

function statementsProveAdditive(ev) {
  const stmts = ev.classified_statements || [];
  if (!stmts.length) return false;
  return stmts.every((c) => c.kind === "ADDITIVE" && ADDITIVE_KIND_SET.has(c.sql_kind))
    && ev.statement_counts.destructive === 0
    && ev.statement_counts.data === 0
    && ev.statement_counts.unknown === 0
    && ev.statement_counts.additive > 0;
}

export function classifyMigration({ qaCheck = null, stagingMigration = null } = {}) {
  if (!qaCheck) {
    return { classification: MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN, reason: "database_migration_check_missing" };
  }
  const ev = normalizeMigrationEvidence({
    ...(qaCheck.evidence && typeof qaCheck.evidence === "object" ? qaCheck.evidence : {}),
    qa_status: qaCheck.status,
    qa_finding: qaCheck.finding,
    staging_migration_status: stagingMigration?.status || null,
    evidence_present: true,
  });

  if (ev.destructive || ev.statement_counts.destructive > 0 || ev.classified_statements.some((c) => c.kind === "DESTRUCTIVE")) {
    return { classification: MIGRATION_CLASSIFICATIONS.DESTRUCTIVE_OR_IRREVERSIBLE, reason: "destructive_or_irreversible_sql", evidence: ev };
  }
  if (ev.data_rewrite || ev.statement_counts.data > 0 || ev.classified_statements.some((c) => c.kind === "DATA")) {
    return { classification: MIGRATION_CLASSIFICATIONS.DATA_MIGRATION, reason: "data_rewrite_or_backfill", evidence: ev };
  }
  if (ev.statement_counts.unknown > 0 || ev.classified_statements.some((c) => c.kind === "UNKNOWN")) {
    return { classification: MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN, reason: "unclassified_or_incompatible_ddl", evidence: ev };
  }

  const noSignal = !ev.schema && !ev.files.length && !ev.additive_only && !ev.proven_additive
    && ev.statement_counts.additive === 0 && ev.statement_counts.data === 0
    && ev.statement_counts.destructive === 0 && ev.statement_counts.unknown === 0;
  if ((ev.qa_status === "PASS" || ev.qa_status == null) && noSignal) {
    return { classification: MIGRATION_CLASSIFICATIONS.NONE, reason: "no_migration_evidence", evidence: ev };
  }

  if (ev.proven_additive || ev.additive_only || statementsProveAdditive(ev)) {
    return { classification: MIGRATION_CLASSIFICATIONS.ADDITIVE_BACKWARD_COMPATIBLE, reason: "proven_additive_only", evidence: ev };
  }

  // Phase-11 既有 {schema:true, files} 而無 statement 證明 → 不得硬判 additive。
  return { classification: MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN, reason: "insufficient_phase11_evidence", evidence: ev };
}

export function assessRollback(classification, ev = {}) {
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
    const proven = ev.rollback_compatible === true || statementsProveAdditive(ev);
    return {
      status: proven ? "REVERSIBLE_DROP_NEW_OBJECTS" : "UNPROVEN",
      proven,
      reason: proven ? "additive_objects_can_be_dropped" : "rollback_not_proven",
    };
  }
  return { status: "UNPROVEN", proven: false, reason: "classification_unproven" };
}

export function assessCompatibility(classification, ev = {}) {
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
    const proven = ev.old_code_compatible === true || statementsProveAdditive(ev);
    return {
      status: proven ? "OLD_CODE_IGNORES_NEW_OBJECTS" : "UNPROVEN",
      proven,
      reason: proven ? "nullable_or_new_table_index_ignored_by_old_code" : "old_code_compat_not_proven",
    };
  }
  return { status: "UNPROVEN", proven: false, reason: "classification_unproven" };
}

export function decideClearance({ classification, rollback, compatibility, policy }) {
  const p = policy || buildMigrationSafetyPolicy();
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
    const rollbackOk = !p.additive_requires_rollback_proof || rollback?.proven === true;
    const compatOk = !p.additive_requires_old_code_compat_proof || compatibility?.proven === true;
    if (rollbackOk && compatOk) {
      return { clearance: CLEARANCE_RESULTS.CLEARED_ADDITIVE, reason: "additive_rollback_and_compat_proven" };
    }
    return { clearance: CLEARANCE_RESULTS.BLOCKED_UNKNOWN, reason: "additive_unproven_rollback_or_compat" };
  }
  return { clearance: CLEARANCE_RESULTS.BLOCKED_UNKNOWN, reason: "unknown_or_unproven" };
}

export function evaluateMigrationSafety({ qaCheck = null, stagingMigration = null, policy = null } = {}) {
  const pol = policy || buildMigrationSafetyPolicy();
  const classified = classifyMigration({ qaCheck, stagingMigration });
  const ev = classified.evidence || normalizeMigrationEvidence({});
  const rollback = assessRollback(classified.classification, ev);
  const compatibility = assessCompatibility(classified.classification, ev);
  const decided = decideClearance({ classification: classified.classification, rollback, compatibility, policy: pol });
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
