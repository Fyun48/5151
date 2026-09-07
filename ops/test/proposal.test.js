import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 讓 env 推導的 evaluation / proposal provider 皆為決定性 stub（node --test 每檔獨立 process）。
process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";

import { openOpsDb } from "../src/opsDb.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { runProposalOnce } from "../src/proposalWorker.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";
import { validateProposalOutput, parseAndValidateProposal } from "../src/proposalSchema.js";
import { buildProposalPolicy, proposalPolicyFingerprint } from "../src/proposalPolicy.js";
import {
  proposalInputFingerprint, computeProposalHash, getCurrentIssueProposal, currentProposalId,
  submitOwnerDecision, listProposals, listOwnerDecisions, getActiveAuthorization, proposalStaleReasons,
  computeProposalInput,
} from "../src/proposal.js";
import { findEntity } from "../src/stateMachine.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
let seq = 1;
const evalStub = () => makeStubEvaluationProvider();
const propStub = (o) => makeStubProposalProvider(o);

function link(db, iid, fid, aid) {
  db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, NOW.toISOString());
}
function seedFeedback(db, { severity = "HIGH", category = "BUG" } = {}) {
  const i = seq++; const ts = NOW.toISOString();
  db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, 'leak@example.com', ?, '3.47', ?)").run(`d${i}`, `k${i}`, `content ${i}`, `reporter-${i}`, ts);
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', ?, 'symptom summary', ?, 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, category, severity, ts, ts, ts);
  const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
  return { fid, aid };
}
// 建立一個「有 fresh PROPOSE 評估」的 issue（8 個 HIGH reporter → 高影響 → 全 PROPOSE）。
function seedProposeIssue(db, { members = 8, category = "BUG" } = {}) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s',?,'cluster-v1','open',?,?)").run(category, ts, ts).lastInsertRowid);
  for (let k = 0; k < members; k++) { const f = seedFeedback(db, { category }); link(db, iid, f.fid, f.aid); }
  calculateAndStoreImpact(db, iid, { now: NOW });
  return iid;
}
async function evaluate(db) { return runEvaluationOnce(db, { provider: evalStub(), config: { concurrency: 1 }, now: () => NOW }); }
async function propose(db, opts = {}) { return runProposalOnce(db, { provider: opts.provider || propStub(), config: { concurrency: 1 }, now: () => NOW }); }

// 建立完整 PROPOSE → proposal 的 issue，回傳 { iid, current }
async function seedApprovableProposal(db, { members = 8 } = {}) {
  const iid = seedProposeIssue(db, { members });
  await evaluate(db);
  await propose(db);
  const current = getCurrentIssueProposal(db, iid, { now: NOW });
  return { iid, current };
}

// ── Schema (5,6) ──
test("5. proposal schema validation works; missing required rejected", () => {
  const ok = validateProposalOutput({ title: "t", problem_statement: "p", proposed_change: "c", scope: ["a"], extra: "ignored" });
  assert.equal(ok.title, "t");
  assert.deepEqual(ok.scope, ["a"]);
  assert.throws(() => validateProposalOutput({ title: "t" }), /missing required/);
  assert.throws(() => parseAndValidateProposal("not json"), /valid JSON/);
});

// ── Fingerprint / policy (8,9) ──
test("8. proposal input fingerprint is deterministic and binds evidence", () => {
  const base = { issueId: 1, issueStatus: "open", issueUpdatedAt: "t", membershipFingerprint: "m", impactAssessmentId: 5, impactMembershipFingerprint: "m", impactAnalysisFingerprint: "a", impactScoringVersion: "impact-v1", evaluationRunId: 9, evaluationInputFingerprint: "ei", evaluationPolicyFingerprint: "ep", finalRecommendation: "PROPOSE", proposalPolicyFingerprint: "pp" };
  assert.equal(proposalInputFingerprint(base), proposalInputFingerprint({ ...base }));
  assert.notEqual(proposalInputFingerprint(base), proposalInputFingerprint({ ...base, evaluationRunId: 10 }));
  assert.notEqual(proposalInputFingerprint(base), proposalInputFingerprint({ ...base, impactAssessmentId: 6 }));
  assert.notEqual(proposalInputFingerprint(base), proposalInputFingerprint({ ...base, proposalPolicyFingerprint: "other" }));
});
test("9. proposal policy fingerprint deterministic; model/prompt/template change it", () => {
  const p = buildProposalPolicy({ provider: { name: "stub" } });
  assert.equal(proposalPolicyFingerprint(p), proposalPolicyFingerprint(buildProposalPolicy({ provider: { name: "stub" } })));
  assert.notEqual(proposalPolicyFingerprint(p), proposalPolicyFingerprint(buildProposalPolicy({ provider: { name: "local", model: "m" } })));
  assert.notEqual(proposalPolicyFingerprint(p), proposalPolicyFingerprint(buildProposalPolicy({ provider: { name: "stub" }, promptVersion: "x" })));
  assert.notEqual(proposalPolicyFingerprint(p), proposalPolicyFingerprint(buildProposalPolicy({ provider: { name: "stub" }, schemaVersion: "x" })));
});

// ── Generation gating (1,2,3,4) ──
test("1. fresh PROPOSE generates a proposal", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current } = await seedApprovableProposal(db);
  assert.ok(current);
  assert.equal(current.status, "completed");
  assert.equal(current.fresh, true);
  assert.equal(findEntity(db, `issue:${iid}`).state, "WAITING_OWNER_APPROVAL");
  db.close();
});
test("2/3. WAIT and IGNORE do not auto-generate a proposal", async () => {
  for (const members of [3 /* MEDIUM→WAIT */, 1 /* LOW→IGNORE */]) {
    const db = openOpsDb(":memory:");
    const iid = seedProposeIssue(db, { members });
    await evaluate(db);
    const s = await propose(db);
    assert.equal(s.enqueued, 0);
    assert.equal(currentProposalId(db, iid), null);
    db.close();
  }
});
test("4. ESCALATE does not silently become development approval / proposal", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedProposeIssue(db, { members: 8, category: "SECURITY" }); // SECURITY role escalates
  await evaluate(db);
  const s = await propose(db);
  assert.equal(s.enqueued, 0);
  assert.equal(currentProposalId(db, iid), null);
  db.close();
});

// ── Content safety (6,7) ──
test("6/7. proposal has no raw PII/secrets and binds exact evaluation run", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current } = await seedApprovableProposal(db);
  const raw = JSON.stringify(current);
  assert.doesNotMatch(raw, /leak@example\.com/);
  assert.doesNotMatch(raw, /reporter-\d/);
  const evalRun = db.prepare("SELECT evaluation_run_id FROM issue_evaluation_current WHERE issue_id=?").get(iid).evaluation_run_id;
  assert.equal(current.source_evaluation_run_id, Number(evalRun));
  db.close();
});

// ── Immutability / versioning (10,11,12,13,14) ──
test("11/12/13/14. immutable; revision → new version + new hash; old kept", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current } = await seedApprovableProposal(db);
  const v1 = current;
  // completed proposal is immutable at DB level
  assert.throws(() => db.prepare("UPDATE issue_proposal SET title='x' WHERE id=?").run(v1.id), /immutable/);
  // REQUEST_CHANGES → new pending version, regenerate
  submitOwnerDecision(db, iid, { action: "REQUEST_CHANGES", proposalId: v1.id, proposalVersion: v1.proposal_version, proposalHash: v1.proposal_hash, reason: "please adjust scope", now: NOW });
  await propose(db);
  const v2 = getCurrentIssueProposal(db, iid, { now: NOW });
  assert.equal(v2.proposal_version, v1.proposal_version + 1);
  assert.notEqual(v2.proposal_hash, v1.proposal_hash);
  const all = listProposals(db, { issueId: iid });
  assert.ok(all.some((p) => p.id === v1.id)); // old kept historically
  assert.ok(all.length >= 2);
  db.close();
});
test("10. proposal policy change makes current proposal stale", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await seedApprovableProposal(db);
  const reasons = proposalStaleReasons(db, iid, { now: NOW, env: { ...process.env, PROPOSAL_PROMPT_VERSION: "proposal-gen-v2" } });
  assert.ok(reasons.includes("proposal_policy_changed"), JSON.stringify(reasons));
  db.close();
});

// ── Current helper + freshness (15,16) ──
test("15. getCurrentIssueProposal returns canonical proposal", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current } = await seedApprovableProposal(db);
  assert.equal(current.id, currentProposalId(db, iid));
  db.close();
});
test("16. source evaluation becoming stale makes proposal stale before approval", async () => {
  const db = openOpsDb(":memory:");
  const { iid } = await seedApprovableProposal(db);
  assert.equal(getCurrentIssueProposal(db, iid, { now: NOW }).fresh, true);
  // add a member → impact stale → evaluation stale → proposal stale
  const f = seedFeedback(db); link(db, iid, f.fid, f.aid);
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  assert.equal(cur.stale, true);
  assert.ok(cur.stale_reasons.some((r) => r.startsWith("evaluation")), JSON.stringify(cur.stale_reasons));
  db.close();
});

// ── Approval + authorization (17,18,19,21,22,23) ──
function approve(db, iid, p, extra = {}) {
  return submitOwnerDecision(db, iid, { action: "APPROVE_DEVELOPMENT", proposalId: p.id, proposalVersion: p.proposal_version, proposalHash: p.proposal_hash, now: NOW, ...extra });
}
test("21/22. APPROVE creates exactly one authorization; duplicate is idempotent", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current } = await seedApprovableProposal(db);
  const r1 = await approve(db, iid, current);
  assert.ok(r1.authorization.id > 0);
  assert.equal(findEntity(db, `issue:${iid}`).state, "APPROVED_FOR_DEVELOPMENT");
  const r2 = await approve(db, iid, current);
  assert.equal(r2.idempotent, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_authorization WHERE issue_id=? AND status='active'").get(iid).n, 1);
  db.close();
});
test("17. stale proposal cannot be approved", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current } = await seedApprovableProposal(db);
  const f = seedFeedback(db); link(db, iid, f.fid, f.aid); // makes evaluation/proposal stale
  assert.throws(() => approve(db, iid, current), /stale/);
  db.close();
});
test("18/19. wrong hash or wrong version cannot be approved", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current } = await seedApprovableProposal(db);
  assert.throws(() => approve(db, iid, { ...current, proposal_hash: "deadbeef" }), /hash mismatch/);
  assert.throws(() => approve(db, iid, { ...current, proposal_version: current.proposal_version + 1 }), /version mismatch|not current/);
  db.close();
});
test("20. non-current old proposal cannot win a TOCTOU approval race", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current: v1 } = await seedApprovableProposal(db);
  submitOwnerDecision(db, iid, { action: "REQUEST_CHANGES", proposalId: v1.id, proposalVersion: v1.proposal_version, proposalHash: v1.proposal_hash, now: NOW });
  await propose(db); // v2 becomes current
  // Owner tries to APPROVE the old v1 (opened earlier)
  assert.throws(() => approve(db, iid, v1), /not current|mismatch/);
  db.close();
});
test("23/24. different version requires new approval; revised proposal supersedes prior authorization", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current: v1 } = await seedApprovableProposal(db);
  await approve(db, iid, v1);
  const auth1 = getActiveAuthorization(db, iid);
  assert.equal(auth1.proposal_version, v1.proposal_version);
  // A new proposal version (simulated revision via fresh generation) supersedes the authorization + invalidates approval.
  const { enqueueProposalRow } = await import("../src/proposal.js");
  enqueueProposalRow(db, { issueId: iid, now: NOW });
  await propose(db);
  const supersededCount = db.prepare("SELECT COUNT(*) n FROM development_authorization WHERE issue_id=? AND status='superseded'").get(iid).n;
  assert.equal(supersededCount, 1);
  assert.equal(getActiveAuthorization(db, iid), null); // prior authorization no longer active
  const state = findEntity(db, `issue:${iid}`).state;
  assert.equal(state, "WAITING_OWNER_APPROVAL"); // re-approval required (invalidated → waiting)
  db.close();
});

// ── Decisions do not authorize coding (25,26,27,28,29) ──
for (const action of ["REQUEST_CHANGES", "DEFER", "REJECT", "BLOCK"]) {
  test(`decision ${action} does not create development authorization`, async () => {
    const db = openOpsDb(":memory:");
    const { iid, current } = await seedApprovableProposal(db);
    submitOwnerDecision(db, iid, { action, proposalId: current.id, proposalVersion: current.proposal_version, proposalHash: current.proposal_hash, reason: "x", now: NOW });
    assert.equal(getActiveAuthorization(db, iid), null);
    db.close();
  });
}
test("29. BLOCK cannot be automatically cleared (no auto re-eval / stays blocked)", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current } = await seedApprovableProposal(db);
  submitOwnerDecision(db, iid, { action: "BLOCK", proposalId: current.id, proposalVersion: current.proposal_version, proposalHash: current.proposal_hash, now: NOW });
  assert.equal(findEntity(db, `issue:${iid}`).state, "BLOCKED");
  // proposal worker must not regenerate for a blocked issue
  const s = await propose(db);
  assert.equal(s.enqueued, 0);
  assert.equal(findEntity(db, `issue:${iid}`).state, "BLOCKED");
  db.close();
});

// ── History / state machine (30,31,32) ──
test("30. owner decisions are append-only history", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current } = await seedApprovableProposal(db);
  submitOwnerDecision(db, iid, { action: "DEFER", proposalId: current.id, proposalVersion: current.proposal_version, proposalHash: current.proposal_hash, now: NOW });
  const decisions = listOwnerDecisions(db, { issueId: iid });
  assert.equal(decisions.length, 1);
  const decId = db.prepare("SELECT id FROM proposal_owner_decision LIMIT 1").get().id;
  assert.throws(() => db.prepare("UPDATE proposal_owner_decision SET action='X' WHERE id=?").run(decId), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM proposal_owner_decision WHERE id=?").run(decId), /append-only/);
  db.close();
});
test("31. lifecycle transitions are recorded via central state machine", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current } = await seedApprovableProposal(db);
  await approve(db, iid, current);
  const trans = db.prepare("SELECT to_state FROM state_transition WHERE entity_id=? ORDER BY id ASC").all(`issue:${iid}`).map((r) => r.to_state);
  assert.ok(trans.includes("WAITING_OWNER_APPROVAL"));
  assert.ok(trans.includes("APPROVED_FOR_DEVELOPMENT"));
  db.close();
});
test("32. approval rollback (bad transition) leaves no partial authorization/state", async () => {
  const db = openOpsDb(":memory:");
  const { iid, current } = await seedApprovableProposal(db);
  submitOwnerDecision(db, iid, { action: "DEFER", proposalId: current.id, proposalVersion: current.proposal_version, proposalHash: current.proposal_hash, now: NOW });
  // Now state is DEFERRED; APPROVE must fail (not WAITING) and create no authorization/decision beyond the DEFER.
  assert.throws(() => approve(db, iid, current), /awaiting owner approval/);
  assert.equal(getActiveAuthorization(db, iid), null);
  assert.equal(listOwnerDecisions(db, { issueId: iid }).length, 1); // only the DEFER
  db.close();
});

// ── Provider unavailable + no cursor + defer (36,37,4) ──
test("36. provider unavailable does not affect previous phases; no proposal created", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedProposeIssue(db, { members: 8 });
  await evaluate(db);
  const { makeProposalProvider } = await import("../src/ai/proposalProvider.js");
  const s = await runProposalOnce(db, { provider: makeProposalProvider({}), now: () => NOW }); // null provider
  assert.equal(s.skipped, "no_provider");
  assert.equal(currentProposalId(db, iid), null);
  // impact recompute still works
  const r = calculateAndStoreImpact(db, iid, { now: NOW });
  assert.ok(r.assessmentId > 0);
  db.close();
});
test("37/35. no Cursor runtime dependency; generator has no repo/deploy creds in source", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ["proposal.js", "proposalWorker.js", "proposalPrompt.js", "proposalSchema.js", "proposalPolicy.js", "ai/proposalProvider.js"]) {
    const src = readFileSync(path.join(dir, "..", "src", f), "utf8");
    assert.doesNotMatch(src, /cursor/i, `${f} must not reference Cursor`);
    assert.doesNotMatch(src, /child_process|exec\(|spawn\(|GITHUB_TOKEN|process\.env\.NAS_/i, `${f} must not hold shell/repo/deploy creds`);
  }
});
test("provider offline defers generation (retryable, no fake proposal)", async () => {
  const db = openOpsDb(":memory:");
  const iid = seedProposeIssue(db, { members: 8 });
  await evaluate(db);
  const s = await propose(db, { provider: propStub({ behavior: "error" }) });
  assert.equal(s.completed, 0);
  assert.equal(currentProposalId(db, iid), null);
  db.close();
});
