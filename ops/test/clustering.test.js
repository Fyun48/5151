import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import {
  cosineSimilarity, areComparable, makeStubEmbeddingProvider, makeNullEmbeddingProvider, makeEmbeddingProvider,
} from "../src/ai/embeddingProvider.js";
import { buildEmbeddingInput, NORMALIZATION_VERSION } from "../src/ai/embeddingInput.js";
import {
  clusteringConfig, activeEmbedding, storeEmbedding, mergeIssues, splitIssue, moveFeedback,
  listIssues, getIssueWithMembers, feedbackIssue,
} from "../src/clustering.js";
import { runEmbeddingOnce } from "../src/clusteringWorker.js";
import { updateProductCapabilities } from "../src/products.js";

let seq = 1;
function seedAnalyzed(db, { content, category = "BUG", summary = null }) {
  updateProductCapabilities(db, "v3", { cross_site_insight: true });
  const i = seq++;
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, context, user_ref, received_at) VALUES (?, ?, 'v3', 'bug', ?, 'secret@x.com', '{\"session\":\"s\"}', 'u-1', ?)").run(`d${i}`, `k${i}`, content, ts);
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  db.prepare(
    `INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at)
     VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', ?, ?, 'MEDIUM', 0.8, 'zh-TW', 'completed', ?, ?, ?)`,
  ).run(fid, category, summary || content, ts, ts, ts);
  const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 'test')").run(fid, aid, ts);
  return { fid, aid };
}
const RUN = { now: () => new Date() };

test("embedding input excludes contact/user_ref/session and attachment content", () => {
  const input = buildEmbeddingInput({ category: "BUG", summary: "登入卡住" }, { content: "按登入沒反應", contact: "a@b.c", user_ref: "u1", context: '{"session":"s"}' });
  assert.doesNotMatch(input.text, /a@b\.c/);
  assert.doesNotMatch(input.text, /u1/);
  assert.doesNotMatch(input.text, /session/);
  assert.equal(input.normalizationVersion, NORMALIZATION_VERSION);
});

test("cosine + comparability: incompatible embedding spaces are not compared", () => {
  assert.ok(cosineSimilarity([1, 0], [1, 0]) > 0.99);
  const a = { model: "m", model_version: "v1", dim: 4, normalization_version: "n1" };
  assert.equal(areComparable(a, { ...a }), true);
  assert.equal(areComparable(a, { ...a, model_version: "v2" }), false);
  assert.equal(areComparable(a, { ...a, dim: 8 }), false);
  assert.equal(areComparable(a, { ...a, normalization_version: "n2" }), false);
});

test("clearly similar feedback clusters together; clearly different stays separate", async () => {
  const db = openOpsDb(":memory:");
  seedAnalyzed(db, { content: "登入按下去之後一直轉圈圈沒反應無法進入系統" });
  seedAnalyzed(db, { content: "登入按下去以後一直轉圈圈沒反應無法進入系統" }); // near-duplicate
  seedAnalyzed(db, { content: "希望可以增加深色模式與字體大小的顯示選項", category: "FEATURE_REQUEST" }); // different
  await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), ...RUN });
  const issues = listIssues(db, {});
  // 相似兩筆同群、與第三筆不同群
  const i1 = feedbackIssue(db, 1), i2 = feedbackIssue(db, 2), i3 = feedbackIssue(db, 3);
  assert.equal(i1, i2);
  assert.notEqual(i1, i3);
  assert.equal(issues.length, 2);
  db.close();
});

test("similar wording but different product area does NOT auto-merge", async () => {
  const db = openOpsDb(":memory:");
  seedAnalyzed(db, { content: "登入頁面按下登入按鈕後一直轉圈圈，帳號密碼都正確卻無法進入系統首頁看到物件列表" });
  seedAnalyzed(db, { content: "結帳付款時按下確認付款一直轉圈圈，信用卡資訊都填好卻無法完成付款交易與訂單" });
  await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), ...RUN });
  assert.notEqual(feedbackIssue(db, 1), feedbackIssue(db, 2)); // 保守：分開
  db.close();
});

test("thresholds are configurable", () => {
  const c = clusteringConfig({ EMBED_SIM_AUTO: "0.9", EMBED_SIM_REVIEW: "0.5" });
  assert.equal(c.auto, 0.9);
  assert.equal(c.review, 0.5);
});

test("duplicate processing does not create duplicate embeddings (idempotent)", async () => {
  const db = openOpsDb(":memory:");
  seedAnalyzed(db, { content: "登入一直轉圈圈" });
  await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), ...RUN });
  await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), ...RUN });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM embedding WHERE feedback_id=1").get().n, 1);
  db.close();
});

test("current-analysis change makes old embedding stale and creates a new embedding", async () => {
  const db = openOpsDb(":memory:");
  const { fid } = seedAnalyzed(db, { content: "登入一直轉圈圈" });
  await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), ...RUN });
  const first = activeEmbedding(db, fid);
  // 模擬 Phase 4 re-analysis：新 completed revision + current 指向它
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 2, 0, 5, 'feedback-classification-v1', 'BUG', '更新後的摘要 登入轉圈', 'HIGH', 0.9, 'zh-TW', 'completed', ?, ?, ?)").run(fid, ts, ts, ts);
  const aid2 = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? AND revision=2").get(fid).id);
  db.prepare("UPDATE feedback_analysis_current SET analysis_id=?, updated_at=? WHERE feedback_id=?").run(aid2, ts, fid);
  await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), ...RUN });
  const rows = db.prepare("SELECT id, analysis_id, status FROM embedding WHERE feedback_id=? ORDER BY id ASC").all(fid);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "stale");
  assert.equal(rows[1].status, "active");
  assert.equal(rows[1].analysis_id, aid2);
  assert.notEqual(activeEmbedding(db, fid).id, first.id);
  db.close();
});

test("provider unavailable does not affect stored feedback and does not cluster", async () => {
  const db = openOpsDb(":memory:");
  seedAnalyzed(db, { content: "登入轉圈" });
  const s = await runEmbeddingOnce(db, { provider: makeNullEmbeddingProvider(), ...RUN });
  assert.equal(s.skipped, "no_provider");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM embedding").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ingested_feedback").get().n, 1); // feedback 仍在
  db.close();
});

test("MERGE preserves history and moves members", async () => {
  const db = openOpsDb(":memory:");
  seedAnalyzed(db, { content: "登入按鈕完全沒有反應而且無法使用系統" });
  seedAnalyzed(db, { content: "希望增加深色模式與多語言的介面設定選項", category: "FEATURE_REQUEST" });
  await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), ...RUN });
  const i1 = feedbackIssue(db, 1), i2 = feedbackIssue(db, 2);
  assert.notEqual(i1, i2);
  const r = mergeIssues(db, { sourceIssueId: i1, targetIssueId: i2, actor: "owner:o" });
  assert.equal(r.merged, 1);
  assert.equal(feedbackIssue(db, 1), i2); // 成員移到目標
  // 歷史保留：舊 link 仍在（active=0），cluster_operation 有 MERGE，issue 標 merged
  assert.ok(db.prepare("SELECT COUNT(*) n FROM issue_feedback_link WHERE active=0").get().n >= 1);
  assert.equal(db.prepare("SELECT status, merged_into FROM issue_candidate WHERE id=?").get(i1).status, "merged");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cluster_operation WHERE op='MERGE'").get().n, 1);
  db.close();
});

test("SPLIT and MOVE preserve history", async () => {
  const db = openOpsDb(":memory:");
  seedAnalyzed(db, { content: "登入按下去一直轉圈圈沒反應無法進入系統首頁" });
  seedAnalyzed(db, { content: "登入按下去以後一直轉圈圈沒反應無法進入系統首頁" });
  await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), ...RUN });
  const issue = feedbackIssue(db, 1);
  assert.equal(feedbackIssue(db, 2), issue);
  // SPLIT feedback 2 into a new issue
  const sp = splitIssue(db, { issueId: issue, feedbackIds: [2], actor: "owner:o" });
  assert.equal(feedbackIssue(db, 2), sp.newIssueId);
  assert.notEqual(sp.newIssueId, issue);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cluster_operation WHERE op='SPLIT'").get().n, 1);
  // MOVE feedback 2 back to original issue
  moveFeedback(db, { feedbackId: 2, toIssueId: issue, actor: "owner:o" });
  assert.equal(feedbackIssue(db, 2), issue);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cluster_operation WHERE op='MOVE'").get().n, 1);
  // 歷史完整（多筆 inactive links）
  assert.ok(db.prepare("SELECT COUNT(*) n FROM issue_feedback_link WHERE feedback_id=2").get().n >= 3);
  db.close();
});

test("cluster_operation is append-only", async () => {
  const db = openOpsDb(":memory:");
  seedAnalyzed(db, { content: "x 問題" });
  await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), ...RUN });
  assert.throws(() => db.prepare("UPDATE cluster_operation SET op='X' WHERE id=1").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM cluster_operation WHERE id=1").run(), /append-only/);
  db.close();
});

test("audit records cluster operations without raw vectors", async () => {
  const db = openOpsDb(":memory:");
  seedAnalyzed(db, { content: "登入轉圈的問題描述長一點點" });
  await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), ...RUN });
  const actions = db.prepare("SELECT DISTINCT action FROM audit_log").all().map((r) => r.action);
  assert.ok(actions.includes("feedback.embedding.completed"));
  assert.ok(actions.includes("issue.created"));
  assert.ok(actions.includes("issue.feedback.linked"));
  // 不落地原始向量
  const emb = db.prepare("SELECT data FROM audit_log WHERE action='feedback.embedding.completed'").get();
  assert.doesNotMatch(emb.data || "", /\[0\.\d/); // 不含向量陣列
  db.close();
});

test("makeEmbeddingProvider defaults to null unless configured", () => {
  assert.equal(makeEmbeddingProvider({}).available, false);
  assert.equal(makeEmbeddingProvider({ EMBEDDING_PROVIDER: "stub" }).available, true);
});
