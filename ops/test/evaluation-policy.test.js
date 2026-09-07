import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { getCurrentIssueEvaluation, evaluationStaleReasons, isEvaluationStale, currentEvaluationRunId, listEvaluationRuns } from "../src/evaluation.js";
import { aggregationConfig } from "../src/evaluationAggregation.js";
import { buildEvaluationPolicy, evaluationPolicyFingerprint, effectiveEvaluationPolicy } from "../src/evaluationPolicy.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
let seq = 1;
const stub = (o) => makeStubEvaluationProvider(o);

function seedIssue(db, { members = 4, category = "BUG" } = {}) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s',?,'cluster-v1','open',?,?)").run(category, ts, ts).lastInsertRowid);
  for (let k = 0; k < members; k++) {
    const i = seq++;
    db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, 'x@x.com', ?, '3.47', ?)").run(`d${i}`, `k${i}`, `c${i}`, `u${i}`, ts);
    const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
    db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', ?, 's', 'HIGH', 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, category, ts, ts, ts);
    const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
    db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
    db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, ts);
  }
  calculateAndStoreImpact(db, iid, { now: NOW });
  return iid;
}
const complete = (db, opts = {}) => runEvaluationOnce(db, { provider: opts.provider || stub(), config: { concurrency: 1, deliberationEnabled: opts.deliberation || false }, aggConfig: opts.aggConfig, now: () => NOW });

// 1. same evidence + same policy remains fresh
test("1. same evidence + same policy remains fresh", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssue(db);
  await complete(db);
  assert.equal(getCurrentIssueEvaluation(db, iid, { now: NOW, provider: stub() }).fresh, true);
  assert.equal(isEvaluationStale(db, iid, { now: NOW, provider: stub() }), false);
  db.close();
});

// helper: baseline completed then check a changed policy => stale with evaluation_policy_changed
async function staleUnderChange(changeOpts) {
  const db = openOpsDb(":memory:");
  const iid = seedIssue(db);
  await complete(db);
  const reasons = evaluationStaleReasons(db, iid, { now: NOW, provider: stub(), ...changeOpts });
  db.close();
  return reasons;
}

test("2. role weight change makes existing evaluation stale", async () => {
  const r = await staleUnderChange({ aggConfig: aggregationConfig({ EVAL_WEIGHT_SECURITY: "3" }) });
  assert.ok(r.includes("evaluation_policy_changed"), JSON.stringify(r));
});
test("3. aggregation threshold change makes existing evaluation stale", async () => {
  const r = await staleUnderChange({ aggConfig: aggregationConfig({ EVAL_PROPOSE_SUPERMAJORITY: "0.9" }) });
  assert.ok(r.includes("evaluation_policy_changed"), JSON.stringify(r));
});
test("4. SECURITY escalation threshold change makes existing evaluation stale", async () => {
  const r = await staleUnderChange({ aggConfig: aggregationConfig({ EVAL_ESCALATE_MIN_CONFIDENCE: "0.9" }) });
  assert.ok(r.includes("evaluation_policy_changed"), JSON.stringify(r));
});
test("5. COMPLIANCE escalation threshold change makes existing evaluation stale", async () => {
  const r = await staleUnderChange({ aggConfig: aggregationConfig({ EVAL_ESCALATE_MIN_RISK: "CRITICAL" }) });
  assert.ok(r.includes("evaluation_policy_changed"), JSON.stringify(r));
});
test("6. deliberation enable/disable change makes existing evaluation stale", async () => {
  const r = await staleUnderChange({ deliberationEnabled: true }); // baseline was false
  assert.ok(r.includes("evaluation_policy_changed"), JSON.stringify(r));
});
test("7. provider / model / model_version change makes existing evaluation stale", async () => {
  assert.ok((await staleUnderChange({ provider: { name: "local", model: "llama3", model_version: "v9" } })).includes("evaluation_policy_changed"));
  assert.ok((await staleUnderChange({ provider: { name: "stub", model: "some-model" } })).includes("evaluation_policy_changed")); // model change
  assert.ok((await staleUnderChange({ provider: { name: "stub", model: null, model_version: "v2" } })).includes("evaluation_policy_changed")); // model_version change
});
test("8. role prompt_version change makes existing evaluation stale", async () => {
  const r = await staleUnderChange({ env: { ...process.env, ROLE_PROMPT_VERSION: "role-eval-v2" }, provider: stub() });
  assert.ok(r.includes("evaluation_policy_changed"), JSON.stringify(r));
});

test("9/10/11. policy change yields a NEW canonical run (not deduped); old run remains historical", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssue(db, { members: 8 });
  await complete(db);
  const first = currentEvaluationRunId(db, iid);
  const changed = aggregationConfig({ EVAL_WEIGHT_SECURITY: "3" });
  const s = await complete(db, { aggConfig: changed });
  assert.equal(s.enqueued, 1);          // policy change ⇒ not idempotent-deduped
  assert.equal(s.completed, 1);
  const runs = listEvaluationRuns(db, { issueId: iid });
  assert.equal(runs.length, 2);         // 11 old run kept historically
  const currentId = currentEvaluationRunId(db, iid);
  assert.notEqual(currentId, first);    // 10 new run is canonical
  assert.equal(runs.filter((r) => r.status === "completed").length, 2);
  // 10 new current is fresh under the new policy
  assert.equal(getCurrentIssueEvaluation(db, iid, { now: NOW, provider: stub(), aggConfig: changed }).fresh, true);
  // and stale under the old policy
  assert.equal(getCurrentIssueEvaluation(db, iid, { now: NOW, provider: stub() }).stale, true);
  db.close();
});

test("12. failed reevaluation under new policy retains old run but stays stale", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssue(db, { members: 8 });
  await complete(db);
  const good = currentEvaluationRunId(db, iid);
  const changed = aggregationConfig({ EVAL_WEIGHT_SECURITY: "3" });
  const s = await complete(db, { aggConfig: changed, provider: stub({ behavior: "error" }) });
  assert.equal(s.completed, 0);
  assert.equal(currentEvaluationRunId(db, iid), good); // old current retained
  const reasons = evaluationStaleReasons(db, iid, { now: NOW, provider: stub(), aggConfig: changed });
  assert.ok(reasons.includes("evaluation_policy_changed"), JSON.stringify(reasons)); // still stale
  db.close();
});

test("13. policy snapshot/fingerprint contains no secret/API credential material", () => {
  const policy = buildEvaluationPolicy({ provider: { name: "local", model: "llama3", model_version: "v9" } });
  const json = JSON.stringify(policy);
  assert.doesNotMatch(json, /api[_-]?key|secret|password|token|bearer|authorization|-----BEGIN|https?:\/\//i);
  const allowed = new Set([
    "evaluation_version", "aggregation_version", "role_set_version", "roles", "weights",
    "propose_supermajority", "ignore_supermajority", "min_quorum_fraction", "missing_evidence_wait_fraction",
    "escalate_roles", "escalate_min_confidence", "escalate_min_risk", "deliberation_enabled",
    "max_deliberation_round", "role_prompt_version", "provider", "model", "model_version",
  ]);
  for (const k of Object.keys(policy)) assert.ok(allowed.has(k), `unexpected policy key ${k}`);
  // even when secrets exist in the env, an env-derived local policy must not embed base URL / secrets
  const env = { ...process.env, EVALUATION_PROVIDER: "local", AI_BASE_URL: "http://secret-host:11434", AI_MODEL: "llama3", OPS_INGEST_SECRET: "supersecret-xyz" };
  const eff = JSON.stringify(effectiveEvaluationPolicy(env));
  assert.doesNotMatch(eff, /secret-host|supersecret-xyz|11434/);
});

test("fingerprint is deterministic and changes only when policy changes", () => {
  const base = buildEvaluationPolicy({ provider: { name: "stub" } });
  assert.equal(evaluationPolicyFingerprint(base), evaluationPolicyFingerprint(buildEvaluationPolicy({ provider: { name: "stub" } })));
  const changed = buildEvaluationPolicy({ provider: { name: "stub" }, aggConfig: aggregationConfig({ EVAL_PROPOSE_SUPERMAJORITY: "0.9" }) });
  assert.notEqual(evaluationPolicyFingerprint(base), evaluationPolicyFingerprint(changed));
});
