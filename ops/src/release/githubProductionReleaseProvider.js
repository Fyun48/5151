import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  PRODUCTION_RELEASE_PROVIDER_VERSION,
  PRODUCTION_WORKFLOWS,
  REQUIRED_OCI_SOURCE,
  REQUIRED_TARGET_ENVIRONMENT,
  REQUIRED_WORKFLOW_REF,
  digestLooksImmutable,
  isAuthorizedGithubActor,
} from "./productionReleasePolicy.js";

// Fail-closed GitHub Actions adapter for Phase 15.
// 只用既有 protected manual workflows；Ops 不持、不回傳 Production / GitHub secrets。
// GitHub workflow_dispatch 回 204 且沒有 run id：必須用 durable intent + 獨立查詢綁定恰好一筆 run。
// 測試只注入 fake API；沒有 Owner mutation grant 時永遠 unavailable。

export const PRODUCTION_RELEASE_MUTATION_GRANT = "owner-dispatch-v1";

const ALLOWED_WORKFLOWS = new Set(Object.values(PRODUCTION_WORKFLOWS));

function sha256(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

function missing(v) {
  return v == null || v === "";
}

function parseRepo(env = {}) {
  const raw = String(env.GITHUB_REPOSITORY || env.PRODUCTION_RELEASE_GITHUB_REPOSITORY || "Fyun48/5151");
  const [owner, repo] = raw.split("/");
  if (!owner || !repo || owner !== "Fyun48" || repo !== "5151") return null;
  return { owner, repo };
}

function workflowInputs({ workflowFile, inputs = {}, confirmation } = {}) {
  const sha = inputs.sha;
  if (!/^[0-9a-f]{40}$/.test(String(sha || ""))) return { ok: false, reason: "sha_not_exact" };
  if (workflowFile === PRODUCTION_WORKFLOWS.BUILD) {
    return { ok: true, inputs: { sha } };
  }
  if (workflowFile === PRODUCTION_WORKFLOWS.PREDEPLOY) {
    const confirm = confirmation || inputs.confirmation;
    if (confirm !== "PREDEPLOY-PRODUCTION") return { ok: false, reason: "confirmation_mismatch" };
    return { ok: true, inputs: { sha, confirmation: confirm } };
  }
  if (workflowFile === PRODUCTION_WORKFLOWS.DEPLOY) {
    const digest = inputs.image_digest || inputs.expected_digest;
    if (!digestLooksImmutable(digest)) return { ok: false, reason: "digest_not_immutable" };
    const confirm = confirmation || inputs.confirmation || "DEPLOY-PRODUCTION";
    if (confirm !== "DEPLOY-PRODUCTION") return { ok: false, reason: "confirmation_mismatch" };
    return { ok: true, inputs: { sha, image_digest: digest, confirmation: confirm } };
  }
  return { ok: false, reason: "workflow_not_allowed" };
}

function loginOf(actor) {
  if (!actor) return null;
  if (typeof actor === "string") return actor;
  return actor.login || null;
}

function createdAfterOk(createdAt, createdAfter) {
  if (!createdAfter) return true;
  return String(createdAt || "") >= String(createdAfter);
}

export function correlateGithubWorkflowRuns(runs, expected = {}) {
  const matches = (runs || []).filter((run) => {
    const actor = loginOf(run.actor);
    const triggering = loginOf(run.triggering_actor);
    const file = run.path || run.workflow_file;
    const sha = run.head_sha;
    if (expected.workflowFile && file !== expected.workflowFile) return false;
    if (expected.headSha && sha !== expected.headSha) return false;
    if (expected.actor && actor !== expected.actor) return false;
    if (expected.actor && triggering !== expected.actor) return false;
    if (run.event && run.event !== "workflow_dispatch") return false;
    if (!createdAfterOk(run.created_at, expected.createdAfter)) return false;
    return true;
  });
  if (matches.length === 0) return { run: null, ambiguous: false, matches: [] };
  if (matches.length > 1) return { run: null, ambiguous: true, matches };
  return { run: matches[0], ambiguous: false, matches };
}

export function normalizeGithubWorkflowRun(raw, extras = {}) {
  if (!raw) return null;
  const jobs = extras.jobs || raw.jobs || [];
  const environment = extras.environment
    || raw.environment
    || jobs.map((j) => j.environment?.name || j.environment).find(Boolean)
    || null;
  const outputs = extras.outputs || raw.outputs || {};
  const actor = loginOf(raw.actor);
  const triggering = loginOf(raw.triggering_actor);
  return {
    id: raw.id != null ? String(raw.id) : null,
    attempt: raw.run_attempt != null ? Number(raw.run_attempt) : (raw.attempt != null ? Number(raw.attempt) : null),
    status: raw.status || null,
    conclusion: raw.conclusion ?? null,
    workflow_file: raw.path || raw.workflow_file || null,
    workflow_ref: raw.workflow_ref || (raw.head_branch === "master" ? REQUIRED_WORKFLOW_REF : null),
    head_sha: raw.head_sha || null,
    actor,
    triggering_actor: triggering,
    environment: environment || null,
    outputs,
    created_at: raw.created_at || null,
    event: raw.event || "workflow_dispatch",
    request_id: extras.request_id || raw.request_id || null,
    provider_response_identity: extras.provider_response_identity || raw.provider_response_identity || null,
  };
}

function unavailable(setup) {
  const err = () => {
    throw Object.assign(new Error("github production release provider unavailable"), { status: 503, code: "provider_unavailable" });
  };
  return {
    name: "github",
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

export function githubProviderLiveEnabled(env = process.env) {
  return String(env.PRODUCTION_RELEASE_MUTATION_GRANT || "") === PRODUCTION_RELEASE_MUTATION_GRANT
    && String(env.PRODUCTION_RELEASE_ALLOW_LIVE || "") === "1"
    && isAuthorizedGithubActor(env.PRODUCTION_RELEASE_GITHUB_ACTOR)
    && !!(env.GITHUB_TOKEN || env.GH_TOKEN);
}

export function githubProviderAvailable(env = process.env, deps = {}) {
  const grant = String(env.PRODUCTION_RELEASE_MUTATION_GRANT || "") === PRODUCTION_RELEASE_MUTATION_GRANT;
  const actor = isAuthorizedGithubActor(env.PRODUCTION_RELEASE_GITHUB_ACTOR);
  const repo = parseRepo(env);
  if (!grant || !actor || !repo) return false;
  if (deps.githubApi) return true;
  return githubProviderLiveEnabled(env);
}

function redactGithubError(err) {
  const msg = String(err?.message || err || "github_api_error").replace(/ghs_|github_pat_|ghp_[A-Za-z0-9_]+/g, "[REDACTED]");
  return msg.slice(0, 240);
}

export function createLiveGithubApi(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  async function gh(path, { method = "GET", body = null, accept = "application/vnd.github+json" } = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "5151-ops-phase15",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }
  return {
    async dispatchWorkflow({ owner, repo, workflowFile, ref, inputs }) {
      const encoded = encodeURIComponent(workflowFile);
      const res = await gh(`/repos/${owner}/${repo}/actions/workflows/${encoded}/dispatches`, {
        method: "POST",
        body: { ref: ref.replace(/^refs\/heads\//, ""), inputs },
      });
      return { status: res.status, ok: res.status === 204 };
    },
    async listWorkflowRuns({ owner, repo, workflowFile }) {
      const encoded = encodeURIComponent(workflowFile);
      const res = await gh(`/repos/${owner}/${repo}/actions/workflows/${encoded}/runs?event=workflow_dispatch&per_page=30`);
      if (!res.ok) return { runs: [] };
      const json = await res.json();
      return { runs: json.workflow_runs || [] };
    },
    async getWorkflowRun({ owner, repo, runId }) {
      const runRes = await gh(`/repos/${owner}/${repo}/actions/runs/${runId}`);
      if (!runRes.ok) return null;
      const run = await runRes.json();
      const jobsRes = await gh(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
      const jobsJson = jobsRes.ok ? await jobsRes.json() : { jobs: [] };
      return { run, jobs: jobsJson.jobs || [] };
    },
    async inspectImage({ digest }) {
      const res = await fetch(`https://ghcr.io/v2/fyun48/5151/manifests/${digest}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json",
          "User-Agent": "5151-ops-phase15",
        },
      });
      if (!res.ok) return null;
      const observed = res.headers.get("docker-content-digest") || digest;
      return { digest: observed };
    },
    async healthSmoke({ url }) {
      const res = await fetch(url, { method: "GET", redirect: "manual" });
      return { status: res.status, ok: res.ok };
    },
  };
}

export function makeGithubProductionReleaseProvider(env = process.env, deps = {}) {
  const setup = {
    status: "mutations_disabled",
    required: [
      "Owner-controlled workflow_dispatch on existing Production workflows only.",
      "Protected GitHub production environment; Ops must not store or return Production secrets.",
      "PRODUCTION_RELEASE_PROVIDER=github plus PRODUCTION_RELEASE_MUTATION_GRANT=owner-dispatch-v1.",
      "Exact SHA + immutable image digest + workflow ref refs/heads/master.",
      "Authorized GitHub login captured immutably at intent creation.",
    ],
  };
  if (!githubProviderAvailable(env, deps)) {
    return unavailable(setup);
  }
  const repo = parseRepo(env);
  const authorizedActor = env.PRODUCTION_RELEASE_GITHUB_ACTOR;
  const api = deps.githubApi || createLiveGithubApi(env);
  const acceptedIntents = deps.acceptedIntents || new Set();
  let dispatchCount = 0;
  let restoreCallCount = 0;

  async function lookupExactRun({ workflowFile, headSha, createdAfter }) {
    const listed = await api.listWorkflowRuns({
      owner: repo.owner,
      repo: repo.repo,
      workflowFile,
    });
    const correlated = correlateGithubWorkflowRuns(listed.runs || [], {
      workflowFile,
      headSha,
      actor: authorizedActor,
      createdAfter,
    });
    if (correlated.ambiguous) return { ambiguous: true, id: null };
    if (!correlated.run) return null;
    const detail = await api.getWorkflowRun({ owner: repo.owner, repo: repo.repo, runId: correlated.run.id });
    const raw = detail?.run || correlated.run;
    return normalizeGithubWorkflowRun(raw, { jobs: detail?.jobs, outputs: detail?.outputs || correlated.run.outputs });
  }

  return {
    name: "github",
    available: true,
    version: PRODUCTION_RELEASE_PROVIDER_VERSION,
    setup: { status: "granted", repository: `${repo.owner}/${repo.repo}`, workflows: [...ALLOWED_WORKFLOWS] },
    get dispatchCount() { return dispatchCount; },
    get restoreCallCount() { return restoreCallCount; },

    async dispatchWorkflow({
      workflowFile, workflowRef, inputs = {}, actor, environment, confirmation, requestId, expectedHead,
    } = {}) {
      if (!ALLOWED_WORKFLOWS.has(workflowFile)) {
        return { accepted: false, reason: "workflow_not_allowed", workflow_run_id: null };
      }
      if (workflowRef && workflowRef !== REQUIRED_WORKFLOW_REF) {
        return { accepted: false, reason: "workflow_ref_mismatch", workflow_run_id: null };
      }
      if (actor && actor !== authorizedActor) {
        return { accepted: false, reason: "actor_mismatch", workflow_run_id: null };
      }
      if (environment && environment !== REQUIRED_TARGET_ENVIRONMENT && workflowFile !== PRODUCTION_WORKFLOWS.BUILD) {
        return { accepted: false, reason: "environment_mismatch", workflow_run_id: null };
      }
      const prepared = workflowInputs({ workflowFile, inputs, confirmation });
      if (!prepared.ok) return { accepted: false, reason: prepared.reason, workflow_run_id: null };
      if (expectedHead && inputs.expected_head && expectedHead !== inputs.expected_head) {
        return { accepted: false, reason: "expected_head_race", workflow_run_id: null };
      }

      const intent = requestId || `gh-intent-${sha256(`${workflowFile}|${prepared.inputs.sha}|${authorizedActor}`).slice(0, 16)}`;
      if (acceptedIntents.has(intent)) {
        const found = await lookupExactRun({
          workflowFile,
          headSha: prepared.inputs.sha,
        });
        if (found?.ambiguous) return { accepted: false, reason: "ambiguous_workflow_run", workflow_run_id: null };
        return {
          accepted: true,
          idempotent: true,
          pending_lookup: !found?.id,
          workflow_run_id: found?.id || null,
          attempt: found?.attempt || null,
          request_id: intent,
          provider_response_identity: `github-dispatch-${sha256(intent).slice(0, 20)}`,
        };
      }

      let dispatched;
      try {
        dispatched = await api.dispatchWorkflow({
          owner: repo.owner,
          repo: repo.repo,
          workflowFile,
          ref: "master",
          inputs: prepared.inputs,
        });
      } catch (err) {
        if (err?.code === "dispatch_timeout") {
          return { accepted: true, timeout: true, workflow_run_id: null, request_id: intent, provider_response_identity: `github-timeout-${sha256(intent).slice(0, 20)}` };
        }
        return { accepted: false, reason: redactGithubError(err), workflow_run_id: null, request_id: intent };
      }
      if (dispatched?.timeout) {
        return { accepted: true, timeout: true, workflow_run_id: null, request_id: intent, provider_response_identity: `github-timeout-${sha256(intent).slice(0, 20)}` };
      }
      if (!dispatched || dispatched.status !== 204) {
        return {
          accepted: false,
          reason: dispatched?.reason || `dispatch_http_${dispatched?.status || "unknown"}`,
          workflow_run_id: null,
          request_id: intent,
        };
      }
      dispatchCount += 1;
      acceptedIntents.add(intent);
      if (deps.crashAfterAccept) {
        throw Object.assign(new Error("crash after dispatch response"), { code: "crash_after_dispatch" });
      }
      const found = await lookupExactRun({ workflowFile, headSha: prepared.inputs.sha });
      if (found?.ambiguous) return { accepted: false, reason: "ambiguous_workflow_run", workflow_run_id: null, request_id: intent };
      return {
        accepted: true,
        pending_lookup: !found?.id,
        workflow_run_id: found?.id || null,
        attempt: found?.attempt || null,
        head_sha: prepared.inputs.sha,
        workflow_ref: REQUIRED_WORKFLOW_REF,
        actor: authorizedActor,
        environment: workflowFile === PRODUCTION_WORKFLOWS.BUILD ? null : (environment || REQUIRED_TARGET_ENVIRONMENT),
        request_id: intent,
        provider_response_identity: `github-dispatch-${sha256(intent).slice(0, 20)}`,
      };
    },

    async getWorkflowRun({ workflow_run_id } = {}) {
      if (!workflow_run_id) return null;
      const detail = await api.getWorkflowRun({ owner: repo.owner, repo: repo.repo, runId: workflow_run_id });
      if (!detail?.run && !detail?.id) return null;
      const raw = detail.run || detail;
      return normalizeGithubWorkflowRun(raw, { jobs: detail.jobs, outputs: detail.outputs || raw.outputs });
    },

    async findWorkflowRunByIdempotency({
      workflowFile, headSha, createdAfter,
    } = {}) {
      if (missing(workflowFile) || missing(headSha)) return null;
      const found = await lookupExactRun({ workflowFile, headSha, createdAfter });
      if (found?.ambiguous) return { ambiguous: true, id: null };
      return found;
    },

    async inspectImage({ sha, digest } = {}) {
      if (!digestLooksImmutable(digest)) return null;
      if (typeof api.inspectImage === "function") {
        const inspected = await api.inspectImage({ sha, digest });
        if (!inspected) return null;
        return {
          digest: inspected.digest || digest,
          oci_revision: inspected.oci_revision || sha,
          oci_source: inspected.oci_source || REQUIRED_OCI_SOURCE,
        };
      }
      return { digest, oci_revision: sha, oci_source: REQUIRED_OCI_SOURCE };
    },

    async mergePullRequest({ sha, expectedHead, repo: gitRepo } = {}) {
      if (!gitRepo || !gitRepo.available) return { ok: false, reason: "repo_unavailable" };
      const master = gitRepo.resolveRef("master");
      if (expectedHead && String(master) !== String(expectedHead)) {
        return { ok: false, reason: "expected_head_race", current_master: master, expected_head: expectedHead, admin_override: false };
      }
      if (gitRepo.isAncestor && gitRepo.isAncestor(sha, "master")) {
        return { ok: true, already_merged: true, master_sha: master };
      }
      try {
        execFileSync("git", ["-C", gitRepo.repoPath, "merge", "--ff-only", sha], { encoding: "utf8" });
      } catch (err) {
        return { ok: false, reason: "branch_protection_rejected", detail: redactGithubError(err), admin_override: false };
      }
      return { ok: true, merged: true, master_sha: gitRepo.resolveRef("master") };
    },

    async healthSmoke({ imageDigest, headSha } = {}) {
      if (typeof api.healthSmoke === "function") {
        const raw = await api.healthSmoke({ imageDigest, headSha, url: env.PRODUCTION_PUBLIC_HEALTH_URL || null });
        if (!raw) return { passed: false, health: false, landing: false, login: false, container_running: false, image_digest: imageDigest, oci_revision: headSha, detail: "health_unavailable" };
        const passed = raw.passed != null ? !!raw.passed : !!raw.ok;
        return {
          passed,
          health: raw.health != null ? !!raw.health : passed,
          landing: raw.landing != null ? !!raw.landing : passed,
          login: raw.login != null ? !!raw.login : passed,
          container_running: raw.container_running != null ? !!raw.container_running : passed,
          image_digest: raw.image_digest || imageDigest,
          oci_revision: raw.oci_revision || headSha,
          detail: raw.detail || null,
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
}
