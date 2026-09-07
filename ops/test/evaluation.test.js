import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { validateRoleOutput, parseAndValidateRole, riskAtLeast } from "../src/evaluationSchema.js";
import { buildRoleEvaluationPrompt, evaluationRolesConfig, DEFAULT_ROLES } from "../src/evaluationRoles.js";
import { aggregateVotes, aggregationConfig } from "../src/evaluationAggregation.js";
import { evaluationInputFingerprint, getCurrentIssueEvaluation, evaluationStaleReasons, isEvaluationStale, currentEvaluationRunId, getEvaluationRunDetail, requestEvaluationRecalc, computeEvaluationInput } from "../src/evaluation.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider, makeEvaluationProvider } from "../src/ai/evaluationProvider.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const hoursLater = (h) => new Date(NOW.getTime() + h * 3600e3);
let seq = 1;

function seedFeedback(db, { userRef = null, severity = "HIGH", category = "BUG", receivedAt = NOW.toISOString() } = {}) {
  const i = seq++;
  db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, 'leak@example.com', ?, '3.47', ?)")
    .run(`d${i}`, `k${i}`, `content ${i}`, userRef, receivedAt);
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  const aid = insertAnalysis(db, fid, { severity, category, receivedAt });
  return { fid, aid };
}
function insertAnalysis(db, fid, { severity = "HIGH", category = "BUG", receivedAt = NOW.toISOString() } = {}) {
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', (SELECT IFNULL(MAX(revision),0)+1 FROM feedback_analysis WHERE feedback_id=?), 0, 5, 'feedback-classification-v1', ?, 'symptom summary', ?, 0.8, 'zh-TW', 'completed', ?, ?, ?)")
    .run(fid, fid, category, severity, receivedAt, receivedAt, receivedAt);
  const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't') ON CONFLICT(feedback_id, analysis_type) DO UPDATE SET analysis_id=excluded.analysis_id, updated_at=excluded.updated_at")
    .run(fid, aid, receivedAt);
  return aid;
}
function newIssue(db, { category = "BUG", status = "open" } = {}) {
  const ts = NOW.toISOString();
  return Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s',?,'cluster-v1',?,?,?)").run(category, status, ts, ts).lastInsertRowid);
}
function link(db, iid, { fid, aid }) {
  db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, NOW.toISOString());
}
// 建一個 open issue，N 個 distinct-reporter HIGH 成員（→ 高 impact），並算出 fresh current impact。
function seedIssueWithImpact(db, { members = 8, category = "BUG", severity = "HIGH", now = NOW } = {}) {
  const iid = newIssue(db, { category });
  for (let k = 0; k < members; k++) link(db, iid, seedFeedback(db, { userRef: `u${seq}`, severity, category }));
  calculateAndStoreImpact(db, iid, { now });
  return iid;
}
const stub = (opts) => makeStubEvaluationProvider(opts);
const once = (db, opts = {}) => runEvaluationOnce(db, { provider: opts.provider || stub(), config: { concurrency: 1, deliberationEnabled: opts.deliberation || false }, now: () => opts.now || NOW });

// ── Schema (7–13) ──
for (const role of DEFAULT_ROLES) {
  test(`role output validates for ${role} (req 7–11)`, () => {
    const out = validateRoleOutput({ recommendation: "propose", confidence: 0.7, risk_level: "medium", rationale: "x", evidence_refs: ["impact"], missing_evidence: [], risk_flags: [] });
    assert.equal(out.recommendation, "PROPOSE");
    assert.equal(out.risk_level, "MEDIUM");
    assert.equal(out.confidence, 0.7);
  });
}
test("12. invalid recommendation is rejected", () => {
  assert.throws(() => validateRoleOutput({ recommendation: "NONSENSE", confidence: 0.5, risk_level: "LOW" }), /invalid recommendation/);
  assert.throws(() => parseAndValidateRole('{"recommendation":"NOPE","confidence":0.5}'), /invalid recommendation/);
});
test("13. invalid confidence is rejected", () => {
  assert.throws(() => validateRoleOutput({ recommendation: "PROPOSE", confidence: 5, risk_level: "LOW" }), /confidence/);
  assert.throws(() => validateRoleOutput({ recommendation: "PROPOSE", confidence: "high", risk_level: "LOW" }), /confidence/);
});
test("risk_level normalizes unknown to UNKNOWN; riskAtLeast ordering", () => {
  assert.equal(validateRoleOutput({ recommendation: "WAIT", confidence: 0.5, risk_level: "bogus" }).risk_level, "UNKNOWN");
  assert.equal(riskAtLeast("CRITICAL", "HIGH"), true);
  assert.equal(riskAtLeast("LOW", "HIGH"), false);
});

// ── Fingerprint (3,4,5,24) ──
test("3/4/5. fingerprint binds membership, impact id, and analysis provenance", () => {
  const base = { issueId: 1, issueStatus: "open", issueCategory: "BUG", issueUpdatedAt: "t", membershipFingerprint: "m1", impactAssessmentId: 10, impactMembershipFingerprint: "m1", impactAnalysisFingerprint: "a1", impactScoringVersion: "impact-v1", impactAsOfAt: "t", roles: DEFAULT_ROLES };
  const fp = evaluationInputFingerprint(base);
  assert.notEqual(fp, evaluationInputFingerprint({ ...base, membershipFingerprint: "m2" })); // 3 membership
  assert.notEqual(fp, evaluationInputFingerprint({ ...base, impactAssessmentId: 11 }));       // 4 impact id
  assert.notEqual(fp, evaluationInputFingerprint({ ...base, impactAnalysisFingerprint: "a2" })); // 5 analysis
  assert.equal(fp, evaluationInputFingerprint({ ...base })); // deterministic
});

// ── Aggregation (17–22) ──
const V = (role, recommendation, confidence, risk_level, missing_evidence = []) => ({ role, recommendation, confidence, risk_level, missing_evidence });
test("17. SECURITY escalation overrides ordinary propose majority", () => {
  const votes = [V("PRODUCT", "PROPOSE", 0.8, "LOW"), V("ENGINEERING", "PROPOSE", 0.8, "LOW"), V("OPERATIONS", "PROPOSE", 0.8, "LOW"), V("COMPLIANCE", "PROPOSE", 0.8, "LOW"), V("SECURITY", "ESCALATE", 0.9, "CRITICAL")];
  const r = aggregateVotes(votes, { requiredRoles: DEFAULT_ROLES });
  assert.equal(r.final_recommendation, "ESCALATE");
  assert.equal(r.details.rule, "blocking_escalation");
});
test("18. COMPLIANCE escalation overrides ordinary propose majority", () => {
  const votes = [V("PRODUCT", "PROPOSE", 0.8, "LOW"), V("ENGINEERING", "PROPOSE", 0.8, "LOW"), V("OPERATIONS", "PROPOSE", 0.8, "LOW"), V("SECURITY", "PROPOSE", 0.8, "LOW"), V("COMPLIANCE", "ESCALATE", 0.9, "CRITICAL")];
  assert.equal(aggregateVotes(votes, { requiredRoles: DEFAULT_ROLES }).final_recommendation, "ESCALATE");
});
test("escalation requires sufficient confidence AND risk", () => {
  const weak = [V("PRODUCT", "PROPOSE", 0.8, "HIGH"), V("ENGINEERING", "PROPOSE", 0.8, "HIGH"), V("OPERATIONS", "PROPOSE", 0.8, "HIGH"), V("COMPLIANCE", "PROPOSE", 0.8, "HIGH"), V("SECURITY", "ESCALATE", 0.4, "CRITICAL")];
  assert.equal(aggregateVotes(weak, { requiredRoles: DEFAULT_ROLES }).final_recommendation, "PROPOSE"); // low confidence → no escalation
  const lowRisk = [V("PRODUCT", "PROPOSE", 0.8, "HIGH"), V("ENGINEERING", "PROPOSE", 0.8, "HIGH"), V("OPERATIONS", "PROPOSE", 0.8, "HIGH"), V("COMPLIANCE", "PROPOSE", 0.8, "HIGH"), V("SECURITY", "ESCALATE", 0.9, "LOW")];
  assert.equal(aggregateVotes(lowRisk, { requiredRoles: DEFAULT_ROLES }).final_recommendation, "PROPOSE"); // low risk → no escalation
});
test("19. PROPOSE aggregation is deterministic", () => {
  const votes = DEFAULT_ROLES.map((r) => V(r, "PROPOSE", 0.8, "MEDIUM"));
  const a = aggregateVotes(votes, { requiredRoles: DEFAULT_ROLES });
  const b = aggregateVotes(votes, { requiredRoles: DEFAULT_ROLES });
  assert.equal(a.final_recommendation, "PROPOSE");
  assert.deepEqual(a, b);
});
test("20. WAIT fallback is deterministic (no supermajority / incomplete quorum)", () => {
  const mixed = [V("PRODUCT", "PROPOSE", 0.6, "LOW"), V("ENGINEERING", "PROPOSE", 0.6, "LOW"), V("SECURITY", "IGNORE", 0.6, "LOW"), V("COMPLIANCE", "IGNORE", 0.6, "LOW"), V("OPERATIONS", "WAIT", 0.6, "LOW")];
  assert.equal(aggregateVotes(mixed, { requiredRoles: DEFAULT_ROLES }).final_recommendation, "WAIT");
  const partial = [V("PRODUCT", "PROPOSE", 0.8, "LOW"), V("ENGINEERING", "PROPOSE", 0.8, "LOW")];
  const r = aggregateVotes(partial, { requiredRoles: DEFAULT_ROLES });
  assert.equal(r.final_recommendation, "WAIT");
  assert.equal(r.details.reason, "incomplete_quorum");
});
test("21. IGNORE aggregation is deterministic", () => {
  const votes = DEFAULT_ROLES.map((r) => V(r, "IGNORE", 0.7, "LOW"));
  assert.equal(aggregateVotes(votes, { requiredRoles: DEFAULT_ROLES }).final_recommendation, "IGNORE");
});
test("material missing evidence forces WAIT", () => {
  const votes = DEFAULT_ROLES.map((r) => V(r, "PROPOSE", 0.8, "LOW", ["need repro"]));
  const r = aggregateVotes(votes, { requiredRoles: DEFAULT_ROLES });
  assert.equal(r.final_recommendation, "WAIT");
  assert.equal(r.details.reason, "material_missing_evidence");
});
test("22. thresholds/weights configurable centrally", () => {
  const cfg = aggregationConfig({ EVAL_PROPOSE_SUPERMAJORITY: "0.9", EVAL_WEIGHT_SECURITY: "3" });
  assert.equal(cfg.proposeSupermajority, 0.9);
  assert.equal(cfg.weights.SECURITY, 3);
  // with 0.9 supermajority, 4/5 PROPOSE (0.8 frac) no longer reaches PROPOSE → WAIT
  const votes = [V("PRODUCT", "PROPOSE", 0.8, "LOW"), V("ENGINEERING", "PROPOSE", 0.8, "LOW"), V("OPERATIONS", "PROPOSE", 0.8, "LOW"), V("COMPLIANCE", "PROPOSE", 0.8, "LOW"), V("SECURITY", "WAIT", 0.8, "LOW")];
  assert.equal(aggregateVotes(votes, { requiredRoles: DEFAULT_ROLES, config: cfg }).final_recommendation, "WAIT");
});

// ── First-round independence + deliberation (14,15,16) ──
test("14. first round prompt is independent (no peers); round 2 includes peers", () => {
  const input = { issue: { id: 1, category: "BUG" }, impact: { impact_level: "HIGH" }, evidence_summaries: [] };
  const r1 = buildRoleEvaluationPrompt({ role: "PRODUCT", input, round: 1 });
  assert.doesNotMatch(r1.user, /"peers"/);
  const r2 = buildRoleEvaluationPrompt({ role: "PRODUCT", input, round: 2, peerSummaries: [{ role: "SECURITY", recommendation: "ESCALATE", risk_level: "CRITICAL" }] });
  assert.match(r2.user, /"peers"/);
});
test("15/16. deliberation bounded to one revision; round-1 history preserved", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 8, category: "SECURITY", severity: "HIGH" });
  await once(db, { deliberation: true });
  const runId = currentEvaluationRunId(db, iid);
  const detail = getEvaluationRunDetail(db, runId);
  const rounds = detail.role_evaluations.map((r) => r.round);
  assert.equal(Math.max(...rounds), 2); // bounded to 2 (one revision)
  assert.ok(!rounds.includes(3));
  const productR1 = detail.role_evaluations.find((r) => r.role === "PRODUCT" && r.round === 1);
  const productR2 = detail.role_evaluations.find((r) => r.role === "PRODUCT" && r.round === 2);
  assert.equal(productR1.recommendation, "PROPOSE"); // first-round preserved
  assert.equal(productR2.recommendation, "WAIT");    // revised after seeing SECURITY critical escalation
  db.close();
});
test("14b. without deliberation only round 1 rows exist", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 8 });
  await once(db, { deliberation: false });
  const detail = getEvaluationRunDetail(db, currentEvaluationRunId(db, iid));
  assert.ok(detail.role_evaluations.every((r) => r.round === 1));
  assert.equal(detail.role_evaluations.length, DEFAULT_ROLES.length);
  db.close();
});

// ── Engine freshness (1,2,6,23,24) ──
test("1. consumes fresh canonical Phase-6 impact; run binds to current assessment", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 8 });
  const impactId = db.prepare("SELECT assessment_id FROM issue_impact_current WHERE issue_id=?").get(iid).assessment_id;
  const s = await once(db);
  assert.equal(s.completed, 1);
  const cur = getCurrentIssueEvaluation(db, iid, { now: NOW, provider: stub() });
  assert.equal(cur.status, "completed");
  assert.equal(cur.source_impact_assessment_id, Number(impactId));
  assert.equal(cur.fresh, true);
  db.close();
});
test("2. stale Phase-6 impact prevents promotion of a new canonical evaluation", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 4 });
  // make impact stale by adding a member WITHOUT recalculating impact
  link(db, iid, seedFeedback(db, { userRef: "extra" }));
  const s = await once(db);
  assert.equal(s.enqueued, 0); // worker won't enqueue when impact is stale
  assert.equal(getCurrentIssueEvaluation(db, iid), null); // nothing promoted
  db.close();
});
test("2b. executeEvaluationRun defers (no promotion) when impact stale", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 4 });
  const r = requestEvaluationRecalc(db, iid, { now: NOW }); // enqueue manual run
  link(db, iid, seedFeedback(db, { userRef: "extra" })); // now impact stale
  const { claimEvaluationBatch, executeEvaluationRun } = await import("../src/evaluation.js");
  const [run] = claimEvaluationBatch(db, { now: NOW });
  const status = await executeEvaluationRun(db, run, { provider: stub(), roles: DEFAULT_ROLES, now: () => NOW });
  assert.equal(status, "deferred");
  assert.equal(getCurrentIssueEvaluation(db, iid), null);
  assert.ok(r.evaluation_run_id > 0);
  db.close();
});
test("6. impact age/staleness propagates to Phase 7 freshness", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 8 });
  await once(db);
  assert.equal(isEvaluationStale(db, iid, { now: NOW, provider: stub() }), false);
  const reasons = evaluationStaleReasons(db, iid, { now: hoursLater(7), provider: stub() }); // > IMPACT_MAX_AGE_MS (6h)
  assert.ok(reasons.includes("impact_stale"));
  assert.ok(reasons.some((r) => r === "impact:age_exceeded"));
  db.close();
});
test("23. same input + same version is idempotent (no duplicate successful run)", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 8 });
  const s1 = await once(db);
  assert.equal(s1.completed, 1);
  const firstRun = currentEvaluationRunId(db, iid);
  const s2 = await once(db);
  assert.equal(s2.enqueued, 0);
  assert.equal(s2.completed, 0);
  assert.equal(currentEvaluationRunId(db, iid), firstRun); // unchanged
  assert.equal(db.prepare("SELECT COUNT(*) n FROM issue_evaluation_run WHERE issue_id=?").get(iid).n, 1);
  db.close();
});
test("24. canonical input change makes prior evaluation stale", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 8 });
  await once(db);
  assert.equal(isEvaluationStale(db, iid, { now: NOW, provider: stub() }), false);
  link(db, iid, seedFeedback(db, { userRef: "new-reporter" })); // membership change
  calculateAndStoreImpact(db, iid, { now: NOW }); // refresh impact → new assessment id + membership fp
  const reasons = evaluationStaleReasons(db, iid, { now: NOW, provider: stub() });
  assert.ok(reasons.includes("input_changed"), JSON.stringify(reasons));
  db.close();
});

// ── Failure / partial / provider-unavailable (25,26,27) ──
test("25. failed provider call does not replace valid current evaluation", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 8 });
  await once(db); // good current
  const good = currentEvaluationRunId(db, iid);
  link(db, iid, seedFeedback(db, { userRef: "new" }));
  calculateAndStoreImpact(db, iid, { now: NOW }); // stale → eligible for re-eval
  const s = await once(db, { provider: stub({ behavior: "error" }) });
  assert.equal(s.completed, 0);
  assert.equal(currentEvaluationRunId(db, iid), good); // unchanged
  db.close();
});
test("26. partial run (one role fails) is not promoted", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 8 });
  const s = await once(db, { provider: stub({ failRole: "SECURITY" }) });
  assert.equal(s.completed, 0);
  assert.equal(getCurrentIssueEvaluation(db, iid), null);
  assert.equal(currentEvaluationRunId(db, iid), null);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM issue_evaluation_run WHERE issue_id=? AND status IN ('failed','failed_retry')").get(iid).n >= 1);
  db.close();
});
test("27. provider unavailable does not affect ingestion/clustering/impact", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 4 });
  const s = await runEvaluationOnce(db, { provider: makeEvaluationProvider({}), now: () => NOW }); // null provider
  assert.equal(s.skipped, "no_provider");
  assert.equal(s.enqueued, 0);
  // impact recompute still works with eval provider offline
  const before = db.prepare("SELECT assessment_id FROM issue_impact_current WHERE issue_id=?").get(iid).assessment_id;
  link(db, iid, seedFeedback(db, { userRef: "z" }));
  const r = calculateAndStoreImpact(db, iid, { now: NOW });
  assert.ok(r.assessmentId > 0 && r.assessmentId !== before);
  db.close();
});

// ── Issue state (34) ──
test("34. merged/inactive issue is not evaluated as active", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedIssueWithImpact(db, { members: 8 });
  db.prepare("UPDATE issue_candidate SET status='merged' WHERE id=?").run(iid);
  const s = await once(db);
  assert.equal(s.enqueued, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM issue_evaluation_run WHERE issue_id=?").get(iid).n, 0);
  assert.throws(() => requestEvaluationRecalc(db, iid, {}), /not active/);
  db.close();
});

// ── No Cursor runtime dependency (28) ──
test("28. no Cursor runtime dependency in Phase 7 sources", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    "evaluation.js", "evaluationWorker.js", "evaluationRoles.js", "evaluationSchema.js",
    "evaluationAggregation.js", "ai/evaluationProvider.js",
  ];
  for (const f of files) {
    const src = readFileSync(path.join(dir, "..", "src", f), "utf8");
    assert.doesNotMatch(src, /cursor/i, `${f} must not reference Cursor as evaluator runtime`);
  }
});

test("rolesConfig is centralized and configurable", () => {
  assert.deepEqual(evaluationRolesConfig().roles, DEFAULT_ROLES);
  assert.deepEqual(evaluationRolesConfig({ EVALUATION_ROLES: "product, security" }).roles, ["PRODUCT", "SECURITY"]);
});
