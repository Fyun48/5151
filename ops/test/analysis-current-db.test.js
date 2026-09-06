import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";

// Phase 4.2：DB 層不變式 —— 直接以 SQL 繞過應用層 helper，證明資料庫本身會拒絕非法 CURRENT 指標。

function seedFeedback(db, i) {
  db.prepare(
    "INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, received_at) VALUES (?, ?, 'v3', 'bug', 'c', ?)",
  ).run(`d${i}`, `k${i}`, new Date().toISOString());
  return Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
}

function insertAnalysis(db, { feedbackId, analysisType = "classification", revision = 1, status = "completed" }) {
  const ts = new Date().toISOString();
  const res = db.prepare(
    `INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, status, next_attempt_at, created_at, completed_at)
     VALUES (?, ?, ?, 0, 5, 'feedback-classification-v1', ?, ?, ?, ?)`,
  ).run(feedbackId, analysisType, revision, status, ts, ts, status === "completed" ? ts : null);
  return Number(res.lastInsertRowid);
}

function setCurrent(db, { feedbackId, analysisType = "classification", analysisId }) {
  db.prepare(
    "INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, ?, ?, ?, 'test')",
  ).run(feedbackId, analysisType, analysisId, new Date().toISOString());
}

test("DB rejects current pointer to an analysis belonging to another feedback", () => {
  const db = openOpsDb(":memory:");
  const a = seedFeedback(db, 1);
  const b = seedFeedback(db, 2);
  const bCompleted = insertAnalysis(db, { feedbackId: b, status: "completed" });
  assert.throws(() => setCurrent(db, { feedbackId: a, analysisId: bCompleted }), /current pointer must reference/);
  db.close();
});

test("DB rejects current pointer to another analysis_type", () => {
  const db = openOpsDb(":memory:");
  const a = seedFeedback(db, 1);
  const otherType = insertAnalysis(db, { feedbackId: a, analysisType: "summary", status: "completed" });
  assert.throws(() => setCurrent(db, { feedbackId: a, analysisType: "classification", analysisId: otherType }), /current pointer must reference/);
  db.close();
});

test("DB rejects current pointer to PENDING / PROCESSING / FAILED analysis", () => {
  const db = openOpsDb(":memory:");
  const a = seedFeedback(db, 1);
  for (const status of ["pending", "processing", "failed"]) {
    const id = insertAnalysis(db, { feedbackId: a, revision: status.length, status });
    assert.throws(() => setCurrent(db, { feedbackId: a, analysisId: id }), /current pointer must reference/, `status ${status} must be rejected`);
  }
  db.close();
});

test("DB allows a valid COMPLETED same-feedback/same-type analysis to become current", () => {
  const db = openOpsDb(":memory:");
  const a = seedFeedback(db, 1);
  const ok = insertAnalysis(db, { feedbackId: a, status: "completed" });
  assert.doesNotThrow(() => setCurrent(db, { feedbackId: a, analysisId: ok }));
  const row = db.prepare("SELECT analysis_id FROM feedback_analysis_current WHERE feedback_id=?").get(a);
  assert.equal(Number(row.analysis_id), ok);
  db.close();
});

test("DB rejects UPDATE of current pointer to an invalid analysis", () => {
  const db = openOpsDb(":memory:");
  const a = seedFeedback(db, 1);
  const b = seedFeedback(db, 2);
  const ok = insertAnalysis(db, { feedbackId: a, status: "completed" });
  const bad = insertAnalysis(db, { feedbackId: b, status: "completed" });
  setCurrent(db, { feedbackId: a, analysisId: ok });
  assert.throws(
    () => db.prepare("UPDATE feedback_analysis_current SET analysis_id=? WHERE feedback_id=?").run(bad, a),
    /current pointer must reference/,
  );
  // 指標維持原值
  assert.equal(Number(db.prepare("SELECT analysis_id FROM feedback_analysis_current WHERE feedback_id=?").get(a).analysis_id), ok);
  db.close();
});
