import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { cosineSimilarity, areComparable } from "./ai/embeddingProvider.js";
import { feedbackAllowsNewInsight } from "./insightConsent.js";

export const CLUSTERING_VERSION = "cluster-v1";

// 相似度門檻：可設定，不散落硬編。
//  >= auto     → 高信心，自動連結到既有 issue
//  review..auto→ 模糊，保守：另建新 issue（不強行合併），供 Owner 檢視
//  < review    → 明顯不同，另建新 issue
export function clusteringConfig(env = process.env) {
  const auto = Number(env.EMBED_SIM_AUTO || 0.86);
  const review = Number(env.EMBED_SIM_REVIEW || 0.70);
  // 群集一致性門檻：候選必須同時對「最近成員」與「群代表(centroid)」都夠相似才自動連結，
  // 避免單一連結鏈狀漂移（A-B-B-C chaining）吸收語意距離遠的成員。
  const coherence = Number(env.EMBED_CLUSTER_COHERENCE || 0.78);
  return { auto, review, coherence, clusteringVersion: CLUSTERING_VERSION };
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
    if (!feedbackAllowsNewInsight(db, m.feedback_id)) continue;
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

export function linkFeedback(db, { issueId, feedbackId, analysisId = null, similarity = null, coherence = null, embeddingId = null, embeddingModel = null, addedBy = "auto", membershipStatus = "active", reason = null, supersedeStatus = "superseded", now = new Date() }) {
  const ts = iso(now);
  // 停用舊 active link（保留歷史）：標記 superseded 或指定狀態。
  db.prepare("UPDATE issue_feedback_link SET active=0, membership_status=?, removed_at=? WHERE feedback_id=? AND active=1").run(supersedeStatus, ts, Number(feedbackId));
  const res = db.prepare(
    `INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, similarity_score, coherence_score, embedding_id, embedding_model, clustering_version, added_by, membership_status, reason, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(Number(issueId), Number(feedbackId), analysisId, similarity, coherence, embeddingId, embeddingModel, CLUSTERING_VERSION, addedBy, membershipStatus, reason, ts);
  db.prepare("INSERT INTO cluster_operation(op, issue_id, feedback_ids, actor, reason, clustering_version, created_at) VALUES ('LINK', ?, ?, ?, ?, ?, ?)").run(Number(issueId), JSON.stringify([Number(feedbackId)]), addedBy, reason, CLUSTERING_VERSION, ts);
  appendAuditRow(db, { actor: addedBy, action: "issue.feedback.linked", entityType: "issue_candidate", entityId: String(issueId), data: { feedback_id: Number(feedbackId), analysis_id: analysisId, embedding_id: embeddingId, similarity_score: similarity, coherence_score: coherence, added_by: addedBy, membership_status: membershipStatus } });
  return Number(res.lastInsertRowid);
}

// 群代表：只用「相容 + active + membership_status='active'」的成員 embedding 取 centroid（不混不相容空間）。
// excludeFeedbackId：計算某成員自身的一致性時，需把自己排除，避免 centroid 被自己灌水。
export function issueRepresentative(db, issueId, meta, { excludeFeedbackId = null } = {}) {
  const members = db.prepare(
    `SELECT e.* FROM issue_feedback_link l
     JOIN embedding e ON e.feedback_id = l.feedback_id AND e.status='active'
     WHERE l.issue_id=? AND l.active=1 AND l.membership_status='active'`,
  ).all(Number(issueId));
  const vecs = [];
  for (const m of members) {
    if (excludeFeedbackId != null && Number(m.feedback_id) === Number(excludeFeedbackId)) continue;
    if (!areComparable(meta, embMeta(m))) continue;
    vecs.push(parseVector(m));
  }
  if (!vecs.length) return null;
  const dim = vecs[0].length;
  const centroid = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) centroid[i] += v[i];
  for (let i = 0; i < dim; i++) centroid[i] /= vecs.length;
  return { centroid, count: vecs.length };
}

// 自動分群（保守）：需同時滿足 nearest>=auto 且 coherence(對群 centroid)>=coherence 才連既有 issue；否則另建新 issue。
export function autoClusterFeedback(db, { feedbackId, currentAnalysis, actor = "system", now = new Date(), config = clusteringConfig() }) {
  return withImmediateTx(db, () => {
    const already = db.prepare("SELECT id FROM issue_feedback_link WHERE feedback_id=? AND active=1").get(Number(feedbackId));
    if (already) return { action: "already_linked" };
    const emb = activeEmbedding(db, feedbackId);
    if (!emb) return { action: "no_embedding" };
    const analysisId = emb.analysis_id;
    const match = bestMatch(db, emb, { excludeFeedbackId: feedbackId });
    if (match.issueId && match.score >= config.auto) {
      // 群一致性檢查：對該 issue 的 centroid 也要夠相似，避免 chaining 漂移。
      const rep = issueRepresentative(db, match.issueId, embMeta(emb));
      const coherence = rep ? cosineSimilarity(parseVector(emb), rep.centroid) : 0;
      if (coherence >= config.coherence) {
        linkFeedback(db, { issueId: match.issueId, feedbackId, analysisId, similarity: match.score, coherence, embeddingId: emb.id, embeddingModel: emb.model, addedBy: "auto", membershipStatus: "active", reason: "auto: nearest>=auto & coherence>=coh", now });
        return { action: "linked", issueId: match.issueId, score: match.score, coherence };
      }
      // 群一致性不足 → 保守：另建新 issue（不強行併入）
      const nid = createIssue(db, { analysis: currentAnalysis, actor, now });
      linkFeedback(db, { issueId: nid, feedbackId, analysisId, similarity: match.score, coherence, embeddingId: emb.id, embeddingModel: emb.model, addedBy: "auto", membershipStatus: "active", reason: "coherence_below_threshold_new_issue", now });
      return { action: "new_issue", issueId: nid, score: match.score, coherence, coherenceFailed: true };
    }
    // 模糊或低相似 → 保守：新建 issue（不強行合併），避免 false merge
    const issueId = createIssue(db, { analysis: currentAnalysis, actor, now });
    linkFeedback(db, { issueId, feedbackId, analysisId, similarity: match.score || null, embeddingId: emb.id, embeddingModel: emb.model, addedBy: "auto", membershipStatus: "active", reason: match.issueId ? "below_auto_new_issue" : "first_member", now });
    return { action: "new_issue", issueId, score: match.score, ambiguous: Boolean(match.issueId && match.score >= config.review) };
  });
}

// 標記某 feedback 目前的 active membership 為 review_required（不搬移、不改 issue）。
export function markMembershipReview(db, feedbackId, { reason = null, now = new Date() } = {}) {
  const link = db.prepare("SELECT * FROM issue_feedback_link WHERE feedback_id=? AND active=1").get(Number(feedbackId));
  if (!link) return null;
  db.prepare("UPDATE issue_feedback_link SET membership_status='review_required' WHERE id=?").run(link.id);
  appendAuditRow(db, { actor: "system", action: "issue.membership.review_required", entityType: "issue_candidate", entityId: String(link.issue_id), data: { feedback_id: Number(feedbackId), reason } });
  return Number(link.issue_id);
}

// 下游 Phase 6/7 唯一入口：僅回「確定的當前成員」（active 且 membership_status='active'）。
export function getCurrentIssueMembers(db, issueId) {
  return db.prepare(
    "SELECT * FROM issue_feedback_link WHERE issue_id=? AND active=1 AND membership_status='active' ORDER BY id ASC",
  ).all(Number(issueId));
}

// 需人工檢視的成員（auto: 非 current 的 review_required；或 owner: current 但 AI 證據衝突 review_flag）。
// 注意：owner review_flag 成員「仍是 current 權威成員」，只是被標記建議檢視。
export function getReviewRequiredMembers(db, issueId) {
  return db.prepare(
    "SELECT * FROM issue_feedback_link WHERE issue_id=? AND active=1 AND (membership_status='review_required' OR review_flag=1) ORDER BY id ASC",
  ).all(Number(issueId));
}

// CURRENT 分析變更（新 embedding）後，重新評估此 feedback 的既有 membership。
//  - Owner 決定為權威：不搬移、不撤銷；僅在與新證據衝突時標 review_required（不反轉）。
//  - Auto membership：舊證據 stale → 先標 review_required（排除於 centroid）→ 用新證據重評：
//      * 仍強力支持「同一 issue」(nearest>=auto 且 coherence>=coh，或該 issue 僅此成員) → 以新證據 reaffirm（新 active link）。
//      * 支持「其他 issue」或模糊 → 不自動搬移；保持 review_required（下游不得當作 confirmed）。
export function reevaluateMembershipOnRefresh(db, { feedbackId, config = clusteringConfig(), now = new Date() }) {
  return withImmediateTx(db, () => {
    const link = db.prepare("SELECT * FROM issue_feedback_link WHERE feedback_id=? AND active=1").get(Number(feedbackId));
    if (!link) return { action: "not_linked" };
    const emb = activeEmbedding(db, feedbackId);
    if (!emb) return { action: "no_embedding" };
    const meta = embMeta(emb);
    const vec = parseVector(emb);
    const isOwner = String(link.added_by || "").startsWith("owner");
    if (isOwner) {
      // Owner 決定為權威：membership 永遠維持 current（membership_status 不動）。
      // 若新 AI 證據衝突，只設「review_flag」中繼資料，不影響 currentness；一致則清除旗標。
      const rep = issueRepresentative(db, link.issue_id, meta, { excludeFeedbackId: feedbackId });
      const coh = rep ? cosineSimilarity(vec, rep.centroid) : 1;
      if (rep && coh < config.coherence) {
        db.prepare("UPDATE issue_feedback_link SET review_flag=1, review_reason='ai_evidence_conflicts', analysis_id=?, coherence_score=? WHERE id=?").run(emb.analysis_id, coh, link.id);
        appendAuditRow(db, { actor: "system", action: "issue.membership.review_recommended", entityType: "issue_candidate", entityId: String(link.issue_id), data: { feedback_id: Number(feedbackId), reason: "owner_link_conflicts_new_evidence", coherence_score: coh, authoritative: true } });
        return { action: "owner_review_recommended", issueId: Number(link.issue_id), coherence: coh };
      }
      db.prepare("UPDATE issue_feedback_link SET review_flag=0, review_reason=NULL, analysis_id=?, coherence_score=? WHERE id=?").run(emb.analysis_id, coh, link.id);
      return { action: "owner_kept", issueId: Number(link.issue_id) };
    }
    // auto：先標 review（排除於 centroid），再用新證據重評
    db.prepare("UPDATE issue_feedback_link SET membership_status='review_required', analysis_id=?, embedding_id=? WHERE id=?").run(emb.analysis_id, emb.id, link.id);
    const rep = issueRepresentative(db, link.issue_id, meta); // 已排除自己（現為 review）
    // solo issue（此 feedback 為唯一成員）→ 用新證據 reaffirm 同一 issue
    if (rep == null) {
      linkFeedback(db, { issueId: Number(link.issue_id), feedbackId, analysisId: emb.analysis_id, similarity: null, coherence: null, embeddingId: emb.id, embeddingModel: emb.model, addedBy: "auto", membershipStatus: "active", reason: "reaffirmed_after_refresh_solo", supersedeStatus: "superseded", now });
      appendAuditRow(db, { actor: "system", action: "issue.membership.reaffirmed", entityType: "issue_candidate", entityId: String(link.issue_id), data: { feedback_id: Number(feedbackId), analysis_id: emb.analysis_id, embedding_id: emb.id, reason: "solo" } });
      return { action: "reaffirmed", issueId: Number(link.issue_id) };
    }
    const match = bestMatch(db, emb, { excludeFeedbackId: feedbackId });
    const coh = cosineSimilarity(vec, rep.centroid);
    const sameIssueStrong = match.issueId === Number(link.issue_id) && match.score >= config.auto && coh >= config.coherence;
    if (sameIssueStrong) {
      linkFeedback(db, { issueId: Number(link.issue_id), feedbackId, analysisId: emb.analysis_id, similarity: match.score, coherence: coh, embeddingId: emb.id, embeddingModel: emb.model, addedBy: "auto", membershipStatus: "active", reason: "reaffirmed_after_refresh", supersedeStatus: "superseded", now });
      appendAuditRow(db, { actor: "system", action: "issue.membership.reaffirmed", entityType: "issue_candidate", entityId: String(link.issue_id), data: { feedback_id: Number(feedbackId), analysis_id: emb.analysis_id, embedding_id: emb.id, similarity_score: match.score, coherence_score: coh } });
      return { action: "reaffirmed", issueId: Number(link.issue_id) };
    }
    appendAuditRow(db, { actor: "system", action: "issue.membership.review_required", entityType: "issue_candidate", entityId: String(link.issue_id), data: { feedback_id: Number(feedbackId), reason: "stale_embedding_reevaluation", best_issue: match.issueId, best_score: match.score, coherence_score: coh } });
    return { action: "review_required", issueId: Number(link.issue_id), best: match, coherence: coh };
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
  const members = db.prepare("SELECT feedback_id, analysis_id, similarity_score, coherence_score, embedding_id, embedding_model, clustering_version, added_by, membership_status, review_flag, review_reason, reason, created_at FROM issue_feedback_link WHERE issue_id=? AND active=1 ORDER BY id ASC").all(Number(issueId));
  const history = db.prepare("SELECT op, from_issue, to_issue, feedback_ids, actor, reason, created_at FROM cluster_operation WHERE issue_id=? OR from_issue=? OR to_issue=? ORDER BY id ASC").all(Number(issueId), Number(issueId), Number(issueId));
  const entity = db.prepare("SELECT state FROM state_entity WHERE id=?").get(`issue:${Number(issueId)}`);
  const followUps = db.prepare(
    "SELECT id, title, issue_kind, product_id, created_at FROM issue_candidate WHERE parent_issue_id=? ORDER BY id DESC",
  ).all(Number(issueId)).map((r) => ({
    id: Number(r.id), title: r.title || "", issue_kind: r.issue_kind || "followup", product_id: r.product_id || null, created_at: r.created_at,
  }));
  return {
    issue: {
      ...issue,
      parent_issue_id: issue.parent_issue_id ? Number(issue.parent_issue_id) : null,
      issue_kind: issue.issue_kind || "normal",
      product_id: issue.product_id || null,
    },
    lifecycle_state: entity?.state || "COLLECTING",
    follow_ups: followUps,
    members,
    history,
  };
}

export function feedbackIssue(db, feedbackId) {
  return db.prepare("SELECT issue_id FROM issue_feedback_link WHERE feedback_id=? AND active=1").get(Number(feedbackId))?.issue_id ?? null;
}
