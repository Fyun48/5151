import { withImmediateTx } from "../tx.js";
import { appendAuditRow, redactAuditData } from "../audit.js";
import { httpError } from "../errors.js";
import { getCurrentCodingQA, getQaRunDetail } from "../qaRun.js";
import { getCurrentCodingStaging } from "../stagingDeploy.js";
import { getCurrentReleaseCandidate } from "../releaseCandidate.js";
import {
  CLEARED_CLEARANCE_RESULTS,
  buildMigrationSafetyPolicy,
  effectiveMigrationSafetyPolicyFingerprint,
  evaluateMigrationSafety,
  evidenceFingerprint,
  migrationSafetyConfigFromEnv,
  migrationSafetyInputFingerprint,
  migrationSafetyPolicyFingerprint,
} from "./migrationSafetyPolicy.js";

const PII_OR_SECRET_KEY = /(pass(word|wd)?|secret|token|cookie|authorization|auth[-_]?header|api[-_]?key|access[-_]?key|private[-_]?key|credential|session|bearer|otp|ssh|email|contact|user_ref|phone|reporter|connection_string|dsn|database_url|prod(uction)?[-_]?(host|db|user|password|secret|token|key))/i;

function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }
function parse(v) { try { return v ? JSON.parse(v) : null; } catch { return null; } }

export function sanitizeMigrationEvidence(value, depth = 0) {
  if (depth > 6) return "[TRUNCATED]";
  if (value == null) return value;
  if (typeof value === "string") {
    const redacted = redactAuditData(value);
    return /@/.test(String(redacted)) && /\.(com|me|org|net|edu)\b/i.test(String(redacted)) ? "[REDACTED]" : redacted;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeMigrationEvidence(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = PII_OR_SECRET_KEY.test(k) ? "[REDACTED]" : sanitizeMigrationEvidence(v, depth + 1);
  }
  return out;
}

function same(a, b) { return String(a ?? "") === String(b ?? ""); }
function sameNum(a, b) { return Number(a) === Number(b); }

function loadBoundAuthorization(db, codingTaskId, releaseAuthorizationId) {
  const auth = db.prepare("SELECT * FROM production_release_authorization WHERE id=?").get(Number(releaseAuthorizationId));
  if (!auth) throw httpError("release authorization not found", 404);
  if (Number(auth.coding_task_id) !== Number(codingTaskId)) throw httpError("release authorization does not belong to coding task", 409);
  if (auth.status !== "active") throw httpError("release authorization superseded", 409);
  return auth;
}

function collectFreshnessReasons(db, {
  codingTaskId, auth, rc, currentRc, qa, staging, env, expected = {},
}) {
  const reasons = [];
  if (!auth) reasons.push("authorization_missing");
  else if (auth.status !== "active") reasons.push("authorization_superseded");
  if (!rc || rc.status !== "completed") reasons.push("manifest_missing");
  if (!currentRc) reasons.push("no_current_release_candidate");
  else {
    if (!currentRc.fresh) reasons.push(...(currentRc.stale_reasons || ["release_not_fresh"]).map((r) => `release:${r}`));
    if (rc && Number(currentRc.id) !== Number(rc.id)) reasons.push("manifest_not_current");
    if (rc && !same(currentRc.manifest_hash, rc.manifest_hash)) reasons.push("current_manifest_hash_drift");
  }
  if (auth && rc) {
    if (!sameNum(auth.release_manifest_id, rc.id)) reasons.push("authorization_manifest_id_mismatch");
    if (!sameNum(auth.release_manifest_version, rc.manifest_version)) reasons.push("authorization_manifest_version_mismatch");
    if (!same(auth.manifest_hash, rc.manifest_hash)) reasons.push("authorization_manifest_hash_mismatch");
    if (!same(auth.head_sha, rc.head_sha)) reasons.push("authorization_head_sha_mismatch");
    if (!same(auth.artifact_digest, rc.artifact_digest)) reasons.push("authorization_artifact_digest_mismatch");
    if (!sameNum(auth.qa_run_id, rc.qa_run_id)) reasons.push("authorization_qa_run_mismatch");
    if (!sameNum(auth.staging_deployment_id, rc.staging_deployment_id)) reasons.push("authorization_staging_mismatch");
  }
  if (!qa) reasons.push("qa_missing");
  else {
    if (!qa.fresh || qa.final_result !== "PASS") reasons.push("qa_not_fresh_pass");
    if (auth && !sameNum(qa.id, auth.qa_run_id)) reasons.push("cannot_justify_old_authorization_with_newer_qa");
  }
  if (!staging) reasons.push("staging_missing");
  else {
    if (!staging.fresh || staging.validation_result !== "PASS") reasons.push("staging_not_fresh_pass");
    if (auth && !sameNum(staging.id, auth.staging_deployment_id)) reasons.push("cannot_justify_old_authorization_with_newer_staging");
  }
  if (expected.releaseAuthorizationId != null && auth && !sameNum(expected.releaseAuthorizationId, auth.id)) reasons.push("release_authorization_id_mismatch");
  if (expected.manifestId != null && rc && !sameNum(expected.manifestId, rc.id)) reasons.push("manifest_id_mismatch");
  if (expected.manifestVersion != null && rc && !sameNum(expected.manifestVersion, rc.manifest_version)) reasons.push("manifest_version_mismatch");
  if (expected.manifestHash != null && rc && !same(expected.manifestHash, rc.manifest_hash)) reasons.push("manifest_hash_mismatch");
  if (expected.headSha != null && rc && !same(expected.headSha, rc.head_sha)) reasons.push("head_sha_mismatch");
  if (expected.artifactDigest != null && rc && !same(expected.artifactDigest, rc.artifact_digest)) reasons.push("artifact_digest_mismatch");
  void db;
  void env;
  return [...new Set(reasons)];
}

function boundContext(db, codingTaskId, expected, { repo = null, env = process.env, now = new Date() } = {}) {
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(codingTaskId));
  if (!task) throw httpError("coding task not found", 404);
  const auth = loadBoundAuthorization(db, codingTaskId, expected.releaseAuthorizationId);
  const rc = db.prepare("SELECT * FROM development_release_candidate WHERE id=?").get(Number(auth.release_manifest_id));
  const currentRc = getCurrentReleaseCandidate(db, codingTaskId, { repo, env, now });
  const qa = getCurrentCodingQA(db, codingTaskId, { env });
  const staging = getCurrentCodingStaging(db, codingTaskId, { env, now });
  const reasons = collectFreshnessReasons(db, { codingTaskId, auth, rc, currentRc, qa, staging, env, expected });
  return { task, auth, rc, currentRc, qa, staging, reasons };
}

function throwIfUnbound(reasons) {
  if (!reasons.length) return;
  const map = [
    ["release_authorization_superseded", /authorization_superseded/],
    ["manifest is not current", /manifest_not_current/],
    ["manifest_hash mismatch", /manifest_hash_mismatch/],
    ["manifest_version mismatch", /manifest_version_mismatch/],
    ["head_sha mismatch", /head_sha_mismatch/],
    ["artifact_digest mismatch", /artifact_digest_mismatch/],
    ["QA stale", /qa_not_fresh_pass|qa_missing/],
    ["staging stale", /staging_not_fresh_pass|staging_missing/],
    ["release candidate stale", /release:/],
    ["cannot justify old authorization with newer provenance", /cannot_justify_old_authorization/],
    ["approved migration evidence drifted from live QA", /approved_migration_evidence_drift/],
  ];
  for (const [msg, re] of map) {
    if (reasons.some((r) => re.test(r))) throw httpError(msg, 409);
  }
  throw httpError(`migration safety binding failed (${reasons.join(",")})`, 409);
}

function qaMigrationCheck(qa) {
  const detail = qa?.checks ? qa : null;
  const checks = detail?.checks || [];
  return checks.find((c) => c.check_type === "DATABASE_MIGRATION") || null;
}

function approvedMigrationFromManifest(rc) {
  const content = parse(rc?.manifest_content);
  return content?.database_config?.migration ?? null;
}

function migrationCheckIdentity(check) {
  if (!check) return evidenceFingerprint({ missing: true });
  return evidenceFingerprint(sanitizeMigrationEvidence({
    status: check.status || null,
    finding: check.finding || null,
    evidence: check.evidence || null,
  }));
}

function asQaCheck(mig) {
  if (!mig) return null;
  return { status: mig.status, finding: mig.finding, evidence: mig.evidence, severity: mig.severity };
}

function stagingMigrationCheck(staging) {
  return (staging?.checks || []).find((c) => c.check_type === "MIGRATION") || null;
}

export function createMigrationSafetyAssessment(db, {
  codingTaskId,
  releaseAuthorizationId,
  manifestId,
  manifestVersion,
  manifestHash,
  headSha,
  artifactDigest,
  repo = null,
  env = process.env,
  now = new Date(),
  actor = "system",
} = {}) {
  const expected = { releaseAuthorizationId, manifestId, manifestVersion, manifestHash, headSha, artifactDigest };
  for (const [k, v] of Object.entries(expected)) {
    if (v == null || v === "") throw httpError(`missing ${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, "")}`, 400);
  }
  const cfg = migrationSafetyConfigFromEnv(env);
  const policy = buildMigrationSafetyPolicy(cfg);
  const policyFp = migrationSafetyPolicyFingerprint(policy);
  const { task, auth, rc, qa, staging, reasons } = boundContext(db, codingTaskId, expected, { repo, env, now });
  const qaDetail = qa.checks ? qa : getQaRunDetail(db, Number(auth.qa_run_id));
  const approvedMigration = approvedMigrationFromManifest(rc);
  const liveMigration = qaMigrationCheck(qaDetail);
  if (migrationCheckIdentity(approvedMigration) !== migrationCheckIdentity(liveMigration)) {
    reasons.push("approved_migration_evidence_drift");
  }
  throwIfUnbound(reasons);

  const binding = {
    artifactDigest: String(auth.artifact_digest),
    qaRunId: Number(auth.qa_run_id),
    stagingDeploymentId: Number(auth.staging_deployment_id),
  };
  const evaluated = evaluateMigrationSafety({
    qaCheck: asQaCheck(approvedMigration),
    stagingMigration: stagingMigrationCheck(staging),
    policy,
    binding,
  });
  const snapshot = sanitizeMigrationEvidence({
    qa_run_id: Number(auth.qa_run_id),
    qa_status: qaDetail?.final_result || null,
    evidence_source: "approved_manifest_database_config_migration",
    qa_migration: approvedMigration ? {
      status: approvedMigration.status,
      severity: approvedMigration.severity || null,
      finding: approvedMigration.finding,
      evidence: evaluated.evidence,
    } : null,
    staging_deployment_id: Number(auth.staging_deployment_id),
    staging_migration: stagingMigrationCheck(staging) ? {
      status: stagingMigrationCheck(staging).status,
      severity: stagingMigrationCheck(staging).severity,
      finding: stagingMigrationCheck(staging).finding,
    } : null,
    classification_reason: evaluated.classification_reason,
    clearance_reason: evaluated.clearance_reason,
  });
  const evidenceFp = evidenceFingerprint(snapshot);
  const inputFp = migrationSafetyInputFingerprint({
    releaseAuthorizationId: Number(auth.id),
    releaseManifestId: Number(rc.id),
    releaseManifestVersion: Number(rc.manifest_version),
    manifestHash: String(rc.manifest_hash),
    codingTaskId: Number(task.id),
    qaRunId: Number(auth.qa_run_id),
    stagingDeploymentId: Number(auth.staging_deployment_id),
    headSha: String(auth.head_sha),
    artifactDigest: String(auth.artifact_digest),
    authorizationHash: auth.authorization_hash,
    qaInputFp: qa.input_fingerprint,
    stagingInputFp: staging.input_fingerprint,
    releaseInputFp: rc.release_input_fingerprint,
    evidenceFingerprint: evidenceFp,
    policyVersion: policy.policy_version,
    policyFingerprint: policyFp,
  });
  const ts = iso(now);
  return withImmediateTx(db, () => {
    const existing = db.prepare("SELECT * FROM production_migration_safety_assessment WHERE input_fingerprint=?").get(inputFp);
    if (existing) {
      db.prepare(`INSERT INTO production_migration_safety_current(coding_task_id, release_authorization_id, assessment_id, input_fingerprint, clearance_result, updated_at)
                  VALUES (?,?,?,?,?,?) ON CONFLICT(coding_task_id) DO UPDATE SET release_authorization_id=excluded.release_authorization_id, assessment_id=excluded.assessment_id, input_fingerprint=excluded.input_fingerprint, clearance_result=excluded.clearance_result, updated_at=excluded.updated_at`)
        .run(Number(task.id), Number(auth.id), Number(existing.id), inputFp, existing.clearance_result, ts);
      return { idempotent: true, assessment: publicAssessment(existing) };
    }
    const version = 1 + (Number(db.prepare("SELECT MAX(assessment_version) m FROM production_migration_safety_assessment WHERE release_authorization_id=?").get(Number(auth.id)).m) || 0);
    const res = db.prepare(
      `INSERT INTO production_migration_safety_assessment(
        issue_id, coding_task_id, release_authorization_id, release_manifest_id, release_manifest_version, manifest_hash,
        qa_run_id, staging_deployment_id, head_sha, artifact_digest, migration_classification, clearance_result,
        evidence_snapshot, rollback_assessment, compatibility_assessment, policy_version, policy_fingerprint,
        input_fingerprint, assessment_version, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      Number(task.issue_id), Number(task.id), Number(auth.id), Number(rc.id), Number(rc.manifest_version), String(rc.manifest_hash),
      Number(auth.qa_run_id), Number(auth.staging_deployment_id), String(auth.head_sha), String(auth.artifact_digest),
      evaluated.classification, evaluated.clearance,
      JSON.stringify(snapshot), JSON.stringify(evaluated.rollback_assessment), JSON.stringify(evaluated.compatibility_assessment),
      policy.policy_version, policyFp, inputFp, version, ts,
    );
    const id = Number(res.lastInsertRowid);
    db.prepare(`INSERT INTO production_migration_safety_current(coding_task_id, release_authorization_id, assessment_id, input_fingerprint, clearance_result, updated_at)
                VALUES (?,?,?,?,?,?) ON CONFLICT(coding_task_id) DO UPDATE SET release_authorization_id=excluded.release_authorization_id, assessment_id=excluded.assessment_id, input_fingerprint=excluded.input_fingerprint, clearance_result=excluded.clearance_result, updated_at=excluded.updated_at`)
      .run(Number(task.id), Number(auth.id), id, inputFp, evaluated.clearance, ts);
    appendAuditRow(db, {
      actor, action: "issue.migration_safety.assessed", entityType: "production_migration_safety_assessment", entityId: String(id),
      data: {
        issue_id: Number(task.issue_id), coding_task_id: Number(task.id), release_authorization_id: Number(auth.id),
        manifest_id: Number(rc.id), manifest_version: Number(rc.manifest_version), manifest_hash: rc.manifest_hash,
        head_sha: auth.head_sha, artifact_digest: auth.artifact_digest, qa_run_id: Number(auth.qa_run_id),
        staging_deployment_id: Number(auth.staging_deployment_id), classification: evaluated.classification,
        clearance: evaluated.clearance, assessment_version: version,
      }, now,
    });
    appendAuditRow(db, {
      actor, action: "issue.migration_safety.current_changed", entityType: "production_migration_safety_current", entityId: String(task.id),
      data: { issue_id: Number(task.issue_id), coding_task_id: Number(task.id), release_authorization_id: Number(auth.id), assessment_id: id, clearance: evaluated.clearance },
      now,
    });
    return { assessment: publicAssessment(db.prepare("SELECT * FROM production_migration_safety_assessment WHERE id=?").get(id)) };
  });
}

export function publicAssessment(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    issue_id: Number(row.issue_id),
    coding_task_id: Number(row.coding_task_id),
    release_authorization_id: Number(row.release_authorization_id),
    release_manifest_id: Number(row.release_manifest_id),
    release_manifest_version: Number(row.release_manifest_version),
    manifest_hash: row.manifest_hash,
    qa_run_id: Number(row.qa_run_id),
    staging_deployment_id: Number(row.staging_deployment_id),
    head_sha: row.head_sha,
    artifact_digest: row.artifact_digest,
    migration_classification: row.migration_classification,
    clearance_result: row.clearance_result,
    evidence_snapshot: parse(row.evidence_snapshot),
    rollback_assessment: parse(row.rollback_assessment),
    compatibility_assessment: parse(row.compatibility_assessment),
    policy_version: row.policy_version,
    policy_fingerprint: row.policy_fingerprint,
    input_fingerprint: row.input_fingerprint,
    assessment_version: Number(row.assessment_version),
    created_at: row.created_at,
  };
}

function assessmentFreshness(db, row, { repo = null, env = process.env, now = new Date() } = {}) {
  if (!row) return { fresh: false, stale: true, stale_reasons: ["assessment_missing"] };
  const auth = db.prepare("SELECT * FROM production_release_authorization WHERE id=?").get(Number(row.release_authorization_id));
  const rc = db.prepare("SELECT * FROM development_release_candidate WHERE id=?").get(Number(row.release_manifest_id));
  const currentRc = getCurrentReleaseCandidate(db, Number(row.coding_task_id), { repo, env, now });
  const qa = getCurrentCodingQA(db, Number(row.coding_task_id), { env });
  const staging = getCurrentCodingStaging(db, Number(row.coding_task_id), { env, now });
  const reasons = collectFreshnessReasons(db, {
    codingTaskId: Number(row.coding_task_id), auth, rc, currentRc, qa, staging, env,
    expected: {
      releaseAuthorizationId: row.release_authorization_id,
      manifestId: row.release_manifest_id,
      manifestVersion: row.release_manifest_version,
      manifestHash: row.manifest_hash,
      headSha: row.head_sha,
      artifactDigest: row.artifact_digest,
    },
  });
  if (auth && !same(auth.manifest_hash, row.manifest_hash)) reasons.push("assessment_manifest_hash_drift");
  if (auth && !same(auth.head_sha, row.head_sha)) reasons.push("assessment_head_sha_drift");
  if (auth && !same(auth.artifact_digest, row.artifact_digest)) reasons.push("assessment_artifact_digest_drift");
  if (rc) {
    const approvedMigration = approvedMigrationFromManifest(rc);
    const liveMigration = qaMigrationCheck(qa);
    if (migrationCheckIdentity(approvedMigration) !== migrationCheckIdentity(liveMigration)) {
      reasons.push("approved_migration_evidence_drift");
    }
    const approvedEval = evaluateMigrationSafety({
      qaCheck: asQaCheck(approvedMigration),
      stagingMigration: stagingMigrationCheck(staging),
      binding: {
        artifactDigest: String(row.artifact_digest),
        qaRunId: Number(row.qa_run_id),
        stagingDeploymentId: Number(row.staging_deployment_id),
      },
    });
    const snap = parse(row.evidence_snapshot);
    if (evidenceFingerprint(sanitizeMigrationEvidence({
      qa_run_id: Number(row.qa_run_id),
      qa_status: qa?.final_result || null,
      evidence_source: "approved_manifest_database_config_migration",
      qa_migration: approvedMigration ? {
        status: approvedMigration.status,
        severity: approvedMigration.severity || null,
        finding: approvedMigration.finding,
        evidence: approvedEval.evidence,
      } : null,
      staging_deployment_id: Number(row.staging_deployment_id),
      staging_migration: stagingMigrationCheck(staging) ? {
        status: stagingMigrationCheck(staging).status,
        severity: stagingMigrationCheck(staging).severity,
        finding: stagingMigrationCheck(staging).finding,
      } : null,
      classification_reason: approvedEval.classification_reason,
      clearance_reason: approvedEval.clearance_reason,
    })) !== evidenceFingerprint(snap || {})) {
      reasons.push("approved_assessment_snapshot_drift");
    }
  }
  if (row.policy_fingerprint && row.policy_fingerprint !== effectiveMigrationSafetyPolicyFingerprint(env)) {
    reasons.push("migration_safety_policy_changed");
  }
  const unique = [...new Set(reasons)];
  return { fresh: unique.length === 0, stale: unique.length > 0, stale_reasons: unique };
}

export function getCurrentMigrationSafety(db, codingTaskId, { repo = null, env = process.env, now = new Date() } = {}) {
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(codingTaskId));
  if (!task) throw httpError("coding task not found", 404);
  const cur = db.prepare("SELECT * FROM production_migration_safety_current WHERE coding_task_id=?").get(Number(codingTaskId));
  const activeAuth = db.prepare("SELECT * FROM production_release_authorization WHERE coding_task_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(Number(codingTaskId)) || null;
  if (!cur) {
    return {
      coding_task_id: Number(codingTaskId),
      issue_id: Number(task.issue_id),
      assessment: null,
      fresh: false,
      stale: true,
      stale_reasons: activeAuth ? ["phase14_clearance_missing"] : ["no_active_release_authorization"],
      active_authorization_id: activeAuth ? Number(activeAuth.id) : null,
    };
  }
  const row = db.prepare("SELECT * FROM production_migration_safety_assessment WHERE id=?").get(Number(cur.assessment_id));
  const freshness = assessmentFreshness(db, row, { repo, env, now });
  if (activeAuth && Number(cur.release_authorization_id) !== Number(activeAuth.id)) {
    freshness.stale_reasons = [...new Set([...(freshness.stale_reasons || []), "authorization_superseded"])];
    freshness.fresh = false;
    freshness.stale = true;
  }
  return {
    coding_task_id: Number(codingTaskId),
    issue_id: Number(task.issue_id),
    assessment: publicAssessment(row),
    fresh: freshness.fresh,
    stale: freshness.stale,
    stale_reasons: freshness.stale_reasons,
    active_authorization_id: activeAuth ? Number(activeAuth.id) : null,
  };
}

export function getMigrationSafetyView(db, codingTaskId, { repo = null, env = process.env, now = new Date() } = {}) {
  const current = getCurrentMigrationSafety(db, codingTaskId, { repo, env, now });
  const history = db.prepare("SELECT * FROM production_migration_safety_assessment WHERE coding_task_id=? ORDER BY id DESC LIMIT 50").all(Number(codingTaskId)).map(publicAssessment);
  return { ...current, history };
}

export const PHASE15_REQUIRED_IDENTITIES = Object.freeze([
  "codingTaskId",
  "releaseAuthorizationId",
  "manifestId",
  "manifestVersion",
  "manifestHash",
  "headSha",
  "artifactDigest",
]);

function identityPresent(v) {
  return v != null && v !== "";
}

function phase15IdentityProblems(identities = {}) {
  const missing = PHASE15_REQUIRED_IDENTITIES.filter((k) => !identityPresent(identities[k]));
  if (missing.length) return { reason: "phase15_identity_required", missing };
  const invalid = [];
  if (!Number.isInteger(Number(identities.codingTaskId)) || Number(identities.codingTaskId) <= 0) invalid.push("coding_task_id");
  if (!Number.isInteger(Number(identities.releaseAuthorizationId)) || Number(identities.releaseAuthorizationId) <= 0) invalid.push("release_authorization_id");
  if (!Number.isInteger(Number(identities.manifestId)) || Number(identities.manifestId) <= 0) invalid.push("manifest_id");
  if (!Number.isInteger(Number(identities.manifestVersion)) || Number(identities.manifestVersion) <= 0) invalid.push("manifest_version");
  if (!/^[a-f0-9]{16,}$/i.test(String(identities.manifestHash)) && !/^sha256:[a-f0-9]{16,}$/i.test(String(identities.manifestHash))) invalid.push("manifest_hash");
  if (!/^[a-f0-9]{7,40}$/i.test(String(identities.headSha)) && !/^sha256:[a-f0-9]{16,}$/i.test(String(identities.headSha))) invalid.push("head_sha");
  if (String(identities.artifactDigest) === "latest" || (!/^[a-f0-9]{16,}$/i.test(String(identities.artifactDigest)) && !/^sha256:[a-f0-9]{16,}$/i.test(String(identities.artifactDigest)))) {
    invalid.push("artifact_digest");
  }
  if (invalid.length) return { reason: "phase15_identity_invalid", invalid };
  return null;
}

// Phase 15 部署消費：強制全部 identity 非空、格式有效、並與 fresh clearance 逐一比對。
// runtime（repo/env）不得覆寫 identities。UI 寬鬆查詢請用 getCurrentMigrationSafety / getMigrationSafetyView。
export function getPhase15ReleaseEligibility(db, identities = {}, runtime = {}) {
  const problems = phase15IdentityProblems(identities);
  if (problems) return { allowed: false, ...problems, clearance: null, fresh: false };
  const repo = runtime.repo ?? null;
  const env = runtime.env ?? process.env;
  const now = runtime.now ?? new Date();
  let current;
  try {
    current = getCurrentMigrationSafety(db, identities.codingTaskId, { repo, env, now });
  } catch (err) {
    if (err.status === 404) return { allowed: false, reason: "phase15_coding_task_not_found", clearance: null, fresh: false };
    throw err;
  }
  if (!current.assessment) {
    return { allowed: false, reason: "phase14_clearance_missing", clearance: null, fresh: false, stale_reasons: current.stale_reasons };
  }
  if (!current.fresh) {
    return { allowed: false, reason: "phase14_clearance_stale", clearance: current.assessment.clearance_result, fresh: false, stale_reasons: current.stale_reasons, assessment: current.assessment };
  }
  const a = current.assessment;
  if (!sameNum(identities.releaseAuthorizationId, a.release_authorization_id)) {
    return { allowed: false, reason: "phase14_authorization_mismatch", clearance: a.clearance_result, fresh: false, assessment: a };
  }
  if (!sameNum(identities.manifestId, a.release_manifest_id)) {
    return { allowed: false, reason: "phase14_manifest_id_mismatch", clearance: a.clearance_result, fresh: false, assessment: a };
  }
  if (!sameNum(identities.manifestVersion, a.release_manifest_version)) {
    return { allowed: false, reason: "phase14_manifest_version_mismatch", clearance: a.clearance_result, fresh: false, assessment: a };
  }
  if (!same(identities.manifestHash, a.manifest_hash)) {
    return { allowed: false, reason: "phase14_manifest_hash_mismatch", clearance: a.clearance_result, fresh: false, assessment: a };
  }
  if (!same(identities.headSha, a.head_sha)) {
    return { allowed: false, reason: "phase14_head_sha_mismatch", clearance: a.clearance_result, fresh: false, assessment: a };
  }
  if (!same(identities.artifactDigest, a.artifact_digest)) {
    return { allowed: false, reason: "phase14_artifact_digest_mismatch", clearance: a.clearance_result, fresh: false, assessment: a };
  }
  if (!CLEARED_CLEARANCE_RESULTS.includes(a.clearance_result)) {
    return { allowed: false, reason: "phase14_clearance_blocked", clearance: a.clearance_result, fresh: true, assessment: a };
  }
  return { allowed: true, reason: "phase14_cleared", clearance: a.clearance_result, fresh: true, assessment: a };
}

export function assertPhase15MigrationClearance(db, identities, runtime = {}) {
  const eligibility = getPhase15ReleaseEligibility(db, identities, runtime);
  if (!eligibility.allowed) throw httpError(`Phase 15 cannot consume clearance: ${eligibility.reason}`, 409);
  return eligibility;
}

export function assessApprovedReleaseIfNeeded(db, { codingTaskId, authorization, repo = null, env = process.env, now = new Date(), actor = "system" } = {}) {
  if (!authorization) return null;
  return createMigrationSafetyAssessment(db, {
    codingTaskId,
    releaseAuthorizationId: authorization.id,
    manifestId: authorization.release_manifest_id,
    manifestVersion: authorization.release_manifest_version,
    manifestHash: authorization.manifest_hash,
    headSha: authorization.head_sha,
    artifactDigest: authorization.artifact_digest,
    repo, env, now, actor,
  });
}
