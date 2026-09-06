import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { runEmbeddingOnce } from "../src/clusteringWorker.js";
import {
  clusteringConfig, getCurrentIssueMembers, getReviewRequiredMembers, feedbackIssue,
  issueRepresentative, moveFeedback, storeEmbedding,
} from "../src/clustering.js";

// 決定性向量 provider：從文字的 #vec[...] 讀出向量，完全控制相似度。
function makeVectorScriptProvider({ model = "script", modelVersion = "v1" } = {}) {
  return {
    name: "script", available: true, model, modelVersion, dim: null,
    async health() { return { ok: true }; },
    getUsage() { return {}; },
    async embed(texts) {
      const vectors = (texts || []).map((t) => {
        const m = String(t).match(/#vec\[([-0-9.,\s]+)\]/);
        const v = m ? m[1].split(",").map(Number) : [0, 0];
        let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
        return v.map((x) => x / n);
      });
      return { vectors, model, model_version: modelVersion, dim: vectors[0]?.length || 0 };
    },
  };
}
const P = makeVectorScriptProvider();
const RUN = { now: () => new Date() };

let seq = 1;
// #vec 放在 summary，才能透過 re-analysis 改變 embedding。
function seedAnalyzed(db, vec, { category = "BUG" } = {}) {
  const i = seq++;
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, received_at) VALUES (?, ?, 'v3', 'bug', ?, ?)").run(`d${i}`, `k${i}`, `feedback ${i}`, ts);
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  const aid = addAnalysis(db, fid, vec, 1, category);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 'test')").run(fid, aid, ts);
  return { fid, aid };
}
function addAnalysis(db, fid, vec, revision, category = "BUG") {
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', ?, 0, 5, 'feedback-classification-v1', ?, ?, 'MEDIUM', 0.8, 'zh-TW', 'completed', ?, ?, ?)")
    .run(fid, revision, category, `sum #vec[${vec.join(",")}]`, ts, ts, ts);
  return Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? AND revision=?").get(fid, revision).id);
}
function reanalyzeWith(db, fid, vec) {
  const rev = Number(db.prepare("SELECT MAX(revision) m FROM feedback_analysis WHERE feedback_id=?").get(fid).m) + 1;
  const aid = addAnalysis(db, fid, vec, rev);
  db.prepare("UPDATE feedback_analysis_current SET analysis_id=?, updated_at=? WHERE feedback_id=?").run(aid, new Date().toISOString(), fid);
  return aid;
}
function link(db, fid) { return db.prepare("SELECT * FROM issue_feedback_link WHERE feedback_id=? AND active=1").get(fid); }

test("1. automatic membership records exact analysis_id and embedding_id", async () => {
  const db = openOpsDb(":memory:");
  const { fid, aid } = seedAnalyzed(db, [1, 0]);
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  const l = link(db, fid);
  assert.equal(l.added_by, "auto");
  assert.equal(l.membership_status, "active");
  assert.equal(l.analysis_id, aid);
  assert.ok(l.embedding_id);
  assert.equal(l.clustering_version, "cluster-v1");
  const emb = db.prepare("SELECT id, analysis_id FROM embedding WHERE id=?").get(l.embedding_id);
  assert.equal(emb.analysis_id, aid);
  db.close();
});

test("2+3+4. current-analysis change marks auto membership review_required; excluded from current-member query; history remains", async () => {
  const db = openOpsDb(":memory:");
  const A = seedAnalyzed(db, [1, 0]);
  const B = seedAnalyzed(db, [1, 0]); // identical → same issue
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  const issue = feedbackIssue(db, A.fid);
  assert.equal(feedbackIssue(db, B.fid), issue);
  assert.equal(getCurrentIssueMembers(db, issue).length, 2);
  // A 的 current 分析變成正交向量（與 issue 不再一致）
  reanalyzeWith(db, A.fid, [0, 1]);
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  const la = link(db, A.fid);
  assert.equal(la.membership_status, "review_required"); // (2)
  const current = getCurrentIssueMembers(db, issue);
  assert.deepEqual(current.map((m) => m.feedback_id), [B.fid]); // (3) A 被排除
  assert.equal(getReviewRequiredMembers(db, issue).length, 1);
  // (4) 該 membership 仍可查（未被刪除；標記為 review_required 保留於 issue 供人工檢視/稽核）
  assert.ok(db.prepare("SELECT COUNT(*) n FROM issue_feedback_link WHERE feedback_id=?").get(A.fid).n >= 1);
  assert.equal(la.issue_id, issue);
  db.close();
});

test("5. successful new embedding reaffirms the SAME issue with new evidence", async () => {
  const db = openOpsDb(":memory:");
  const A = seedAnalyzed(db, [1, 0]); // single-member issue
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  const issue = feedbackIssue(db, A.fid);
  const before = link(db, A.fid);
  const newAid = reanalyzeWith(db, A.fid, [0.99, 0.14]); // 相近
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  const after = link(db, A.fid);
  assert.equal(feedbackIssue(db, A.fid), issue); // 仍同 issue
  assert.equal(after.membership_status, "active"); // reaffirmed
  assert.equal(after.analysis_id, newAid); // 用新證據
  assert.notEqual(after.id, before.id); // 新的 active link（舊的 supersede）
  db.close();
});

test("6. ambiguous re-evaluation keeps review_required (not counted as current)", async () => {
  const db = openOpsDb(":memory:");
  const A = seedAnalyzed(db, [1, 0]);
  const B = seedAnalyzed(db, [1, 0]);
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  const issue = feedbackIssue(db, A.fid);
  reanalyzeWith(db, A.fid, [0.2, 0.98]); // 明顯偏離 → 不 reaffirm
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  assert.equal(link(db, A.fid).membership_status, "review_required");
  assert.equal(getCurrentIssueMembers(db, issue).length, 1);
  db.close();
});

test("7. Owner MOVE stays current & authoritative under conflicting re-analysis; conflict shown as review metadata", async () => {
  const db = openOpsDb(":memory:");
  const A = seedAnalyzed(db, [1, 0]);
  seedAnalyzed(db, [1, 0]); // B
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  const C = seedAnalyzed(db, [0, 1]);
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  const targetIssue = feedbackIssue(db, C.fid);
  moveFeedback(db, { feedbackId: A.fid, toIssueId: targetIssue, actor: "owner:o" });
  assert.equal(feedbackIssue(db, A.fid), targetIssue);
  assert.equal(link(db, A.fid).added_by, "owner");
  // 用「與 target issue（含 C=[0,1]）衝突」的新證據重新分析 A
  reanalyzeWith(db, A.fid, [1, 0]);
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  // Owner membership 仍是 current 權威成員（不因 AI 衝突而消失）
  assert.equal(feedbackIssue(db, A.fid), targetIssue);
  const la = link(db, A.fid);
  assert.equal(la.added_by, "owner");
  assert.equal(la.membership_status, "active");
  const currentIds = getCurrentIssueMembers(db, targetIssue).map((m) => m.feedback_id);
  assert.ok(currentIds.includes(A.fid)); // 仍被 canonical 查詢視為 current
  // 衝突以 review-needed 中繼資料呈現
  assert.equal(la.review_flag, 1);
  assert.ok(getReviewRequiredMembers(db, targetIssue).some((m) => m.feedback_id === A.fid));
  db.close();
});

test("8b. only an explicit later Owner action supersedes an Owner membership", async () => {
  const db = openOpsDb(":memory:");
  const A = seedAnalyzed(db, [1, 0]);
  const C = seedAnalyzed(db, [0, 1]);
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  const issueA = feedbackIssue(db, A.fid);
  const issueC = feedbackIssue(db, C.fid);
  moveFeedback(db, { feedbackId: A.fid, toIssueId: issueC, actor: "owner:o" });
  // 多次衝突刷新都不會撤銷 owner 決定
  reanalyzeWith(db, A.fid, [1, 0]);
  await runEmbeddingOnce(db, { provider: P, ...RUN });
  assert.equal(feedbackIssue(db, A.fid), issueC);
  // 只有明確的後續 Owner MOVE 能取代 owner membership
  moveFeedback(db, { feedbackId: A.fid, toIssueId: issueA, actor: "owner:o" });
  assert.equal(feedbackIssue(db, A.fid), issueA);
  // 歷史 provenance 完整（多筆 link 保留）
  assert.ok(db.prepare("SELECT COUNT(*) n FROM issue_feedback_link WHERE feedback_id=?").get(A.fid).n >= 3);
  db.close();
});

test("9. chaining is prevented by cluster-coherence threshold", async () => {
  const db = openOpsDb(":memory:");
  const cfg = clusteringConfig({ EMBED_SIM_AUTO: "0.85", EMBED_CLUSTER_COHERENCE: "0.90", EMBED_SIM_REVIEW: "0.5" });
  const A = seedAnalyzed(db, [1, 0]);
  const B = seedAnalyzed(db, [0.9848, 0.1736]); // 10° from A
  const C = seedAnalyzed(db, [0.766, 0.6428]); // 40° from A, 30° from B
  await runEmbeddingOnce(db, { provider: P, config: cfg, ...RUN });
  const iA = feedbackIssue(db, A.fid), iB = feedbackIssue(db, B.fid), iC = feedbackIssue(db, C.fid);
  assert.equal(iA, iB); // A,B 同群（coherence 0.985 通過）
  assert.notEqual(iC, iA); // C 雖與 B 最近相似>=auto，但對群 centroid coherence 不足 → 不吸收
  db.close();
});

test("10+11. representative uses only compatible embeddings and never mixes spaces", () => {
  const db = openOpsDb(":memory:");
  const A = seedAnalyzed(db, [1, 0]);
  const B = seedAnalyzed(db, [1, 0]);
  // 直接放兩個不同 model_version 的 embedding 到同一 issue 情境
  const ts = new Date().toISOString();
  storeEmbedding(db, { feedbackId: A.fid, analysisId: A.aid, provider: "script", model: "m", modelVersion: "v1", dim: 2, normalizationVersion: "embed-input-v1", vector: [1, 0], textHash: "h1", now: new Date() });
  storeEmbedding(db, { feedbackId: B.fid, analysisId: B.aid, provider: "script", model: "m", modelVersion: "v2", dim: 2, normalizationVersion: "embed-input-v1", vector: [0, 1], textHash: "h2", now: new Date() });
  // 建一個 issue 並把兩者以 active/active 連進去
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
  db.prepare("INSERT INTO issue_feedback_link(issue_id,feedback_id,added_by,membership_status,active,created_at) VALUES(?,?, 'auto','active',1,?)").run(iid, A.fid, ts);
  db.prepare("INSERT INTO issue_feedback_link(issue_id,feedback_id,added_by,membership_status,active,created_at) VALUES(?,?, 'auto','active',1,?)").run(iid, B.fid, ts);
  const repV1 = issueRepresentative(db, iid, { model: "m", model_version: "v1", dim: 2, normalization_version: "embed-input-v1" });
  assert.equal(repV1.count, 1); // 只含相容 v1，不混 v2
  db.close();
});

test("12. thresholds are configurable", () => {
  const c = clusteringConfig({ EMBED_SIM_AUTO: "0.9", EMBED_CLUSTER_COHERENCE: "0.8", EMBED_SIM_REVIEW: "0.4" });
  assert.equal(c.auto, 0.9);
  assert.equal(c.coherence, 0.8);
  assert.equal(c.review, 0.4);
});
