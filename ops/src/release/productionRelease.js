import { randomUUID } from "node:crypto";
import { withImmediateTx } from "../tx.js";
import { appendAuditRow, redactAuditData } from "../audit.js";
import { httpError } from "../errors.js";
import { getPhase15ReleaseEligibility } from "./migrationSafety.js";
import {
  BINDING_STATUSES,
  HAPPY_PATH_STATUSES,
  PRODUCTION_WORKFLOWS,
  RELEASE_STATUSES,
  REQUIRED_OCI_SOURCE,
  REQUIRED_TARGET_ENVIRONMENT,
  REQUIRED_WORKFLOW_REF,
  ROLLBACK_PATH_STATUSES,
  WORKFLOW_KINDS,
  buildProductionReleasePolicy,
  classifyWorkflowRun,
  decideDbRollbackDisposition,
  digestLooksImmutable,
  isAllowedReleaseTransition,
  isAuthorizedGithubActor,
  authorizedGithubActorFromEnv,
  isFrozenReleaseStatus,
  isTerminalReleaseStatus,
  previousStableComplete,
  productionReleaseConfigFromEnv,
  productionReleaseInputFingerprint,
  productionReleasePolicyFingerprint,
  stableProvenanceFingerprint,
  workflowIdempotencyKey,
} from "./productionReleasePolicy.js";
import { makeProductionReleaseProvider, newDispatchRequestId } from "./productionReleaseProvider.js";
import { DEFAULT_PRODUCT_ID } from "../products.js";
import { inferredIssueProductId } from "../codingTask.js";
import {
  DEFAULT_ENVIRONMENT_KEY,
  normalizeEnvironmentKey,
  resolveProductionTarget,
} from "../productEnvironment.js";
import {
  INSTRUCTION_SOURCES,
  recordInstruction,
  rejectSpoofedOwnerDirect,
  resolveVerifiedInstruction,
} from "../instructionSource.js";
import {
  assertCompleteRollbackContract,
  assertDbRestoreConfirmation,
  looksLikeStaticTreeHash,
  SCHEMA_COMPAT_OK,
} from "./rollbackContract.js";

const PII_OR_SECRET_KEY = /(pass(word|wd)?|secret|token|cookie|authorization|auth[-_]?header|api[-_]?key|access[-_]?key|private[-_]?key|credential|session|bearer|otp|ssh|email|contact|user_ref|phone|reporter|connection_string|dsn|database_url|prod(uction)?[-_]?(host|db|user|password|secret|token|key)|nas[-_]?(host|user|key|password))/i;

function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }
function parse(v) { try { return v ? JSON.parse(v) : null; } catch { return null; } }
function same(a, b) { return String(a ?? "") === String(b ?? ""); }
function sameNum(a, b) { return Number(a) === Number(b); }

export function sanitizeReleaseEvidence(value, depth = 0) {
  if (depth > 6) return "[TRUNCATED]";
  if (value == null) return value;
  if (typeof value === "string") {
    const redacted = redactAuditData(value);
    return /@/.test(String(redacted)) && /\.(com|me|org|net|edu)\b/i.test(String(redacted)) ? "[REDACTED]" : redacted;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeReleaseEvidence(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = PII_OR_SECRET_KEY.test(k) ? "[REDACTED]" : sanitizeReleaseEvidence(v, depth + 1);
  }
  return out;
}

const REQUIRED_EXECUTE_FIELDS = Object.freeze({
  releaseAuthorizationId: "release_authorization_id",
  releaseAuthorizationHash: "release_authorization_hash",
  manifestId: "manifest_id",
  manifestVersion: "manifest_version",
  manifestHash: "manifest_hash",
  migrationSafetyAssessmentId: "migration_safety_assessment_id",
  migrationSafetyPolicyFingerprint: "migration_safety_policy_fingerprint",
  migrationSafetyInputFingerprint: "migration_safety_input_fingerprint",
  clearanceResult: "clearance_result",
  qaRunId: "qa_run_id",
  stagingDeploymentId: "staging_deployment_id",
  headSha: "head_sha",
  artifactDigest: "artifact_digest",
  targetEnvironment: "target_environment",
  workflowRef: "workflow_ref",
});

function requireExactIdentities(body) {
  const missing = [];
  for (const [k, name] of Object.entries(REQUIRED_EXECUTE_FIELDS)) {
    if (body[k] == null || body[k] === "") missing.push(name);
  }
  if (missing.length) throw httpError(`missing ${missing.join(",")}`, 400);
  if (body.targetEnvironment !== REQUIRED_TARGET_ENVIRONMENT) throw httpError("target environment must be production", 409);
  if (body.workflowRef !== REQUIRED_WORKFLOW_REF) throw httpError("workflow ref must be refs/heads/master", 409);
  if (!digestLooksImmutable(body.artifactDigest)) throw httpError("artifact_digest must be an immutable digest", 400);
  if (String(body.headSha) === "latest") throw httpError("head_sha must be exact", 400);
  if (!isAuthorizedGithubActor(body.githubActor)) throw httpError("authorized github actor must be an exact GitHub login", 400);
}

function latestEvent(db, releaseRunId) {
  return db.prepare("SELECT * FROM production_release_run_event WHERE release_run_id=? ORDER BY id DESC LIMIT 1").get(Number(releaseRunId)) || null;
}

function latestStatus(db, releaseRunId) {
  const ev = latestEvent(db, releaseRunId);
  return ev ? ev.to_status : null;
}

function happyRank(status) {
  return HAPPY_PATH_STATUSES.indexOf(String(status || ""));
}

function alreadyAtOrBeyond(current, target) {
  if (!current) return false;
  if (current === target) return true;
  const ci = happyRank(current);
  const ti = happyRank(target);
  if (ci >= 0 && ti >= 0) return ci >= ti;
  const ri = ROLLBACK_PATH_STATUSES.indexOf(String(current));
  const rt = ROLLBACK_PATH_STATUSES.indexOf(String(target));
  if (ri >= 0 && rt >= 0) return ri >= rt;
  return false;
}

function appendEvent(db, { releaseRunId, toStatus, eventType, reason = null, errorCode = null, evidence = null, now, actor }) {
  const from = latestStatus(db, releaseRunId);
  if (from === toStatus) return;
  if (toStatus !== RELEASE_STATUSES.BLOCKED && alreadyAtOrBeyond(from, toStatus)) return;
  if (!isAllowedReleaseTransition(from, toStatus)) {
    throw httpError(`illegal production release transition ${from || "∅"} → ${toStatus}`, 409);
  }
  const ts = iso(now);
  db.prepare(
    `INSERT INTO production_release_run_event(release_run_id, from_status, to_status, event_type, reason, error_code, evidence_json, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(Number(releaseRunId), from, toStatus, eventType, reason, errorCode, evidence == null ? null : JSON.stringify(sanitizeReleaseEvidence(evidence)), ts);
  const run = db.prepare("SELECT * FROM production_release_run WHERE id=?").get(Number(releaseRunId));
  db.prepare(`INSERT INTO production_release_current(coding_task_id, release_run_id, current_status, input_fingerprint, updated_at)
              VALUES (?,?,?,?,?) ON CONFLICT(coding_task_id) DO UPDATE SET release_run_id=excluded.release_run_id, current_status=excluded.current_status, input_fingerprint=excluded.input_fingerprint, updated_at=excluded.updated_at`)
    .run(Number(run.coding_task_id), Number(releaseRunId), toStatus, run.input_fingerprint, ts);
  appendAuditRow(db, {
    actor: actor || "system",
    action: "issue.production_release.event",
    entityType: "production_release_run",
    entityId: String(releaseRunId),
    data: { coding_task_id: Number(run.coding_task_id), from_status: from, to_status: toStatus, event_type: eventType, reason, error_code: errorCode },
    now,
  });
}

function appendEvidence(db, { releaseRunId, kind, now, ...rest }) {
  const ts = iso(now);
  const payload = sanitizeReleaseEvidence(rest.payload || null);
  db.prepare(
    `INSERT INTO production_release_evidence(
      release_run_id, evidence_kind, workflow_name, workflow_file, workflow_ref, workflow_run_id, workflow_attempt,
      workflow_conclusion, workflow_head_sha, workflow_actor, target_environment, image_digest, oci_revision, oci_source,
      db_backup_identity, db_backup_hash, health_result, smoke_result, dispatch_request_id, provider_response_identity, payload_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    Number(releaseRunId), kind, rest.workflow_name || null, rest.workflow_file || null, rest.workflow_ref || null,
    rest.workflow_run_id || null, rest.workflow_attempt == null ? null : Number(rest.workflow_attempt),
    rest.workflow_conclusion || null, rest.workflow_head_sha || null, rest.workflow_actor || null,
    rest.target_environment || null, rest.image_digest || null, rest.oci_revision || null, rest.oci_source || null,
    rest.db_backup_identity || null, rest.db_backup_hash || null, rest.health_result || null, rest.smoke_result || null,
    rest.dispatch_request_id || null, rest.provider_response_identity || null,
    payload == null ? null : JSON.stringify(payload), ts,
  );
}

export function publicReleaseRun(db, row) {
  if (!row) return null;
  const status = latestStatus(db, row.id) || RELEASE_STATUSES.CREATED;
  return {
    id: Number(row.id),
    issue_id: Number(row.issue_id),
    coding_task_id: Number(row.coding_task_id),
    release_authorization_id: Number(row.release_authorization_id),
    release_authorization_hash: row.release_authorization_hash,
    release_manifest_id: Number(row.release_manifest_id),
    release_manifest_version: Number(row.release_manifest_version),
    manifest_hash: row.manifest_hash,
    migration_safety_assessment_id: Number(row.migration_safety_assessment_id),
    migration_safety_policy_fingerprint: row.migration_safety_policy_fingerprint,
    migration_safety_input_fingerprint: row.migration_safety_input_fingerprint,
    clearance_result: row.clearance_result,
    proposal_id: Number(row.proposal_id),
    qa_run_id: Number(row.qa_run_id),
    staging_deployment_id: Number(row.staging_deployment_id),
    authorized_head_sha: row.authorized_head_sha,
    source_tree_hash: row.source_tree_hash,
    artifact_digest: row.artifact_digest,
    target_environment: row.target_environment,
    workflow_file: row.workflow_file,
    workflow_ref: row.workflow_ref,
    expected_master_head: row.expected_master_head,
    input_fingerprint: row.input_fingerprint,
    policy_fingerprint: row.policy_fingerprint,
    run_version: Number(row.run_version),
    previous_stable_sha: row.previous_stable_sha,
    previous_stable_digest: row.previous_stable_digest,
    previous_stable_workflow_run_id: row.previous_stable_workflow_run_id,
    previous_stable_release_run_id: row.previous_stable_release_run_id == null ? null : Number(row.previous_stable_release_run_id),
    previous_stable_provenance: parse(row.previous_stable_provenance),
    previous_stable_static_tree_hash: row.previous_stable_static_tree_hash || null,
    previous_stable_schema_compat: row.previous_stable_schema_compat || null,
    product_id: row.product_id || DEFAULT_PRODUCT_ID,
    environment_key: row.environment_key || DEFAULT_ENVIRONMENT_KEY,
    instruction_source: row.instruction_source || null,
    instruction_actor: row.instruction_actor || null,
    authorized_github_actor: row.authorized_github_actor,
    current_status: status,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function listReleaseEvidence(db, releaseRunId) {
  return db.prepare("SELECT * FROM production_release_evidence WHERE release_run_id=? ORDER BY id ASC").all(Number(releaseRunId)).map((e) => ({
    id: Number(e.id),
    evidence_kind: e.evidence_kind,
    workflow_name: e.workflow_name,
    workflow_file: e.workflow_file,
    workflow_ref: e.workflow_ref,
    workflow_run_id: e.workflow_run_id,
    workflow_attempt: e.workflow_attempt == null ? null : Number(e.workflow_attempt),
    workflow_conclusion: e.workflow_conclusion,
    workflow_head_sha: e.workflow_head_sha,
    workflow_actor: e.workflow_actor,
    target_environment: e.target_environment,
    image_digest: e.image_digest,
    oci_revision: e.oci_revision,
    oci_source: e.oci_source,
    db_backup_identity: e.db_backup_identity,
    db_backup_hash: e.db_backup_hash,
    health_result: e.health_result,
    smoke_result: e.smoke_result,
    dispatch_request_id: e.dispatch_request_id,
    provider_response_identity: e.provider_response_identity,
    payload: parse(e.payload_json),
    created_at: e.created_at,
  }));
}

export function listReleaseEvents(db, releaseRunId) {
  return db.prepare("SELECT * FROM production_release_run_event WHERE release_run_id=? ORDER BY id ASC").all(Number(releaseRunId)).map((e) => ({
    id: Number(e.id),
    from_status: e.from_status,
    to_status: e.to_status,
    event_type: e.event_type,
    reason: e.reason,
    error_code: e.error_code,
    evidence: parse(e.evidence_json),
    created_at: e.created_at,
  }));
}

function targetIds(runOrOpts = {}) {
  return {
    productId: runOrOpts.product_id || runOrOpts.productId || DEFAULT_PRODUCT_ID,
    environmentKey: runOrOpts.environment_key || runOrOpts.environmentKey || DEFAULT_ENVIRONMENT_KEY,
  };
}

export function getProductionStable(db, productId = DEFAULT_PRODUCT_ID, environmentKey = DEFAULT_ENVIRONMENT_KEY) {
  const env = normalizeEnvironmentKey(environmentKey, { fallback: DEFAULT_ENVIRONMENT_KEY });
  const row = db.prepare(
    "SELECT * FROM production_stable_current WHERE product_id=? AND environment_key=?",
  ).get(productId, env);
  if (!row) return null;
  return {
    product_id: row.product_id,
    environment_key: row.environment_key || env,
    release_run_id: row.release_run_id == null ? null : Number(row.release_run_id),
    source_sha: row.source_sha,
    artifact_digest: row.artifact_digest,
    workflow_run_id: row.workflow_run_id,
    static_tree_hash: row.static_tree_hash || null,
    schema_compat: row.schema_compat || null,
    provenance: parse(row.provenance_json),
    provenance_fingerprint: row.provenance_fingerprint || stableProvenanceFingerprint(parse(row.provenance_json)),
    updated_at: row.updated_at,
  };
}

export function seedProductionStable(db, {
  sourceSha, artifactDigest, workflowRunId, releaseRunId = null, provenance = {},
  productId = DEFAULT_PRODUCT_ID, environmentKey = DEFAULT_ENVIRONMENT_KEY,
  staticTreeHash = null, schemaCompat = null, now = new Date(),
} = {}) {
  const ts = iso(now);
  const env = normalizeEnvironmentKey(environmentKey, { fallback: DEFAULT_ENVIRONMENT_KEY });
  const clean = sanitizeReleaseEvidence(provenance) || {};
  const fp = stableProvenanceFingerprint(clean);
  db.prepare(`INSERT INTO production_stable_current(
                product_id, environment_key, release_run_id, source_sha, artifact_digest, workflow_run_id,
                provenance_json, provenance_fingerprint, static_tree_hash, schema_compat, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(product_id, environment_key) DO UPDATE SET
                release_run_id=excluded.release_run_id, source_sha=excluded.source_sha,
                artifact_digest=excluded.artifact_digest, workflow_run_id=excluded.workflow_run_id,
                provenance_json=excluded.provenance_json, provenance_fingerprint=excluded.provenance_fingerprint,
                static_tree_hash=excluded.static_tree_hash, schema_compat=excluded.schema_compat,
                updated_at=excluded.updated_at`)
    .run(productId, env, releaseRunId, sourceSha, artifactDigest, workflowRunId, JSON.stringify(clean), fp, staticTreeHash, schemaCompat, ts);
  return getProductionStable(db, productId, env);
}

function resolveRunInstruction(body, { actor, session = null, workflowActor = null, env = process.env, instruction = null } = {}) {
  rejectSpoofedOwnerDirect(body);
  if (instruction?.source && instruction?.actor) return instruction;
  if (session || workflowActor) return resolveVerifiedInstruction({ session, workflowActor, body, env });
  if (actor) {
    return { source: INSTRUCTION_SOURCES.VERIFIED_SESSION, actor, session_nonce: null };
  }
  throw httpError("instruction source must be a verified session or authorized workflow actor", 403);
}

export async function observeLiveIdentity(provider, { productId, environmentKey } = {}) {
  if (!provider || typeof provider.observeLiveIdentity !== "function") return null;
  const raw = await provider.observeLiveIdentity({ productId, environmentKey });
  if (!raw) return null;
  if (!/^[a-f0-9]{40}$/i.test(String(raw.source_sha || ""))) return null;
  if (!digestLooksImmutable(raw.artifact_digest)) return null;
  return {
    source_sha: raw.source_sha,
    artifact_digest: raw.artifact_digest,
    static_tree_hash: raw.static_tree_hash || null,
    schema_compat: raw.schema_compat || null,
    workflow_run_id: raw.workflow_run_id || null,
  };
}

export function importOwnerDirectObservation(db, {
  productId = DEFAULT_PRODUCT_ID, environmentKey = DEFAULT_ENVIRONMENT_KEY,
  sourceSha, artifactDigest, staticTreeHash = null, schemaCompat = null,
  workflowRunId = null, now = new Date(), instruction,
} = {}) {
  if (!instruction?.source || !instruction?.actor) {
    throw httpError("instruction source must be a verified session or authorized workflow actor", 403);
  }
  const env = normalizeEnvironmentKey(environmentKey, { fallback: DEFAULT_ENVIRONMENT_KEY });
  const provenance = {
    kind: "owner_direct_observed",
    instruction_source: instruction.source,
    instruction_actor: instruction.actor,
    product_id: productId,
    environment_key: env,
  };
  const written = seedProductionStable(db, {
    sourceSha, artifactDigest, workflowRunId, releaseRunId: null, provenance,
    productId, environmentKey: env, staticTreeHash, schemaCompat, now,
  });
  recordInstruction(db, {
    source: instruction.source,
    actor: instruction.actor,
    action: "production_release.owner_direct_observed",
    entityType: "production_stable_current",
    entityId: `${productId}:${env}`,
    productId,
    environmentKey: env,
    sessionNonce: instruction.session_nonce || null,
    now,
  });
  appendAuditRow(db, {
    actor: instruction.actor,
    action: "issue.production_release.owner_direct_observed",
    entityType: "production_stable_current",
    entityId: `${productId}:${env}`,
    data: { source_sha: sourceSha, artifact_digest: artifactDigest, product_id: productId, environment_key: env },
    now,
  });
  return written;
}

async function assertLiveIdentityAllowsDispatch(db, run, { provider, now, actor }) {
  const { productId, environmentKey } = targetIds(run);
  const live = await observeLiveIdentity(provider, { productId, environmentKey });
  if (!live) return null;
  const matchesCandidate = same(live.source_sha, run.authorized_head_sha) && same(live.artifact_digest, run.artifact_digest);
  const matchesPrevious = same(live.source_sha, run.previous_stable_sha) && same(live.artifact_digest, run.previous_stable_digest);
  if (matchesCandidate || matchesPrevious) return live;
  const instruction = {
    source: INSTRUCTION_SOURCES.VERIFIED_SESSION,
    actor: actor || run.instruction_actor || "system",
    session_nonce: null,
  };
  withImmediateTx(db, () => {
    importOwnerDirectObservation(db, {
      productId, environmentKey,
      sourceSha: live.source_sha, artifactDigest: live.artifact_digest,
      staticTreeHash: live.static_tree_hash, schemaCompat: live.schema_compat,
      workflowRunId: live.workflow_run_id, now, instruction,
    });
    appendEvent(db, {
      releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "live_superseded",
      reason: "live production identity superseded this candidate", errorCode: "live_superseded", now, actor,
      evidence: { live, authorized_head_sha: run.authorized_head_sha, previous_stable_sha: run.previous_stable_sha },
    });
  });
  throw httpError("live production identity superseded this candidate; re-check required", 409);
}

function snapshotPreviousStable(db, productId = DEFAULT_PRODUCT_ID, environmentKey = DEFAULT_ENVIRONMENT_KEY) {
  const cur = getProductionStable(db, productId, environmentKey);
  if (!cur || !cur.source_sha) {
    return {
      sha: null, digest: null, workflow_run_id: null, release_run_id: null, provenance: null,
      static_tree_hash: null, schema_compat: null,
    };
  }
  return {
    sha: cur.source_sha,
    digest: cur.artifact_digest,
    workflow_run_id: cur.workflow_run_id,
    release_run_id: cur.release_run_id,
    static_tree_hash: cur.static_tree_hash || null,
    schema_compat: cur.schema_compat || null,
    provenance: { ...(cur.provenance || {}), release_run_id: cur.release_run_id, provenance_fingerprint: cur.provenance_fingerprint },
  };
}

function assertIdentitiesUnchanged(db, run, { repo = null, env = process.env, allowMasterMovement = false } = {}) {
  const elig = getPhase15ReleaseEligibility(db, {
    codingTaskId: Number(run.coding_task_id),
    releaseAuthorizationId: Number(run.release_authorization_id),
    manifestId: Number(run.release_manifest_id),
    manifestVersion: Number(run.release_manifest_version),
    manifestHash: run.manifest_hash,
    headSha: run.authorized_head_sha,
    artifactDigest: run.artifact_digest,
  }, { repo: allowMasterMovement ? null : repo, env });
  if (!elig.allowed) {
    const stale = elig.stale_reasons || [];
    const onlySourceDrift = stale.length > 0 && stale.every((r) => /source_base_drift|source_base_unverified|release:source_base/.test(r));
    if (!(allowMasterMovement && (elig.reason === "phase14_clearance_stale" || onlySourceDrift) && onlySourceDrift)) {
      const extra = (elig.stale_reasons || []).join(",");
      throw httpError(`Phase 15 eligibility failed: ${elig.reason}${extra ? ` (${extra})` : ""}`, 409);
    }
    // merge 後 master 前進到 authorized head 是預期的；其餘 identity 仍須成立。
  }
  const a = elig.assessment;
  if (!a) throw httpError("migration safety assessment drifted", 409);
  if (!sameNum(run.migration_safety_assessment_id, a.id)) throw httpError("migration safety assessment drifted", 409);
  if (!same(run.migration_safety_input_fingerprint, a.input_fingerprint)) throw httpError("migration safety input fingerprint drifted", 409);
  if (!same(run.migration_safety_policy_fingerprint, a.policy_fingerprint)) throw httpError("migration safety policy fingerprint drifted", 409);
  if (!same(run.clearance_result, a.clearance_result)) throw httpError("clearance drifted", 409);
  if (!sameNum(run.qa_run_id, a.qa_run_id)) throw httpError("qa_run_id drifted", 409);
  if (!sameNum(run.staging_deployment_id, a.staging_deployment_id)) throw httpError("staging_deployment_id drifted", 409);
  const auth = db.prepare("SELECT * FROM production_release_authorization WHERE id=?").get(Number(run.release_authorization_id));
  if (!auth || auth.status !== "active") throw httpError("release authorization superseded", 409);
  if (!same(auth.authorization_hash, run.release_authorization_hash)) throw httpError("authorization hash drifted", 409);
  return elig;
}

function assertImageBinding({ digest, ociRevision, ociSource, authorizedSha, authorizedDigest }) {
  if (!digestLooksImmutable(digest)) throw httpError("image digest missing or not immutable", 409);
  if (!same(digest, authorizedDigest)) throw httpError("image digest mismatch", 409);
  if (!same(ociRevision, authorizedSha)) throw httpError("OCI revision mismatch", 409);
  if (String(ociSource || "").toLowerCase() !== REQUIRED_OCI_SOURCE.toLowerCase()) throw httpError("OCI source mismatch", 409);
}

function getBinding(db, releaseRunId, kind) {
  return db.prepare("SELECT * FROM production_release_workflow_binding WHERE release_run_id=? AND workflow_kind=?").get(Number(releaseRunId), kind) || null;
}

function reserveBinding(db, { run, workflowKind, now }) {
  const existing = getBinding(db, run.id, workflowKind);
  if (existing) return existing;
  const key = workflowIdempotencyKey({
    releaseAuthorizationId: run.release_authorization_id,
    targetEnvironment: run.target_environment || REQUIRED_TARGET_ENVIRONMENT,
    workflowKind,
  });
  db.prepare(
    `INSERT INTO production_release_workflow_binding(release_run_id, workflow_kind, idempotency_key, binding_status, created_at)
     VALUES (?,?,?,?,?)`,
  ).run(Number(run.id), workflowKind, key, BINDING_STATUSES.RESERVED, iso(now));
  return getBinding(db, run.id, workflowKind);
}

function expectedStableFromRun(run) {
  const provenance = parse(run.previous_stable_provenance);
  return stableSnapshot({
    source_sha: run.previous_stable_sha,
    artifact_digest: run.previous_stable_digest,
    workflow_run_id: run.previous_stable_workflow_run_id,
    release_run_id: run.previous_stable_release_run_id,
    provenance,
    provenance_fingerprint: provenance?.provenance_fingerprint || stableProvenanceFingerprint(provenance),
  });
}

function markDispatchSubmitted(db, bindingId, now) {
  const res = db.prepare(
    `UPDATE production_release_workflow_binding SET dispatch_submitted_at=?
     WHERE id=? AND dispatch_submitted_at IS NULL AND workflow_run_id IS NULL`,
  ).run(iso(now), Number(bindingId));
  return res.changes === 1;
}

const MUTATING_WORKFLOWS = new Set([WORKFLOW_KINDS.DEPLOY, WORKFLOW_KINDS.ROLLBACK]);
const PRODUCTION_SCOPED_WORKFLOWS = new Set([
  WORKFLOW_KINDS.PREDEPLOY,
  WORKFLOW_KINDS.DEPLOY,
  WORKFLOW_KINDS.ROLLBACK,
]);

export function getProductionTargetLease(db, productId = DEFAULT_PRODUCT_ID, environmentKey = DEFAULT_ENVIRONMENT_KEY) {
  const env = normalizeEnvironmentKey(environmentKey, { fallback: DEFAULT_ENVIRONMENT_KEY });
  return db.prepare(
    "SELECT * FROM production_release_target_lease WHERE product_id=? AND environment_key=?",
  ).get(productId, env) || null;
}

function claimTargetProductionLease(db, { releaseRunId, workflowKind, owner, now, productId = DEFAULT_PRODUCT_ID, environmentKey = DEFAULT_ENVIRONMENT_KEY }) {
  if (!PRODUCTION_SCOPED_WORKFLOWS.has(workflowKind)) return;
  const env = normalizeEnvironmentKey(environmentKey, { fallback: DEFAULT_ENVIRONMENT_KEY });
  db.prepare(
    `INSERT OR IGNORE INTO production_release_target_lease(product_id, environment_key, updated_at) VALUES (?,?,?)`,
  ).run(productId, env, iso(now));
  const row = getProductionTargetLease(db, productId, env);
  if (row?.release_run_id && Number(row.release_run_id) !== Number(releaseRunId)) {
    throw httpError("production dispatch lease held by another release on this site/environment", 409);
  }
  const res = db.prepare(
    `UPDATE production_release_target_lease SET release_run_id=?, workflow_kind=?, lease_owner=?, claimed_at=?, updated_at=?
     WHERE product_id=? AND environment_key=? AND (release_run_id IS NULL OR release_run_id=?)`,
  ).run(Number(releaseRunId), workflowKind, owner, iso(now), iso(now), productId, env, Number(releaseRunId));
  if (res.changes !== 1) throw httpError("production dispatch lease held by another release on this site/environment", 409);
}

function releaseTargetProductionLease(db, { releaseRunId, workflowKind, productId = DEFAULT_PRODUCT_ID, environmentKey = DEFAULT_ENVIRONMENT_KEY }) {
  if (!PRODUCTION_SCOPED_WORKFLOWS.has(workflowKind)) return;
  const env = normalizeEnvironmentKey(environmentKey, { fallback: DEFAULT_ENVIRONMENT_KEY });
  db.prepare(
    `UPDATE production_release_target_lease SET release_run_id=NULL, workflow_kind=NULL, lease_owner=NULL, claimed_at=NULL, updated_at=?
     WHERE product_id=? AND environment_key=? AND release_run_id=?`,
  ).run(new Date().toISOString(), productId, env, Number(releaseRunId));
}

function saveBindingDispatch(db, bindingId, { workflowRunId, attempt, requestId, responseIdentity, status }) {
  db.prepare(
    `UPDATE production_release_workflow_binding SET workflow_run_id=?, workflow_attempt=?, dispatch_request_id=COALESCE(?, dispatch_request_id), provider_response_identity=COALESCE(?, provider_response_identity), binding_status=?
     WHERE id=?`,
  ).run(workflowRunId || null, attempt == null ? null : Number(attempt), requestId || null, responseIdentity || null, status, Number(bindingId));
}

function stableSnapshot(cur) {
  if (!cur) {
    return { source_sha: null, artifact_digest: null, workflow_run_id: null, release_run_id: null, provenance_fingerprint: null };
  }
  return {
    source_sha: cur.source_sha || null,
    artifact_digest: cur.artifact_digest || null,
    workflow_run_id: cur.workflow_run_id || null,
    release_run_id: cur.release_run_id == null ? null : Number(cur.release_run_id),
    provenance_fingerprint: cur.provenance_fingerprint || stableProvenanceFingerprint(cur.provenance),
  };
}

function sameStable(a, b) {
  return same(a?.source_sha, b?.source_sha)
    && same(a?.artifact_digest, b?.artifact_digest)
    && same(a?.workflow_run_id, b?.workflow_run_id)
    && sameNum(a?.release_run_id || 0, b?.release_run_id || 0)
    && same(a?.provenance_fingerprint, b?.provenance_fingerprint);
}

function requireStableUnchanged(db, observed, run = null) {
  const { productId, environmentKey } = targetIds(run || {});
  const cur = stableSnapshot(getProductionStable(db, productId, environmentKey));
  const exp = stableSnapshot(observed);
  if (!exp.source_sha && !cur.source_sha) return cur;
  if (!sameStable(cur, exp)) throw httpError("production stable identity drifted or superseded", 409);
  return cur;
}

function casWriteProductionStable(db, { next, casFrom = null, now, productId = DEFAULT_PRODUCT_ID, environmentKey = DEFAULT_ENVIRONMENT_KEY }) {
  const ts = iso(now);
  const env = normalizeEnvironmentKey(environmentKey, { fallback: DEFAULT_ENVIRONMENT_KEY });
  const clean = sanitizeReleaseEvidence(next.provenance || {}) || {};
  const payload = JSON.stringify(clean);
  const nextFp = stableProvenanceFingerprint(clean);
  const staticHash = next.staticTreeHash || next.static_tree_hash || null;
  const schemaCompat = next.schemaCompat || next.schema_compat || null;
  if (!casFrom || !casFrom.source_sha) {
    const cur = getProductionStable(db, productId, env);
    if (cur && cur.source_sha) throw httpError("production stable identity drifted or superseded", 409);
    db.prepare(`INSERT INTO production_stable_current(
                  product_id, environment_key, release_run_id, source_sha, artifact_digest, workflow_run_id,
                  provenance_json, provenance_fingerprint, static_tree_hash, schema_compat, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(product_id, environment_key) DO UPDATE SET
                  release_run_id=excluded.release_run_id, source_sha=excluded.source_sha,
                  artifact_digest=excluded.artifact_digest, workflow_run_id=excluded.workflow_run_id,
                  provenance_json=excluded.provenance_json, provenance_fingerprint=excluded.provenance_fingerprint,
                  static_tree_hash=excluded.static_tree_hash, schema_compat=excluded.schema_compat,
                  updated_at=excluded.updated_at
                WHERE production_stable_current.source_sha IS NULL OR production_stable_current.source_sha=''`)
      .run(productId, env, next.releaseRunId, next.sourceSha, next.artifactDigest, next.workflowRunId, payload, nextFp, staticHash, schemaCompat, ts);
    const written = getProductionStable(db, productId, env);
    if (!written || !same(written.source_sha, next.sourceSha) || !same(written.artifact_digest, next.artifactDigest) || !sameNum(written.release_run_id, next.releaseRunId)) {
      throw httpError("production stable compare-and-swap failed", 409);
    }
    return written;
  }
  const res = db.prepare(
    `UPDATE production_stable_current SET release_run_id=?, source_sha=?, artifact_digest=?, workflow_run_id=?, provenance_json=?, provenance_fingerprint=?, static_tree_hash=?, schema_compat=?, updated_at=?
     WHERE product_id=? AND environment_key=? AND source_sha=? AND artifact_digest=? AND IFNULL(workflow_run_id,'')=? AND IFNULL(release_run_id,0)=? AND IFNULL(provenance_fingerprint,'')=?`,
  ).run(
    next.releaseRunId, next.sourceSha, next.artifactDigest, next.workflowRunId, payload, nextFp, staticHash, schemaCompat, ts,
    productId, env, casFrom.source_sha, casFrom.artifact_digest, casFrom.workflow_run_id || "", Number(casFrom.release_run_id || 0), casFrom.provenance_fingerprint || "",
  );
  if (res.changes !== 1) throw httpError("production stable compare-and-swap failed", 409);
  return getProductionStable(db, productId, env);
}

function rollbackObservedFrom(db, run) {
  const { productId, environmentKey } = targetIds(run);
  const cur = getProductionStable(db, productId, environmentKey);
  if (!cur || !cur.source_sha) throw httpError("no current production stable to roll back", 409);
  const thisPointer = cur.release_run_id != null && Number(cur.release_run_id) === Number(run.id);
  const prevRid = run.previous_stable_release_run_id != null
    ? Number(run.previous_stable_release_run_id)
    : (parse(run.previous_stable_provenance)?.release_run_id == null ? null : Number(parse(run.previous_stable_provenance).release_run_id));
  const stillPrevious = same(cur.source_sha, run.previous_stable_sha)
    && same(cur.artifact_digest, run.previous_stable_digest)
    && (prevRid == null ? cur.release_run_id == null : Number(cur.release_run_id) === prevRid);
  const status = latestStatus(db, run.id);
  if (thisPointer) return stableSnapshot(cur);
  if (stillPrevious && status !== RELEASE_STATUSES.SUCCEEDED) return stableSnapshot(cur);
  throw httpError("rollback target is stale or superseded by a newer production release", 409);
}

function claimDispatchLease(db, { run, workflowKind, owner, now, repo, env }) {
  return withImmediateTx(db, () => {
    assertIdentitiesUnchanged(db, run, { repo, env, allowMasterMovement: true });
    let binding = getBinding(db, run.id, workflowKind);
    if (!binding) {
      reserveBinding(db, { run, workflowKind, now });
      binding = getBinding(db, run.id, workflowKind);
    }
    if (binding.workflow_run_id) return { binding, role: "reconcile" };
    if (binding.binding_status === BINDING_STATUSES.REJECTED) return { binding, role: "lookup" };
    if (binding.binding_status === BINDING_STATUSES.UNKNOWN) return { binding, role: "lookup" };
    if (binding.binding_status === BINDING_STATUSES.DISPATCHED || binding.binding_status === BINDING_STATUSES.RECONCILED) {
      return { binding, role: "lookup" };
    }
    if (binding.binding_status === BINDING_STATUSES.CLAIMED && binding.dispatch_submitted_at) {
      return { binding, role: "lookup" };
    }
    if (binding.binding_status === BINDING_STATUSES.CLAIMED && !binding.dispatch_submitted_at) {
      db.prepare(`UPDATE production_release_workflow_binding SET dispatch_owner=? WHERE id=? AND dispatch_submitted_at IS NULL AND workflow_run_id IS NULL`)
        .run(owner, Number(binding.id));
      return { binding: getBinding(db, run.id, workflowKind), role: "dispatch" };
    }
    const intentId = binding.dispatch_intent_id || binding.dispatch_request_id || newDispatchRequestId();
    const res = db.prepare(
      `UPDATE production_release_workflow_binding
       SET binding_status=?, dispatch_owner=?, dispatch_intent_id=COALESCE(dispatch_intent_id, ?),
           dispatch_request_id=COALESCE(dispatch_request_id, ?), dispatch_claimed_at=?,
           authorized_github_actor=COALESCE(authorized_github_actor, ?)
       WHERE id=? AND workflow_run_id IS NULL AND binding_status=?
         AND (dispatch_owner IS NULL OR dispatch_owner='')`,
    ).run(BINDING_STATUSES.CLAIMED, owner, intentId, intentId, iso(now), run.authorized_github_actor, Number(binding.id), BINDING_STATUSES.RESERVED);
    if (res.changes !== 1) return { binding: getBinding(db, run.id, workflowKind), role: "wait" };
    return { binding: getBinding(db, run.id, workflowKind), role: "dispatch" };
  });
}

function expectedWorkflowEvidence(run, { workflowKind, workflowFile, environment, binding, imageDigest = null, rollbackTarget = null }) {
  const rollback = workflowKind === WORKFLOW_KINDS.ROLLBACK;
  const githubActor = binding?.authorized_github_actor || run.authorized_github_actor;
  const rollbackSha = rollbackTarget?.source_sha || run.previous_stable_sha;
  return {
    workflow_run_id: binding?.workflow_run_id || null,
    attempt: binding?.workflow_attempt == null ? null : Number(binding.workflow_attempt),
    workflow_file: workflowFile,
    workflow_ref: run.workflow_ref || REQUIRED_WORKFLOW_REF,
    head_sha: rollback ? rollbackSha : run.authorized_head_sha,
    actor: githubActor,
    triggering_actor: githubActor,
    environment: environment || null,
    image_digest: imageDigest,
    oci_revision: imageDigest ? (rollback ? rollbackSha : run.authorized_head_sha) : null,
    oci_source: imageDigest ? REQUIRED_OCI_SOURCE : null,
  };
}

async function dispatchOrReconcile(db, {
  run, provider, workflowKind, workflowFile, inputs, environment, confirmation, actor, now, dispatchedStatus, repo, env,
  owner, hooks = null, observedStable = null, requireImageOutputs = false,
}) {
  const rollbackTarget = workflowKind === WORKFLOW_KINDS.ROLLBACK ? resolveAuthorizedRollbackTarget(db, run) : null;
  const rollbackSha = rollbackTarget?.source_sha || run.previous_stable_sha;
  const rollbackDigest = rollbackTarget?.artifact_digest || run.previous_stable_digest;
  const leaseOwner = owner || randomUUID();
  const { binding: claimedBinding, role } = claimDispatchLease(db, {
    run, workflowKind, owner: leaseOwner, now, repo, env,
  });
  let binding = claimedBinding;

  if (!binding.workflow_run_id && (binding.dispatch_intent_id || binding.dispatch_request_id)) {
    const foundEarly = await provider.findWorkflowRunByIdempotency({
      idempotencyKey: binding.idempotency_key,
      workflowFile,
      workflowRef: run.workflow_ref,
      headSha: workflowKind === WORKFLOW_KINDS.ROLLBACK ? rollbackSha : run.authorized_head_sha,
      actor: run.authorized_github_actor,
      createdAfter: binding.dispatch_claimed_at || binding.created_at,
      dispatchIntentId: binding.dispatch_intent_id || binding.dispatch_request_id,
      environment,
    });
    if (foundEarly?.ambiguous) {
      withImmediateTx(db, () => {
        appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: `${workflowKind}_ambiguous`, reason: "multiple_matching_workflow_runs", errorCode: "ambiguous_workflow_run", now, actor });
      });
      throw httpError("ambiguous workflow run correlation; refuse to guess", 409);
    }
    if (foundEarly?.id) {
      withImmediateTx(db, () => {
        const fresh = getBinding(db, run.id, workflowKind);
        if (!fresh.workflow_run_id) {
          saveBindingDispatch(db, fresh.id, {
            workflowRunId: String(foundEarly.id),
            attempt: foundEarly.attempt,
            requestId: foundEarly.request_id || fresh.dispatch_request_id,
            responseIdentity: foundEarly.provider_response_identity,
            status: BINDING_STATUSES.DISPATCHED,
          });
          appendEvent(db, { releaseRunId: run.id, toStatus: dispatchedStatus, eventType: `${workflowKind}_dispatched`, now, actor });
        }
      });
      binding = getBinding(db, run.id, workflowKind);
    }
  }

    if (role === "dispatch" && !binding.workflow_run_id) {
    if (isFrozenReleaseStatus(latestStatus(db, run.id)) && PRODUCTION_SCOPED_WORKFLOWS.has(workflowKind)) {
      throw httpError("production state unknown forbids new production dispatch", 409);
    }
    if (hooks?.beforeDispatch) await hooks.beforeDispatch({ workflowKind, run, binding });
    if (MUTATING_WORKFLOWS.has(workflowKind)) {
      await assertLiveIdentityAllowsDispatch(db, run, { provider, now, actor });
    }
    let decisionError = null;
    withImmediateTx(db, () => {
      if (hooks?.duringMutatingDecision) hooks.duringMutatingDecision({ workflowKind, run, binding });
      const ids = targetIds(run);
      claimTargetProductionLease(db, {
        releaseRunId: run.id, workflowKind, owner: leaseOwner, now,
        productId: ids.productId, environmentKey: ids.environmentKey,
      });
      try {
        assertIdentitiesUnchanged(db, run, { repo, env, allowMasterMovement: true });
        if (observedStable) requireStableUnchanged(db, observedStable, run);
      } catch (err) {
        releaseTargetProductionLease(db, {
          releaseRunId: run.id, workflowKind, productId: ids.productId, environmentKey: ids.environmentKey,
        });
        appendEvent(db, {
          releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "stable_superseded",
          reason: err.message || "production_stable_identity_drifted", errorCode: "stable_superseded", now, actor,
        });
        decisionError = err;
        return;
      }
      const submitted = markDispatchSubmitted(db, binding.id, now);
      if (!submitted) {
        decisionError = httpError(`${workflowKind} is still queued`, 409, { code: "workflow_in_progress" });
      }
    });
    if (decisionError) throw decisionError;
    const intentId = binding.dispatch_request_id || binding.dispatch_intent_id;
    const dispatched = await provider.dispatchWorkflow({
      workflowFile,
      workflowRef: run.workflow_ref,
      inputs: { ...inputs, release_intent_id: intentId },
      idempotencyKey: binding.idempotency_key,
      expectedHead: run.expected_master_head || null,
      actor: run.authorized_github_actor,
      environment,
      confirmation,
      requestId: intentId,
    });
    let afterDispatchError = null;
    withImmediateTx(db, () => {
      const fresh = getBinding(db, run.id, workflowKind);
      if (fresh.workflow_run_id) return;
      if (!dispatched?.accepted) {
        saveBindingDispatch(db, fresh.id, { status: BINDING_STATUSES.REJECTED, requestId: dispatched?.request_id, responseIdentity: dispatched?.provider_response_identity });
        appendEvidence(db, {
          releaseRunId: run.id, kind: `${workflowKind}_dispatch_rejected`, now, workflow_file: workflowFile, workflow_ref: run.workflow_ref,
          target_environment: environment, dispatch_request_id: dispatched?.request_id || fresh.dispatch_request_id, provider_response_identity: dispatched?.provider_response_identity,
          payload: { reason: dispatched?.reason || "dispatch_rejected" },
        });
        appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: `${workflowKind}_dispatch_rejected`, reason: dispatched?.reason || "dispatch_rejected", errorCode: dispatched?.reason || "dispatch_rejected", now, actor });
        afterDispatchError = httpError(`workflow dispatch rejected: ${dispatched?.reason || "unknown"}`, 409);
        return;
      }
      if (!dispatched.workflow_run_id) {
        if (dispatched.pending_lookup || dispatched.timeout) {
          saveBindingDispatch(db, fresh.id, {
            status: BINDING_STATUSES.DISPATCHED,
            requestId: dispatched.request_id,
            responseIdentity: dispatched.provider_response_identity,
          });
          appendEvidence(db, {
            releaseRunId: run.id, kind: `${workflowKind}_dispatch_pending`, now, workflow_file: workflowFile, workflow_ref: run.workflow_ref,
            target_environment: environment, dispatch_request_id: dispatched.request_id || fresh.dispatch_request_id, provider_response_identity: dispatched.provider_response_identity,
            payload: { accepted: true, pending_lookup: true, workflow_run_id: null },
          });
          appendEvent(db, { releaseRunId: run.id, toStatus: dispatchedStatus, eventType: `${workflowKind}_dispatched`, now, actor });
          afterDispatchError = httpError(`${workflowKind} is still queued`, 409, { code: "workflow_in_progress" });
          return;
        }
        saveBindingDispatch(db, fresh.id, {
          status: BINDING_STATUSES.UNKNOWN,
          requestId: dispatched.request_id,
          responseIdentity: dispatched.provider_response_identity,
        });
        appendEvidence(db, {
          releaseRunId: run.id, kind: `${workflowKind}_dispatch_unverified`, now, workflow_file: workflowFile, workflow_ref: run.workflow_ref,
          target_environment: environment, dispatch_request_id: dispatched.request_id || fresh.dispatch_request_id, provider_response_identity: dispatched.provider_response_identity,
          payload: { timeout: !!dispatched.timeout, accepted: true, workflow_run_id: null },
        });
        appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: `${workflowKind}_unverified`, reason: "provider_accepted_without_workflow_run", errorCode: "unverified_workflow_run", now, actor });
        afterDispatchError = httpError("provider API success is not a verifiable workflow run", 409);
        return;
      }
      saveBindingDispatch(db, fresh.id, {
        workflowRunId: String(dispatched.workflow_run_id),
        attempt: dispatched.attempt,
        requestId: dispatched.request_id,
        responseIdentity: dispatched.provider_response_identity,
        status: BINDING_STATUSES.DISPATCHED,
      });
      appendEvidence(db, {
        releaseRunId: run.id, kind: `${workflowKind}_dispatch`, now, workflow_name: workflowKind, workflow_file: workflowFile,
        workflow_ref: dispatched.workflow_ref || run.workflow_ref, workflow_run_id: String(dispatched.workflow_run_id),
        workflow_attempt: dispatched.attempt, workflow_head_sha: dispatched.head_sha, workflow_actor: dispatched.actor,
        target_environment: dispatched.environment || environment, dispatch_request_id: dispatched.request_id || fresh.dispatch_request_id,
        provider_response_identity: dispatched.provider_response_identity,
        payload: { accepted: true, dispatch_intent_id: fresh.dispatch_intent_id, dispatch_owner: fresh.dispatch_owner },
      });
      appendEvent(db, { releaseRunId: run.id, toStatus: dispatchedStatus, eventType: `${workflowKind}_dispatched`, now, actor });
    });
    if (afterDispatchError) throw afterDispatchError;
    binding = getBinding(db, run.id, workflowKind);
  } else if (!binding.workflow_run_id) {
    const found = await provider.findWorkflowRunByIdempotency({
      idempotencyKey: binding.idempotency_key,
      workflowFile,
      workflowRef: run.workflow_ref,
      headSha: workflowKind === WORKFLOW_KINDS.ROLLBACK ? rollbackSha : run.authorized_head_sha,
      actor: run.authorized_github_actor,
      createdAfter: binding.dispatch_claimed_at || binding.created_at,
      dispatchIntentId: binding.dispatch_intent_id || binding.dispatch_request_id,
      environment,
    });
    if (!found?.id) {
      if (found?.ambiguous) {
        withImmediateTx(db, () => {
          appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: `${workflowKind}_ambiguous`, reason: "multiple_matching_workflow_runs", errorCode: "ambiguous_workflow_run", now, actor });
        });
        throw httpError("ambiguous workflow run correlation; refuse to guess", 409);
      }
      if (role === "wait" || role === "lookup" || binding.binding_status === BINDING_STATUSES.CLAIMED || binding.binding_status === BINDING_STATUSES.DISPATCHED) {
        throw httpError(`${workflowKind} is still queued`, 409, { code: "workflow_in_progress" });
      }
      withImmediateTx(db, () => {
        appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: `${workflowKind}_unverified`, reason: "timeout_or_unknown_must_reconcile_not_redispatch", errorCode: "unverified_workflow_run", now, actor });
      });
      throw httpError("unknown workflow result must be reconciled, not re-dispatched", 409);
    }
    withImmediateTx(db, () => {
      const fresh = getBinding(db, run.id, workflowKind);
      if (!fresh.workflow_run_id) {
        saveBindingDispatch(db, fresh.id, {
          workflowRunId: String(found.id),
          attempt: found.attempt,
          requestId: found.request_id,
          responseIdentity: found.provider_response_identity,
          status: BINDING_STATUSES.DISPATCHED,
        });
        appendEvent(db, { releaseRunId: run.id, toStatus: dispatchedStatus, eventType: `${workflowKind}_dispatched`, now, actor });
      }
    });
    binding = getBinding(db, run.id, workflowKind);
  }

  const wf = await provider.getWorkflowRun({ workflow_run_id: binding.workflow_run_id });
  if (!wf) {
    const unknown = holdLeaseOnUncertainMutation(db, run.id, workflowKind);
    withImmediateTx(db, () => {
      appendEvent(db, {
        releaseRunId: run.id,
        toStatus: unknown ? RELEASE_STATUSES.PRODUCTION_STATE_UNKNOWN : RELEASE_STATUSES.BLOCKED,
        eventType: `${workflowKind}_missing`, reason: "workflow_run_missing", errorCode: "workflow_run_missing", now, actor,
      });
    });
    throw httpError("workflow run missing", 409);
  }
  const expected = expectedWorkflowEvidence(run, {
    workflowKind, workflowFile, environment, binding, rollbackTarget,
    imageDigest: requireImageOutputs ? (workflowKind === WORKFLOW_KINDS.ROLLBACK ? rollbackDigest : run.artifact_digest) : null,
  });
  const classified = classifyWorkflowRun(wf, expected);
  if (classified.kind === "waiting") {
    throw httpError(`${workflowKind} is still ${wf.status || "queued"}`, 409, { code: "workflow_in_progress" });
  }
  if (classified.kind !== "success") {
    const reason = classified.kind === "failed"
      ? `workflow completed with conclusion ${wf.conclusion || "empty"}`
      : `workflow evidence is not an exact successful ${workflowKind} run (${(classified.problems || []).join(",")})`;
    withImmediateTx(db, () => {
      appendEvidence(db, {
        releaseRunId: run.id, kind: `${workflowKind}_conclusion`, now, workflow_name: workflowKind, workflow_file: workflowFile,
        workflow_ref: wf.workflow_ref, workflow_run_id: wf.id != null ? String(wf.id) : null, workflow_attempt: wf.attempt, workflow_conclusion: wf.conclusion || wf.status,
        workflow_head_sha: wf.head_sha, workflow_actor: wf.actor || wf.triggering_actor, target_environment: wf.environment || environment,
        payload: { status: wf.status, conclusion: wf.conclusion, classification: classified.kind, problems: classified.problems || [] },
      });
      appendEvent(db, {
        releaseRunId: run.id,
        toStatus: holdLeaseOnUncertainMutation(db, run.id, workflowKind)
          ? RELEASE_STATUSES.PRODUCTION_STATE_UNKNOWN
          : RELEASE_STATUSES.BLOCKED,
        eventType: `${workflowKind}_not_success`,
        reason, errorCode: classified.kind === "failed" ? "workflow_completed_not_success" : "workflow_not_exactly_bound", now, actor,
      });
    });
    throw httpError(reason, 409);
  }
  withImmediateTx(db, () => {
    const fresh = getBinding(db, run.id, workflowKind);
    if (fresh.binding_status !== BINDING_STATUSES.RECONCILED) {
      saveBindingDispatch(db, fresh.id, {
        workflowRunId: fresh.workflow_run_id,
        attempt: wf.attempt,
        requestId: fresh.dispatch_request_id,
        responseIdentity: fresh.provider_response_identity,
        status: BINDING_STATUSES.RECONCILED,
      });
      appendEvidence(db, {
        releaseRunId: run.id, kind: `${workflowKind}_reconciled`, now, workflow_name: workflowKind, workflow_file: workflowFile,
        workflow_ref: wf.workflow_ref, workflow_run_id: String(wf.id), workflow_attempt: wf.attempt, workflow_conclusion: wf.conclusion,
        workflow_head_sha: wf.head_sha, workflow_actor: wf.actor || wf.triggering_actor, target_environment: wf.environment || environment,
        image_digest: wf.outputs?.image_digest || null,
        oci_revision: wf.outputs?.oci_revision || null,
        oci_source: wf.outputs?.oci_source || null,
        db_backup_identity: wf.outputs?.db_backup?.backup_id || null,
        db_backup_hash: wf.outputs?.db_backup?.backup_hash || null,
        payload: sanitizeReleaseEvidence({ outputs: wf.outputs || {} }),
      });
    }
  });
  return { binding: getBinding(db, run.id, workflowKind), workflow: wf };
}

export function createProductionReleaseRun(db, body, {
  repo = null, env = process.env, now = new Date(), actor = "owner",
  session = null, workflowActor = null, instruction = null,
} = {}) {
  requireExactIdentities(body);
  const serverActor = authorizedGithubActorFromEnv(env);
  if (!serverActor) throw httpError("authorized github actor is not configured", 503);
  if (body.githubActor && body.githubActor !== serverActor) {
    throw httpError("github actor must be the server-authorized login", 400);
  }
  const policy = buildProductionReleasePolicy(productionReleaseConfigFromEnv(env));
  const policyFp = productionReleasePolicyFingerprint(policy);
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(body.codingTaskId));
  if (!task) throw httpError("coding task not found", 404);
  const auth = db.prepare("SELECT * FROM production_release_authorization WHERE id=?").get(Number(body.releaseAuthorizationId));
  if (!auth) throw httpError("release authorization not found", 404);
  if (Number(auth.coding_task_id) !== Number(body.codingTaskId)) throw httpError("release authorization does not belong to coding task", 409);
  if (!same(body.releaseAuthorizationHash, auth.authorization_hash)) throw httpError("release_authorization_hash mismatch", 409);
  const assessmentRow = db.prepare("SELECT * FROM production_migration_safety_assessment WHERE id=?").get(Number(body.migrationSafetyAssessmentId));
  if (!assessmentRow) throw httpError("migration safety assessment not found", 404);
  if (!sameNum(assessmentRow.release_authorization_id, auth.id)) throw httpError("migration_safety_assessment_id mismatch", 409);
  if (!same(body.migrationSafetyPolicyFingerprint, assessmentRow.policy_fingerprint)) throw httpError("migration_safety_policy_fingerprint mismatch", 409);
  if (!same(body.migrationSafetyInputFingerprint, assessmentRow.input_fingerprint)) throw httpError("migration_safety_input_fingerprint mismatch", 409);
  if (!same(body.clearanceResult, assessmentRow.clearance_result)) throw httpError("clearance_result mismatch", 409);
  if (!sameNum(body.qaRunId, assessmentRow.qa_run_id)) throw httpError("qa_run_id mismatch", 409);
  if (!sameNum(body.stagingDeploymentId, assessmentRow.staging_deployment_id)) throw httpError("staging_deployment_id mismatch", 409);
  if (!sameNum(body.manifestId, auth.release_manifest_id) || !sameNum(body.manifestVersion, auth.release_manifest_version)) throw httpError("manifest identity mismatch", 409);
  if (!same(body.manifestHash, auth.manifest_hash) || !same(body.headSha, auth.head_sha) || !same(body.artifactDigest, auth.artifact_digest)) {
    throw httpError("authorization identity mismatch", 409);
  }
  const rc = db.prepare("SELECT * FROM development_release_candidate WHERE id=?").get(Number(auth.release_manifest_id));
  if (!rc) throw httpError("release manifest not found", 404);
  const inputFp = productionReleaseInputFingerprint({
    codingTaskId: Number(task.id),
    releaseAuthorizationId: Number(auth.id),
    releaseAuthorizationHash: auth.authorization_hash,
    manifestId: Number(rc.id),
    manifestVersion: Number(rc.manifest_version),
    manifestHash: rc.manifest_hash,
    migrationSafetyAssessmentId: Number(assessmentRow.id),
    migrationSafetyPolicyFingerprint: assessmentRow.policy_fingerprint,
    migrationSafetyInputFingerprint: assessmentRow.input_fingerprint,
    clearanceResult: assessmentRow.clearance_result,
    qaRunId: Number(assessmentRow.qa_run_id),
    stagingDeploymentId: Number(assessmentRow.staging_deployment_id),
    headSha: auth.head_sha,
    artifactDigest: auth.artifact_digest,
    targetEnvironment: REQUIRED_TARGET_ENVIRONMENT,
    workflowRef: REQUIRED_WORKFLOW_REF,
    policyFingerprint: policyFp,
  });
  const existingAuth = db.prepare(
    "SELECT * FROM production_release_run WHERE release_authorization_id=? AND target_environment=?",
  ).get(Number(auth.id), REQUIRED_TARGET_ENVIRONMENT);
  if (existingAuth) {
    return { idempotent: true, run: publicReleaseRun(db, existingAuth) };
  }
  const existing = db.prepare("SELECT * FROM production_release_run WHERE input_fingerprint=?").get(inputFp);
  if (existing) {
    return { idempotent: true, run: publicReleaseRun(db, existing) };
  }
  const elig = getPhase15ReleaseEligibility(db, {
    codingTaskId: body.codingTaskId,
    releaseAuthorizationId: body.releaseAuthorizationId,
    manifestId: body.manifestId,
    manifestVersion: body.manifestVersion,
    manifestHash: body.manifestHash,
    headSha: body.headSha,
    artifactDigest: body.artifactDigest,
  }, { repo, env });
  if (!elig.allowed) {
    const extra = (elig.stale_reasons || elig.missing || elig.invalid || []).join(",");
    throw httpError(`Phase 15 cannot start: ${elig.reason}${extra ? ` (${extra})` : ""}`, 409);
  }
  if (auth.status !== "active") throw httpError("release authorization superseded", 409);
  const a = elig.assessment;
  if (!sameNum(body.migrationSafetyAssessmentId, a.id)) throw httpError("migration_safety_assessment_id mismatch", 409);
  const productId = inferredIssueProductId(db, task.issue_id) || DEFAULT_PRODUCT_ID;
  const environmentKey = normalizeEnvironmentKey(body.targetEnvironment, { fallback: DEFAULT_ENVIRONMENT_KEY });
  resolveProductionTarget(db, { productId, environmentKey, displayName: body.displayName || body.display_name });
  const resolvedInstruction = instruction || resolveRunInstruction(body, { actor, session, workflowActor, env });
  const prev = snapshotPreviousStable(db, productId, environmentKey);
  const ts = iso(now);
  return withImmediateTx(db, () => {
    const racedAuth = db.prepare("SELECT * FROM production_release_run WHERE release_authorization_id=? AND target_environment=?").get(Number(auth.id), REQUIRED_TARGET_ENVIRONMENT);
    if (racedAuth) return { idempotent: true, run: publicReleaseRun(db, racedAuth) };
    const raced = db.prepare("SELECT * FROM production_release_run WHERE input_fingerprint=?").get(inputFp);
    if (raced) return { idempotent: true, run: publicReleaseRun(db, raced) };
    const version = 1 + (Number(db.prepare("SELECT MAX(run_version) m FROM production_release_run WHERE coding_task_id=?").get(Number(task.id)).m) || 0);
    const res = db.prepare(
      `INSERT INTO production_release_run(
        issue_id, coding_task_id, release_authorization_id, release_authorization_hash, release_manifest_id, release_manifest_version, manifest_hash,
        migration_safety_assessment_id, migration_safety_policy_fingerprint, migration_safety_input_fingerprint, clearance_result,
        proposal_id, qa_run_id, staging_deployment_id, authorized_head_sha, source_tree_hash, artifact_digest, target_environment,
        workflow_file, workflow_ref, expected_master_head, input_fingerprint, policy_fingerprint, run_version,
        previous_stable_sha, previous_stable_digest, previous_stable_workflow_run_id, previous_stable_release_run_id, previous_stable_provenance,
        authorized_github_actor, created_by, created_at,
        product_id, environment_key, instruction_source, instruction_actor,
        previous_stable_static_tree_hash, previous_stable_schema_compat)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      Number(task.issue_id), Number(task.id), Number(auth.id), auth.authorization_hash, Number(rc.id), Number(rc.manifest_version), rc.manifest_hash,
      Number(a.id), a.policy_fingerprint, a.input_fingerprint, a.clearance_result,
      Number(auth.proposal_id), Number(a.qa_run_id), Number(a.staging_deployment_id), auth.head_sha, rc.source_tree_hash || null, auth.artifact_digest,
      REQUIRED_TARGET_ENVIRONMENT, PRODUCTION_WORKFLOWS.DEPLOY, REQUIRED_WORKFLOW_REF, body.expectedMasterHead || null,
      inputFp, policyFp, version,
      prev.sha, prev.digest, prev.workflow_run_id, prev.release_run_id,
      prev.provenance ? JSON.stringify(sanitizeReleaseEvidence(prev.provenance)) : null,
      serverActor, actor, ts,
      productId, environmentKey, resolvedInstruction.source, resolvedInstruction.actor,
      prev.static_tree_hash, prev.schema_compat,
    );
    const id = Number(res.lastInsertRowid);
    recordInstruction(db, {
      source: resolvedInstruction.source,
      actor: resolvedInstruction.actor,
      action: "production_release.create",
      entityType: "production_release_run",
      entityId: String(id),
      productId,
      environmentKey,
      sessionNonce: resolvedInstruction.session_nonce || null,
      now,
    });
    appendEvent(db, { releaseRunId: id, toStatus: RELEASE_STATUSES.CREATED, eventType: "created", now, actor });
    appendAuditRow(db, {
      actor, action: "issue.production_release.created", entityType: "production_release_run", entityId: String(id),
      data: {
        issue_id: Number(task.issue_id), coding_task_id: Number(task.id), release_authorization_id: Number(auth.id),
        manifest_id: Number(rc.id), manifest_hash: rc.manifest_hash, head_sha: auth.head_sha, artifact_digest: auth.artifact_digest,
        assessment_id: Number(a.id), clearance: a.clearance_result,
        product_id: productId, environment_key: environmentKey, instruction_source: resolvedInstruction.source,
      }, now,
    });
    return { run: publicReleaseRun(db, db.prepare("SELECT * FROM production_release_run WHERE id=?").get(id)) };
  });
}

async function ensureMasterAncestry(db, run, { provider, repo, now, actor }) {
  if (!repo || !repo.available) throw httpError("release repository gateway unavailable", 503);
  const remoteOk = typeof repo.isRemoteAncestor === "function"
    && repo.isRemoteAncestor(run.authorized_head_sha, "master");
  if (remoteOk) {
    const masterSha = repo.resolveRemoteRef("master");
    if (run.expected_master_head && masterSha && !same(masterSha, run.expected_master_head)) {
      withImmediateTx(db, () => {
        appendEvent(db, {
          releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "expected_head_race",
          reason: "expected_head_race", errorCode: "expected_head_race", now, actor,
          evidence: { expected_master_head: run.expected_master_head, remote_master: masterSha, source: "github_remote" },
        });
      });
      throw httpError("protected remote master moved: expected_head_race", 409);
    }
    withImmediateTx(db, () => {
      appendEvidence(db, {
        releaseRunId: run.id, kind: "master_ancestry", now, workflow_head_sha: run.authorized_head_sha,
        payload: { already_on_protected_master: true, master_sha: masterSha, source: "github_remote" },
      });
    });
    return { already: true, master_sha: masterSha };
  }
  const merged = await provider.mergePullRequest({
    sha: run.authorized_head_sha,
    expectedHead: run.expected_master_head,
    repo,
  });
  if (!merged?.ok || merged.local_only) {
    withImmediateTx(db, () => {
      appendEvent(db, {
        releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "ancestry_blocked",
        reason: merged?.reason || "target_sha_not_on_protected_master", errorCode: "master_ancestry_failed", now, actor,
        evidence: { admin_override: false, source: "github_remote" },
      });
    });
    throw httpError(`target SHA is not reachable from protected remote master: ${merged?.reason || "not_on_protected_master"}`, 409);
  }
  if (!repo.isRemoteAncestor(run.authorized_head_sha, "master")) {
    withImmediateTx(db, () => {
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "ancestry_blocked", reason: "remote_master_unverified_after_merge", errorCode: "master_ancestry_failed", now, actor });
    });
    throw httpError("target SHA is not reachable from protected remote master after merge", 409);
  }
  withImmediateTx(db, () => {
    appendEvidence(db, { releaseRunId: run.id, kind: "master_merge", now, workflow_head_sha: run.authorized_head_sha, payload: { master_sha: merged.master_sha, already_merged: !!merged.already_merged, source: "github_remote" } });
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.MERGED, eventType: "merged", now, actor });
  });
  return merged;
}

function recordDbDisposition(db, run, { now, actor }) {
  const assessment = db.prepare("SELECT * FROM production_migration_safety_assessment WHERE id=?").get(Number(run.migration_safety_assessment_id));
  const decided = decideDbRollbackDisposition(assessment?.migration_classification);
  const existing = db.prepare("SELECT id FROM production_release_evidence WHERE release_run_id=? AND evidence_kind='db_rollback_disposition' LIMIT 1").get(Number(run.id));
  if (existing) return decided;
  withImmediateTx(db, () => {
    appendEvidence(db, {
      releaseRunId: run.id, kind: "db_rollback_disposition", now,
      payload: { classification: assessment?.migration_classification || null, ...decided, auto_restore: false },
    });
    appendAuditRow(db, {
      actor: actor || "system",
      action: "issue.production_release.db_disposition",
      entityType: "production_release_run",
      entityId: String(run.id),
      data: { disposition: decided.disposition, auto_restore: false, reason: decided.reason },
      now,
    });
  });
  return decided;
}

function resolveAuthorizedRollbackTarget(db, run) {
  const pinned = {
    source_sha: run.previous_stable_sha,
    artifact_digest: run.previous_stable_digest,
    workflow_run_id: run.previous_stable_workflow_run_id,
    static_tree_hash: run.previous_stable_static_tree_hash || null,
    schema_compat: run.previous_stable_schema_compat || null,
    previous_stable_provenance: parse(run.previous_stable_provenance) || run.previous_stable_provenance,
  };
  if (previousStableComplete(pinned)) return pinned;
  const boot = db.prepare(
    `SELECT workflow_run_id, image_digest, oci_revision, oci_source, payload_json
     FROM production_release_evidence
     WHERE release_run_id=? AND evidence_kind='first_live_bootstrap'
     ORDER BY id ASC LIMIT 1`,
  ).get(Number(run.id));
  if (!boot) return pinned;
  const payload = parse(boot.payload_json) || {};
  const inspected = payload.inspected || {};
  const provenance = payload.provenance || {};
  const candidate = {
    source_sha: inspected.oci_revision || boot.oci_revision || null,
    artifact_digest: inspected.digest || boot.image_digest || null,
    workflow_run_id: provenance.predeploy_workflow_run_id || boot.workflow_run_id || null,
    static_tree_hash: inspected.static_tree_hash || provenance.static_tree_hash || null,
    schema_compat: inspected.schema_compat || provenance.schema_compat || null,
    previous_stable_provenance: provenance.kind === "first_live_bootstrap" ? provenance : {
      kind: "first_live_bootstrap",
      ...provenance,
      oci_revision: inspected.oci_revision || boot.oci_revision || null,
      observed_digest: inspected.digest || boot.image_digest || null,
    },
  };
  return previousStableComplete(candidate) ? candidate : pinned;
}

function effectivePreviousStable(db, run) {
  return resolveAuthorizedRollbackTarget(db, run);
}

function observedStableForRun(db, run) {
  const fromRun = expectedStableFromRun(run);
  if (fromRun.source_sha) return fromRun;
  const ids = targetIds(run);
  const cur = getProductionStable(db, ids.productId, ids.environmentKey);
  if (cur?.provenance?.kind === "first_live_bootstrap" && Number(cur.release_run_id) === Number(run.id)) {
    return stableSnapshot(cur);
  }
  return fromRun;
}

function parseObservedCurrentProduction(workflow) {
  const cp = workflow?.outputs?.current_production;
  if (!cp || typeof cp !== "object") return null;
  const digest = String(cp.digest || "");
  if (!digestLooksImmutable(digest)) return null;
  return {
    digest,
    image_ref: cp.image_ref || null,
    image_id: cp.image_id || null,
    container: cp.container || null,
    workflow_run_id: workflow.id != null ? String(workflow.id) : null,
  };
}

async function bootstrapFirstLiveStable(db, run, { provider, repo, predeployWorkflow, now, actor }) {
  const bootIds = targetIds(run);
  if (previousStableComplete(effectivePreviousStable(db, run))) return getProductionStable(db, bootIds.productId, bootIds.environmentKey);
  const observed = parseObservedCurrentProduction(predeployWorkflow);
  if (!observed) return null;
  const inspected = await provider.inspectImage({ digest: observed.digest });
  if (!inspected || !digestLooksImmutable(inspected.digest) || !same(inspected.digest, observed.digest)) return null;
  if (!inspected.oci_revision || !/^[a-f0-9]{40}$/i.test(inspected.oci_revision)) return null;
  if (String(inspected.oci_source || "").toLowerCase() !== REQUIRED_OCI_SOURCE.toLowerCase()) return null;
  if (!repo?.available || typeof repo.isRemoteAncestor !== "function" || !repo.isRemoteAncestor(inspected.oci_revision, "master")) {
    return null;
  }
  const provenance = {
    kind: "first_live_bootstrap",
    release_run_id: Number(run.id),
    authorization_id: Number(run.release_authorization_id),
    authorization_hash: run.release_authorization_hash,
    predeploy_workflow_run_id: String(predeployWorkflow.id),
    observed_digest: observed.digest,
    oci_revision: inspected.oci_revision,
    oci_source: inspected.oci_source,
    independent_inspect: true,
    static_tree_hash: inspected.static_tree_hash || null,
    schema_compat: inspected.schema_compat || null,
  };
  const bootTarget = targetIds(run);
  withImmediateTx(db, () => {
    casWriteProductionStable(db, {
      next: {
        sourceSha: inspected.oci_revision,
        artifactDigest: inspected.digest,
        workflowRunId: String(predeployWorkflow.id),
        releaseRunId: run.id,
        provenance,
        staticTreeHash: inspected.static_tree_hash || null,
        schemaCompat: inspected.schema_compat || null,
      },
      casFrom: null,
      now,
      productId: bootTarget.productId,
      environmentKey: bootTarget.environmentKey,
    });
    appendEvidence(db, {
      releaseRunId: run.id,
      kind: "first_live_bootstrap",
      now,
      workflow_run_id: String(predeployWorkflow.id),
      image_digest: inspected.digest,
      oci_revision: inspected.oci_revision,
      oci_source: inspected.oci_source,
      payload: { observed, inspected, provenance },
    });
    appendAuditRow(db, {
      actor: actor || "system",
      action: "issue.production_release.first_live_bootstrap",
      entityType: "production_release_run",
      entityId: String(run.id),
      data: { source_sha: inspected.oci_revision, artifact_digest: inspected.digest, workflow_run_id: String(predeployWorkflow.id) },
      now,
    });
  });
  return getProductionStable(db, bootTarget.productId, bootTarget.environmentKey);
}

async function executeCodeRollback(db, run, { provider, repo, env, now, actor, owner, hooks = null }) {
  const prev = effectivePreviousStable(db, run);
  if (!previousStableComplete(prev)) {
    withImmediateTx(db, () => {
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "rollback_blocked", reason: "previous_stable_incomplete", errorCode: "previous_stable_incomplete", now, actor });
    });
    throw httpError("previous stable identity is incomplete; code rollback blocked", 409);
  }
  assertCompleteRollbackContract(prev);
  const rollbackIds = targetIds(run);
  const observedStable = rollbackObservedFrom(db, run);
  if (repo?.available && !(repo.isRemoteAncestor?.(prev.source_sha, "master") || repo.isAncestor(prev.source_sha, "origin/master"))) {
    throw httpError("previous stable SHA is not reachable from protected remote master", 409);
  }
  const image = await provider.inspectImage({ sha: prev.source_sha, digest: prev.artifact_digest });
  assertImageBinding({
    digest: image?.digest, ociRevision: image?.oci_revision, ociSource: image?.oci_source,
    authorizedSha: prev.source_sha, authorizedDigest: prev.artifact_digest,
  });
  requireStableUnchanged(db, observedStable, run);
  const { workflow } = await dispatchOrReconcile(db, {
    run, provider, workflowKind: WORKFLOW_KINDS.ROLLBACK, workflowFile: PRODUCTION_WORKFLOWS.DEPLOY,
    inputs: {
      sha: prev.source_sha,
      image_digest: prev.artifact_digest,
      expected_digest: prev.artifact_digest,
      static_tree_hash: prev.static_tree_hash || run.previous_stable_static_tree_hash,
      schema_compat: prev.schema_compat || run.previous_stable_schema_compat,
    },
    environment: REQUIRED_TARGET_ENVIRONMENT, confirmation: "DEPLOY-PRODUCTION",
    actor, now, dispatchedStatus: RELEASE_STATUSES.CODE_ROLLBACK_DISPATCHED, repo, env,
    owner, hooks, observedStable, requireImageOutputs: true,
  });
  const health = await provider.healthSmoke({
    imageDigest: prev.artifact_digest, headSha: prev.source_sha,
    workflowRunId: String(workflow.id), workflow: workflow,
  });
  if (!health?.passed || !same(health.image_digest, prev.artifact_digest) || !same(health.oci_revision, prev.source_sha)) {
    withImmediateTx(db, () => {
      appendEvidence(db, { releaseRunId: run.id, kind: "rollback_health", now, health_result: health?.health ? "PASS" : "FAIL", smoke_result: health?.passed ? "PASS" : "FAIL", image_digest: health?.image_digest, oci_revision: health?.oci_revision, payload: health });
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "rollback_health_failed", reason: health?.detail || "rollback_health_failed", errorCode: "rollback_health_failed", now, actor });
    });
    throw httpError("code rollback health/smoke failed", 409);
  }
  if (hooks?.beforeStableWrite) await hooks.beforeStableWrite({ run, kind: "rollback" });
  withImmediateTx(db, () => {
    assertIdentitiesUnchanged(db, run, { repo, env, allowMasterMovement: true });
    requireStableUnchanged(db, observedStable, run);
    appendEvidence(db, { releaseRunId: run.id, kind: "rollback_health", now, health_result: "PASS", smoke_result: "PASS", image_digest: health.image_digest, oci_revision: health.oci_revision, payload: health });
    casWriteProductionStable(db, {
      next: {
        sourceSha: prev.source_sha, artifactDigest: prev.artifact_digest, workflowRunId: String(workflow.id),
        releaseRunId: run.id,
        staticTreeHash: prev.static_tree_hash || run.previous_stable_static_tree_hash,
        schemaCompat: prev.schema_compat || run.previous_stable_schema_compat,
        provenance: {
          kind: "code_rollback",
          release_run_id: Number(run.id),
          authorization_id: Number(run.release_authorization_id),
          authorization_hash: run.release_authorization_hash,
          assessment_id: Number(run.migration_safety_assessment_id),
          previous_stable_workflow_run_id: prev.workflow_run_id,
          previous_stable_release_run_id: run.previous_stable_release_run_id,
        },
      },
      casFrom: observedStable,
      now,
      productId: rollbackIds.productId,
      environmentKey: rollbackIds.environmentKey,
    });
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.CODE_ROLLBACK_RECONCILED, eventType: "code_rollback_reconciled", now, actor });
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.ROLLED_BACK, eventType: "rolled_back", now, actor });
    appendAuditRow(db, {
      actor, action: "issue.production_release.code_rolled_back", entityType: "production_release_run", entityId: String(run.id),
      data: { previous_stable_sha: prev.source_sha, previous_stable_digest: prev.artifact_digest, workflow_run_id: String(workflow.id) }, now,
    });
  });
  recordDbDisposition(db, run, { now, actor });
  return { rolled_back: true, db_restore: false };
}

function mutatingDispatchSubmitted(db, releaseRunId) {
  const rows = db.prepare(
    `SELECT dispatch_submitted_at, workflow_run_id, binding_status FROM production_release_workflow_binding
     WHERE release_run_id=? AND workflow_kind IN (?,?)`,
  ).all(Number(releaseRunId), WORKFLOW_KINDS.DEPLOY, WORKFLOW_KINDS.ROLLBACK);
  return rows.some((b) => {
    if (b.workflow_run_id) return true;
    if (!b.dispatch_submitted_at) return false;
    return b.binding_status !== BINDING_STATUSES.REJECTED;
  });
}

function holdLeaseOnUncertainMutation(db, releaseRunId, workflowKind) {
  return MUTATING_WORKFLOWS.has(workflowKind) && mutatingDispatchSubmitted(db, releaseRunId);
}

function releaseAllProductionLeases(db, releaseRunId) {
  const run = db.prepare("SELECT product_id, environment_key FROM production_release_run WHERE id=?").get(Number(releaseRunId)) || {};
  const ids = targetIds(run);
  releaseTargetProductionLease(db, { releaseRunId, workflowKind: WORKFLOW_KINDS.PREDEPLOY, productId: ids.productId, environmentKey: ids.environmentKey });
  releaseTargetProductionLease(db, { releaseRunId, workflowKind: WORKFLOW_KINDS.DEPLOY, productId: ids.productId, environmentKey: ids.environmentKey });
  releaseTargetProductionLease(db, { releaseRunId, workflowKind: WORKFLOW_KINDS.ROLLBACK, productId: ids.productId, environmentKey: ids.environmentKey });
}

function releaseLeaseIfSafe(db, releaseRunId) {
  const status = latestStatus(db, releaseRunId);
  if (isFrozenReleaseStatus(status)) return;
  if (status === RELEASE_STATUSES.SUCCEEDED || status === RELEASE_STATUSES.ROLLED_BACK) {
    releaseAllProductionLeases(db, releaseRunId);
    return;
  }
  if (status === RELEASE_STATUSES.BLOCKED && !mutatingDispatchSubmitted(db, releaseRunId)) {
    releaseAllProductionLeases(db, releaseRunId);
  }
}

async function finishDeployAfterReconcile(db, run, deploy, {
  provider, repo, env, now, actor, owner, hooks, observedStable,
}) {
  withImmediateTx(db, () => {
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.DEPLOY_RECONCILED, eventType: "deploy_reconciled", now, actor });
  });

  const health = await provider.healthSmoke({
    imageDigest: run.artifact_digest, headSha: run.authorized_head_sha,
    workflowRunId: String(deploy.workflow.id), workflow: deploy.workflow,
  });
  const healthOk = !!(health?.passed && health.health && health.landing && health.login && health.container_running
    && same(health.image_digest, run.artifact_digest) && same(health.oci_revision, run.authorized_head_sha));
  if (!healthOk) {
    withImmediateTx(db, () => {
      appendEvidence(db, {
        releaseRunId: run.id, kind: "health_smoke", now, health_result: health?.health ? "PASS" : "FAIL",
        smoke_result: health?.passed ? "PASS" : "FAIL", image_digest: health?.image_digest, oci_revision: health?.oci_revision, payload: health,
      });
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.HEALTH_FAILED, eventType: "health_failed", reason: health?.detail || "health_or_smoke_failed", errorCode: "health_failed", now, actor });
    });
    await executeCodeRollback(db, run, { provider, repo, env, now, actor, owner, hooks });
    return { run: publicReleaseRun(db, db.prepare("SELECT * FROM production_release_run WHERE id=?").get(run.id)), rolled_back: true, db_restore: false };
  }

  if (hooks?.beforeStableWrite) await hooks.beforeStableWrite({ run, kind: "release" });
  const succeedIds = targetIds(run);
  withImmediateTx(db, () => {
    assertIdentitiesUnchanged(db, run, { repo, env, allowMasterMovement: true });
    requireStableUnchanged(db, observedStable, run);
    appendEvidence(db, {
      releaseRunId: run.id, kind: "health_smoke", now, health_result: "PASS", smoke_result: "PASS",
      image_digest: health.image_digest, oci_revision: health.oci_revision, payload: health,
    });
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.HEALTH_VERIFIED, eventType: "health_verified", now, actor });
    casWriteProductionStable(db, {
      next: {
        sourceSha: run.authorized_head_sha, artifactDigest: run.artifact_digest, workflowRunId: String(deploy.workflow.id),
        releaseRunId: run.id,
        staticTreeHash: looksLikeStaticTreeHash(run.source_tree_hash) ? run.source_tree_hash : null,
        schemaCompat: SCHEMA_COMPAT_OK,
        provenance: {
          kind: "release_succeeded",
          release_run_id: Number(run.id),
          authorization_id: Number(run.release_authorization_id),
          authorization_hash: run.release_authorization_hash,
          assessment_id: Number(run.migration_safety_assessment_id),
          assessment_input_fingerprint: run.migration_safety_input_fingerprint,
          workflow_file: PRODUCTION_WORKFLOWS.DEPLOY,
          workflow_ref: REQUIRED_WORKFLOW_REF,
          attempt: deploy.workflow.attempt,
        },
      },
      casFrom: observedStable,
      now,
      productId: succeedIds.productId,
      environmentKey: succeedIds.environmentKey,
    });
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.SUCCEEDED, eventType: "succeeded", now, actor });
    appendAuditRow(db, {
      actor, action: "issue.production_release.succeeded", entityType: "production_release_run", entityId: String(run.id),
      data: { coding_task_id: Number(run.coding_task_id), head_sha: run.authorized_head_sha, artifact_digest: run.artifact_digest, workflow_run_id: String(deploy.workflow.id) }, now,
    });
  });
  const dbDisp = recordDbDisposition(db, run, { now, actor });
  return { run: publicReleaseRun(db, db.prepare("SELECT * FROM production_release_run WHERE id=?").get(run.id)), current_stable: getProductionStable(db, succeedIds.productId, succeedIds.environmentKey), db_rollback: dbDisp, db_restore: false };
}

async function reconcileUnknownOwningRelease(db, run, {
  provider, repo, env, now, actor, owner, hooks,
}) {
  const rollbackBinding = getBinding(db, run.id, WORKFLOW_KINDS.ROLLBACK);
  const deployBinding = getBinding(db, run.id, WORKFLOW_KINDS.DEPLOY);
  const rollbackSubmitted = !!(rollbackBinding && (rollbackBinding.dispatch_submitted_at || rollbackBinding.workflow_run_id));
  const deploySubmitted = !!(deployBinding && (deployBinding.dispatch_submitted_at || deployBinding.workflow_run_id));
  if (rollbackSubmitted) {
    await executeCodeRollback(db, run, { provider, repo, env, now, actor, owner, hooks });
    return { run: publicReleaseRun(db, db.prepare("SELECT * FROM production_release_run WHERE id=?").get(run.id)), rolled_back: true, db_restore: false, reconciled_from_unknown: true };
  }
  if (!deploySubmitted) {
    throw httpError("production state unknown; refuse to dispatch", 409);
  }
  const observedStable = observedStableForRun(db, run);
  const deploy = await dispatchOrReconcile(db, {
    run, provider, workflowKind: WORKFLOW_KINDS.DEPLOY, workflowFile: PRODUCTION_WORKFLOWS.DEPLOY,
    inputs: { sha: run.authorized_head_sha, image_digest: run.artifact_digest },
    environment: REQUIRED_TARGET_ENVIRONMENT, confirmation: "DEPLOY-PRODUCTION",
    actor, now, dispatchedStatus: RELEASE_STATUSES.DEPLOY_DISPATCHED, repo, env,
    owner, hooks, observedStable, requireImageOutputs: true,
  });
  const finished = await finishDeployAfterReconcile(db, run, deploy, {
    provider, repo, env, now, actor, owner, hooks, observedStable,
  });
  return { ...finished, reconciled_from_unknown: true };
}

export async function executeProductionRelease(db, releaseRunId, {
  provider = null, repo = null, env = process.env, now = new Date(), actor = "owner", hooks = null,
  currentStableSha = null, currentStableDigest = null, currentStable = null,
} = {}) {
  void currentStableSha;
  void currentStableDigest;
  void currentStable;
  const prov = provider || makeProductionReleaseProvider(env);
  if (!prov.available) throw httpError("production release provider unavailable", 503);
  const row = db.prepare("SELECT * FROM production_release_run WHERE id=?").get(Number(releaseRunId));
  if (!row) throw httpError("production release run not found", 404);
  let run = row;
  const status = latestStatus(db, run.id) || RELEASE_STATUSES.CREATED;
  if (isTerminalReleaseStatus(status)) {
    releaseLeaseIfSafe(db, run.id);
    return { run: publicReleaseRun(db, run), current_status: status, idempotent: true };
  }
  const owner = randomUUID();
  let observedStable = observedStableForRun(db, run);
  try {
  if (isFrozenReleaseStatus(status)) {
    return await reconcileUnknownOwningRelease(db, run, { provider: prov, repo, env, now, actor, owner, hooks });
  }
  if (ROLLBACK_PATH_STATUSES.includes(status) && status !== RELEASE_STATUSES.ROLLED_BACK) {
    await executeCodeRollback(db, run, { provider: prov, repo, env, now, actor, owner, hooks });
    return { run: publicReleaseRun(db, db.prepare("SELECT * FROM production_release_run WHERE id=?").get(run.id)), rolled_back: true, db_restore: false };
  }

  await ensureMasterAncestry(db, run, { provider: prov, repo, now, actor });

  withImmediateTx(db, () => {
    const alreadyOnMaster = !!(repo?.available && repo.isRemoteAncestor?.(run.authorized_head_sha, "master"));
    assertIdentitiesUnchanged(db, run, { repo, env, allowMasterMovement: alreadyOnMaster });
    if ((latestStatus(db, run.id) || RELEASE_STATUSES.CREATED) === RELEASE_STATUSES.CREATED) {
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.ELIGIBILITY_VERIFIED, eventType: "eligibility_verified", now, actor });
    }
  });

  const build = await dispatchOrReconcile(db, {
    run, provider: prov, workflowKind: WORKFLOW_KINDS.BUILD, workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    inputs: { sha: run.authorized_head_sha, expected_digest: run.artifact_digest, image_digest: run.artifact_digest },
    environment: null, actor, now, dispatchedStatus: RELEASE_STATUSES.BUILD_DISPATCHED, repo, env,
    owner, hooks, observedStable, requireImageOutputs: true,
  });
  const inspected = await prov.inspectImage({ sha: run.authorized_head_sha, digest: run.artifact_digest });
  try {
    assertImageBinding({
      digest: inspected?.digest, ociRevision: inspected?.oci_revision, ociSource: inspected?.oci_source,
      authorizedSha: run.authorized_head_sha, authorizedDigest: run.artifact_digest,
    });
  } catch (err) {
    withImmediateTx(db, () => {
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "image_mismatch", reason: err.message, errorCode: "image_mismatch", now, actor });
    });
    throw err;
  }
  withImmediateTx(db, () => {
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BUILD_RECONCILED, eventType: "build_reconciled", now, actor });
  });

  const pre = await dispatchOrReconcile(db, {
    run, provider: prov, workflowKind: WORKFLOW_KINDS.PREDEPLOY, workflowFile: PRODUCTION_WORKFLOWS.PREDEPLOY,
    inputs: { sha: run.authorized_head_sha }, environment: REQUIRED_TARGET_ENVIRONMENT, confirmation: "PREDEPLOY-PRODUCTION",
    actor, now, dispatchedStatus: RELEASE_STATUSES.PREDEPLOY_DISPATCHED, repo, env,
    owner, hooks, observedStable,
  });
  const backup = pre.workflow.outputs?.db_backup;
  if (!backup?.verified || !backup.backup_id || !backup.backup_hash) {
    withImmediateTx(db, () => {
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "predeploy_backup_blocked", reason: "predeploy_backup_missing_or_unverified", errorCode: "predeploy_backup_unverified", now, actor });
    });
    throw httpError("predeploy backup missing or unverified", 409);
  }
  withImmediateTx(db, () => {
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.PREDEPLOY_RECONCILED, eventType: "predeploy_reconciled", now, actor });
  });

  if (!previousStableComplete(effectivePreviousStable(db, run))) {
    const bootstrapped = await bootstrapFirstLiveStable(db, run, {
      provider: prov, repo, predeployWorkflow: pre.workflow, now, actor,
    });
    if (!bootstrapped || !previousStableComplete(bootstrapped)) {
      withImmediateTx(db, () => {
        appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "previous_stable_incomplete", reason: "previous_stable_required_before_deploy", errorCode: "previous_stable_incomplete", now, actor });
      });
      throw httpError("previous stable identity is incomplete; deploy blocked", 409);
    }
    observedStable = stableSnapshot(bootstrapped);
  }

  const deploy = await dispatchOrReconcile(db, {
    run, provider: prov, workflowKind: WORKFLOW_KINDS.DEPLOY, workflowFile: PRODUCTION_WORKFLOWS.DEPLOY,
    inputs: { sha: run.authorized_head_sha, image_digest: run.artifact_digest },
    environment: REQUIRED_TARGET_ENVIRONMENT, confirmation: "DEPLOY-PRODUCTION",
    actor, now, dispatchedStatus: RELEASE_STATUSES.DEPLOY_DISPATCHED, repo, env,
    owner, hooks, observedStable, requireImageOutputs: true,
  });
  return await finishDeployAfterReconcile(db, run, deploy, {
    provider: prov, repo, env, now, actor, owner, hooks, observedStable,
  });
  } finally {
    releaseLeaseIfSafe(db, releaseRunId);
  }
}

export async function reconcileProductionRelease(db, releaseRunId, opts = {}) {
  return executeProductionRelease(db, releaseRunId, opts);
}

export async function retryProductionRelease(db, releaseRunId, opts = {}) {
  const row = db.prepare("SELECT * FROM production_release_run WHERE id=?").get(Number(releaseRunId));
  if (!row) throw httpError("production release run not found", 404);
  const bindings = db.prepare("SELECT * FROM production_release_workflow_binding WHERE release_run_id=?").all(Number(releaseRunId));
  const risky = bindings.filter((b) => b.binding_status === BINDING_STATUSES.DISPATCHED || b.binding_status === BINDING_STATUSES.UNKNOWN || b.workflow_run_id);
  if (risky.length) throw httpError("retry is only allowed before a verifiable dispatch; reconcile instead", 409);
  return executeProductionRelease(db, releaseRunId, opts);
}

export async function requestCodeRollback(db, {
  releaseRunId, previousStableSha, previousStableDigest, previousStableWorkflowRunId, provider, repo, env = process.env, now = new Date(), actor = "owner", hooks = null,
  confirmDbRestore = null, session = null, workflowActor = null, instruction = null,
} = {}) {
  const row = db.prepare("SELECT * FROM production_release_run WHERE id=?").get(Number(releaseRunId));
  if (!row) throw httpError("production release run not found", 404);
  resolveRunInstruction({}, { actor, session, workflowActor, env, instruction });
  const dbRestore = assertDbRestoreConfirmation({ confirm_db_restore: confirmDbRestore });
  if (dbRestore.requested) {
    throw httpError("database restore is a separate confirmation and is not performed by code rollback", 409);
  }
  const authorizedTarget = resolveAuthorizedRollbackTarget(db, row);
  if (!previousStableComplete(authorizedTarget)
    || !same(previousStableSha, authorizedTarget.source_sha)
    || !same(previousStableDigest, authorizedTarget.artifact_digest)
    || !same(previousStableWorkflowRunId, authorizedTarget.workflow_run_id)) {
    throw httpError("previous stable identity mismatch", 409);
  }
  assertCompleteRollbackContract(authorizedTarget);
  const status = latestStatus(db, row.id);
  if (status === RELEASE_STATUSES.ROLLED_BACK) {
    return { run: publicReleaseRun(db, row), rolled_back: true, db_restore: false, idempotent: true };
  }
  const ids = targetIds(row);
  const cur = getProductionStable(db, ids.productId, ids.environmentKey);
  const thisPointer = cur && cur.release_run_id != null && Number(cur.release_run_id) === Number(row.id);
  if (!thisPointer) {
    throw httpError("rollback run is stale or superseded by a newer production release", 409);
  }
  const prov = provider || makeProductionReleaseProvider(env);
  if (!prov.available) throw httpError("production release provider unavailable", 503);
  try {
    const result = await executeCodeRollback(db, row, { provider: prov, repo, env, now, actor, hooks });
    return { run: publicReleaseRun(db, db.prepare("SELECT * FROM production_release_run WHERE id=?").get(row.id)), ...result };
  } finally {
    releaseLeaseIfSafe(db, row.id);
  }
}

export function getProductionRelease(db, releaseRunId) {
  const row = db.prepare("SELECT * FROM production_release_run WHERE id=?").get(Number(releaseRunId));
  if (!row) return null;
  return {
    run: publicReleaseRun(db, row),
    events: listReleaseEvents(db, row.id),
    evidence: listReleaseEvidence(db, row.id),
    bindings: db.prepare("SELECT * FROM production_release_workflow_binding WHERE release_run_id=? ORDER BY id ASC").all(Number(row.id)).map((b) => ({
      id: Number(b.id),
      workflow_kind: b.workflow_kind,
      idempotency_key: b.idempotency_key,
      workflow_run_id: b.workflow_run_id,
      workflow_attempt: b.workflow_attempt == null ? null : Number(b.workflow_attempt),
      dispatch_request_id: b.dispatch_request_id,
      dispatch_owner: b.dispatch_owner,
      dispatch_intent_id: b.dispatch_intent_id,
      dispatch_claimed_at: b.dispatch_claimed_at,
      dispatch_submitted_at: b.dispatch_submitted_at,
      provider_response_identity: b.provider_response_identity,
      binding_status: b.binding_status,
      created_at: b.created_at,
    })),
    current_stable: getProductionStable(db, targetIds(row).productId, targetIds(row).environmentKey),
    target_lease: getProductionTargetLease(db, targetIds(row).productId, targetIds(row).environmentKey),
  };
}

export function getProductionReleaseView(db, codingTaskId, { repo = null, env = process.env } = {}) {
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(codingTaskId));
  if (!task) throw httpError("coding task not found", 404);
  const activeAuth = db.prepare("SELECT * FROM production_release_authorization WHERE coding_task_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(Number(codingTaskId)) || null;
  let eligibility = null;
  if (activeAuth) {
    const assessment = db.prepare("SELECT * FROM production_migration_safety_assessment WHERE release_authorization_id=? ORDER BY id DESC LIMIT 1").get(Number(activeAuth.id));
    if (assessment) {
      eligibility = getPhase15ReleaseEligibility(db, {
        codingTaskId: Number(codingTaskId),
        releaseAuthorizationId: Number(activeAuth.id),
        manifestId: Number(activeAuth.release_manifest_id),
        manifestVersion: Number(activeAuth.release_manifest_version),
        manifestHash: activeAuth.manifest_hash,
        headSha: activeAuth.head_sha,
        artifactDigest: activeAuth.artifact_digest,
      }, { repo, env });
    } else {
      eligibility = { allowed: false, reason: "phase14_clearance_missing", fresh: false };
    }
  } else {
    eligibility = { allowed: false, reason: "no_active_release_authorization", fresh: false };
  }
  const cur = db.prepare("SELECT * FROM production_release_current WHERE coding_task_id=?").get(Number(codingTaskId));
  const current = cur ? getProductionRelease(db, Number(cur.release_run_id)) : null;
  const history = db.prepare("SELECT * FROM production_release_run WHERE coding_task_id=? ORDER BY id DESC LIMIT 50").all(Number(codingTaskId)).map((r) => publicReleaseRun(db, r));
  return {
    coding_task_id: Number(codingTaskId),
    issue_id: Number(task.issue_id),
    readiness: eligibility,
    current,
    history,
    current_stable: getProductionStable(db, inferredIssueProductId(db, task.issue_id) || DEFAULT_PRODUCT_ID, DEFAULT_ENVIRONMENT_KEY),
  };
}

export function parseProductionWorkflowTriggers(yamlText) {
  const text = String(yamlText || "");
  const onIdx = text.search(/^on:\s*$/m);
  if (onIdx < 0) return { workflow_dispatch: false, push: false, pull_request: false, schedule: false };
  const after = text.slice(onIdx + 3);
  const nextTop = after.search(/\n[a-zA-Z]/);
  const block = nextTop >= 0 ? after.slice(0, nextTop) : after;
  return {
    workflow_dispatch: /^\s+workflow_dispatch:/m.test(block) || /workflow_dispatch:/.test(block),
    push: /^\s+push:/m.test(block),
    pull_request: /^\s+pull_request:/m.test(block),
    schedule: /^\s+schedule:/m.test(block),
  };
}
