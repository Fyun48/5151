import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { cosineSimilarity, areComparable } from "./ai/embeddingProvider.js";

export const CLUSTERING_VERSION = "cluster-v1";

// 相似度門檻：可設定，不散落硬編。
//  >= auto     → 高信心，自動連結到既有 issue
//  review..auto→ 模糊，保守：另建新 issue（不強行合併），供 Owner 檢視
//  < review    → 明顯不同，另建新 issue
export function clusteringConfig(env = process.env) {
  const auto = Number(env.EMBED_SIM_AUTO || 0.86);
  const review = Number(env.EMBED_SIM_REVIEW || 0.70);
  return { auto, review, clusteringVersion: CLUSTERING_VERSION };
}

function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }

function parseVector(row) {
  try { return JSON.parse(row.vector); } catch { return []; }
}
function embMeta(row) {
  return { model: row.model, model_version: row.model_version, dim: Number(row.dim), normalization_version: row.normalization_version };
}

export function activeEmbedding(db, feedbackId) {
  return db.prepare("SELECT * FROM embedding WHERE feedback_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(Number(feedbackId)) || null;
}

// 儲存新 embedding：先把此 feedback 其他「不同 analysis_id」的 active 標為 stale，再冪等插入。
export function storeEmbedding(db, { feedbackId, analysisId, provider, model, modelVersion = null, dim, normalizationVersion, vector, textHash, now = new Date() }) {
  return withImmediateTx(db, () => {
    const existing = db.prepare(
      "SELECT id, status, analysis_id FROM embedding WHERE feedback_id=? AND analysis_id=? AND model=? AND model_version IS ? AND normalization_version=?",
    ).get(Number(feedbackId), Number(analysisId), model, modelVersion, normalizationVersion);
    // 舊的（其他 analysis_id）active → stale（current 變更偵測）
    const staled = db.prepare(
      "UPDATE embedding SET status='stale' WHERE feedback_id=? AND status='active' AND analysis_id<>?",
    ).run(Number(feedbackId), Number(analysisId));
    if (existing) {
      // 已存在（冪等）；確保是 active
      db.prepare("UPDATE embedding SET status='active' WHERE id=?").run(existing.id);
      return { id: Number(existing.id), created: false, staled: Number(staled.changes) || 0 };
    }
    const res = db.prepare(
      `INSERT INTO embedding(feedback_id, analysis_id, provider, model, model_version, dim, normalization_version, vector, text_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(Number(feedbackId), Number(analysisId), provider, model, modelVersion, Number(dim), normalizationVersion, JSON.stringify(vector), textHash, iso(now));
    const id = Number(res.lastInsertRowid);
    appendAuditRow(db, { actor: "system", action: "feedback.embedding.completed", entityType: "embedding", entityId: String(id), data: { feedback_id: Number(feedbackId), analysis_id: Number(analysisId), provider, model, model_version: modelVersion, dim: Number(dim), normalization_version: normalizationVersion, staled: Number(staled.changes) || 0 } });
    return { id, created: true, staled: Number(staled.changes) || 0 };
  });
}

// 找與此 embedding 最相似、且屬於某 active issue 的成員（只比較相容向量）。
export function bestMatch(db, embRow, { excludeFeedbackId = null } = {}) {
  const vec = parseVector(embRow);
  const meta = embMeta(embRow);
  const members = db.prepare(
    `SELECT e.*, l.issue_id AS issue_id FROM issue_feedback_link l
     JOIN embedding e ON e.feedback_id = l.feedback_id AND e.status='active'
     WHERE l.active=1`,
  ).all();
  let best = { issueId: null, score: 0 };
  for (const m of members) {
    if (excludeFeedbackId != null && Number(m.feedback_id) === Number(excludeFeedbackId)) continue;
    if (!areComparable(meta, embMeta(m))) continue; // 不比較不相容向量空間
    const s = cosineSimilarity(vec, parseVector(m));
    if (s > best.score) best = { issueId: Number(m.issue_id), score: s };
  }
  return best;
}

export function createIssue(db, { analysis, actor = "system", now = new Date() }) {
  const ts = iso(now);
  const res = db.prepare(
    `INSERT INTO issue_candidate(title, summary, category, clustering_version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?)`,
  ).run(
    String(analysis?.summary || "").slice(0, 120) || "(untitled)",
    String(analysis?.summary || ""),
    String(analysis?.category || "OTHER"),
    CLUSTERING_VERSION, ts, ts,
  );
  const id = Number(res.lastInsertRowid);
  db.prepare("INSERT INTO cluster_operation(op, issue_id, feedback_ids, actor, reason, clustering_version, created_at) VALUES ('CREATE', ?, NULL, ?, NULL, ?, ?)").run(id, actor, CLUSTERING_VERSION, ts);
  appendAuditRow(db, { actor, action: "issue.created", entityType: "issue_candidate", entityId: String(id), data: { category: String(analysis?.category || "OTHER") } });
  return id;
}

function deactivateActiveLink(db, feedbackId, now) {
  db.prepare("UPDATE issue_feedback_link SET active=0, removed_at=? WHERE feedback_id=? AND active=1").run(iso(now), Number(feedbackId));
}

export function linkFeedback(db, { issueId, feedbackId, similarity = null, embeddingId = null, embeddingModel = null, addedBy = "auto", reason = null, now = new Date() }) {
  const ts = iso(now);
  deactivateActiveLink(db, feedbackId, now); // 一筆 feedback 至多一個 active issue
  const res = db.prepare(
    `INSERT INTO issue_feedback_link(issue_id, feedback_id, similarity_score, embedding_id, embedding_model, added_by, reason, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(Number(issueId), Number(feedbackId), similarity, embeddingId, embeddingModel, addedBy, reason, ts);
  db.prepare("INSERT INTO cluster_operation(op, issue_id, feedback_ids, actor, reason, clustering_version, created_at) VALUES ('LINK', ?, ?, ?, ?, ?, ?)").run(Number(issueId), JSON.stringify([Number(feedbackId)]), addedBy, reason, CLUSTERING_VERSION, ts);
  appendAuditRow(db, { actor: addedBy, action: "issue.feedback.linked", entityType: "issue_candidate", entityId: String(issueId), data: { feedback_id: Number(feedbackId), similarity_score: similarity, added_by: addedBy } });
  return Number(res.lastInsertRowid);
}

// 自動分群（保守）：>=auto 連既有 issue；否則另建新 issue。
export function autoClusterFeedback(db, { feedbackId, currentAnalysis, actor = "system", now = new Date(), config = clusteringConfig() }) {
  return withImmediateTx(db, () => {
    const already = db.prepare("SELECT id FROM issue_feedback_link WHERE feedback_id=? AND active=1").get(Number(feedbackId));
    if (already) return { action: "already_linked" };
    const emb = activeEmbedding(db, feedbackId);
    if (!emb) return { action: "no_embedding" };
    const match = bestMatch(db, emb, { excludeFeedbackId: feedbackId });
    if (match.issueId && match.score >= config.auto) {
      linkFeedback(db, { issueId: match.issueId, feedbackId, similarity: match.score, embeddingId: emb.id, embeddingModel: emb.model, addedBy: "auto", reason: "auto>=auto", now });
      return { action: "linked", issueId: match.issueId, score: match.score };
    }
    // 模糊或低相似 → 保守：新建 issue（不強行合併），避免 false merge
    const issueId = createIssue(db, { analysis: currentAnalysis, actor, now });
    linkFeedback(db, { issueId, feedbackId, similarity: match.score || null, embeddingId: emb.id, embeddingModel: emb.model, addedBy: "auto", reason: match.issueId ? "below_auto_new_issue" : "first_member", now });
    return { action: "new_issue", issueId, score: match.score, ambiguous: Boolean(match.issueId && match.score >= config.review) };
  });
}

// ── Owner 可逆操作（保留完整歷史） ──
export function mergeIssues(db, { sourceIssueId, targetIssueId, actor = "owner", reason = null, now = new Date() }) {
  if (Number(sourceIssueId) === Number(targetIssueId)) throw httpError("cannot merge an issue into itself", 400);
  return withImmediateTx(db, () => {
    const src = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(sourceIssueId));
    const tgt = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(targetIssueId));
    if (!src || !tgt) throw httpError("issue not found", 404);
    const ts = iso(now);
    const links = db.prepare("SELECT * FROM issue_feedback_link WHERE issue_id=? AND active=1").all(Number(sourceIssueId));
    const moved = [];
    for (const l of links) {
      db.prepare("UPDATE issue_feedback_link SET active=0, removed_at=? WHERE id=?").run(ts, l.id);
      db.prepare(
        `INSERT INTO issue_feedback_link(issue_id, feedback_id, similarity_score, embedding_id, embedding_model, added_by, reason, active, created_at)
         VALUES (?, ?, ?, ?, ?, 'owner', ?, 1, ?)`,
      ).run(Number(targetIssueId), l.feedback_id, l.similarity_score, l.embedding_id, l.embedding_model, `merged from #${sourceIssueId}`, ts);
      moved.push(Number(l.feedback_id));
    }
    db.prepare("UPDATE issue_candidate SET status='merged', merged_into=?, updated_at=? WHERE id=?").run(Number(targetIssueId), ts, Number(sourceIssueId));
    db.prepare("INSERT INTO cluster_operation(op, issue_id, from_issue, to_issue, feedback_ids, actor, reason, clustering_version, created_at) VALUES ('MERGE', ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(Number(targetIssueId), Number(sourceIssueId), Number(targetIssueId), JSON.stringify(moved), actor, reason, CLUSTERING_VERSION, ts);
    appendAuditRow(db, { actor, action: "issue.merged", entityType: "issue_candidate", entityId: String(targetIssueId), data: { from_issue: Number(sourceIssueId), to_issue: Number(targetIssueId), moved_count: moved.length } });
    return { merged: moved.length, from: Number(sourceIssueId), to: Number(targetIssueId) };
  });
}

export function splitIssue(db, { issueId, feedbackIds, actor = "owner", reason = null, now = new Date() }) {
  const ids = (Array.isArray(feedbackIds) ? feedbackIds : []).map(Number).filter(Boolean);
  if (!ids.length) throw httpError("feedbackIds required", 400);
  return withImmediateTx(db, () => {
    const src = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(issueId));
    if (!src) throw httpError("issue not found", 404);
    const ts = iso(now);
    const newId = Number(db.prepare(
      "INSERT INTO issue_candidate(title, summary, category, clustering_version, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)",
    ).run(`split from #${issueId}`, src.summary, src.category, CLUSTERING_VERSION, ts, ts).lastInsertRowid);
    const moved = [];
    for (const fid of ids) {
      const l = db.prepare("SELECT * FROM issue_feedback_link WHERE issue_id=? AND feedback_id=? AND active=1").get(Number(issueId), fid);
      if (!l) continue;
      db.prepare("UPDATE issue_feedback_link SET active=0, removed_at=? WHERE id=?").run(ts, l.id);
      db.prepare(
        "INSERT INTO issue_feedback_link(issue_id, feedback_id, similarity_score, embedding_id, embedding_model, added_by, reason, active, created_at) VALUES (?, ?, ?, ?, ?, 'owner', ?, 1, ?)",
      ).run(newId, fid, l.similarity_score, l.embedding_id, l.embedding_model, `split from #${issueId}`, ts);
      moved.push(fid);
    }
    if (!moved.length) throw httpError("none of the given feedback are active members of this issue", 400);
    db.prepare("INSERT INTO cluster_operation(op, issue_id, from_issue, to_issue, feedback_ids, actor, reason, clustering_version, created_at) VALUES ('SPLIT', ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(newId, Number(issueId), newId, JSON.stringify(moved), actor, reason, CLUSTERING_VERSION, ts);
    appendAuditRow(db, { actor, action: "issue.split", entityType: "issue_candidate", entityId: String(issueId), data: { new_issue: newId, moved_count: moved.length } });
    return { newIssueId: newId, moved: moved.length };
  });
}

export function moveFeedback(db, { feedbackId, toIssueId, actor = "owner", reason = null, now = new Date() }) {
  return withImmediateTx(db, () => {
    const tgt = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(toIssueId));
    if (!tgt) throw httpError("target issue not found", 404);
    const cur = db.prepare("SELECT * FROM issue_feedback_link WHERE feedback_id=? AND active=1").get(Number(feedbackId));
    const fromIssue = cur ? Number(cur.issue_id) : null;
    const ts = iso(now);
    if (cur) db.prepare("UPDATE issue_feedback_link SET active=0, removed_at=? WHERE id=?").run(ts, cur.id);
    db.prepare(
      "INSERT INTO issue_feedback_link(issue_id, feedback_id, similarity_score, embedding_id, embedding_model, added_by, reason, active, created_at) VALUES (?, ?, ?, ?, ?, 'owner', ?, 1, ?)",
    ).run(Number(toIssueId), Number(feedbackId), cur?.similarity_score ?? null, cur?.embedding_id ?? null, cur?.embedding_model ?? null, reason, ts);
    db.prepare("INSERT INTO cluster_operation(op, issue_id, from_issue, to_issue, feedback_ids, actor, reason, clustering_version, created_at) VALUES ('MOVE', ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(Number(toIssueId), fromIssue, Number(toIssueId), JSON.stringify([Number(feedbackId)]), actor, reason, CLUSTERING_VERSION, ts);
    appendAuditRow(db, { actor, action: "issue.feedback.moved", entityType: "issue_candidate", entityId: String(toIssueId), data: { feedback_id: Number(feedbackId), from_issue: fromIssue, to_issue: Number(toIssueId) } });
    return { feedbackId: Number(feedbackId), from: fromIssue, to: Number(toIssueId) };
  });
}

// ── 讀取 ──
export function listIssues(db, { limit = 100, includeMerged = true } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
  const rows = includeMerged
    ? db.prepare("SELECT * FROM issue_candidate ORDER BY id DESC LIMIT ?").all(cap)
    : db.prepare("SELECT * FROM issue_candidate WHERE status='open' ORDER BY id DESC LIMIT ?").all(cap);
  return rows.map((r) => ({ ...r, member_count: Number(db.prepare("SELECT COUNT(*) n FROM issue_feedback_link WHERE issue_id=? AND active=1").get(r.id).n) }));
}

export function getIssueWithMembers(db, issueId) {
  const issue = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(issueId));
  if (!issue) return null;
  const members = db.prepare("SELECT feedback_id, similarity_score, embedding_model, added_by, reason, created_at FROM issue_feedback_link WHERE issue_id=? AND active=1 ORDER BY id ASC").all(Number(issueId));
  const history = db.prepare("SELECT op, from_issue, to_issue, feedback_ids, actor, reason, created_at FROM cluster_operation WHERE issue_id=? OR from_issue=? OR to_issue=? ORDER BY id ASC").all(Number(issueId), Number(issueId), Number(issueId));
  return { issue, members, history };
}

export function feedbackIssue(db, feedbackId) {
  return db.prepare("SELECT issue_id FROM issue_feedback_link WHERE feedback_id=? AND active=1").get(Number(feedbackId))?.issue_id ?? null;
}
