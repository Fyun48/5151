import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { getCurrentFeedbackAnalysis } from "./feedbackAnalysis.js";
import { buildEmbeddingInput, NORMALIZATION_VERSION } from "./ai/embeddingInput.js";
import { storeEmbedding, autoClusterFeedback, activeEmbedding, bestMatch, feedbackIssue, clusteringConfig } from "./clustering.js";

// Phase 5 背景 worker：異步產生 embedding 並保守自動分群。
// - ingestion 永不等待；provider 未設定（available=false）→ 略過，不影響 feedback 儲存。
// - 冪等：embedding 唯一鍵；autoCluster 檢查已連結。
// - stale 偵測：CURRENT 分析變更 → 為新 analysis_id 產生新 embedding、舊的標 stale、再 re-evaluate 成員。

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_BATCH = 20;

export function clusteringConfigFromEnv(env = process.env) {
  const provider = String(env.EMBEDDING_PROVIDER || "").toLowerCase();
  return {
    enabled: provider === "local" || provider === "stub",
    intervalMs: Number(env.CLUSTERING_INTERVAL_MS || 20000),
    timeoutMs: Number(env.EMBEDDING_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    batchSize: Number(env.CLUSTERING_BATCH || DEFAULT_BATCH),
  };
}

function candidates(db, { model, modelVersion, normVersion, limit }) {
  return db.prepare(
    `SELECT fac.feedback_id AS feedback_id, fac.analysis_id AS analysis_id
     FROM feedback_analysis_current fac
     JOIN feedback_analysis fa ON fa.id = fac.analysis_id AND fa.status='completed'
     WHERE NOT EXISTS (
       SELECT 1 FROM embedding e
       WHERE e.feedback_id = fac.feedback_id AND e.analysis_id = fac.analysis_id
         AND e.model = ? AND e.model_version IS ? AND e.normalization_version = ? AND e.status='active'
     )
     ORDER BY fac.feedback_id ASC LIMIT ?`,
  ).all(model, modelVersion, normVersion, Math.max(1, Math.min(Number(limit) || DEFAULT_BATCH, 200)));
}

// 新 embedding 產生後，若該 feedback 已在某 issue：保守 re-evaluate（僅在明確更相似的其他 issue 才移動）。
function reevaluateMembership(db, { feedbackId, emb, config, now }) {
  const curIssue = feedbackIssue(db, feedbackId);
  if (curIssue == null) return { action: "not_linked" };
  const match = bestMatch(db, emb, { excludeFeedbackId: feedbackId });
  appendAuditRow(db, { actor: "system", action: "issue.membership.reevaluated", entityType: "issue_candidate", entityId: String(curIssue), data: { feedback_id: Number(feedbackId), best_issue: match.issueId, best_score: match.score } });
  // 保守：不因 stale 主動搬移；僅記錄。實際搬移交由 Owner（MOVE）或未來政策。
  return { action: "kept", issue: curIssue, best: match };
}

export async function runEmbeddingOnce(db, { provider, now = () => new Date(), timeoutMs = DEFAULT_TIMEOUT_MS, batchSize = DEFAULT_BATCH, config = clusteringConfig() } = {}) {
  if (!provider || !provider.available) return { embedded: 0, clustered: 0, staled: 0, skipped: "no_provider" };
  const model = provider.model;
  const modelVersion = provider.modelVersion ?? null;
  const rows = candidates(db, { model, modelVersion, normVersion: NORMALIZATION_VERSION, limit: batchSize });
  const summary = { embedded: 0, clustered: 0, staled: 0, new_issues: 0, linked: 0 };
  for (const c of rows) {
    const current = getCurrentFeedbackAnalysis(db, c.feedback_id);
    if (!current || current.id !== c.analysis_id) continue; // current 可能又變了
    const fb = db.prepare("SELECT id, content FROM ingested_feedback WHERE id=?").get(c.feedback_id);
    if (!fb) continue;
    const input = buildEmbeddingInput(current, fb);
    let result;
    try {
      result = await provider.embed([input.text], { timeoutMs });
    } catch {
      continue; // 暫時失敗 → 下一輪重試（idempotent；不影響 ingestion）
    }
    const vector = result.vectors?.[0];
    if (!Array.isArray(vector) || !vector.length) continue;
    const stored = storeEmbedding(db, {
      feedbackId: c.feedback_id, analysisId: c.analysis_id, provider: provider.name,
      model: result.model || model, modelVersion: result.model_version ?? modelVersion,
      dim: result.dim || vector.length, normalizationVersion: input.normalizationVersion,
      vector, textHash: input.textHash, now: now(),
    });
    summary.embedded += 1;
    summary.staled += stored.staled || 0;
    const emb = activeEmbedding(db, c.feedback_id);
    const alreadyLinked = feedbackIssue(db, c.feedback_id) != null;
    if (!alreadyLinked) {
      const res = autoClusterFeedback(db, { feedbackId: c.feedback_id, currentAnalysis: current, now: now(), config });
      summary.clustered += 1;
      if (res.action === "new_issue") summary.new_issues += 1;
      if (res.action === "linked") summary.linked += 1;
    } else if (stored.created) {
      withImmediateTx(db, () => reevaluateMembership(db, { feedbackId: c.feedback_id, emb, config, now: now() }));
    }
  }
  return summary;
}

export function startClusteringLoop(db, { provider, config, log = () => {} }) {
  if (!provider?.available || !config?.enabled) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runEmbeddingOnce(db, { provider, timeoutMs: config.timeoutMs, batchSize: config.batchSize });
      if (summary.embedded) log("clustering", summary);
    } catch (err) {
      log("clustering-error", { error: err?.name || "error" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
