import { appendAuditRow } from "./audit.js";
import { withImmediateTx } from "./tx.js";
import { httpError } from "./errors.js";
import { ANALYSIS_TYPE_CLASSIFICATION, CLASSIFICATION_PROMPT_VERSION } from "./ai/prompt.js";

// feedback_analysis 的資料/狀態機。狀態：pending → processing → completed | failed。
// reprocess 一律建立新的 attempt（不覆寫歷史）。worker 以 claim 保證同一 job 不被重複處理。

export const ANALYSIS_MAX_ATTEMPTS = 5;
export const ANALYSIS_SCHEMA_MAX_ATTEMPTS = 2; // 明顯的 schema/設定錯誤不無限重試
export const ANALYSIS_CLAIM_STALE_MS = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;

function iso(now) {
  return (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
}

export function analysisBackoffMs(attempts, { base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS, random = Math.random } = {}) {
  const raw = Math.min(base * 2 ** Math.max(0, attempts - 1), cap);
  return Math.round(raw * (0.5 + 0.5 * random()));
}

// 建立一筆待分析 job（不自帶交易；ingest 已在交易內，reprocess 由本模組包交易）。
export function enqueueAnalysisRow(db, { feedbackId, analysisType = ANALYSIS_TYPE_CLASSIFICATION, promptVersion = CLASSIFICATION_PROMPT_VERSION, maxAttempts = ANALYSIS_MAX_ATTEMPTS, now = new Date() }) {
  if (!feedbackId) throw new Error("enqueueAnalysisRow requires feedbackId");
  const prev = db.prepare(
    "SELECT MAX(attempt) AS m FROM feedback_analysis WHERE feedback_id = ? AND analysis_type = ? AND prompt_version = ?",
  ).get(Number(feedbackId), analysisType, promptVersion);
  const attempt = (Number(prev?.m) || 0) + 1;
  const ts = iso(now);
  const res = db.prepare(
    `INSERT INTO feedback_analysis(feedback_id, analysis_type, attempt, prompt_version, status, attempts, max_attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).run(Number(feedbackId), analysisType, attempt, promptVersion, maxAttempts, ts, ts);
  return { id: Number(res.lastInsertRowid), attempt };
}

// Owner 手動 reprocess：建立新 attempt（可指定新的 prompt_version）。
export function reprocessAnalysis(db, feedbackId, { analysisType = ANALYSIS_TYPE_CLASSIFICATION, promptVersion = CLASSIFICATION_PROMPT_VERSION, actor = "owner", now = new Date() } = {}) {
  const exists = db.prepare("SELECT id FROM ingested_feedback WHERE id = ?").get(Number(feedbackId) || 0);
  if (!exists) throw httpError("feedback not found", 404);
  return withImmediateTx(db, () => {
    const row = enqueueAnalysisRow(db, { feedbackId, analysisType, promptVersion, now });
    appendAuditRow(db, {
      actor,
      action: "feedback.analysis.reprocessed",
      entityType: "feedback_analysis",
      entityId: String(row.id),
      data: { feedback_id: Number(feedbackId), analysis_type: analysisType, prompt_version: promptVersion, attempt: row.attempt },
      now,
    });
    return row;
  });
}

// 認領一批待處理 job（原子標記 processing；crash 復原 stale processing）。
export function claimAnalysisBatch(db, { limit = 10, now = new Date(), staleMs = ANALYSIS_CLAIM_STALE_MS } = {}) {
  const nowIso = iso(now);
  const staleBefore = iso(new Date((now instanceof Date ? now.getTime() : now) - staleMs));
  const candidates = db.prepare(
    `SELECT * FROM feedback_analysis
     WHERE (status IN ('pending','failed_retry') AND next_attempt_at <= ?)
        OR (status = 'processing' AND (claimed_at IS NULL OR claimed_at <= ?))
     ORDER BY id ASC LIMIT ?`,
  ).all(nowIso, staleBefore, Math.max(1, Math.min(Number(limit) || 10, 100)));
  const claimed = [];
  for (const row of candidates) {
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

export function completeAnalysis(db, id, { provider, model, modelVersion = null, result, rawOutputHash, usage = {}, now = new Date() }) {
  const ts = iso(now);
  db.prepare(
    `UPDATE feedback_analysis SET status='completed', provider=?, model=?, model_version=?,
       category=?, summary=?, severity_hint=?, confidence=?, language=?, raw_output_hash=?,
       usage_input_tokens=?, usage_output_tokens=?, estimated_cost=?, error_code=NULL, completed_at=?
     WHERE id=?`,
  ).run(
    provider, model, modelVersion,
    result.category, result.summary, result.severity_hint, result.confidence, result.language, rawOutputHash,
    usage.input_tokens ?? null, usage.output_tokens ?? null, usage.estimated_cost ?? null, ts, id,
  );
}

// 失敗：transient=true 用一般上限；schema/設定錯誤用較低上限，避免無限重試。
export function failAnalysis(db, row, { errorCode, transient = true, now = new Date(), random = Math.random }) {
  const attempts = Number(row.attempts) + 1;
  const cap = transient ? Number(row.max_attempts || ANALYSIS_MAX_ATTEMPTS) : ANALYSIS_SCHEMA_MAX_ATTEMPTS;
  const code = String(errorCode || "error").slice(0, 64);
  if (attempts >= cap) {
    db.prepare("UPDATE feedback_analysis SET status='failed', attempts=?, error_code=? WHERE id=?").run(attempts, code, row.id);
    return { status: "failed", attempts };
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const next = iso(new Date(nowMs + analysisBackoffMs(attempts, { random })));
  db.prepare("UPDATE feedback_analysis SET status='failed_retry', attempts=?, next_attempt_at=?, error_code=? WHERE id=?").run(attempts, next, code, row.id);
  return { status: "failed_retry", attempts, next_attempt_at: next };
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

export function analysisStats(db) {
  const out = { pending: 0, processing: 0, failed_retry: 0, completed: 0, failed: 0, total: 0 };
  for (const r of db.prepare("SELECT status, COUNT(*) n FROM feedback_analysis GROUP BY status").all()) {
    out[r.status] = Number(r.n) || 0;
    out.total += Number(r.n) || 0;
  }
  return out;
}

// 對外視圖：只露結構化結果與 provenance，不露內部欄位。
export function publicAnalysis(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    feedback_id: Number(row.feedback_id),
    analysis_type: row.analysis_type,
    attempt: Number(row.attempt),
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
