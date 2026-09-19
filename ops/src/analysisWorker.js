import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAudit, appendAuditRow } from "./audit.js";
import { claimAnalysisBatch, completeAnalysis, failAnalysis } from "./feedbackAnalysis.js";
import { workerWriteDecision } from "./insightConsent.js";
import { minimizeForAnalysis, buildClassificationPrompt } from "./ai/prompt.js";
import { parseAndValidate } from "./ai/schema.js";

// AI 分析背景 worker：bounded concurrency、provider timeout、retry/backoff、stale 復原。
// provider 未設定（available=false）→ 直接略過，不認領、不消耗 attempts（feedback 保持 pending）。
// 分析輸出一律經 ai/schema 嚴格驗證；驗證失敗＝非暫時性錯誤（較低重試上限）。

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_BATCH = 10;
const DEFAULT_CONCURRENCY = 2;

export function analysisConfigFromEnv(env = process.env, opts = {}) {
  const provider = String(opts.kind || env.AI_PROVIDER || "").toLowerCase();
  return {
    enabled: provider === "local" || provider === "stub",
    intervalMs: Number(env.AI_ANALYSIS_INTERVAL_MS || 15000),
    timeoutMs: Number(env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    batchSize: Number(env.AI_ANALYSIS_BATCH || DEFAULT_BATCH),
    concurrency: Number(env.AI_ANALYSIS_CONCURRENCY || DEFAULT_CONCURRENCY),
  };
}

async function runPool(items, concurrency, worker) {
  const results = [];
  let idx = 0;
  const runners = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (idx < items.length) {
      const cur = items[idx++];
      results.push(await worker(cur));
    }
  });
  await Promise.all(runners);
  return results;
}

async function processOne(db, job, { provider, timeoutMs, now = () => new Date(), random = Math.random }) {
  const fb = db.prepare("SELECT * FROM ingested_feedback WHERE id = ?").get(job.feedback_id);
  if (!fb) {
    // 理論上不會發生（FK）；視為非暫時性失敗。
    let out;
    withImmediateTx(db, () => {
      out = failAnalysis(db, job, { errorCode: "feedback_missing", transient: false, now: now() });
      appendAuditRow(db, { actor: "system", action: "feedback.analysis.failed", entityType: "feedback_analysis", entityId: String(job.id), data: { feedback_id: job.feedback_id, error_code: "feedback_missing", status: out.status } });
    });
    return out.status;
  }

  const gate = workerWriteDecision(db, job.feedback_id, { expectedGeneration: job.subscription_generation });
  if (!gate.ok) {
    let out;
    withImmediateTx(db, () => {
      out = failAnalysis(db, job, { errorCode: gate.reason || "subscription_revoked", transient: false, now: now() });
      appendAuditRow(db, { actor: "system", action: "feedback.analysis.failed", entityType: "feedback_analysis", entityId: String(job.id), data: { feedback_id: job.feedback_id, error_code: gate.reason || "subscription_revoked", status: out.status } });
    });
    return out.status;
  }

  const input = minimizeForAnalysis(fb);
  const { system, user, promptVersion } = buildClassificationPrompt(input);
  appendAudit(db, { actor: "system", action: "feedback.analysis.started", entityType: "feedback_analysis", entityId: String(job.id), data: { feedback_id: job.feedback_id, provider: provider.name, prompt_version: promptVersion, attempt: job.attempt } });

  try {
    const { rawText, usage } = await provider.analyze({ system, user, timeoutMs });
    const result = parseAndValidate(rawText); // 嚴格驗證；失敗會丟 422
    const rawOutputHash = createHash("sha256").update(String(rawText)).digest("hex");
    let promo;
    withImmediateTx(db, () => {
      promo = completeAnalysis(db, job.id, {
        provider: provider.name,
        model: provider.model || null,
        result,
        rawOutputHash,
        usage: usage || {},
        now: now(),
      });
      if (promo.skipped) return;
      appendAuditRow(db, {
        actor: "system",
        action: "feedback.analysis.completed",
        entityType: "feedback_analysis",
        entityId: String(job.id),
        // 只記 metadata；不記 prompt、不記完整內容、不記隱藏推理。
        data: { feedback_id: job.feedback_id, revision: job.revision, category: result.category, severity_hint: result.severity_hint, confidence: result.confidence, provider: provider.name, model: provider.model || null, prompt_version: promptVersion },
      });
      // CURRENT 指標移動（promotion）稽核：只記 metadata。
      appendAuditRow(db, {
        actor: "system",
        action: "feedback.analysis.promoted",
        entityType: "feedback_analysis_current",
        entityId: String(job.feedback_id),
        data: { feedback_id: job.feedback_id, analysis_type: job.analysis_type, from_analysis_id: promo.previousCurrentId, to_analysis_id: job.id, revision: job.revision },
      });
    });
    if (promo?.skipped) return promo.reason === "cancelled" ? "cancelled" : (promo.reason || "skipped");
    return "completed";
  } catch (err) {
    const isSchema = err?.status === 422;
    const isStale = err?.status === 409;
    const code = isStale ? (err.code || "stale_generation") : (isSchema ? "schema_invalid" : (err?.name === "AbortError" ? "timeout" : (err?.name || "provider_error")));
    let out;
    withImmediateTx(db, () => {
      out = failAnalysis(db, job, { errorCode: code, transient: !isSchema && !isStale, now: now(), random });
      appendAuditRow(db, { actor: "system", action: "feedback.analysis.failed", entityType: "feedback_analysis", entityId: String(job.id), data: { feedback_id: job.feedback_id, revision: job.revision, error_code: code, status: out.status, retry_count: out.retry_count } });
    });
    return out.status;
  }
}

export async function runAnalysisOnce(db, { provider, now = () => new Date(), timeoutMs = DEFAULT_TIMEOUT_MS, batchSize = DEFAULT_BATCH, concurrency = DEFAULT_CONCURRENCY, random = Math.random } = {}) {
  if (!provider || !provider.available) {
    return { claimed: 0, completed: 0, failed: 0, failed_retry: 0, cancelled: 0, skipped: "no_provider" };
  }
  const claimed = claimAnalysisBatch(db, { limit: batchSize, now: now() });
  if (!claimed.length) return { claimed: 0, completed: 0, failed: 0, failed_retry: 0, cancelled: 0 };
  const results = await runPool(claimed, concurrency, (job) => processOne(db, job, { provider, timeoutMs, now, random }));
  const summary = { claimed: claimed.length, completed: 0, failed: 0, failed_retry: 0, cancelled: 0 };
  for (const r of results) {
    if (r === "completed") summary.completed += 1;
    else if (r === "failed") summary.failed += 1;
    else if (r === "cancelled") summary.cancelled += 1;
    else summary.failed_retry += 1;
  }
  return summary;
}

export function startAnalysisLoop(db, { provider, config, log = () => {} }) {
  if (!provider?.available || !config?.enabled) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runAnalysisOnce(db, {
        provider,
        timeoutMs: config.timeoutMs,
        batchSize: config.batchSize,
        concurrency: config.concurrency,
      });
      if (summary.claimed) log("ai-analysis", summary);
    } catch (err) {
      log("ai-analysis-error", { error: err?.name || "error" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
