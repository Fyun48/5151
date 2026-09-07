import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";

import { openOpsDb } from "../src/opsDb.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { runProposalOnce } from "../src/proposalWorker.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";
import { getCurrentIssueProposal, submitOwnerDecision, getActiveAuthorization, listProposals, listOwnerDecisions } from "../src/proposal.js";
import { findEntity } from "../src/stateMachine.js";
import { reevaluationConfig, reevaluationPolicyFingerprint, assessMaterialChange } from "../src/reevaluationPolicy.js";
import {
  assessReevaluation, authorizeAndReopen, ownerManualReevaluate, ownerUnblock,
  getReevaluationBaseline, baselineFingerprint, evidenceFingerprint, listReevaluationAuthorizations,
} from "../src/reevaluation.js";
import { runReevaluationOnce } from "../src/reevaluationWorker.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const hoursLater = (h) => new Date(NOW.getTime() + h * 3600e3);
const CFG0 = reevaluationConfig({ REEVAL_COOLDOWN_MS: "0" }); // 略過 cooldown 供 material 測試
let seq = 1;
const state = (db, iid) => findEntity(db, `issue:${iid}`)?.state;

function link(db, iid, fid, aid) {
  db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, NOW.toISOString());
}
function seedFeedback(db, { severity = "HIGH", category = "BUG" } = {}) {
  const i = seq++; const ts = NOW.toISOString();
  db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, 'leak@example.com', ?, '3.47', ?)").run(`d${i}`, `k${i}`, `c${i}`, `reporter-${i}`, ts);
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', ?, 's', ?, 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, category, severity, ts, ts, ts);
  const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
  return { fid, aid };
}
function seedIssue(db, { members = 8, severity = "HIGH", category = "BUG" } = {}) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s',?,'cluster-v1','open',?,?)").run(category, ts, ts).lastInsertRowid);
  for (let k = 0; k < members; k++) { const f = seedFeedback(db, { severity, category }); link(db, iid, f.fid, f.aid); }
  calculateAndStoreImpact(db, iid, { now: NOW });
  return iid;
}
function grow(db, iid, { count = 2, severity = "HIGH" } = {}, { recalc = true } = {}) {
  for (let k = 0; k < count; k++) { const f = seedFeedback(db, { severity }); link(db, iid, f.fid, f.aid); }
  if (recalc) calculateAndStoreImpact(db, iid, { now: NOW });
}
async function decideIssue(db, { members = 8, category = "BUG", decision } = {}) {
  const iid = seedIssue(db, { members, category });
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  submitOwnerDecision(db, iid, { action: decision, proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
  return { iid, proposal: cur };
}

// ── Policy determinism + DEFER vs REJECT (1,5,6,7,19,20) ──
test("assessMaterialChange: DEFER lower threshold than REJECT; deterministic reasons", () => {
  const baseline = { current_feedback_count: 8, distinct_reporter_count: 8, impact_score: 60, impact_level: "HIGH", recent_velocity: 5, severity_distribution: { HIGH: 8 } };
  const small = { ...baseline, current_feedback_count: 10, distinct_reporter_count: 10, impact_score: 63 }; // +2 fb, +2 reporters
  const defer = assessMaterialChange({ decisionType: "DEFER", baseline, current: small });
  const reject = assessMaterialChange({ decisionType: "REJECT", baseline, current: small });
  assert.equal(defer.eligible, true);                 // 1/6: small change reopens DEFER
  assert.equal(reject.eligible, false);               // 5: same change does NOT reopen REJECT
  const big = { ...baseline, current_feedback_count: 14, distinct_reporter_count: 14, impact_score: 90, impact_level: "CRITICAL", severity_distribution: { CRITICAL: 6 } };
  assert.equal(assessMaterialChange({ decisionType: "REJECT", baseline, current: big }).eligible, true); // 7
});
test("no change → not eligible (below threshold stays put)", () => {
  const b = { current_feedback_count: 8, distinct_reporter_count: 8, impact_score: 60, impact_level: "HIGH", recent_velocity: 5, severity_distribution: { HIGH: 8 } };
  assert.equal(assessMaterialChange({ decisionType: "DEFER", baseline: b, current: { ...b } }).eligible, false);
});
test("fingerprints deterministic; policy fingerprint changes with config; no secrets", () => {
  const b = { issue_id: 1, owner_decision_id: 2, decision_type: "DEFER", proposal_id: 3, proposal_version: 1, proposal_hash: "h", source_impact_assessment_id: 4, membership_fingerprint: "m", analysis_fingerprint: "a", impact_score: 60, impact_level: "HIGH", current_feedback_count: 8, distinct_reporter_count: 8, severity_distribution: {}, decision_at: "t" };
  assert.equal(baselineFingerprint(b), baselineFingerprint({ ...b }));
  assert.notEqual(baselineFingerprint(b), baselineFingerprint({ ...b, impact_score: 61 }));
  const ev = { membership_fingerprint: "m", id: 4, analysis_fingerprint: "a", scoring_version: "impact-v1", impact_score: 60, impact_level: "HIGH", current_feedback_count: 8, distinct_reporter_count: 8, severity_distribution: {} };
  assert.equal(evidenceFingerprint(ev), evidenceFingerprint({ ...ev }));
  assert.notEqual(evidenceFingerprint(ev), evidenceFingerprint({ ...ev, impact_score: 70 }));
  const fp = reevaluationPolicyFingerprint(reevaluationConfig());
  assert.equal(fp, reevaluationPolicyFingerprint(reevaluationConfig()));
  assert.notEqual(fp, reevaluationPolicyFingerprint(reevaluationConfig({ REEVAL_DEFER_MIN_FEEDBACK_DELTA: "9" })));
  const snap = JSON.stringify(reevaluationConfig({ ...process.env, OPS_INGEST_SECRET: "supersecret-xyz", AI_BASE_URL: "http://h:1" }));
  assert.doesNotMatch(snap, /supersecret-xyz|http:\/\//);
});

// ── DEFER auto reopen (2,3,4,16,25,29) ──
test("DEFER: material growth becomes eligible, reopens once via central state machine (no dev auth)", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await decideIssue(db, { decision: "DEFER" });
  assert.equal(state(db, iid), "DEFERRED");
  grow(db, iid, { count: 4 });
  assert.equal(assessReevaluation(db, iid, { now: NOW, config: CFG0 }).eligible, true);
  const r = authorizeAndReopen(db, iid, { now: NOW, config: CFG0 });
  assert.equal(r.reopened, true);
  assert.equal(state(db, iid), "EVALUATING"); // 4 central state machine
  assert.equal(listReevaluationAuthorizations(db, { issueId: iid }).length, 1); // 3 exactly one
  assert.equal(getActiveAuthorization(db, iid), null); // 29 no approved dev scope
  // 18: baseline binds to the exact historical decision/proposal
  const trans = db.prepare("SELECT to_state FROM state_transition WHERE entity_id=? ORDER BY id ASC").all(`issue:${iid}`).map((x) => x.to_state);
  assert.ok(trans.includes("EVALUATING"));
  db.close();
});
test("DEFER below threshold stays DEFERRED", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await decideIssue(db, { decision: "DEFER" });
  calculateAndStoreImpact(db, iid, { now: NOW }); // recalc, no new evidence → deltas 0
  assert.equal(assessReevaluation(db, iid, { now: NOW, config: CFG0 }).eligible, false);
  assert.throws(() => authorizeAndReopen(db, iid, { now: NOW, config: CFG0 }), /no material change/);
  assert.equal(state(db, iid), "DEFERRED");
  db.close();
});
test("16/17. stale impact → wait (not eligible, cannot reopen)", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await decideIssue(db, { decision: "DEFER" });
  grow(db, iid, { count: 4 }, { recalc: false }); // members changed but impact NOT recalculated → stale
  const a = assessReevaluation(db, iid, { now: NOW, config: CFG0 });
  assert.equal(a.eligible, false);
  assert.equal(a.reason, "impact_stale");
  assert.throws(() => authorizeAndReopen(db, iid, { now: NOW, config: CFG0 }), /stale/);
  db.close();
});

// ── REJECT (7 end-to-end) ──
test("REJECT: strong material change (CRITICAL) reopens; old proposal/decision remain historical", async () => {
  const db = openOpsDb(":memory:");
  const { iid, proposal } = await decideIssue(db, { decision: "REJECT" });
  assert.equal(state(db, iid), "REJECTED");
  grow(db, iid, { count: 6, severity: "CRITICAL" });
  const r = authorizeAndReopen(db, iid, { now: NOW, config: CFG0 });
  assert.equal(r.reopened, true);
  assert.equal(state(db, iid), "EVALUATING");
  // 27/28: original decision + proposal remain
  assert.ok(listOwnerDecisions(db, { issueId: iid }).some((d) => d.action === "REJECT"));
  assert.ok(listProposals(db, { issueId: iid }).some((p) => p.id === proposal.id));
  db.close();
});

// ── BLOCK is absolute for automation (8,9,10,11,12,15) ──
test("BLOCKED never auto-reopens even with CRITICAL flood; only Owner UNBLOCK works", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await decideIssue(db, { decision: "BLOCK" });
  assert.equal(state(db, iid), "BLOCKED");
  grow(db, iid, { count: 100, severity: "CRITICAL" });
  // worker never scans BLOCKED
  const s = runReevaluationOnce(db, { now: () => NOW, config: CFG0 });
  assert.equal(s.reopened, 0);
  assert.equal(state(db, iid), "BLOCKED"); // 8/9/10
  // auto authorize refuses
  assert.throws(() => authorizeAndReopen(db, iid, { now: NOW, config: CFG0 }), /not reopenable/);
  // owner manual re-eval cannot bypass BLOCK (15)
  assert.throws(() => ownerManualReevaluate(db, iid, { now: NOW, config: CFG0 }), /not reopenable/);
  // owner UNBLOCK works (11)
  const u = ownerUnblock(db, iid, { actor: "owner:x", now: NOW, config: CFG0 });
  assert.equal(u.unblocked, true);
  assert.equal(state(db, iid), "EVALUATING");
  db.close();
});
test("12. worker source performs no UNBLOCK (only Owner route can)", () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "reevaluationWorker.js"), "utf8");
  assert.doesNotMatch(src, /ownerUnblock|owner_unblock/);
  assert.doesNotMatch(src, /cursor/i);
});

// ── Owner manual re-evaluation (13,14) ──
for (const decision of ["DEFER", "REJECT"]) {
  test(`Owner manual re-evaluation works for ${decision} (bypasses thresholds, still audited/transactional)`, async () => {
    const db = openOpsDb(":memory:");
    const { iid } = await decideIssue(db, { decision });
    calculateAndStoreImpact(db, iid, { now: NOW }); // no material change
    assert.equal(assessReevaluation(db, iid, { now: NOW, config: CFG0 }).eligible, false);
    const r = ownerManualReevaluate(db, iid, { actor: "owner:x", now: NOW, config: CFG0 });
    assert.equal(r.reopened, true);
    assert.equal(state(db, iid), "EVALUATING");
    const auth = listReevaluationAuthorizations(db, { issueId: iid })[0];
    assert.equal(auth.trigger_type, "owner_manual");
    assert.equal(auth.authorized_by, "owner");
    db.close();
  });
}

// ── cooldown / idempotency / already-evaluating / merged (23,24,22,31,32) ──
test("cooldown prevents immediate reopen; after cooldown new evidence considered", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await decideIssue(db, { decision: "DEFER" });
  grow(db, iid, { count: 4 }, { recalc: false });
  calculateAndStoreImpact(db, iid, { now: hoursLater(25) }); // keep impact fresh at +25h
  const withCooldown = assessReevaluation(db, iid, { now: hoursLater(1) }); // default 24h cooldown, still within
  assert.equal(withCooldown.eligible, false);
  assert.equal(withCooldown.cooldown, true);
  const afterCooldown = assessReevaluation(db, iid, { now: hoursLater(25) });
  assert.equal(afterCooldown.eligible, true);
  db.close();
});
test("22/31. idempotent: worker does not reopen an already-EVALUATING issue twice", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await decideIssue(db, { decision: "DEFER" });
  grow(db, iid, { count: 4 });
  const s1 = runReevaluationOnce(db, { now: () => NOW, config: CFG0 });
  assert.equal(s1.reopened, 1);
  const s2 = runReevaluationOnce(db, { now: () => NOW, config: CFG0 });
  assert.equal(s2.reopened, 0); // now EVALUATING → not scanned
  assert.equal(listReevaluationAuthorizations(db, { issueId: iid }).length, 1);
  db.close();
});
test("append-only authorization: duplicate insert rejected at DB level", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await decideIssue(db, { decision: "DEFER" });
  grow(db, iid, { count: 4 });
  authorizeAndReopen(db, iid, { now: NOW, config: CFG0 });
  const row = db.prepare("SELECT * FROM issue_reevaluation_authorization WHERE issue_id=?").get(iid);
  assert.throws(() => db.prepare(
    "INSERT INTO issue_reevaluation_authorization(issue_id, trigger_type, authorized_by, from_state, baseline_fingerprint, current_evidence_fingerprint, policy_version, policy_fingerprint, actor, created_at) VALUES (?, 'auto','policy','DEFERRED', ?, ?, ?, ?, 'x', ?)",
  ).run(iid, row.baseline_fingerprint, row.current_evidence_fingerprint, row.policy_version, row.policy_fingerprint, NOW.toISOString()), /UNIQUE|append-only|constraint/i);
  assert.throws(() => db.prepare("UPDATE issue_reevaluation_authorization SET actor='y' WHERE id=?").run(row.id), /append-only/);
  db.close();
});
test("32. merged/obsolete issue is not reopened", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await decideIssue(db, { decision: "DEFER" });
  grow(db, iid, { count: 4 });
  db.prepare("UPDATE issue_candidate SET status='merged' WHERE id=?").run(iid);
  const a = assessReevaluation(db, iid, { now: NOW, config: CFG0 });
  assert.equal(a.applicable, false);
  assert.throws(() => authorizeAndReopen(db, iid, { now: NOW, config: CFG0 }), /not active|not reopenable/);
  db.close();
});

// ── Approved development not reopened (30) ──
test("30. APPROVED issue with active development authorization is not auto-reopened", async () => {
  const db = openOpsDb(":memory:");
  const { iid, proposal } = await decideIssue(db, { decision: "APPROVE_DEVELOPMENT" });
  assert.equal(state(db, iid), "APPROVED_FOR_DEVELOPMENT");
  assert.ok(getActiveAuthorization(db, iid));
  grow(db, iid, { count: 10, severity: "CRITICAL" });
  const s = runReevaluationOnce(db, { now: () => NOW, config: CFG0 });
  assert.equal(s.scanned, 0); // APPROVED not in reopenable scan
  assert.equal(state(db, iid), "APPROVED_FOR_DEVELOPMENT");
  assert.ok(getActiveAuthorization(db, iid)); // dev auth untouched
  assert.throws(() => authorizeAndReopen(db, iid, { now: NOW, config: CFG0 }), /not reopenable/);
  void proposal;
  db.close();
});

// ── failed transaction leaves no partial (26) ──
test("26. failed authorize (stale impact) leaves no authorization and keeps state", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await decideIssue(db, { decision: "DEFER" });
  grow(db, iid, { count: 4 }, { recalc: false }); // stale
  assert.throws(() => authorizeAndReopen(db, iid, { now: NOW, config: CFG0 }), /stale/);
  assert.equal(listReevaluationAuthorizations(db, { issueId: iid }).length, 0);
  assert.equal(state(db, iid), "DEFERRED");
  db.close();
});

// ── security boundary: no Cursor / coding / deploy (36,37,38,39) ──
test("36/37/38/39. Phase 9 sources have no Cursor/coding-provider/repo/deploy dependency", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ["reevaluation.js", "reevaluationWorker.js", "reevaluationPolicy.js"]) {
    const src = readFileSync(path.join(dir, "..", "src", f), "utf8");
    assert.doesNotMatch(src, /cursor|codex|claude|gemini/i, `${f} must not reference a coding provider`);
    assert.doesNotMatch(src, /child_process|exec\(|spawn\(|GITHUB_TOKEN|process\.env\.NAS_|deploy/i, `${f} must not touch shell/repo/deploy`);
  }
});

// ── baseline provenance (18) ──
test("18. baseline binds to exact historical owner decision + proposal + source impact", async () => {
  const db = openOpsDb(":memory:");
  const { iid, proposal } = await decideIssue(db, { decision: "REJECT" });
  const b = getReevaluationBaseline(db, iid, "REJECT");
  assert.equal(b.proposal_id, proposal.id);
  assert.equal(b.proposal_hash, proposal.proposal_hash);
  assert.equal(b.decision_type, "REJECT");
  assert.ok(b.source_impact_assessment_id > 0);
  db.close();
});
