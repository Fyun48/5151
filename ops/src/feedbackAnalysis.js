import { appendAuditRow } from "./audit.js";
import { withImmediateTx } from "./tx.js";
import { httpError } from "./errors.js";
import { ANALYSIS_TYPE_CLASSIFICATION, CLASSIFICATION_PROMPT_VERSION } from "./ai/prompt.js";
import { currentSubscriptionGeneration, feedbackAllowsNewInsight, workerWriteDecision } from "./insightConsent.js";
import { analysisStatsForConsent } from "./usageConsent.js";

// feedback_analysis 的資料/狀態機。狀態：pending → processing → completed | failed。
//
// 語意分層（Phase 4.1）：
//   revision    = 語意分析執行/版本 identity（每 feedback_id+analysis_type 遞增；reprocess 建新 revision）
//   retry_count = 同一 revision 的執行層重試次數（provider timeout 等暫時失敗）
//
// CURRENT 指標（feedback_analysis_current）：每 (feedback_id, analysis_type) 至多一筆，
// 只會指向「已 COMPLETED」的分析；只有成功完成才會 promote（原子化於 completeAnalysis）。
// 失敗/逾時/schema 無效/重試耗盡都不會動到 CURRENT。

export const ANALYSIS_MAX_RETRIES = 5;
export const ANALYSIS_SCHEMA_MAX_RETRIES = 2; // 明顯 schema/設定錯誤不無限重試
export const ANALYSIS_CLAIM_STALE_MS = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;

function iso(now) {
  return (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
}

export function analysisBackoffMs(retries, { base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS, random = Math.random } = {}) {
  const raw = Math.min(base * 2 ** Math.max(0, retries - 1), cap);
  return Math.round(raw * (0.5 + 0.5 * random()));
}

// 建立一筆待分析 job（新的 revision）。不自帶交易；ingest 已在交易內，reprocess 由本模組包交易。
export function enqueueAnalysisRow(db, { feedbackId, analysisType = ANALYSIS_TYPE_CLASSIFICATION, promptVersion = CLASSIFICATION_PROMPT_VERSION, maxRetries = ANALYSIS_MAX_RETRIES, now = new Date() }) {
  if (!feedbackId) throw new Error("enqueueAnalysisRow requires feedbackId");
  const prev = db.prepare(
    "SELECT MAX(revision) AS m FROM feedback_analysis WHERE feedback_id = ? AND analysis_type = ?",
  ).get(Number(feedbackId), analysisType);
  const revision = (Number(prev?.m) || 0) + 1;
  const ts = iso(now);
  const productId = db.prepare("SELECT product_id FROM ingested_feedback WHERE id=?").get(Number(feedbackId))?.product_id;
  const generation = currentSubscriptionGeneration(db, productId);
  const res = db.prepare(
    `INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, status, next_attempt_at, created_at, subscription_generation)
     VALUES (?, ?, ?, 0, ?, ?, 'pending', ?, ?, ?)`,
  ).run(Number(feedbackId), analysisType, revision, maxRetries, promptVersion, ts, ts, generation);
  return { id: Number(res.lastInsertRowid), revision, subscription_generation: generation };
}

// Owner 手動 reprocess：建立新的 revision（可指定新的 prompt_version）。永不覆寫舊結果。
export function reprocessAnalysis(db, feedbackId, { analysisType = ANALYSIS_TYPE_CLASSIFICATION, promptVersion = CLASSIFICATION_PROMPT_VERSION, actor = "owner", now = new Date() } = {}) {
  const exists = db.prepare("SELECT id FROM ingested_feedback WHERE id = ?").get(Number(feedbackId) || 0);
  if (!exists) throw httpError("feedback not found", 404);
  if (!feedbackAllowsNewInsight(db, feedbackId)) {
    throw httpError("跨站分析未授權或已退出且未約定保留。不會產生新洞察。", 403);
  }
  return withImmediateTx(db, () => {
    const row = enqueueAnalysisRow(db, { feedbackId, analysisType, promptVersion, now });
    appendAuditRow(db, {
      actor,
      action: "feedback.analysis.reprocessed",
      entityType: "feedback_analysis",
      entityId: String(row.id),
      data: { feedback_id: Number(feedbackId), analysis_type: analysisType, prompt_version: promptVersion, revision: row.revision },
      now,
    });
    return row;
  });
}

export function claimAnalysisBatch(db, { limit = 10, now = new Date(), staleMs = ANALYSIS_CLAIM_STALE_MS } = {}) {
  const nowIso = iso(now);
  const staleBefore = iso(new Date((now instanceof Date ? now.getTime() : now) - staleMs));
  const inflight = db.prepare("SELECT * FROM feedback_analysis WHERE status IN ('pending','failed_retry','processing')").all();
  for (const row of inflight) {
    const decision = workerWriteDecision(db, row.feedback_id, { expectedGeneration: row.subscription_generation });
    if (decision.ok) continue;
    db.prepare("UPDATE feedback_analysis SET status='failed', error_code=? WHERE id=? AND status IN ('pending','failed_retry','processing')")
      .run(decision.reason || "subscription_revoked", row.id);
  }
  const candidates = db.prepare(
    `SELECT * FROM feedback_analysis
     WHERE (status IN ('pending','failed_retry') AND next_attempt_at <= ?)
        OR (status = 'processing' AND (claimed_at IS NULL OR claimed_at <= ?))
     ORDER BY id ASC LIMIT ?`,
  ).all(nowIso, staleBefore, Math.max(1, Math.min(Number(limit) || 10, 100)));
  const claimed = [];
  for (const row of candidates) {
    const decision = workerWriteDecision(db, row.feedback_id, { expectedGeneration: row.subscription_generation });
    if (!decision.ok) {
      db.prepare("UPDATE feedback_analysis SET status='failed', error_code=? WHERE id=? AND status IN ('pending','failed_retry','processing')")
        .run(decision.reason || "subscription_revoked", row.id);
      continue;
    }
    let res;
    if (row.status === "processing") {
      res = db.prepare("UPDATE feedback_analysis SET claimed_at=? WHERE id=? AND status='processing' AND (claimed_at IS NULL OR claimed_at <= ?)").run(nowIso, row.id, staleBefore);
    } else {
      res = db.prepare("UPDATE feedback_analysis SET status='processing', claimed_at=? WHERE id=? AND status=?").run(nowIso, row.id, row.status);
    }
    if (res.changes === 1) claimed.push({ ...row, status: "processing", claimed_at: nowIso });
  }
  return claimed;
}

// 成功完成 → 寫結果 + 原子 promote CURRENT 指標。回傳 promotion metadata（供稽核；不含原始內容）。
// 呼叫端須在同一交易內（worker 已用 withImmediateTx 包住）。
export function completeAnalysis(db, id, { provider, model, modelVersion = null, result, rawOutputHash, usage = {}, now = new Date() }) {
  const ts = iso(now);
  const row = db.prepare("SELECT feedback_id, analysis_type, subscription_generation FROM feedback_analysis WHERE id = ?").get(Number(id));
  if (!row) throw httpError("analysis not found", 404);
  const decision = workerWriteDecision(db, row.feedback_id, { expectedGeneration: row.subscription_generation });
  if (!decision.ok) {
    const err = httpError(decision.reason === "stale_generation" ? "訂閱世代已換，晚到結果不寫入。" : "訂閱已退出或未授權，晚到結果不寫入。", 409);
    err.code = decision.reason || "subscription_revoked";
    throw err;
  }
  db.prepare(
    `UPDATE feedback_analysis SET status='completed', provider=?, model=?, model_version=?,
       category=?, summary=?, severity_hint=?, confidence=?, language=?, raw_output_hash=?,
       usage_input_tokens=?, usage_output_tokens=?, estimated_cost=?, error_code=NULL, completed_at=?
     WHERE id=?`,
  ).run(
    provider, model, modelVersion,
    result.category, result.summary, result.severity_hint, result.confidence, result.language, rawOutputHash,
    usage.input_tokens ?? null, usage.output_tokens ?? null, usage.estimated_cost ?? null, ts, Number(id),
  );
  // promote：只在成功 COMPLETED 時移動指標；同 (feedback_id, analysis_type) upsert。
  const prev = db.prepare("SELECT analysis_id FROM feedback_analysis_current WHERE feedback_id=? AND analysis_type=?").get(row.feedback_id, row.analysis_type);
  const previousCurrentId = prev ? Number(prev.analysis_id) : null;
  db.prepare(
    `INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason)
     VALUES (?, ?, ?, ?, 'completed')
     ON CONFLICT(feedback_id, analysis_type) DO UPDATE SET analysis_id=excluded.analysis_id, updated_at=excluded.updated_at, reason=excluded.reason`,
  ).run(row.feedback_id, row.analysis_type, Number(id), ts);
  return { feedbackId: Number(row.feedback_id), analysisType: row.analysis_type, previousCurrentId, promoted: true };
}

// 失敗：transient=true 用一般上限；schema/設定錯誤用較低上限。CURRENT 指標不受影響。
export function failAnalysis(db, row, { errorCode, transient = true, now = new Date(), random = Math.random }) {
  const retries = Number(row.retry_count) + 1;
  const cap = transient ? Number(row.max_retries || ANALYSIS_MAX_RETRIES) : ANALYSIS_SCHEMA_MAX_RETRIES;
  const code = String(errorCode || "error").slice(0, 64);
  if (retries >= cap) {
    db.prepare("UPDATE feedback_analysis SET status='failed', retry_count=?, error_code=? WHERE id=?").run(retries, code, row.id);
    return { status: "failed", retry_count: retries };
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const next = iso(new Date(nowMs + analysisBackoffMs(retries, { random })));
  db.prepare("UPDATE feedback_analysis SET status='failed_retry', retry_count=?, next_attempt_at=?, error_code=? WHERE id=?").run(retries, next, code, row.id);
  return { status: "failed_retry", retry_count: retries, next_attempt_at: next };
}

export function getAnalysis(db, id) {
  return db.prepare("SELECT * FROM feedback_analysis WHERE id = ?").get(Number(id) || 0) || null;
}

export function listAnalyses(db, { feedbackId = null, limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
  if (feedbackId) {
    return db.prepare("SELECT * FROM feedback_analysis WHERE feedback_id = ? ORDER BY id DESC LIMIT ?").all(Number(feedbackId), cap);
  }
  return db.prepare("SELECT * FROM feedback_analysis ORDER BY id DESC LIMIT ?").all(cap);
}

export function currentAnalysisId(db, feedbackId, analysisType = ANALYSIS_TYPE_CLASSIFICATION) {
  const row = db.prepare("SELECT analysis_id FROM feedback_analysis_current WHERE feedback_id=? AND analysis_type=?").get(Number(feedbackId) || 0, analysisType);
  return row ? Number(row.analysis_id) : null;
}

// 下游 Phase 5/6/7 一律用這個取「唯一、確定、已 COMPLETED」的當前分析。回 null 表示尚無有效分析。
export function getCurrentFeedbackAnalysis(db, feedbackId, analysisType = ANALYSIS_TYPE_CLASSIFICATION) {
  const id = currentAnalysisId(db, feedbackId, analysisType);
  if (!id) return null;
  const row = getAnalysis(db, id);
  // 防禦：指標只應指向同 feedback/type 的 COMPLETED 分析。
  if (!row || row.status !== "completed" || Number(row.feedback_id) !== Number(feedbackId) || row.analysis_type !== analysisType) {
    return null;
  }
  return publicAnalysis(row);
}

export function analysisStats(db) {
  const out = { pending: 0, processing: 0, failed_retry: 0, completed: 0, failed: 0, total: 0 };
  for (const r of db.prepare("SELECT status, COUNT(*) n FROM feedback_analysis GROUP BY status").all()) {
    out[r.status] = Number(r.n) || 0;
    out.total += Number(r.n) || 0;
  }
  return analysisStatsForConsent(db, out);
}

export function publicAnalysis(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    feedback_id: Number(row.feedback_id),
    analysis_type: row.analysis_type,
    revision: Number(row.revision),
    retry_count: Number(row.retry_count),
    status: row.status,
    category: row.category,
    summary: row.summary,
    severity_hint: row.severity_hint,
    confidence: row.confidence == null ? null : Number(row.confidence),
    language: row.language,
    provider: row.provider,
    model: row.model,
    model_version: row.model_version,
    prompt_version: row.prompt_version,
    raw_output_hash: row.raw_output_hash,
    subscription_generation: row.subscription_generation == null ? null : Number(row.subscription_generation),
    error_code: row.error_code,
    usage: {
      input_tokens: row.usage_input_tokens,
      output_tokens: row.usage_output_tokens,
      estimated_cost: row.estimated_cost,
    },
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}
