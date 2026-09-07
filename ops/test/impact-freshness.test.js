import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import {
  calculateAndStoreImpact, getCurrentIssueImpact, currentImpactId,
  isImpactStale, impactStaleReasons, listAssessments, impactConfig,
} from "../src/impact.js";
import { runImpactOnce } from "../src/impactWorker.js";

const T0 = new Date("2026-06-01T00:00:00.000Z");
const plusH = (h) => new Date(T0.getTime() + h * 3600e3);
const daysAgo = (from, d) => new Date(from.getTime() - d * 24 * 3600e3).toISOString();
let seq = 1;

function seedFeedback(db, { receivedAt, severity = "MEDIUM", category = "BUG", userRef = null } = {}) {
  const i = seq++;
  db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, ?, '3.47', ?)").run(`d${i}`, `k${i}`, `c${i}`, userRef, receivedAt);
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  const aid = addAnalysis(db, fid, 1, severity, category, receivedAt);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, receivedAt);
  return { fid, aid };
}
function addAnalysis(db, fid, revision, severity, category, ts) {
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', ?, 0, 5, 'feedback-classification-v1', ?, 's', ?, 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, revision, category, severity, ts, ts, ts);
  return Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? AND revision=?").get(fid, revision).id);
}
function repointCurrent(db, fid, severity, category, ts) {
  const rev = Number(db.prepare("SELECT MAX(revision) m FROM feedback_analysis WHERE feedback_id=?").get(fid).m) + 1;
  const aid = addAnalysis(db, fid, rev, severity, category, ts);
  db.prepare("UPDATE feedback_analysis_current SET analysis_id=?, updated_at=? WHERE feedback_id=?").run(aid, ts, fid);
  return aid;
}
function newIssue(db) {
  const ts = T0.toISOString();
  return Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
}
function link(db, issueId, fid, { addedBy = "auto" } = {}) {
  db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'active', 1, ?)").run(issueId, fid, addedBy, T0.toISOString());
}

// ── time-based freshness ──
test("time: T0 windows correct; age beyond horizon → stale without membership change; recalc at T1 updates windows", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  // 相對 T0：0d、2d、10d
  link(db, iid, seedFeedback(db, { receivedAt: daysAgo(T0, 0) }).fid);
  link(db, iid, seedFeedback(db, { receivedAt: daysAgo(T0, 2) }).fid);
  link(db, iid, seedFeedback(db, { receivedAt: daysAgo(T0, 10) }).fid);
  calculateAndStoreImpact(db, iid, { now: T0 });
  const a0 = getCurrentIssueImpact(db, iid, { now: T0 });
  assert.equal(a0.feedback_count_24h, 1);
  assert.equal(a0.feedback_count_7d, 2);
  assert.equal(a0.feedback_count_30d, 3);
  assert.equal(a0.fresh, true);

  // 時間前進超過 horizon（預設 6h），成員未變 → stale（age_exceeded）
  const later = plusH(7);
  assert.equal(isImpactStale(db, iid, { now: later }), true);
  assert.ok(impactStaleReasons(db, iid, { now: later }).includes("age_exceeded"));
  // getCurrentIssueImpact 也要顯示 stale（不讓 Phase 7 誤判 fresh）
  assert.equal(getCurrentIssueImpact(db, iid, { now: later }).stale, true);

  // 前進 8 天後重算：7d 視窗只剩 2d 與 8d... 以 T0+8d 計
  const t8d = new Date(T0.getTime() + 8 * 24 * 3600e3);
  calculateAndStoreImpact(db, iid, { now: t8d });
  const a1 = getCurrentIssueImpact(db, iid, { now: t8d });
  // 相對 t8d：原 0d→8天前(7d外)、2d→10天前(7d外,30d內)、10d→18天前
  assert.equal(a1.feedback_count_7d, 0);
  assert.equal(a1.feedback_count_30d, 3);
  assert.equal(a1.fresh, true);
  db.close();
});

test("time: no new feedback required for time-based staleness; worker refreshes aged assessment", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  link(db, iid, seedFeedback(db, { receivedAt: T0.toISOString() }).fid);
  calculateAndStoreImpact(db, iid, { now: T0 });
  const first = currentImpactId(db, iid);
  // worker 在 horizon 內不重算（冪等）
  assert.equal(runImpactOnce(db, { now: () => plusH(1) }).recalculated, 0);
  // 超過 horizon → 重算（不需新 feedback）
  const s = runImpactOnce(db, { now: () => plusH(7) });
  assert.equal(s.recalculated, 1);
  assert.notEqual(currentImpactId(db, iid), first);
  db.close();
});

// ── current-analysis provenance ──
test("analysis: unchanged current analysis → not stale for analysis reason", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  link(db, iid, seedFeedback(db, { receivedAt: T0.toISOString(), severity: "MEDIUM" }).fid);
  calculateAndStoreImpact(db, iid, { now: T0 });
  assert.ok(!impactStaleReasons(db, iid, { now: T0 }).includes("analysis_changed"));
  db.close();
});

test("analysis: membership unchanged + CURRENT analysis changed → stale (analysis_changed); recalc uses new evidence", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  const A = seedFeedback(db, { receivedAt: T0.toISOString(), severity: "MEDIUM", category: "BUG" });
  link(db, iid, A.fid);
  calculateAndStoreImpact(db, iid, { now: T0 });
  const before = getCurrentIssueImpact(db, iid, { now: T0 });
  assert.equal(before.severity_distribution.MEDIUM, 1);
  // 成員不變，但 Phase-4 CURRENT 分析改成 CRITICAL/PERFORMANCE
  repointCurrent(db, A.fid, "CRITICAL", "PERFORMANCE", T0.toISOString());
  const reasons = impactStaleReasons(db, iid, { now: T0 });
  assert.ok(reasons.includes("analysis_changed"));
  assert.ok(!reasons.includes("membership_changed"));
  calculateAndStoreImpact(db, iid, { now: T0 });
  const after = getCurrentIssueImpact(db, iid, { now: T0 });
  assert.equal(after.severity_distribution.CRITICAL, 1); // 用新分析證據
  assert.equal(after.category_distribution.PERFORMANCE, 1);
  assert.equal(after.fresh, true);
  db.close();
});

test("analysis: Owner-authoritative membership stays; analysis refresh makes stale; recalc keeps owner member with new evidence; history preserved", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  const A = seedFeedback(db, { receivedAt: T0.toISOString(), severity: "LOW" });
  link(db, iid, A.fid, { addedBy: "owner" }); // 權威 owner 成員
  calculateAndStoreImpact(db, iid, { now: T0 });
  const firstId = currentImpactId(db, iid);
  repointCurrent(db, A.fid, "HIGH", "SECURITY", T0.toISOString()); // 成員不變、CURRENT 分析變
  assert.equal(isImpactStale(db, iid, { now: T0 }), true);
  calculateAndStoreImpact(db, iid, { now: T0 });
  const after = getCurrentIssueImpact(db, iid, { now: T0 });
  assert.equal(after.membership_count, 1); // owner 成員仍在
  assert.equal(after.severity_distribution.HIGH, 1); // 新分析
  assert.notEqual(currentImpactId(db, iid), firstId); // 新 canonical
  assert.equal(listAssessments(db, { issueId: iid }).length, 2); // 歷史保留（T0 + 重算）
  db.close();
});

test("failed refresh does not make stale data fresh", () => {
  const db = openOpsDb(":memory:");
  const iid = newIssue(db);
  link(db, iid, seedFeedback(db, { receivedAt: T0.toISOString() }).fid);
  calculateAndStoreImpact(db, iid, { now: T0 });
  const good = currentImpactId(db, iid);
  const later = plusH(7); // 已 stale（age）
  const failing = new Proxy(db, {
    get(t, p, r) { if (p === "prepare") return (sql) => { if (/INSERT\s+INTO\s+issue_impact_assessment/i.test(sql)) return { run: () => { throw new Error("boom"); } }; return t.prepare(sql); }; const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v; },
  });
  assert.throws(() => calculateAndStoreImpact(failing, iid, { now: later }), /boom/);
  assert.equal(currentImpactId(db, iid), good); // 保留舊 current
  assert.equal(isImpactStale(db, iid, { now: later }), true); // 仍回報 stale（不因失敗變 fresh）
  db.close();
});
