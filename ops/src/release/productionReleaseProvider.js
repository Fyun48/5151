import { createHash, randomUUID } from "node:crypto";
import {
  PRODUCTION_RELEASE_PROVIDER_VERSION,
  PRODUCTION_WORKFLOWS,
  REQUIRED_OCI_SOURCE,
  REQUIRED_TARGET_ENVIRONMENT,
  REQUIRED_WORKFLOW_REF,
} from "./productionReleasePolicy.js";
import { makeGithubProductionReleaseProvider as makeBoundGithubProductionReleaseProvider } from "./githubProductionReleaseProvider.js";

// Phase 15 廠商中立 Production release provider。
// 概念能力：dispatchWorkflow / getWorkflowRun / findByIdempotency / inspectImage / mergePullRequest / healthSmoke。
// 決定性 stub（測試）；正式 adapter 僅能呼叫既有受保護 CI/CD，Ops 不直接 SSH、不持 Production secrets。
// 預設 unavailable。測試與本機開發只使用 stub。GitHub adapter 預設拒絕，避免誤 dispatch。

function sha256(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

function unavailable(name, setup) {
  const err = () => {
    const e = Object.assign(new Error(`${name} production release provider unavailable`), { status: 503, code: "provider_unavailable" });
    throw e;
  };
  return {
    name,
    available: false,
    version: PRODUCTION_RELEASE_PROVIDER_VERSION,
    setup,
    restoreCallCount: 0,
    dispatchCount: 0,
    async dispatchWorkflow() { err(); },
    async getWorkflowRun() { err(); },
    async findWorkflowRunByIdempotency() { err(); },
    async inspectImage() { err(); },
    async mergePullRequest() { err(); },
    async healthSmoke() { err(); },
    async restoreDatabase() { err(); },
  };
}

export function makeStubProductionReleaseProvider(opts = {}) {
  const runsById = new Map();
  const runsByKey = new Map();
  let seq = opts.startRunId || 34000000000;
  let dispatchCount = 0;
  let restoreCallCount = 0;

  function nextId() { seq += 1; return String(seq); }

  function storedRun(partial) {
    const run = {
      id: partial.id,
      attempt: partial.attempt || 1,
      status: partial.status || "completed",
      conclusion: partial.conclusion ?? "success",
      head_sha: partial.head_sha,
      workflow_file: partial.workflow_file,
      workflow_ref: partial.workflow_ref || REQUIRED_WORKFLOW_REF,
      actor: partial.actor || opts.actor || "Fyun48",
      triggering_actor: partial.triggering_actor || partial.actor || opts.actor || "Fyun48",
      environment: partial.environment ?? null,
      inputs: partial.inputs || {},
      outputs: partial.outputs || {},
      idempotency_key: partial.idempotency_key,
      request_id: partial.request_id,
      provider_response_identity: partial.provider_response_identity,
    };
    runsById.set(run.id, run);
    if (run.idempotency_key) runsByKey.set(run.idempotency_key, run);
    return run;
  }

  const self = {
    name: "stub",
    available: true,
    version: PRODUCTION_RELEASE_PROVIDER_VERSION,
    healthFailFor: opts.healthFailFor || null,
    get dispatchCount() { return dispatchCount; },
    get restoreCallCount() { return restoreCallCount; },
    _runsById: runsById,
    _runsByKey: runsByKey,

    async dispatchWorkflow({
      workflowFile, workflowRef, inputs = {}, idempotencyKey, expectedHead, actor, environment, confirmation, requestId: persistRequestId,
    } = {}) {
      if (opts.dispatchDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, Number(opts.dispatchDelayMs)));
      }
      if (opts.deduplicate !== false && runsByKey.has(idempotencyKey)) {
        const existing = runsByKey.get(idempotencyKey);
        return {
          accepted: true,
          idempotent: true,
          workflow_run_id: existing.id,
          attempt: existing.attempt,
          head_sha: existing.head_sha,
          workflow_ref: existing.workflow_ref,
          actor: existing.actor,
          environment: existing.environment,
          request_id: existing.request_id,
          provider_response_identity: existing.provider_response_identity,
        };
      }

      if (workflowRef && workflowRef !== REQUIRED_WORKFLOW_REF) {
        return { accepted: false, reason: "workflow_ref_mismatch", workflow_run_id: null };
      }
      if (opts.requireActor && actor && actor !== opts.requireActor) {
        return { accepted: false, reason: "actor_mismatch", workflow_run_id: null };
      }
      if (environment && environment !== REQUIRED_TARGET_ENVIRONMENT && workflowFile !== PRODUCTION_WORKFLOWS.BUILD) {
        return { accepted: false, reason: "environment_mismatch", workflow_run_id: null };
      }
      if (opts.expectedHead && expectedHead && expectedHead !== opts.expectedHead) {
        return { accepted: false, reason: "expected_head_race", workflow_run_id: null };
      }

      dispatchCount += 1;
      const requestId = persistRequestId || opts.requestId || `stub-req-${sha256(idempotencyKey).slice(0, 16)}`;
      const responseIdentity = `stub-dispatch-${sha256(`${idempotencyKey}|${requestId}`).slice(0, 20)}`;

      if (opts.dispatchTimeout) {
        return { accepted: true, timeout: true, workflow_run_id: null, request_id: requestId, provider_response_identity: responseIdentity };
      }
      if (opts.dispatchNoRunId) {
        return { accepted: true, workflow_run_id: null, request_id: requestId, provider_response_identity: responseIdentity };
      }

      const conclusionMap = opts.conclusions || {};
      const pendingSet = new Set(opts.pendingWorkflows || []);
      const conclusion = Object.prototype.hasOwnProperty.call(conclusionMap, workflowFile)
        ? conclusionMap[workflowFile]
        : "success";
      const pending = pendingSet.has(workflowFile) || !!opts.leavePending;
      const digest = inputs.image_digest || inputs.expected_digest || opts.imageDigest || null;
      const sha = inputs.sha || null;
      const run = storedRun({
        id: nextId(),
        status: pending ? "in_progress" : "completed",
        conclusion: pending ? null : conclusion,
        head_sha: sha,
        workflow_file: workflowFile,
        workflow_ref: workflowRef || REQUIRED_WORKFLOW_REF,
        actor: actor || opts.actor || "Fyun48",
        triggering_actor: actor || opts.actor || "Fyun48",
        environment: workflowFile === PRODUCTION_WORKFLOWS.BUILD ? null : (environment || REQUIRED_TARGET_ENVIRONMENT),
        inputs,
        idempotency_key: idempotencyKey,
        request_id: requestId,
        provider_response_identity: responseIdentity,
        outputs: {
          image_digest: digest,
          oci_revision: sha,
          oci_source: REQUIRED_OCI_SOURCE,
          confirmation: confirmation || null,
          db_backup: workflowFile === PRODUCTION_WORKFLOWS.PREDEPLOY ? {
            backup_id: opts.missingBackup ? null : `stub-backup-${sha256(sha || "none").slice(0, 16)}`,
            backup_hash: opts.unverifiedBackup ? null : `sha256:${sha256(`backup|${sha}|verified`)}`,
            verified: !opts.missingBackup && !opts.unverifiedBackup,
            location_class: "isolated_stub",
            current_stable_sha: opts.currentStableSha || null,
            current_stable_digest: opts.currentStableDigest || null,
          } : null,
        },
      });
      return {
        accepted: true,
        workflow_run_id: run.id,
        attempt: run.attempt,
        head_sha: run.head_sha,
        workflow_ref: run.workflow_ref,
        actor: run.actor,
        environment: run.environment,
        request_id: run.request_id,
        provider_response_identity: run.provider_response_identity,
      };
    },

    async getWorkflowRun({ workflow_run_id } = {}) {
      if (!workflow_run_id) return null;
      return runsById.get(String(workflow_run_id)) || null;
    },

    async findWorkflowRunByIdempotency({ idempotencyKey } = {}) {
      if (!idempotencyKey) return null;
      return runsByKey.get(String(idempotencyKey)) || null;
    },

    async inspectImage({ sha, digest } = {}) {
      if (opts.imageMissingLabels) {
        return { digest: digest || opts.imageDigest, oci_revision: null, oci_source: null };
      }
      if (opts.imageMismatch) {
        return {
          digest: opts.mismatchDigest || "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          oci_revision: opts.mismatchRevision || "0".repeat(40),
          oci_source: opts.mismatchSource || "https://github.com/other/repo",
        };
      }
      if (opts.imageMissing) return null;
      return {
        digest: digest || opts.imageDigest,
        oci_revision: sha,
        oci_source: REQUIRED_OCI_SOURCE,
      };
    },

    async mergePullRequest({ sha, repo } = {}) {
      if (opts.protectionReject) {
        return { ok: false, reason: "branch_protection_rejected", admin_override: false };
      }
      if (!repo || !repo.available) return { ok: false, reason: "repo_unavailable" };
      if (typeof repo.isRemoteAncestor === "function" && repo.isRemoteAncestor(sha, "master")) {
        return { ok: true, already_merged: true, master_sha: repo.resolveRemoteRef("master"), admin_override: false };
      }
      return { ok: false, reason: "target_sha_not_on_protected_master", admin_override: false, local_only: true };
    },

    async healthSmoke({ imageDigest, headSha } = {}) {
      if (opts.healthHttpOnly) {
        return {
          passed: false, health: false, landing: false, login: false, container_running: false,
          image_digest: null, oci_revision: null, detail: "health_evidence_missing", http_status: 200,
        };
      }
      const failFor = self.healthFailFor || opts.healthFailFor;
      if (failFor && imageDigest === failFor) {
        return {
          passed: false,
          health: false,
          landing: true,
          login: true,
          container_running: true,
          image_digest: imageDigest,
          oci_revision: headSha,
          detail: "health_endpoint_failed",
        };
      }
      if (opts.healthFail) {
        return {
          passed: false,
          health: false,
          landing: true,
          login: true,
          container_running: true,
          image_digest: imageDigest,
          oci_revision: headSha,
          detail: "health_endpoint_failed",
        };
      }
      if (opts.smokeFail) {
        return {
          passed: false,
          health: true,
          landing: true,
          login: false,
          container_running: true,
          image_digest: imageDigest,
          oci_revision: headSha,
          detail: "login_smoke_failed",
        };
      }
      if (opts.healthDigestMismatch) {
        return {
          passed: false,
          health: true,
          landing: true,
          login: true,
          container_running: true,
          image_digest: "sha256:" + "ab".repeat(32),
          oci_revision: headSha,
          detail: "running_digest_mismatch",
        };
      }
      return {
        passed: true,
        health: true,
        landing: true,
        login: true,
        container_running: true,
        image_digest: imageDigest,
        oci_revision: headSha,
      };
    },

    async restoreDatabase() {
      restoreCallCount += 1;
      throw Object.assign(new Error("automatic production DB restore is forbidden"), { code: "db_restore_forbidden", status: 409 });
    },
  };
  return self;
}

export function makeGithubProductionReleaseProvider(env = process.env, deps = {}) {
  return makeBoundGithubProductionReleaseProvider(env, deps);
}

export function makeProductionReleaseProvider(env = process.env) {
  const kind = String(env.PRODUCTION_RELEASE_PROVIDER || "").toLowerCase();
  if (kind === "stub") return makeStubProductionReleaseProvider();
  if (kind === "github" || kind === "actions") return makeGithubProductionReleaseProvider(env);
  return unavailable("none", {
    status: "not_configured",
    required: ["Set PRODUCTION_RELEASE_PROVIDER=stub for isolated tests. Production mutations stay manual-only."],
  });
}

export function newDispatchRequestId() {
  return randomUUID();
}
