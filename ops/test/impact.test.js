import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import {
  computeImpactSignals, scoreImpact, levelForScore, impactConfig,
  calculateAndStoreImpact, getCurrentIssueImpact, currentImpactId, isImpactStale, listAssessments,
} from "../src/impact.js";
import { runImpactOnce } from "../src/impactWorker.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 3600e3).toISOString();
let seq = 1;

function seedFeedback(db, { userRef = null, appVersion = "3.47", receivedAt = NOW.toISOString(), severity = "MEDIUM", category = "BUG", source = "v3" } = {}) {
  const i = seq++;
  db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, ?, 'bug', ?, 'secret@x.com', ?, ?, ?)")
    .run(`d${i}`, `k${i}`, source, `content ${i}`, userRef, appVersion, receivedAt);
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', ?, 's', ?, 0.8, 'zh-TW', 'completed', ?, ?, ?)")
    .run(fid, category, severity, receivedAt, receivedAt, receivedAt);
  const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, receivedAt);
  return { fid, aid };
}
function newIssue(db) {
  const ts = NOW.toISOString();
  return Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
}
function linkMember(db, issueId, { fid, aid = null, addedBy = "auto", membershipStatus = "active", reviewFlag = 0 }) {
  db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, review_flag, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
    .run(issueId, fid, aid, addedBy, membershipStatus, reviewFlag, NOW.toISOString());
}

test("1/2/3. canonical membership: excludes auto review_required; includes owner active+review_flag", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  const a = seedFeedback(db); linkMember(db, iid, { fid: a.fid, aid: a.aid, addedBy: "auto", membershipStatus: "active" });
  const b = seedFeedback(db); linkMember(db, iid, { fid: b.fid, aid: b.aid, addedBy: "auto", membershipStatus: "review_required" });
  const c = seedFeedback(db); linkMember(db, iid, { fid: c.fid, aid: c.aid, addedBy: "owner", membershipStatus: "active", reviewFlag: 1 });
  const s = computeImpactSignals(db, iid, { now: NOW });
  assert.equal(s.current_feedback_count, 2); // a + owner c ; b excluded
  db.close();
});

test("4/5/6. feedback count, distinct reporters, anonymous not collapsed", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  for (const ref of ["u1", "u1", "u2", null, null]) {
    const f = seedFeedback(db, { userRef: ref });
    linkMember(db, iid, { fid: f.fid, aid: f.aid });
  }
  const s = computeImpactSignals(db, iid, { now: NOW });
  assert.equal(s.current_feedback_count, 5);
  assert.equal(s.distinct_reporter_count, 2); // u1,u2
  assert.equal(s.anonymous_feedback_count, 2); // 兩筆匿名不塌成 1
  db.close();
});

test("7. 24h / 7d / 30d windows are correct", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  for (const d of [0, 2, 10, 40]) {
    const f = seedFeedback(db, { receivedAt: daysAgo(d) });
    linkMember(db, iid, { fid: f.fid, aid: f.aid });
  }
  const s = computeImpactSignals(db, iid, { now: NOW });
  assert.equal(s.feedback_count_24h, 1);
  assert.equal(s.feedback_count_7d, 2);
  assert.equal(s.feedback_count_30d, 3);
  db.close();
});

test("8/9. severity and app-version distributions", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  linkMember(db, iid, seedFeedback(db, { severity: "HIGH", appVersion: "3.47" }));
  linkMember(db, iid, seedFeedback(db, { severity: "HIGH", appVersion: "3.48" }));
  linkMember(db, iid, seedFeedback(db, { severity: "LOW", appVersion: "3.47" }));
  const s = computeImpactSignals(db, iid, { now: NOW });
  assert.equal(s.severity_distribution.HIGH, 2);
  assert.equal(s.severity_distribution.LOW, 1);
  assert.equal(s.app_version_distribution["3.47"], 2);
  assert.equal(s.app_version_distribution["3.48"], 1);
  db.close();
});

test("10/11. score is deterministic and components are explainable", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  linkMember(db, iid, seedFeedback(db, { severity: "HIGH", userRef: "u1" }));
  linkMember(db, iid, seedFeedback(db, { severity: "MEDIUM", userRef: "u2" }));
  const s = computeImpactSignals(db, iid, { now: NOW });
  const a = scoreImpact(s), b = scoreImpact(s);
  assert.equal(a.total, b.total); // deterministic
  assert.ok(a.components.frequency >= 0 && a.components.severity >= 0);
  assert.ok(a.weighted.severity <= a.weights.severity);
  db.close();
});

test("12. thresholds/weights configurable", () => {
  const cfg = impactConfig({ IMPACT_W_FREQUENCY: "0.5", IMPACT_LEVEL_HIGH: "40" });
  assert.equal(cfg.weights.frequency, 0.5);
  assert.equal(levelForScore(45, cfg), "HIGH");
  assert.equal(levelForScore(24, cfg), "LOW");
});

test("13. single-feedback issue still gets an assessment", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  linkMember(db, iid, seedFeedback(db));
  const r = calculateAndStoreImpact(db, iid, { now: NOW });
  assert.ok(r.assessmentId > 0);
  assert.ok(getCurrentIssueImpact(db, iid));
  db.close();
});

test("14/15/16. membership change stales current; recalc promotes new current; history preserved", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  linkMember(db, iid, seedFeedback(db));
  calculateAndStoreImpact(db, iid, { now: NOW });
  const first = currentImpactId(db, iid);
  assert.equal(isImpactStale(db, iid), false);
  // 新增成員 → fingerprint 改變 → stale
  linkMember(db, iid, seedFeedback(db));
  assert.equal(isImpactStale(db, iid), true);
  calculateAndStoreImpact(db, iid, { now: NOW });
  const second = currentImpactId(db, iid);
  assert.notEqual(second, first); // 新 current
  assert.equal(isImpactStale(db, iid), false);
  assert.equal(listAssessments(db, { issueId: iid }).length, 2); // 歷史保留
  db.close();
});

test("17. failed recalculation does not replace valid current assessment", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  linkMember(db, iid, seedFeedback(db));
  calculateAndStoreImpact(db, iid, { now: NOW });
  const good = currentImpactId(db, iid);
  const failing = new Proxy(db, {
    get(t, p, r) {
      if (p === "prepare") return (sql) => { if (/INSERT\s+INTO\s+issue_impact_assessment/i.test(sql)) return { run: () => { throw new Error("boom"); } }; return t.prepare(sql); };
      const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v;
    },
  });
  linkMember(db, iid, seedFeedback(db)); // make stale
  assert.throws(() => calculateAndStoreImpact(failing, iid, { now: NOW }), /boom/);
  assert.equal(currentImpactId(db, iid), good); // current 未變
  db.close();
});

test("18. worker is idempotent (no recompute when not stale)", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  linkMember(db, iid, seedFeedback(db));
  const s1 = runImpactOnce(db, { now: () => NOW });
  assert.equal(s1.recalculated, 1);
  const s2 = runImpactOnce(db, { now: () => NOW });
  assert.equal(s2.recalculated, 0);
  assert.equal(s2.skipped, 1);
  assert.equal(listAssessments(db, { issueId: iid }).length, 1);
  db.close();
});

test("DB trigger: impact current cannot point to another issue's assessment", () => {
  const db = openOpsDb(":memory:");
  const i1 = newIssue(db), i2 = newIssue(db);
  linkMember(db, i1, seedFeedback(db));
  const r = calculateAndStoreImpact(db, i1, { now: NOW });
  assert.throws(
    () => db.prepare("INSERT INTO issue_impact_current(issue_id, assessment_id, membership_fingerprint, updated_at) VALUES (?, ?, 'x', ?)").run(i2, r.assessmentId, NOW.toISOString()),
    /same issue/,
  );
  db.close();
});
