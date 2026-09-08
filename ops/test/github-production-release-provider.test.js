import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCTION_WORKFLOWS,
  REQUIRED_OCI_SOURCE,
  REQUIRED_WORKFLOW_REF,
} from "../src/release/productionReleasePolicy.js";
import { makeGithubProductionReleaseProvider, makeProductionReleaseProvider } from "../src/release/productionReleaseProvider.js";
import { correlateGithubWorkflowRuns } from "../src/release/githubProductionReleaseProvider.js";

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
  let seq = opts.startId || 55000000000;
  let dispatchHttp = 0;
  return {
    runs,
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
        runs.push({
          id: ++seq,
          run_attempt: 1,
          status: opts.runStatus || "queued",
          conclusion: opts.runConclusion ?? null,
          path: workflowFile,
          workflow_file: workflowFile,
          head_sha: inputs.sha,
          head_branch: "master",
          actor: { login: ACTOR },
          triggering_actor: { login: ACTOR },
          event: "workflow_dispatch",
          created_at: opts.createdAt || "2026-06-01T00:00:00.000Z",
          environment: workflowFile === PRODUCTION_WORKFLOWS.BUILD ? null : "production",
          outputs: {
            image_digest: DIGEST,
            oci_revision: inputs.sha,
            oci_source: REQUIRED_OCI_SOURCE,
            db_backup: workflowFile === PRODUCTION_WORKFLOWS.PREDEPLOY
              ? { backup_id: "backup-1", backup_hash: "sha256:" + "11".repeat(32), verified: true }
              : null,
          },
        });
      }
      return { status: 204 };
    },
    async listWorkflowRuns() {
      return { runs };
    },
    async getWorkflowRun({ runId }) {
      const run = runs.find((r) => String(r.id) === String(runId));
      if (!run) return null;
      return {
        run,
        jobs: run.environment ? [{ environment: { name: run.environment } }] : [],
        outputs: run.outputs,
      };
    },
    async inspectImage({ sha, digest }) {
      return { digest, oci_revision: sha, oci_source: REQUIRED_OCI_SOURCE };
    },
    async healthSmoke() {
      return { passed: true, health: true, landing: true, login: true, container_running: true, image_digest: DIGEST, oci_revision: SHA };
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
    requestId: "intent-build-1",
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
    requestId: "intent-204",
  });
  assert.equal(dispatched.accepted, true);
  assert.equal(dispatched.pending_lookup, true);
  assert.equal(dispatched.workflow_run_id, null);
  assert.equal(api.dispatchHttp, 1);
  const found = await provider.findWorkflowRunByIdempotency({ workflowFile: PRODUCTION_WORKFLOWS.BUILD, headSha: SHA });
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
  const found = await restarted.findWorkflowRunByIdempotency({ workflowFile: PRODUCTION_WORKFLOWS.BUILD, headSha: SHA });
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
    requestId: "intent-timeout",
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
  const api = makeFakeGithubApi({
    runs: [{ ...twin, id: 11 }, { ...twin, id: 12 }],
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
  const found = await provider.findWorkflowRunByIdempotency({ workflowFile: PRODUCTION_WORKFLOWS.DEPLOY, headSha: SHA });
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
    requestId: "intent-once",
  });
  const second = await provider.dispatchWorkflow({
    workflowFile: PRODUCTION_WORKFLOWS.BUILD,
    workflowRef: REQUIRED_WORKFLOW_REF,
    inputs: { sha: SHA },
    actor: ACTOR,
    requestId: "intent-once",
  });
  assert.equal(first.accepted, true);
  assert.equal(second.idempotent, true);
  assert.equal(api.dispatchHttp, 1);
  assert.equal(provider.dispatchCount, 1);
  assert.equal(String(first.workflow_run_id), String(second.workflow_run_id));
});
