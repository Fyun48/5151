import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import {
  enqueueAnalysisRow,
  reprocessAnalysis,
  currentAnalysisId,
  getCurrentFeedbackAnalysis,
  listAnalyses,
} from "../src/feedbackAnalysis.js";
import { runAnalysisOnce } from "../src/analysisWorker.js";
import { makeStubProvider } from "../src/ai/provider.js";

const RUN = { random: () => 0.5, now: () => new Date() };

function seed(db, content = "登入轉圈圈", i = Math.floor(Math.random() * 1e9)) {
  db.prepare(
    `INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, received_at)
     VALUES (?, ?, 'v3', 'bug', ?, ?)`,
  ).run(`d${i}`, `k${i}`, content, new Date().toISOString());
  return Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
}
function runToPast(db, fid) {
  db.prepare("UPDATE feedback_analysis SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE feedback_id=? AND status IN ('pending','failed_retry')").run(fid);
}

test("1. first successful analysis becomes current", async () => {
  const db = openOpsDb(":memory:");
  const fid = seed(db);
  enqueueAnalysisRow(db, { feedbackId: fid });
  await runAnalysisOnce(db, { provider: makeStubProvider(), ...RUN });
  const cur = getCurrentFeedbackAnalysis(db, fid);
  assert.ok(cur);
  assert.equal(cur.status, "completed");
  assert.equal(cur.revision, 1);
  assert.equal(currentAnalysisId(db, fid), cur.id);
  db.close();
});

test("2+3. second successful re-analysis becomes current; previous stays historical", async () => {
  const db = openOpsDb(":memory:");
  const fid = seed(db);
  enqueueAnalysisRow(db, { feedbackId: fid });
  await runAnalysisOnce(db, { provider: makeStubProvider(), ...RUN });
  const firstCurrent = currentAnalysisId(db, fid);
  reprocessAnalysis(db, fid, {});
  runToPast(db, fid);
  await runAnalysisOnce(db, { provider: makeStubProvider(), ...RUN });
  const secondCurrent = currentAnalysisId(db, fid);
  assert.notEqual(secondCurrent, firstCurrent);
  assert.equal(getCurrentFeedbackAnalysis(db, fid).revision, 2);
  // 舊的仍在歷史且維持 completed
  assert.equal(listAnalyses(db, { feedbackId: fid }).length, 2);
  const old = listAnalyses(db, { feedbackId: fid }).find((r) => r.id === firstCurrent);
  assert.equal(old.status, "completed");
  db.close();
});

test("4. failed re-analysis does NOT replace current", async () => {
  const db = openOpsDb(":memory:");
  const fid = seed(db);
  enqueueAnalysisRow(db, { feedbackId: fid });
  await runAnalysisOnce(db, { provider: makeStubProvider(), ...RUN });
  const good = currentAnalysisId(db, fid);
  // 新 revision，但 provider 持續錯誤 → 最終 failed
  reprocessAnalysis(db, fid, {});
  db.prepare("UPDATE feedback_analysis SET max_retries=2 WHERE feedback_id=? AND revision=2").run(fid);
  const err = makeStubProvider({ behavior: "error" });
  for (let i = 0; i < 3; i++) { runToPast(db, fid); await runAnalysisOnce(db, { provider: err, ...RUN }); }
  const failedRow = listAnalyses(db, { feedbackId: fid }).find((r) => r.revision === 2);
  assert.equal(failedRow.status, "failed");
  assert.equal(currentAnalysisId(db, fid), good); // 指標不動
  assert.equal(getCurrentFeedbackAnalysis(db, fid).revision, 1);
  db.close();
});

test("5. schema-invalid re-analysis does NOT replace current", async () => {
  const db = openOpsDb(":memory:");
  const fid = seed(db);
  enqueueAnalysisRow(db, { feedbackId: fid });
  await runAnalysisOnce(db, { provider: makeStubProvider(), ...RUN });
  const good = currentAnalysisId(db, fid);
  reprocessAnalysis(db, fid, {});
  const bad = makeStubProvider({ behavior: "badenum" });
  for (let i = 0; i < 3; i++) { runToPast(db, fid); await runAnalysisOnce(db, { provider: bad, ...RUN }); }
  assert.equal(currentAnalysisId(db, fid), good);
  db.close();
});

test("6+7. transport retries do NOT create new revisions; retry_count distinct from revision", async () => {
  const db = openOpsDb(":memory:");
  const fid = seed(db);
  enqueueAnalysisRow(db, { feedbackId: fid });
  const timeout = makeStubProvider({ behavior: "timeout" });
  // 同一 revision 連續逾時重試多次
  for (let i = 0; i < 3; i++) { runToPast(db, fid); await runAnalysisOnce(db, { provider: timeout, ...RUN }); }
  const rows = listAnalyses(db, { feedbackId: fid });
  assert.equal(rows.length, 1); // 沒有為每次傳輸重試新增 revision
  assert.equal(rows[0].revision, 1);
  assert.ok(rows[0].retry_count >= 2); // retry_count 累加
  db.close();
});

test("8. current pointer can never reference another feedback's analysis", async () => {
  const db = openOpsDb(":memory:");
  const f1 = seed(db, "aaa");
  const f2 = seed(db, "bbb");
  enqueueAnalysisRow(db, { feedbackId: f1 });
  enqueueAnalysisRow(db, { feedbackId: f2 });
  await runAnalysisOnce(db, { provider: makeStubProvider(), batchSize: 10, ...RUN });
  const c1 = currentAnalysisId(db, f1);
  const c2 = currentAnalysisId(db, f2);
  assert.notEqual(c1, c2);
  assert.equal(getCurrentFeedbackAnalysis(db, f1).feedback_id, f1);
  assert.equal(getCurrentFeedbackAnalysis(db, f2).feedback_id, f2);
  db.close();
});

test("9. getCurrentFeedbackAnalysis never returns a non-COMPLETED analysis", async () => {
  const db = openOpsDb(":memory:");
  const fid = seed(db);
  enqueueAnalysisRow(db, { feedbackId: fid });
  // 尚未執行 → 無 current
  assert.equal(getCurrentFeedbackAnalysis(db, fid), null);
  assert.equal(currentAnalysisId(db, fid), null);
  db.close();
});

test("10. defensive: pointer to a non-completed row is treated as no current", async () => {
  const db = openOpsDb(":memory:");
  const fid = seed(db);
  enqueueAnalysisRow(db, { feedbackId: fid });
  await runAnalysisOnce(db, { provider: makeStubProvider(), ...RUN });
  const id = currentAnalysisId(db, fid);
  // 人為破壞：把被指向的列改成非 completed（實務上不會發生），helper 應防禦性回 null
  db.prepare("UPDATE feedback_analysis SET status='failed' WHERE id=?").run(id);
  assert.equal(getCurrentFeedbackAnalysis(db, fid), null);
  db.close();
});
