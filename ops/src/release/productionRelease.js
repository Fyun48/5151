import { withImmediateTx } from "../tx.js";
import { appendAuditRow, redactAuditData } from "../audit.js";
import { httpError } from "../errors.js";
import { getPhase15ReleaseEligibility } from "./migrationSafety.js";
import {
  BINDING_STATUSES,
  DB_ROLLBACK_DISPOSITIONS,
  PRODUCTION_WORKFLOWS,
  RELEASE_STATUSES,
  REQUIRED_OCI_SOURCE,
  REQUIRED_TARGET_ENVIRONMENT,
  REQUIRED_WORKFLOW_REF,
  WORKFLOW_KINDS,
  buildProductionReleasePolicy,
  decideDbRollbackDisposition,
  digestLooksImmutable,
  isSuccessfulConclusion,
  previousStableComplete,
  productionReleaseConfigFromEnv,
  productionReleaseInputFingerprint,
  productionReleasePolicyFingerprint,
  workflowIdempotencyKey,
} from "./productionReleasePolicy.js";
import { makeProductionReleaseProvider } from "./productionReleaseProvider.js";

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
}

function latestEvent(db, releaseRunId) {
  return db.prepare("SELECT * FROM production_release_run_event WHERE release_run_id=? ORDER BY id DESC LIMIT 1").get(Number(releaseRunId)) || null;
}

function latestStatus(db, releaseRunId) {
  const ev = latestEvent(db, releaseRunId);
  return ev ? ev.to_status : RELEASE_STATUSES.CREATED;
}

function appendEvent(db, { releaseRunId, toStatus, eventType, reason = null, errorCode = null, evidence = null, now, actor }) {
  const from = latestStatus(db, releaseRunId);
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
  const status = latestStatus(db, row.id);
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
    previous_stable_provenance: parse(row.previous_stable_provenance),
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

export function getProductionStable(db) {
  const row = db.prepare("SELECT * FROM production_stable_current WHERE id=1").get();
  if (!row) return null;
  return {
    release_run_id: row.release_run_id == null ? null : Number(row.release_run_id),
    source_sha: row.source_sha,
    artifact_digest: row.artifact_digest,
    workflow_run_id: row.workflow_run_id,
    provenance: parse(row.provenance_json),
    updated_at: row.updated_at,
  };
}

export function seedProductionStable(db, { sourceSha, artifactDigest, workflowRunId, releaseRunId = null, provenance = {}, now = new Date() } = {}) {
  const ts = iso(now);
  db.prepare(`INSERT INTO production_stable_current(id, release_run_id, source_sha, artifact_digest, workflow_run_id, provenance_json, updated_at)
              VALUES (1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET release_run_id=excluded.release_run_id, source_sha=excluded.source_sha, artifact_digest=excluded.artifact_digest, workflow_run_id=excluded.workflow_run_id, provenance_json=excluded.provenance_json, updated_at=excluded.updated_at`)
    .run(releaseRunId, sourceSha, artifactDigest, workflowRunId, JSON.stringify(sanitizeReleaseEvidence(provenance)), ts);
  return getProductionStable(db);
}

function snapshotPreviousStable(db) {
  const cur = getProductionStable(db);
  if (!cur || !cur.source_sha) return { sha: null, digest: null, workflow_run_id: null, provenance: null };
  return {
    sha: cur.source_sha,
    digest: cur.artifact_digest,
    workflow_run_id: cur.workflow_run_id,
    provenance: cur.provenance,
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
    if (allowMasterMovement && (elig.reason === "phase14_clearance_stale" || onlySourceDrift) && onlySourceDrift) {
      // merge 後 master 前進到 authorized head 是預期的；其餘 identity 仍須成立。
      const auth = db.prepare("SELECT * FROM production_release_authorization WHERE id=?").get(Number(run.release_authorization_id));
      if (!auth || auth.status !== "active") throw httpError("release authorization superseded", 409);
      if (!same(auth.manifest_hash, run.manifest_hash) || !same(auth.head_sha, run.authorized_head_sha) || !same(auth.artifact_digest, run.artifact_digest)) {
        throw httpError("authorization identity drifted", 409);
      }
      return { ...elig, allowed: true, reason: "phase15_identities_hold_after_merge" };
    }
    const extra = (elig.stale_reasons || []).join(",");
    throw httpError(`Phase 15 eligibility failed: ${elig.reason}${extra ? ` (${extra})` : ""}`, 409);
  }
  const a = elig.assessment;
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

function reserveBinding(db, { releaseRunId, workflowKind, inputFingerprint, now }) {
  const existing = getBinding(db, releaseRunId, workflowKind);
  if (existing) return existing;
  const key = workflowIdempotencyKey({ releaseRunId, workflowKind, inputFingerprint });
  db.prepare(
    `INSERT INTO production_release_workflow_binding(release_run_id, workflow_kind, idempotency_key, binding_status, created_at)
     VALUES (?,?,?,?,?)`,
  ).run(Number(releaseRunId), workflowKind, key, BINDING_STATUSES.RESERVED, iso(now));
  return getBinding(db, releaseRunId, workflowKind);
}

function saveBindingDispatch(db, bindingId, { workflowRunId, attempt, requestId, responseIdentity, status }) {
  db.prepare(
    `UPDATE production_release_workflow_binding SET workflow_run_id=?, workflow_attempt=?, dispatch_request_id=?, provider_response_identity=?, binding_status=?
     WHERE id=?`,
  ).run(workflowRunId || null, attempt == null ? null : Number(attempt), requestId || null, responseIdentity || null, status, Number(bindingId));
}

async function dispatchOrReconcile(db, {
  run, provider, workflowKind, workflowFile, inputs, environment, confirmation, actor, now, dispatchedStatus, repo, env,
}) {
  let binding = getBinding(db, run.id, workflowKind);
  if (!binding) {
    withImmediateTx(db, () => {
      assertIdentitiesUnchanged(db, run, { repo, env, allowMasterMovement: true }); // repo 仍傳入；僅忽略預期的 master 前進
      reserveBinding(db, { releaseRunId: run.id, workflowKind, inputFingerprint: run.input_fingerprint, now });
    });
    binding = getBinding(db, run.id, workflowKind);
  }

  if (!binding.workflow_run_id && binding.binding_status === BINDING_STATUSES.RESERVED) {
    const dispatched = await provider.dispatchWorkflow({
      workflowFile,
      workflowRef: run.workflow_ref,
      inputs,
      idempotencyKey: binding.idempotency_key,
      expectedHead: run.expected_master_head || null,
      actor,
      environment,
      confirmation,
    });
    let afterDispatchError = null;
    withImmediateTx(db, () => {
      const fresh = getBinding(db, run.id, workflowKind);
      if (fresh.workflow_run_id) return;
      if (!dispatched?.accepted) {
        saveBindingDispatch(db, fresh.id, { status: BINDING_STATUSES.UNKNOWN, requestId: dispatched?.request_id, responseIdentity: dispatched?.provider_response_identity });
        appendEvidence(db, {
          releaseRunId: run.id, kind: `${workflowKind}_dispatch_rejected`, now, workflow_file: workflowFile, workflow_ref: run.workflow_ref,
          target_environment: environment, dispatch_request_id: dispatched?.request_id, provider_response_identity: dispatched?.provider_response_identity,
          payload: { reason: dispatched?.reason || "dispatch_rejected" },
        });
        appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: `${workflowKind}_dispatch_rejected`, reason: dispatched?.reason || "dispatch_rejected", errorCode: dispatched?.reason || "dispatch_rejected", now, actor });
        afterDispatchError = httpError(`workflow dispatch rejected: ${dispatched?.reason || "unknown"}`, 409);
        return;
      }
      if (!dispatched.workflow_run_id) {
        saveBindingDispatch(db, fresh.id, {
          status: BINDING_STATUSES.UNKNOWN,
          requestId: dispatched.request_id,
          responseIdentity: dispatched.provider_response_identity,
        });
        appendEvidence(db, {
          releaseRunId: run.id, kind: `${workflowKind}_dispatch_unverified`, now, workflow_file: workflowFile, workflow_ref: run.workflow_ref,
          target_environment: environment, dispatch_request_id: dispatched.request_id, provider_response_identity: dispatched.provider_response_identity,
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
        target_environment: dispatched.environment || environment, dispatch_request_id: dispatched.request_id,
        provider_response_identity: dispatched.provider_response_identity,
        payload: { accepted: true },
      });
      appendEvent(db, { releaseRunId: run.id, toStatus: dispatchedStatus, eventType: `${workflowKind}_dispatched`, now, actor });
    });
    if (afterDispatchError) throw afterDispatchError;
    binding = getBinding(db, run.id, workflowKind);
  } else if (!binding.workflow_run_id) {
    const found = await provider.findWorkflowRunByIdempotency({ idempotencyKey: binding.idempotency_key });
    if (!found?.id) {
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
      }
    });
    binding = getBinding(db, run.id, workflowKind);
  }

  const wf = await provider.getWorkflowRun({ workflow_run_id: binding.workflow_run_id });
  if (!wf) {
    withImmediateTx(db, () => {
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: `${workflowKind}_missing`, reason: "workflow_run_missing", errorCode: "workflow_run_missing", now, actor });
    });
    throw httpError("workflow run missing", 409);
  }
  if (wf.workflow_ref && wf.workflow_ref !== REQUIRED_WORKFLOW_REF) {
    throw httpError("workflow ref mismatch", 409);
  }
  if (environment && wf.environment && wf.environment !== environment) {
    throw httpError("workflow environment mismatch", 409);
  }
  if (!isSuccessfulConclusion(wf.conclusion, wf.status)) {
    withImmediateTx(db, () => {
      appendEvidence(db, {
        releaseRunId: run.id, kind: `${workflowKind}_conclusion`, now, workflow_name: workflowKind, workflow_file: workflowFile,
        workflow_ref: wf.workflow_ref, workflow_run_id: String(wf.id), workflow_attempt: wf.attempt, workflow_conclusion: wf.conclusion || wf.status,
        workflow_head_sha: wf.head_sha, workflow_actor: wf.actor, target_environment: wf.environment || environment,
        payload: { status: wf.status, conclusion: wf.conclusion },
      });
      appendEvent(db, {
        releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: `${workflowKind}_not_success`,
        reason: `conclusion=${wf.conclusion || "empty"} status=${wf.status || "empty"}`,
        errorCode: "workflow_not_success", now, actor,
      });
    });
    throw httpError(`workflow ${workflowKind} is not success (${wf.status}/${wf.conclusion})`, 409);
  }
  withImmediateTx(db, () => {
    const fresh = getBinding(db, run.id, workflowKind);
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
      workflow_head_sha: wf.head_sha, workflow_actor: wf.actor, target_environment: wf.environment || environment,
      image_digest: wf.outputs?.image_digest || null,
      oci_revision: wf.outputs?.oci_revision || null,
      oci_source: wf.outputs?.oci_source || null,
      db_backup_identity: wf.outputs?.db_backup?.backup_id || null,
      db_backup_hash: wf.outputs?.db_backup?.backup_hash || null,
      payload: sanitizeReleaseEvidence({ outputs: wf.outputs || {} }),
    });
  });
  return { binding: getBinding(db, run.id, workflowKind), workflow: wf };
}

export function createProductionReleaseRun(db, body, { repo = null, env = process.env, now = new Date(), actor = "owner" } = {}) {
  requireExactIdentities(body);
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
    expectedMasterHead: body.expectedMasterHead || "",
    policyFingerprint: policyFp,
  });
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
  const prev = snapshotPreviousStable(db);
  const ts = iso(now);
  return withImmediateTx(db, () => {
    const raced = db.prepare("SELECT * FROM production_release_run WHERE input_fingerprint=?").get(inputFp);
    if (raced) return { idempotent: true, run: publicReleaseRun(db, raced) };
    const version = 1 + (Number(db.prepare("SELECT MAX(run_version) m FROM production_release_run WHERE coding_task_id=?").get(Number(task.id)).m) || 0);
    const res = db.prepare(
      `INSERT INTO production_release_run(
        issue_id, coding_task_id, release_authorization_id, release_authorization_hash, release_manifest_id, release_manifest_version, manifest_hash,
        migration_safety_assessment_id, migration_safety_policy_fingerprint, migration_safety_input_fingerprint, clearance_result,
        proposal_id, qa_run_id, staging_deployment_id, authorized_head_sha, source_tree_hash, artifact_digest, target_environment,
        workflow_file, workflow_ref, expected_master_head, input_fingerprint, policy_fingerprint, run_version,
        previous_stable_sha, previous_stable_digest, previous_stable_workflow_run_id, previous_stable_provenance, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      Number(task.issue_id), Number(task.id), Number(auth.id), auth.authorization_hash, Number(rc.id), Number(rc.manifest_version), rc.manifest_hash,
      Number(a.id), a.policy_fingerprint, a.input_fingerprint, a.clearance_result,
      Number(auth.proposal_id), Number(a.qa_run_id), Number(a.staging_deployment_id), auth.head_sha, rc.source_tree_hash || null, auth.artifact_digest,
      REQUIRED_TARGET_ENVIRONMENT, PRODUCTION_WORKFLOWS.DEPLOY, REQUIRED_WORKFLOW_REF, body.expectedMasterHead || null,
      inputFp, policyFp, version,
      prev.sha, prev.digest, prev.workflow_run_id, prev.provenance ? JSON.stringify(sanitizeReleaseEvidence(prev.provenance)) : null,
      actor, ts,
    );
    const id = Number(res.lastInsertRowid);
    appendEvent(db, { releaseRunId: id, toStatus: RELEASE_STATUSES.CREATED, eventType: "created", now, actor });
    appendAuditRow(db, {
      actor, action: "issue.production_release.created", entityType: "production_release_run", entityId: String(id),
      data: {
        issue_id: Number(task.issue_id), coding_task_id: Number(task.id), release_authorization_id: Number(auth.id),
        manifest_id: Number(rc.id), manifest_hash: rc.manifest_hash, head_sha: auth.head_sha, artifact_digest: auth.artifact_digest,
        assessment_id: Number(a.id), clearance: a.clearance_result,
      }, now,
    });
    return { run: publicReleaseRun(db, db.prepare("SELECT * FROM production_release_run WHERE id=?").get(id)) };
  });
}

async function ensureMasterAncestry(db, run, { provider, repo, now, actor }) {
  if (!repo || !repo.available) throw httpError("release repository gateway unavailable", 503);
  if (repo.isAncestor(run.authorized_head_sha, "master")) return { already: true };
  if (!run.expected_master_head) {
    withImmediateTx(db, () => {
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "ancestry_blocked", reason: "target_sha_not_on_master", errorCode: "master_ancestry_failed", now, actor });
    });
    throw httpError("target SHA is not reachable from protected master", 409);
  }
  const merged = await provider.mergePullRequest({
    sha: run.authorized_head_sha,
    expectedHead: run.expected_master_head,
    repo,
  });
  if (!merged?.ok) {
    withImmediateTx(db, () => {
      appendEvent(db, {
        releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "merge_blocked",
        reason: merged?.reason || "merge_failed", errorCode: merged?.reason || "merge_failed", now, actor,
        evidence: { admin_override: false },
      });
    });
    throw httpError(`protected merge refused: ${merged?.reason || "unknown"}`, 409);
  }
  if (!repo.isAncestor(run.authorized_head_sha, "master")) {
    throw httpError("target SHA is not reachable from protected master after merge", 409);
  }
  withImmediateTx(db, () => {
    appendEvidence(db, { releaseRunId: run.id, kind: "master_merge", now, workflow_head_sha: run.authorized_head_sha, payload: { master_sha: merged.master_sha, already_merged: !!merged.already_merged } });
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.MERGED, eventType: "merged", now, actor });
  });
  return merged;
}

function recordDbDisposition(db, run, { now, actor }) {
  const assessment = db.prepare("SELECT * FROM production_migration_safety_assessment WHERE id=?").get(Number(run.migration_safety_assessment_id));
  const decided = decideDbRollbackDisposition(assessment?.migration_classification);
  withImmediateTx(db, () => {
    appendEvidence(db, {
      releaseRunId: run.id, kind: "db_rollback_disposition", now,
      payload: { classification: assessment?.migration_classification || null, ...decided, auto_restore: false },
    });
    if (decided.disposition === DB_ROLLBACK_DISPOSITIONS.MANUAL_REQUIRED) {
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.DB_ROLLBACK_MANUAL_REQUIRED, eventType: "db_rollback_manual_required", reason: decided.reason, errorCode: decided.disposition, now, actor });
    }
  });
  return decided;
}

async function executeCodeRollback(db, run, { provider, repo, env, now, actor }) {
  const prev = {
    source_sha: run.previous_stable_sha,
    artifact_digest: run.previous_stable_digest,
    workflow_run_id: run.previous_stable_workflow_run_id,
  };
  if (!previousStableComplete(prev)) {
    withImmediateTx(db, () => {
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "rollback_blocked", reason: "previous_stable_incomplete", errorCode: "previous_stable_incomplete", now, actor });
    });
    throw httpError("previous stable identity is incomplete; code rollback blocked", 409);
  }
  if (repo?.available && !repo.isAncestor(prev.source_sha, "master")) {
    throw httpError("previous stable SHA is not reachable from protected master", 409);
  }
  const image = await provider.inspectImage({ sha: prev.source_sha, digest: prev.artifact_digest });
  assertImageBinding({
    digest: image?.digest, ociRevision: image?.oci_revision, ociSource: image?.oci_source,
    authorizedSha: prev.source_sha, authorizedDigest: prev.artifact_digest,
  });
  const { workflow } = await dispatchOrReconcile(db, {
    run, provider, workflowKind: WORKFLOW_KINDS.ROLLBACK, workflowFile: PRODUCTION_WORKFLOWS.DEPLOY,
    inputs: { sha: prev.source_sha, image_digest: prev.artifact_digest, expected_digest: prev.artifact_digest },
    environment: REQUIRED_TARGET_ENVIRONMENT, confirmation: "DEPLOY-PRODUCTION",
    actor, now, dispatchedStatus: RELEASE_STATUSES.CODE_ROLLBACK_DISPATCHED, repo, env,
  });
  const health = await provider.healthSmoke({ imageDigest: prev.artifact_digest, headSha: prev.source_sha });
  if (!health?.passed || !same(health.image_digest, prev.artifact_digest) || !same(health.oci_revision, prev.source_sha)) {
    withImmediateTx(db, () => {
      appendEvidence(db, { releaseRunId: run.id, kind: "rollback_health", now, health_result: health?.health ? "PASS" : "FAIL", smoke_result: health?.passed ? "PASS" : "FAIL", image_digest: health?.image_digest, oci_revision: health?.oci_revision, payload: health });
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.BLOCKED, eventType: "rollback_health_failed", reason: health?.detail || "rollback_health_failed", errorCode: "rollback_health_failed", now, actor });
    });
    throw httpError("code rollback health/smoke failed", 409);
  }
  withImmediateTx(db, () => {
    appendEvidence(db, { releaseRunId: run.id, kind: "rollback_health", now, health_result: "PASS", smoke_result: "PASS", image_digest: health.image_digest, oci_revision: health.oci_revision, payload: health });
    seedProductionStable(db, {
      sourceSha: prev.source_sha, artifactDigest: prev.artifact_digest, workflowRunId: String(workflow.id),
      releaseRunId: run.id, provenance: { kind: "code_rollback", previous_stable_workflow_run_id: prev.workflow_run_id }, now,
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

export async function executeProductionRelease(db, releaseRunId, {
  provider = null, repo = null, env = process.env, now = new Date(), actor = "owner",
} = {}) {
  const prov = provider || makeProductionReleaseProvider(env);
  if (!prov.available) throw httpError("production release provider unavailable", 503);
  const row = db.prepare("SELECT * FROM production_release_run WHERE id=?").get(Number(releaseRunId));
  if (!row) throw httpError("production release run not found", 404);
  let run = row;
  const status = latestStatus(db, run.id);
  if (status === RELEASE_STATUSES.SUCCEEDED || status === RELEASE_STATUSES.ROLLED_BACK) {
    return { run: publicReleaseRun(db, run), current_status: status, idempotent: true };
  }

  withImmediateTx(db, () => {
    const alreadyOnMaster = !!(repo?.available && repo.isAncestor(run.authorized_head_sha, "master"));
    assertIdentitiesUnchanged(db, run, { repo, env, allowMasterMovement: alreadyOnMaster });
    if (latestStatus(db, run.id) === RELEASE_STATUSES.CREATED) {
      appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.ELIGIBILITY_VERIFIED, eventType: "eligibility_verified", now, actor });
    }
  });

  await ensureMasterAncestry(db, run, { provider: prov, repo, now, actor });

  const build = await dispatchOrReconcile(db, {
    run, provider: prov, workflowKind: WORKFLOW_KINDS.BUILD, workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    inputs: { sha: run.authorized_head_sha, expected_digest: run.artifact_digest, image_digest: run.artifact_digest },
    environment: null, actor, now, dispatchedStatus: RELEASE_STATUSES.BUILD_DISPATCHED, repo, env,
  });
  const inspected = await prov.inspectImage({ sha: run.authorized_head_sha, digest: run.artifact_digest });
  const buildDigest = inspected?.digest || build.workflow.outputs?.image_digest;
  try {
    assertImageBinding({
      digest: buildDigest, ociRevision: inspected?.oci_revision || build.workflow.outputs?.oci_revision,
      ociSource: inspected?.oci_source || build.workflow.outputs?.oci_source,
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

  const deploy = await dispatchOrReconcile(db, {
    run, provider: prov, workflowKind: WORKFLOW_KINDS.DEPLOY, workflowFile: PRODUCTION_WORKFLOWS.DEPLOY,
    inputs: { sha: run.authorized_head_sha, image_digest: run.artifact_digest },
    environment: REQUIRED_TARGET_ENVIRONMENT, confirmation: "DEPLOY-PRODUCTION",
    actor, now, dispatchedStatus: RELEASE_STATUSES.DEPLOY_DISPATCHED, repo, env,
  });
  withImmediateTx(db, () => {
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.DEPLOY_RECONCILED, eventType: "deploy_reconciled", now, actor });
  });

  const health = await prov.healthSmoke({ imageDigest: run.artifact_digest, headSha: run.authorized_head_sha });
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
    await executeCodeRollback(db, run, { provider: prov, repo, env, now, actor });
    return { run: publicReleaseRun(db, db.prepare("SELECT * FROM production_release_run WHERE id=?").get(run.id)), rolled_back: true, db_restore: false };
  }

  withImmediateTx(db, () => {
    appendEvidence(db, {
      releaseRunId: run.id, kind: "health_smoke", now, health_result: "PASS", smoke_result: "PASS",
      image_digest: health.image_digest, oci_revision: health.oci_revision, payload: health,
    });
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.HEALTH_VERIFIED, eventType: "health_verified", now, actor });
    seedProductionStable(db, {
      sourceSha: run.authorized_head_sha, artifactDigest: run.artifact_digest, workflowRunId: String(deploy.workflow.id),
      releaseRunId: run.id,
      provenance: { kind: "release_succeeded", workflow_file: PRODUCTION_WORKFLOWS.DEPLOY, workflow_ref: REQUIRED_WORKFLOW_REF, attempt: deploy.workflow.attempt },
      now,
    });
    appendEvent(db, { releaseRunId: run.id, toStatus: RELEASE_STATUSES.SUCCEEDED, eventType: "succeeded", now, actor });
    appendAuditRow(db, {
      actor, action: "issue.production_release.succeeded", entityType: "production_release_run", entityId: String(run.id),
      data: { coding_task_id: Number(run.coding_task_id), head_sha: run.authorized_head_sha, artifact_digest: run.artifact_digest, workflow_run_id: String(deploy.workflow.id) }, now,
    });
  });
  const dbDisp = recordDbDisposition(db, run, { now, actor });
  return { run: publicReleaseRun(db, db.prepare("SELECT * FROM production_release_run WHERE id=?").get(run.id)), current_stable: getProductionStable(db), db_rollback: dbDisp, db_restore: false };
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
  releaseRunId, previousStableSha, previousStableDigest, previousStableWorkflowRunId, provider, repo, env = process.env, now = new Date(), actor = "owner",
} = {}) {
  const row = db.prepare("SELECT * FROM production_release_run WHERE id=?").get(Number(releaseRunId));
  if (!row) throw httpError("production release run not found", 404);
  if (!same(previousStableSha, row.previous_stable_sha) || !same(previousStableDigest, row.previous_stable_digest) || !same(previousStableWorkflowRunId, row.previous_stable_workflow_run_id)) {
    throw httpError("previous stable identity mismatch", 409);
  }
  const prov = provider || makeProductionReleaseProvider(env);
  if (!prov.available) throw httpError("production release provider unavailable", 503);
  const result = await executeCodeRollback(db, row, { provider: prov, repo, env, now, actor });
  return { run: publicReleaseRun(db, db.prepare("SELECT * FROM production_release_run WHERE id=?").get(row.id)), ...result };
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
      provider_response_identity: b.provider_response_identity,
      binding_status: b.binding_status,
      created_at: b.created_at,
    })),
    current_stable: getProductionStable(db),
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
    current_stable: getProductionStable(db),
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
