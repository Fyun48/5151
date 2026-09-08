import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PRODUCTION_WORKFLOWS,
  REQUIRED_OCI_SOURCE,
  REQUIRED_WORKFLOW_REF,
} from "../src/release/productionReleasePolicy.js";
import { makeGithubProductionReleaseProvider, makeProductionReleaseProvider } from "../src/release/productionReleaseProvider.js";
import {
  correlateGithubWorkflowRuns,
  ociLabelsFromConfig,
  bindPhase15EvidenceToRun,
  extractJsonFromArtifactZip,
  sealPhase15Evidence,
  PHASE15_EVIDENCE_SCHEMA,
  PHASE15_EVIDENCE_ARTIFACT,
  PHASE15_IDENTITY_ARTIFACT,
  phase15IntentRunName,
} from "../src/release/githubProductionReleaseProvider.js";

const ACTOR = "Fyun48";
const SHA = "a".repeat(40);
const DIGEST = "sha256:" + "ab".repeat(32);
const GRANT_ENV = {
  PRODUCTION_RELEASE_PROVIDER: "github",
  PRODUCTION_RELEASE_MUTATION_GRANT: "owner-dispatch-v1",
  PRODUCTION_RELEASE_GITHUB_ACTOR: ACTOR,
  GITHUB_REPOSITORY: "Fyun48/5151",
};

function makeFakeGithubApi(opts = {}) {
  const runs = opts.runs || [];
  const artifacts = opts.artifacts || new Map();
  let seq = opts.startId || 55000000000;
  let artSeq = 1;
  let dispatchHttp = 0;
  const liveShaped = !!opts.liveShaped;
  return {
    runs,
    artifacts,
    get dispatchHttp() { return dispatchHttp; },
    crashBeforeDispatch: !!opts.crashBeforeDispatch,
    timeout: !!opts.timeout,
    status: opts.status == null ? 204 : opts.status,
    suppressRunOnDispatch: !!opts.suppressRunOnDispatch,
    async dispatchWorkflow({ workflowFile, inputs }) {
      if (this.crashBeforeDispatch) throw new Error("crash_before_dispatch");
      if (this.timeout) throw Object.assign(new Error("timeout"), { code: "dispatch_timeout" });
      dispatchHttp += 1;
      if (this.status !== 204) return { status: this.status, reason: "dispatch_rejected" };
      if (!this.suppressRunOnDispatch) {
        const run = {
          id: ++seq,
          run_attempt: 1,
          status: opts.runStatus || "queued",
          conclusion: opts.runConclusion ?? null,
          path: workflowFile,
          name: `phase15-intent:${inputs.release_intent_id}`,
          display_title: `phase15-intent:${inputs.release_intent_id}`,
          head_sha: liveShaped ? "b".repeat(40) : inputs.sha,
          head_branch: "master",
          actor: { login: ACTOR },
          triggering_actor: { login: ACTOR },
          event: "workflow_dispatch",
          created_at: opts.createdAt || "2026-06-01T00:00:00.000Z",
        };
        runs.push(run);
        if (opts.attachEvidence !== false && !liveShaped) {
          const evidence = sealPhase15Evidence({
            schema: PHASE15_EVIDENCE_SCHEMA,
            workflow_file: workflowFile,
            workflow_ref: REQUIRED_WORKFLOW_REF,
            workflow_run_id: String(run.id),
            workflow_attempt: 1,
            head_sha: run.head_sha,
            source_sha: inputs.sha,
            actor: ACTOR,
            triggering_actor: ACTOR,
            environment: workflowFile === PRODUCTION_WORKFLOWS.BUILD ? null : "production",
            confirmation: workflowFile === PRODUCTION_WORKFLOWS.BUILD
              ? null
              : (inputs.confirmation || (workflowFile === PRODUCTION_WORKFLOWS.PREDEPLOY ? "PREDEPLOY-PRODUCTION" : "DEPLOY-PRODUCTION")),
            release_intent_id: inputs.release_intent_id || null,
            image_digest: DIGEST,
            oci_revision: inputs.sha,
            oci_source: REQUIRED_OCI_SOURCE,
          });
          artifacts.set(String(run.id), [{ id: ++artSeq, name: PHASE15_EVIDENCE_ARTIFACT, expired: false, evidence }]);
        }
      }
      return { status: 204 };
    },
    async listWorkflowRuns() {
      return { runs };
    },
    async getWorkflowRun({ runId }) {
      const run = runs.find((r) => String(r.id) === String(runId));
      if (!run) return null;
      return { run, jobs: [] };
    },
    async listArtifacts({ runId }) {
      return { artifacts: artifacts.get(String(runId)) || [] };
    },
    async downloadArtifact({ artifactId, runId }) {
      const list = artifacts.get(String(runId)) || [...artifacts.values()].flat();
      const art = list.find((a) => a.id === artifactId) || list[0];
      return art ? { evidence: art.evidence } : null;
    },
    async inspectImage({ digest }) {
      if (liveShaped) return { digest };
      return { digest, oci_revision: SHA, oci_source: REQUIRED_OCI_SOURCE };
    },
  };
}

test("GitHub provider stays unavailable without Owner mutation grant", () => {
  assert.equal(makeGithubProductionReleaseProvider({ GITHUB_TOKEN: "ghs_this_must_not_enable_dispatch" }).available, false);
  assert.equal(makeProductionReleaseProvider({ PRODUCTION_RELEASE_PROVIDER: "github", GITHUB_TOKEN: "ghs_x" }).available, false);
  assert.equal(makeGithubProductionReleaseProvider({
    ...GRANT_ENV,
    PRODUCTION_RELEASE_ALLOW_LIVE: "1",
    GITHUB_TOKEN: "ghs_x",
    PRODUCTION_RELEASE_MUTATION_GRANT: "",
  }).available, false);
});

test("injected GitHub adapter is available with grant and never stores secrets", async () => {
  const api = makeFakeGithubApi({ runStatus: "completed", runConclusion: "success" });
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api });
  assert.equal(provider.available, true);
  const dispatched = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA, image_digest: DIGEST },
    actor: ACTOR,
    requestId: "intent-build-0001",
  });
  assert.equal(dispatched.accepted, true);
  assert.ok(dispatched.workflow_run_id);
  const wf = await provider.getWorkflowRun({ workflow_run_id: dispatched.workflow_run_id });
  assert.equal(wf.actor, ACTOR);
  assert.equal(wf.triggering_actor, ACTOR);
  assert.equal(wf.workflow_file, PRODUCTION_WORKFLOWS.BUILD);
  assert.equal(wf.head_sha, SHA);
  assert.doesNotMatch(JSON.stringify(provider.setup), /ghs_|NAS_|AUTH_PASSWORD|token/i);
  assert.doesNotMatch(JSON.stringify(dispatched), /ghs_|NAS_|AUTH_PASSWORD/i);
});

test("GitHub adapter 204 without a visible run is pending and does not invent a run id", async () => {
  const api = makeFakeGithubApi({ suppressRunOnDispatch: true });
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api });
  const dispatched = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA },
    actor: ACTOR,
    requestId: "intent-204-xxxxx",
  });
  assert.equal(dispatched.accepted, true);
  assert.equal(dispatched.pending_lookup, true);
  assert.equal(dispatched.workflow_run_id, null);
  assert.equal(api.dispatchHttp, 1);
  const found = await provider.findWorkflowRunByIdempotency({ workflowFile: PRODUCTION_WORKFLOWS.BUILD, dispatchIntentId: "intent-204-xxxxx" });
  assert.equal(found, null);
});

test("crash before dispatch does not mark durable ownership or call GitHub", async () => {
  const api = makeFakeGithubApi({ crashBeforeDispatch: true });
  const acceptedIntents = new Set();
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api, acceptedIntents });
  const out = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA },
    actor: ACTOR,
    requestId: "intent-crash-before",
  });
  assert.equal(out.accepted, false);
  assert.equal(api.dispatchHttp, 0);
  assert.equal(acceptedIntents.size, 0);
  assert.equal(provider.dispatchCount, 0);
});

test("crash after dispatch response keeps exactly-once ownership and later lookup binds the run", async () => {
  const api = makeFakeGithubApi({ runStatus: "in_progress" });
  const acceptedIntents = new Set();
  const crashing = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api, acceptedIntents, crashAfterAccept: true });
  await assert.rejects(() => crashing.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA },
    actor: ACTOR,
    requestId: "intent-crash-after",
  }), /crash after dispatch/);
  assert.equal(api.dispatchHttp, 1);
  assert.equal(acceptedIntents.has("intent-crash-after"), true);
  const restarted = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api, acceptedIntents });
  const replay = await restarted.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA },
    actor: ACTOR,
    requestId: "intent-crash-after",
  });
  assert.equal(replay.accepted, true);
  assert.equal(replay.idempotent, true);
  assert.equal(api.dispatchHttp, 1);
  assert.ok(replay.workflow_run_id);
  const found = await restarted.findWorkflowRunByIdempotency({ workflowFile: PRODUCTION_WORKFLOWS.BUILD, dispatchIntentId: "intent-crash-after" });
  assert.equal(String(found.id), String(replay.workflow_run_id));
  assert.equal(found.status, "in_progress");
});

test("timeout is accepted without a run id and does not re-dispatch as success", async () => {
  const api = makeFakeGithubApi({ timeout: true });
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api });
  const out = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.PREDEPLOY,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA },
    confirmation: "PREDEPLOY-PRODUCTION",
    actor: ACTOR,
    environment: "production",
    requestId: "intent-timeout-xx",
  });
  assert.equal(out.accepted, true);
  assert.equal(out.timeout, true);
  assert.equal(out.workflow_run_id, null);
  assert.equal(provider.dispatchCount, 0);
});

test("ambiguous matching GitHub runs fail closed", async () => {
  const twin = {
    id: 1,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    path: PRODUCTION_WORKFLOWS.DEPLOY,
    head_sha: SHA,
    actor: { login: ACTOR },
    triggering_actor: { login: ACTOR },
    event: "workflow_dispatch",
    created_at: "2026-06-01T00:00:00.000Z",
  };
  const artifacts = new Map();
  for (const id of [11, 12]) {
    artifacts.set(String(id), [{
      id,
      name: PHASE15_EVIDENCE_ARTIFACT,
      expired: false,
      evidence: sealPhase15Evidence({
        schema: PHASE15_EVIDENCE_SCHEMA,
        workflow_file: PRODUCTION_WORKFLOWS.DEPLOY,
        workflow_ref: REQUIRED_WORKFLOW_REF,
        workflow_run_id: String(id),
        workflow_attempt: 1,
        head_sha: SHA,
        source_sha: SHA,
        actor: ACTOR,
        triggering_actor: ACTOR,
        environment: "production",
        confirmation: "DEPLOY-PRODUCTION",
        release_intent_id: "intent-ambiguous",
        image_digest: DIGEST,
      }),
    }]);
  }
  const api = makeFakeGithubApi({
    runs: [{ ...twin, id: 11 }, { ...twin, id: 12 }],
    artifacts,
    suppressRunOnDispatch: true,
  });
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api });
  const dispatched = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.DEPLOY,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA, image_digest: DIGEST },
    confirmation: "DEPLOY-PRODUCTION",
    actor: ACTOR,
    environment: "production",
    requestId: "intent-ambiguous",
  });
  assert.equal(dispatched.accepted, false);
  assert.equal(dispatched.reason, "ambiguous_workflow_run");
  const found = await provider.findWorkflowRunByIdempotency({ workflowFile: PRODUCTION_WORKFLOWS.DEPLOY, dispatchIntentId: "intent-ambiguous" });
  assert.equal(found.ambiguous, true);
  assert.equal(found.id, null);
  const correlated = correlateGithubWorkflowRuns(api.runs, { workflowFile: PRODUCTION_WORKFLOWS.DEPLOY, headSha: SHA, actor: ACTOR });
  assert.equal(correlated.ambiguous, true);
});

test("durable request id is exactly-once even if dispatch is retried", async () => {
  const api = makeFakeGithubApi({ runStatus: "queued" });
  const acceptedIntents = new Set();
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api, acceptedIntents });
  const first = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA },
    actor: ACTOR,
    requestId: "intent-once-xxxxx",
  });
  const second = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA },
    actor: ACTOR,
    requestId: "intent-once-xxxxx",
  });
  assert.equal(first.accepted, true);
  assert.equal(second.idempotent, true);
  assert.equal(api.dispatchHttp, 1);
  assert.equal(provider.dispatchCount, 1);
  assert.equal(String(first.workflow_run_id), String(second.workflow_run_id));
});

test("GitHub REST-shaped run without evidence artifact has no synthetic outputs", async () => {
  const api = makeFakeGithubApi({ runStatus: "completed", runConclusion: "success", attachEvidence: false });
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api });
  const dispatched = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA, image_digest: DIGEST },
    actor: ACTOR,
    requestId: "intent-rest-xxxxx",
  });
  assert.equal(dispatched.accepted, true);
  assert.equal(String(dispatched.workflow_run_id), String(api.runs[0].id));
  const wf = await provider.getWorkflowRun({ workflow_run_id: String(api.runs[0].id) });
  assert.equal(wf.status, "completed");
  assert.deepEqual(wf.outputs, {});
  assert.equal(wf.outputs.image_digest, undefined);
});

test("accepted deploy without final artifact still correlates by run-name and does not redispatch", async () => {
  const api = makeFakeGithubApi({ runStatus: "completed", runConclusion: "failure", attachEvidence: false });
  const acceptedIntents = new Set();
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api, acceptedIntents });
  const first = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.DEPLOY,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA, image_digest: DIGEST },
    confirmation: "DEPLOY-PRODUCTION",
    actor: ACTOR,
    environment: "production",
    requestId: "intent-no-final-art",
  });
  assert.equal(first.accepted, true);
  assert.equal(String(first.workflow_run_id), String(api.runs[0].id));
  assert.equal(api.runs[0].name, phase15IntentRunName("intent-no-final-art"));
  const found = await provider.findWorkflowRunByIdempotency({
    workflowFile: PRODUCTION_WORKFLOWS.DEPLOY,
    dispatchIntentId: "intent-no-final-art",
  });
  assert.equal(String(found.id), String(api.runs[0].id));
  assert.deepEqual(found.outputs, {});
  const replay = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.DEPLOY,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA, image_digest: DIGEST },
    confirmation: "DEPLOY-PRODUCTION",
    actor: ACTOR,
    environment: "production",
    requestId: "intent-no-final-art",
  });
  assert.equal(replay.accepted, true);
  assert.equal(replay.idempotent, true);
  assert.equal(api.dispatchHttp, 1);
  assert.equal(provider.dispatchCount, 1);
});

test("inspectImage never synthesizes missing OCI revision or source", async () => {
  const api = makeFakeGithubApi();
  api.inspectImage = async ({ digest }) => ({ digest });
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api });
  const inspected = await provider.inspectImage({ sha: SHA, digest: DIGEST });
  assert.equal(inspected.digest, DIGEST);
  assert.equal(inspected.oci_revision, null);
  assert.equal(inspected.oci_source, null);
  const labels = ociLabelsFromConfig({ config: { Labels: { "org.opencontainers.image.revision": SHA, "org.opencontainers.image.source": REQUIRED_OCI_SOURCE } } });
  assert.equal(labels.revision, SHA);
  assert.equal(labels.source, REQUIRED_OCI_SOURCE);
});

test("healthSmoke does not treat HTTP 200 as Production health proof", async () => {
  const api = makeFakeGithubApi();
  api.healthSmoke = async () => ({ ok: true, status: 200 });
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api });
  const health = await provider.healthSmoke({ imageDigest: DIGEST, headSha: SHA });
  assert.equal(health.passed, false);
  assert.equal(health.health, false);
  assert.equal(health.landing, false);
  assert.equal(health.login, false);
  assert.equal(health.container_running, false);
  assert.equal(health.image_digest, null);
  assert.equal(health.oci_revision, null);
});

test("trusted evidence artifact binds outputs only when run identity matches", () => {
  const run = {
    id: "11",
    run_attempt: 1,
    path: PRODUCTION_WORKFLOWS.DEPLOY,
    actor: { login: ACTOR },
    triggering_actor: { login: ACTOR },
  };
  const sealed = sealPhase15Evidence({
    schema: PHASE15_EVIDENCE_SCHEMA,
    workflow_run_id: "11",
    workflow_attempt: 1,
    workflow_file: PRODUCTION_WORKFLOWS.DEPLOY,
    workflow_ref: REQUIRED_WORKFLOW_REF,
    head_sha: SHA,
    source_sha: SHA,
    actor: ACTOR,
    triggering_actor: ACTOR,
    environment: "production",
    confirmation: "DEPLOY-PRODUCTION",
    release_intent_id: "intent-bind-ok",
    image_digest: DIGEST,
    oci_revision: SHA,
    oci_source: REQUIRED_OCI_SOURCE,
    health: { passed: true, health: true, landing: true, login: true, container_running: true, image_digest: DIGEST, oci_revision: SHA },
  });
  const ok = bindPhase15EvidenceToRun(sealed, run, { releaseIntentId: "intent-bind-ok" });
  assert.equal(ok.image_digest, DIGEST);
  assert.equal(bindPhase15EvidenceToRun({ ...sealed, workflow_attempt: 2 }, run, { releaseIntentId: "intent-bind-ok" }), null);
  const tampered = { ...sealed, image_digest: "sha256:" + "cd".repeat(32) };
  assert.equal(bindPhase15EvidenceToRun(tampered, run, { releaseIntentId: "intent-bind-ok" }), null);
});

test("missing or tampered evidence artifact fails closed", async () => {
  const run = {
    id: "22",
    run_attempt: 1,
    path: PRODUCTION_WORKFLOWS.PREDEPLOY,
    actor: { login: ACTOR },
    triggering_actor: { login: ACTOR },
  };
  const sealed = sealPhase15Evidence({
    schema: PHASE15_EVIDENCE_SCHEMA,
    workflow_run_id: "22",
    workflow_attempt: 1,
    workflow_file: PRODUCTION_WORKFLOWS.PREDEPLOY,
    workflow_ref: REQUIRED_WORKFLOW_REF,
    head_sha: SHA,
    source_sha: SHA,
    actor: ACTOR,
    triggering_actor: ACTOR,
    release_intent_id: "intent-predeploy-1",
    environment: "production",
    confirmation: "PREDEPLOY-PRODUCTION",
    db_backup: { backup_id: "b1", backup_hash: "sha256:" + "11".repeat(32), verified: true },
  });
  assert.equal(bindPhase15EvidenceToRun(null, run, { releaseIntentId: "intent-predeploy-1" }), null);
  assert.equal(bindPhase15EvidenceToRun({ ...sealed, evidence_sha256: "sha256:" + "00".repeat(32) }, run, { releaseIntentId: "intent-predeploy-1" }), null);
  assert.equal(bindPhase15EvidenceToRun(sealed, run, { releaseIntentId: "intent-other-xxxxx" }), null);
  const ok = bindPhase15EvidenceToRun(sealed, run, { releaseIntentId: "intent-predeploy-1" });
  assert.equal(ok.db_backup.backup_id, "b1");
});

test("live REST-shaped fixture never fabricates OCI/health and rejects missing evidence", async () => {
  const api = makeFakeGithubApi({ liveShaped: true, runStatus: "completed", runConclusion: "success" });
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api });
  const dispatched = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA, image_digest: DIGEST },
    actor: ACTOR,
    requestId: "intent-live-rest",
  });
  assert.equal(dispatched.accepted, true);
  assert.equal(String(dispatched.workflow_run_id), String(api.runs[0].id));
  const wf = await provider.getWorkflowRun({ workflow_run_id: String(api.runs[0].id) });
  assert.deepEqual(wf.outputs, {});
  const inspected = await provider.inspectImage({ digest: DIGEST, sha: SHA });
  assert.equal(inspected.digest, DIGEST);
  assert.equal(inspected.oci_revision, null);
  assert.equal(inspected.oci_source, null);
  const health = await provider.healthSmoke({ imageDigest: DIGEST, headSha: SHA, workflow: wf });
  assert.equal(health.passed, false);
  assert.equal(health.container_running, false);
  assert.equal(dispatched.head_sha, "b".repeat(40));
  assert.equal(dispatched.actor, ACTOR);
  assert.equal(dispatched.environment, null);
});

function liveRestRun(id, workflowFile) {
  return {
    id,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    path: workflowFile,
    head_sha: "b".repeat(40),
    head_branch: "master",
    actor: { login: ACTOR, id: 1, type: "User" },
    triggering_actor: { login: ACTOR, id: 1, type: "User" },
    event: "workflow_dispatch",
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

function liveEvidence(workflowFile, extras = {}) {
  return sealPhase15Evidence({
    schema: PHASE15_EVIDENCE_SCHEMA,
    workflow_file: workflowFile,
    workflow_ref: REQUIRED_WORKFLOW_REF,
    workflow_run_id: "88001",
    workflow_attempt: 1,
    head_sha: "b".repeat(40),
    source_sha: SHA,
    actor: ACTOR,
    triggering_actor: ACTOR,
    environment: workflowFile === PRODUCTION_WORKFLOWS.BUILD ? null : "production",
    confirmation: workflowFile === PRODUCTION_WORKFLOWS.PREDEPLOY
      ? "PREDEPLOY-PRODUCTION"
      : workflowFile === PRODUCTION_WORKFLOWS.DEPLOY ? "DEPLOY-PRODUCTION" : null,
    release_intent_id: "intent-live-artifact",
    image_digest: DIGEST,
    oci_revision: SHA,
    oci_source: REQUIRED_OCI_SOURCE,
    ...extras,
  });
}

test("live REST-shaped run uses artifact environment and rejects missing or tampered identity", async () => {
  const run = liveRestRun(88001, PRODUCTION_WORKFLOWS.PREDEPLOY);
  const jobs = [{ id: 1, name: "predeploy", status: "completed", conclusion: "success" }];
  const artifacts = new Map();
  artifacts.set("88001", [{
    id: 91,
    name: PHASE15_EVIDENCE_ARTIFACT,
    expired: false,
    evidence: liveEvidence(PRODUCTION_WORKFLOWS.PREDEPLOY, {
      db_backup: { backup_id: "b-live", backup_hash: "sha256:" + "11".repeat(32), verified: true },
    }),
  }]);
  const api = {
    async listWorkflowRuns() { return { runs: [run] }; },
    async getWorkflowRun() { return { run, jobs }; },
    async listArtifacts() { return { artifacts: artifacts.get("88001") }; },
    async downloadArtifact() { return { evidence: artifacts.get("88001")[0].evidence }; },
    async inspectImage({ digest }) { return { digest }; },
  };
  const provider = makeGithubProductionReleaseProvider(GRANT_ENV, { githubApi: api });
  const wf = await provider.getWorkflowRun({ workflow_run_id: "88001" });
  assert.equal(wf.environment, "production");
  assert.equal(wf.outputs.source_sha, SHA);
  assert.equal(wf.outputs.confirmation, "PREDEPLOY-PRODUCTION");
  assert.equal(wf.outputs.db_backup.backup_id, "b-live");
  assert.equal(wf.head_sha, "b".repeat(40));

  const missingEnv = liveEvidence(PRODUCTION_WORKFLOWS.PREDEPLOY, { environment: null });
  assert.equal(bindPhase15EvidenceToRun(missingEnv, run, { releaseIntentId: "intent-live-artifact" }), null);
  const badEnv = liveEvidence(PRODUCTION_WORKFLOWS.PREDEPLOY, { environment: "staging" });
  assert.equal(bindPhase15EvidenceToRun(badEnv, run, { releaseIntentId: "intent-live-artifact" }), null);
  const badSource = liveEvidence(PRODUCTION_WORKFLOWS.PREDEPLOY, { source_sha: "c".repeat(40) });
  assert.equal(bindPhase15EvidenceToRun(badSource, run, { releaseIntentId: "intent-live-artifact", sourceSha: SHA }), null);
  const missingConfirm = liveEvidence(PRODUCTION_WORKFLOWS.PREDEPLOY, { confirmation: null });
  assert.equal(bindPhase15EvidenceToRun(missingConfirm, run, { releaseIntentId: "intent-live-artifact" }), null);
  const tamperedConfirm = liveEvidence(PRODUCTION_WORKFLOWS.PREDEPLOY, { confirmation: "DEPLOY-PRODUCTION" });
  assert.equal(bindPhase15EvidenceToRun(tamperedConfirm, run, { releaseIntentId: "intent-live-artifact" }), null);

  artifacts.set("88001", [{ id: 92, name: PHASE15_EVIDENCE_ARTIFACT, expired: false, evidence: missingEnv }]);
  const blocked = await provider.getWorkflowRun({ workflow_run_id: "88001" });
  assert.equal(blocked.environment, null);
  assert.deepEqual(blocked.outputs, {});
});

test("every required artifact identity field missing or mismatched fails closed", () => {
  const run = {
    id: "88001",
    run_attempt: 1,
    path: PRODUCTION_WORKFLOWS.DEPLOY,
    head_sha: "b".repeat(40),
    actor: { login: ACTOR },
    triggering_actor: { login: ACTOR },
  };
  const base = {
    schema: PHASE15_EVIDENCE_SCHEMA,
    workflow_file: PRODUCTION_WORKFLOWS.DEPLOY,
    workflow_ref: REQUIRED_WORKFLOW_REF,
    workflow_run_id: "88001",
    workflow_attempt: 1,
    head_sha: "b".repeat(40),
    source_sha: SHA,
    actor: ACTOR,
    triggering_actor: ACTOR,
    environment: "production",
    confirmation: "DEPLOY-PRODUCTION",
    release_intent_id: "intent-live-artifact",
    image_digest: DIGEST,
  };
  assert.ok(bindPhase15EvidenceToRun(sealPhase15Evidence(base), run, { releaseIntentId: "intent-live-artifact" }));
  for (const key of ["workflow_ref", "head_sha", "actor", "triggering_actor", "source_sha", "confirmation", "environment", "release_intent_id", "image_digest"]) {
    const missing = { ...base };
    missing[key] = key === "workflow_attempt" ? 0 : null;
    assert.equal(bindPhase15EvidenceToRun(sealPhase15Evidence(missing), run, { releaseIntentId: "intent-live-artifact" }), null, `missing ${key}`);
  }
  const mismatches = {
    workflow_ref: "refs/heads/other",
    head_sha: "c".repeat(40),
    actor: "attacker",
    triggering_actor: "attacker",
    source_sha: "c".repeat(40),
    confirmation: "PREDEPLOY-PRODUCTION",
    environment: "staging",
    release_intent_id: "intent-other-xxxxx",
    image_digest: "sha256:" + "00".repeat(32),
  };
  for (const [key, value] of Object.entries(mismatches)) {
    const bad = { ...base, [key]: value };
    assert.equal(bindPhase15EvidenceToRun(sealPhase15Evidence(bad), run, {
      releaseIntentId: "intent-live-artifact",
      sourceSha: SHA,
      imageDigest: DIGEST,
    }), null, `mismatch ${key}`);
  }
});

test("live zip downloader reads identity and evidence filenames from the same archive", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "phase15-zip-"));
  const zipPath = path.join(dir, "artifacts.zip");
  const identity = { schema: "phase15-run-identity-v1", release_intent_id: "intent-zip-identity" };
  const evidence = { schema: PHASE15_EVIDENCE_SCHEMA, release_intent_id: "intent-zip-evidence" };
  writeFileSync(path.join(dir, `${PHASE15_IDENTITY_ARTIFACT}.json`), JSON.stringify(identity));
  writeFileSync(path.join(dir, `${PHASE15_EVIDENCE_ARTIFACT}.json`), JSON.stringify(evidence));
  execFileSync("python3", ["-c", `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(zipPath)}, "w")
z.write(${JSON.stringify(path.join(dir, `${PHASE15_IDENTITY_ARTIFACT}.json`))}, "${PHASE15_IDENTITY_ARTIFACT}.json")
z.write(${JSON.stringify(path.join(dir, `${PHASE15_EVIDENCE_ARTIFACT}.json`))}, "${PHASE15_EVIDENCE_ARTIFACT}.json")
z.close()
`]);
  const buf = readFileSync(zipPath);
  assert.equal(extractJsonFromArtifactZip(buf, `${PHASE15_IDENTITY_ARTIFACT}.json`).schema, "phase15-run-identity-v1");
  assert.equal(extractJsonFromArtifactZip(buf, `${PHASE15_EVIDENCE_ARTIFACT}.json`).schema, PHASE15_EVIDENCE_SCHEMA);
  assert.notEqual(
    extractJsonFromArtifactZip(buf, `${PHASE15_IDENTITY_ARTIFACT}.json`).release_intent_id,
    extractJsonFromArtifactZip(buf, `${PHASE15_EVIDENCE_ARTIFACT}.json`).release_intent_id,
  );
  assert.throws(() => extractJsonFromArtifactZip(buf, "../secrets.json"));
  rmSync(dir, { recursive: true, force: true });
});
