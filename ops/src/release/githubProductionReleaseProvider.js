import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
export const PHASE15_EVIDENCE_ARTIFACT = "phase15-workflow-evidence";
export const PHASE15_EVIDENCE_SCHEMA = "phase15-workflow-evidence-v1";

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

function workflowInputs({ workflowFile, inputs = {}, confirmation, releaseIntentId } = {}) {
  const sha = inputs.sha;
  if (!/^[0-9a-f]{40}$/.test(String(sha || ""))) return { ok: false, reason: "sha_not_exact" };
  const intent = releaseIntentId || inputs.release_intent_id || "";
  if (!intent || String(intent).length < 16) return { ok: false, reason: "release_intent_missing" };
  const withIntent = { sha, release_intent_id: String(intent) };
  if (workflowFile === PRODUCTION_WORKFLOWS.BUILD) {
    return { ok: true, inputs: withIntent };
  }
  if (workflowFile === PRODUCTION_WORKFLOWS.PREDEPLOY) {
    const confirm = confirmation || inputs.confirmation;
    if (confirm !== "PREDEPLOY-PRODUCTION") return { ok: false, reason: "confirmation_mismatch" };
    return { ok: true, inputs: { ...withIntent, confirmation: confirm } };
  }
  if (workflowFile === PRODUCTION_WORKFLOWS.DEPLOY) {
    const digest = inputs.image_digest || inputs.expected_digest;
    if (!digestLooksImmutable(digest)) return { ok: false, reason: "digest_not_immutable" };
    const confirm = confirmation || inputs.confirmation || "DEPLOY-PRODUCTION";
    if (confirm !== "DEPLOY-PRODUCTION") return { ok: false, reason: "confirmation_mismatch" };
    return { ok: true, inputs: { ...withIntent, image_digest: digest, confirmation: confirm } };
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

export function ociLabelsFromConfig(config) {
  if (!config || typeof config !== "object") return { revision: null, source: null };
  const labels = config.config?.Labels || config.Labels || config.config?.labels || {};
  const revision = labels["org.opencontainers.image.revision"] || null;
  const source = labels["org.opencontainers.image.source"] || null;
  return { revision: revision || null, source: source || null };
}

export function sealPhase15Evidence(doc) {
  const rest = { ...doc };
  delete rest.evidence_sha256;
  const canonical = JSON.stringify(sortKeys(rest));
  return { ...rest, evidence_sha256: `sha256:${sha256(canonical)}` };
}

export function verifyPhase15EvidenceDigest(evidence) {
  if (!evidence || typeof evidence !== "object") return false;
  const expected = evidence.evidence_sha256;
  if (!/^sha256:[a-f0-9]{64}$/.test(String(expected || ""))) return false;
  const rest = { ...evidence };
  delete rest.evidence_sha256;
  const canonical = JSON.stringify(sortKeys(rest));
  return `sha256:${sha256(canonical)}` === expected;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

export function bindPhase15EvidenceToRun(evidence, run, expected = {}) {
  if (!evidence || evidence.schema !== PHASE15_EVIDENCE_SCHEMA) return null;
  if (!verifyPhase15EvidenceDigest(evidence)) return null;
  if (String(evidence.workflow_run_id) !== String(run.id)) return null;
  if (Number(evidence.workflow_attempt) !== Number(run.run_attempt || run.attempt)) return null;
  if (evidence.workflow_file && (run.path || run.workflow_file) && evidence.workflow_file !== (run.path || run.workflow_file)) return null;
  if (evidence.workflow_ref && run.workflow_ref && evidence.workflow_ref !== run.workflow_ref) return null;
  if (evidence.head_sha && run.head_sha && evidence.head_sha !== run.head_sha) return null;
  if (evidence.environment && run.environment && evidence.environment !== run.environment) return null;
  if (evidence.actor && loginOf(run.actor) && evidence.actor !== loginOf(run.actor)) return null;
  if (evidence.triggering_actor && loginOf(run.triggering_actor) && evidence.triggering_actor !== loginOf(run.triggering_actor)) return null;
  if (expected.releaseIntentId && evidence.release_intent_id !== expected.releaseIntentId) return null;
  if (expected.releaseIntentId && !evidence.release_intent_id) return null;
  return {
    image_digest: evidence.image_digest || null,
    oci_revision: evidence.oci_revision || null,
    oci_source: evidence.oci_source || null,
    source_sha: evidence.source_sha || null,
    confirmation: evidence.confirmation || null,
    release_intent_id: evidence.release_intent_id || null,
    db_backup: evidence.db_backup && evidence.db_backup.verified ? evidence.db_backup : null,
    health: evidence.health && typeof evidence.health === "object" ? evidence.health : null,
  };
}

export function normalizeGithubWorkflowRun(raw, extras = {}) {
  if (!raw) return null;
  const jobs = extras.jobs || raw.jobs || [];
  const environment = extras.environment
    || raw.environment
    || jobs.map((j) => j.environment?.name || j.environment).find(Boolean)
    || null;
  const outputs = extras.evidenceOutputs && typeof extras.evidenceOutputs === "object" ? extras.evidenceOutputs : {};
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
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
        "User-Agent": "5151-ops-phase15",
      };
      const manifestRes = await fetch(`https://ghcr.io/v2/fyun48/5151/manifests/${digest}`, { headers });
      if (!manifestRes.ok) return null;
      const observed = manifestRes.headers.get("docker-content-digest") || digest;
      const manifest = await manifestRes.json();
      let imageManifest = manifest;
      if (Array.isArray(manifest.manifests) && manifest.manifests.length) {
        const amd = manifest.manifests.find((m) => m.platform?.architecture === "amd64" && m.platform?.os === "linux") || manifest.manifests[0];
        if (!amd?.digest) return { digest: observed };
        const nested = await fetch(`https://ghcr.io/v2/fyun48/5151/manifests/${amd.digest}`, { headers });
        if (!nested.ok) return { digest: observed };
        imageManifest = await nested.json();
      }
      const configDigest = imageManifest.config?.digest;
      if (!configDigest) return { digest: observed };
      const configRes = await fetch(`https://ghcr.io/v2/fyun48/5151/blobs/${configDigest}`, { headers });
      if (!configRes.ok) return { digest: observed };
      const labels = ociLabelsFromConfig(await configRes.json());
      return { digest: observed, oci_revision: labels.revision, oci_source: labels.source };
    },
    async listArtifacts({ owner, repo, runId }) {
      const res = await gh(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`);
      if (!res.ok) return { artifacts: [] };
      return res.json();
    },
    async downloadArtifact({ owner, repo, artifactId }) {
      const res = await gh(`/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const dir = mkdtempSync(path.join(tmpdir(), "phase15-art-"));
      try {
        writeFileSync(path.join(dir, "a.zip"), buf);
        const text = execFileSync("unzip", ["-p", path.join(dir, "a.zip"), `${PHASE15_EVIDENCE_ARTIFACT}.json`], { encoding: "utf8" });
        return { evidence: JSON.parse(text) };
      } catch {
        return null;
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
      }
    },
    async compare({ owner, repo, base, head }) {
      const res = await gh(`/repos/${owner}/${repo}/compare/${base}...${head}`);
      if (!res.ok) return null;
      return res.json();
    },
    async getRef({ owner, repo, ref }) {
      const res = await gh(`/repos/${owner}/${repo}/git/ref/heads/${ref}`);
      if (!res.ok) return null;
      return res.json();
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

  async function loadEvidenceOutputs(run, expected = {}) {
    if (!run?.id) return {};
    if (typeof api.listArtifacts !== "function" || typeof api.downloadArtifact !== "function") return {};
    const listed = await api.listArtifacts({ owner: repo.owner, repo: repo.repo, runId: run.id });
    const matches = (listed?.artifacts || []).filter((a) => a.name === PHASE15_EVIDENCE_ARTIFACT && !a.expired);
    if (matches.length !== 1) return {};
    const downloaded = await api.downloadArtifact({ owner: repo.owner, repo: repo.repo, artifactId: matches[0].id, runId: run.id });
    const evidence = downloaded?.evidence
      || downloaded?.files?.[`${PHASE15_EVIDENCE_ARTIFACT}.json`]
      || downloaded?.json
      || null;
    return bindPhase15EvidenceToRun(evidence, run, expected) || {};
  }

  async function hydrateRun(raw, jobs, expected = {}) {
    const evidenceOutputs = await loadEvidenceOutputs(raw, expected);
    return normalizeGithubWorkflowRun(raw, { jobs, evidenceOutputs });
  }

  async function lookupRunByIntent({ workflowFile, releaseIntentId, createdAfter } = {}) {
    if (!releaseIntentId) return null;
    const listed = await api.listWorkflowRuns({
      owner: repo.owner,
      repo: repo.repo,
      workflowFile,
    });
    const candidates = (listed.runs || []).filter((run) => {
      const file = run.path || run.workflow_file;
      if (workflowFile && file !== workflowFile) return false;
      if (run.event && run.event !== "workflow_dispatch") return false;
      if (!createdAfterOk(run.created_at, createdAfter)) return false;
      return true;
    });
    const bound = [];
    for (const raw of candidates) {
      const detail = await api.getWorkflowRun({ owner: repo.owner, repo: repo.repo, runId: raw.id });
      const run = detail?.run || raw;
      const evidenceOutputs = await loadEvidenceOutputs(run, { releaseIntentId });
      if (evidenceOutputs.release_intent_id === releaseIntentId) {
        bound.push(normalizeGithubWorkflowRun(run, { jobs: detail?.jobs, evidenceOutputs }));
      }
    }
    if (bound.length > 1) return { ambiguous: true, id: null };
    return bound[0] || null;
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
      const intent = requestId || inputs.release_intent_id || "";
      const prepared = workflowInputs({ workflowFile, inputs, confirmation, releaseIntentId: intent });
      if (!prepared.ok) return { accepted: false, reason: prepared.reason, workflow_run_id: null };
      if (expectedHead && inputs.expected_head && expectedHead !== inputs.expected_head) {
        return { accepted: false, reason: "expected_head_race", workflow_run_id: null };
      }

      const existing = await lookupRunByIntent({ workflowFile, releaseIntentId: prepared.inputs.release_intent_id });
      if (existing?.ambiguous) return { accepted: false, reason: "ambiguous_workflow_run", workflow_run_id: null };
      if (existing?.id || acceptedIntents.has(prepared.inputs.release_intent_id)) {
        return {
          accepted: true,
          idempotent: true,
          pending_lookup: !existing?.id,
          workflow_run_id: existing?.id || null,
          attempt: existing?.attempt || null,
          request_id: prepared.inputs.release_intent_id,
          provider_response_identity: `github-dispatch-${sha256(prepared.inputs.release_intent_id).slice(0, 20)}`,
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
          return { accepted: true, timeout: true, workflow_run_id: null, request_id: prepared.inputs.release_intent_id, provider_response_identity: `github-timeout-${sha256(prepared.inputs.release_intent_id).slice(0, 20)}` };
        }
        return { accepted: false, reason: redactGithubError(err), workflow_run_id: null, request_id: prepared.inputs.release_intent_id };
      }
      if (dispatched?.timeout) {
        return { accepted: true, timeout: true, workflow_run_id: null, request_id: prepared.inputs.release_intent_id, provider_response_identity: `github-timeout-${sha256(prepared.inputs.release_intent_id).slice(0, 20)}` };
      }
      if (!dispatched || dispatched.status !== 204) {
        return {
          accepted: false,
          reason: dispatched?.reason || `dispatch_http_${dispatched?.status || "unknown"}`,
          workflow_run_id: null,
          request_id: prepared.inputs.release_intent_id,
        };
      }
      dispatchCount += 1;
      acceptedIntents.add(prepared.inputs.release_intent_id);
      if (deps.crashAfterAccept) {
        throw Object.assign(new Error("crash after dispatch response"), { code: "crash_after_dispatch" });
      }
      const found = await lookupRunByIntent({ workflowFile, releaseIntentId: prepared.inputs.release_intent_id });
      if (found?.ambiguous) return { accepted: false, reason: "ambiguous_workflow_run", workflow_run_id: null, request_id: prepared.inputs.release_intent_id };
      return {
        accepted: true,
        pending_lookup: !found?.id,
        workflow_run_id: found?.id || null,
        attempt: found?.attempt || null,
        head_sha: prepared.inputs.sha,
        workflow_ref: REQUIRED_WORKFLOW_REF,
        actor: authorizedActor,
        environment: workflowFile === PRODUCTION_WORKFLOWS.BUILD ? null : (environment || REQUIRED_TARGET_ENVIRONMENT),
        request_id: prepared.inputs.release_intent_id,
        provider_response_identity: `github-dispatch-${sha256(prepared.inputs.release_intent_id).slice(0, 20)}`,
      };
    },

    async getWorkflowRun({ workflow_run_id } = {}) {
      if (!workflow_run_id) return null;
      const detail = await api.getWorkflowRun({ owner: repo.owner, repo: repo.repo, runId: workflow_run_id });
      if (!detail?.run && !detail?.id) return null;
      const raw = detail.run || detail;
      return hydrateRun(raw, detail.jobs);
    },

    async findWorkflowRunByIdempotency({
      workflowFile, dispatchIntentId, createdAfter,
    } = {}) {
      if (missing(workflowFile) || missing(dispatchIntentId)) return null;
      const found = await lookupRunByIntent({ workflowFile, releaseIntentId: dispatchIntentId, createdAfter });
      if (found?.ambiguous) return { ambiguous: true, id: null };
      return found;
    },

    async inspectImage({ digest } = {}) {
      if (!digestLooksImmutable(digest)) return null;
      if (typeof api.inspectImage !== "function") return null;
      const inspected = await api.inspectImage({ digest });
      if (!inspected?.digest) return null;
      return {
        digest: inspected.digest,
        oci_revision: inspected.oci_revision || null,
        oci_source: inspected.oci_source || null,
      };
    },

    async mergePullRequest({ sha, repo: gitRepo } = {}) {
      if (typeof api.compare === "function") {
        const cmp = await api.compare({ owner: repo.owner, repo: repo.repo, base: sha, head: "master" });
        const mergeBase = cmp?.merge_base_commit?.sha;
        if (mergeBase && String(mergeBase) === String(sha)) {
          const ref = typeof api.getRef === "function" ? await api.getRef({ owner: repo.owner, repo: repo.repo, ref: "master" }) : null;
          return { ok: true, already_merged: true, master_sha: ref?.object?.sha || mergeBase, admin_override: false };
        }
        return { ok: false, reason: "target_sha_not_on_protected_master", admin_override: false };
      }
      if (gitRepo?.isRemoteAncestor?.(sha, "master")) {
        return { ok: true, already_merged: true, master_sha: gitRepo.resolveRemoteRef("master"), admin_override: false };
      }
      return { ok: false, reason: "target_sha_not_on_protected_master", admin_override: false, local_only: true };
    },

    async healthSmoke({ workflowRunId, workflow } = {}) {
      const empty = {
        passed: false, health: false, landing: false, login: false, container_running: false,
        image_digest: null, oci_revision: null, detail: "health_evidence_missing",
      };
      const wf = workflow || (workflowRunId ? await this.getWorkflowRun({ workflow_run_id: workflowRunId }) : null);
      const h = wf?.outputs?.health;
      if (!h || typeof h !== "object") return empty;
      const imageDigest = h.image_digest || null;
      const revision = h.oci_revision || null;
      const complete = !!(h.health && h.landing && h.login && h.container_running && imageDigest && revision);
      return {
        passed: complete && h.passed !== false,
        health: !!h.health,
        landing: !!h.landing,
        login: !!h.login,
        container_running: !!h.container_running,
        image_digest: imageDigest,
        oci_revision: revision,
        detail: complete ? null : "health_evidence_incomplete",
      };
    },

    async restoreDatabase() {
      restoreCallCount += 1;
      throw Object.assign(new Error("automatic production DB restore is forbidden"), { code: "db_restore_forbidden", status: 409 });
    },
  };
}
