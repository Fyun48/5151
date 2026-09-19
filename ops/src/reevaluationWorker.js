import { reevaluationConfig } from "./reevaluationPolicy.js";
import { assessReevaluation, authorizeAndReopen } from "./reevaluation.js";

// Phase 9 自動重評 worker：純本地決定性（無外部 AI）。只處理 DEFERRED/REJECTED；BLOCKED 永不自動重啟。
// 寫入前重驗訂閱世代：解除訂閱或世代已換 → 不把舊議題重開成 EVALUATING。Owner 手動重評／解除 BLOCK 不走這條。
// - feedback ingestion / 其它階段不受影響。
// - 冪等：同 baseline+evidence+policy 只授權一次（DB unique + engine 檢查）。
// - impact stale 時等待（不做自動決策）。cooldown 由 policy 控制，避免 flapping。
// - 低頻輪詢；不製造每 tick 的稽核噪音（只有真的授權/重啟才寫稽核，於 engine 內完成）。

const DEFAULT_BATCH = 50;

export function reevaluationWorkerConfigFromEnv(env = process.env) {
  return {
    enabled: env.REEVAL_WORKER !== "0", // 預設開（純本地計算、無外部依賴）
    intervalMs: Number(env.REEVAL_INTERVAL_MS || 5 * 60 * 1000),
    batchSize: Number(env.REEVAL_BATCH || DEFAULT_BATCH),
  };
}

function issueIdsInReopenableStates(db, batchSize) {
  const rows = db.prepare(
    "SELECT id FROM state_entity WHERE entity_type='issue' AND state IN ('DEFERRED','REJECTED') ORDER BY id ASC LIMIT ?",
  ).all(Math.max(1, Math.min(Number(batchSize) || DEFAULT_BATCH, 500)));
  const out = [];
  for (const r of rows) {
    const n = Number(String(r.id).split(":")[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export function runReevaluationOnce(db, { now = () => new Date(), config = reevaluationConfig(), batchSize = DEFAULT_BATCH } = {}) {
  const ids = issueIdsInReopenableStates(db, batchSize);
  const summary = { scanned: 0, eligible: 0, reopened: 0, skipped: 0, failed: 0 };
  for (const issueId of ids) {
    summary.scanned += 1;
    const a = assessReevaluation(db, issueId, { now: now(), config });
    if (!a.applicable || !a.eligible) { summary.skipped += 1; continue; }
    summary.eligible += 1;
    try {
      const r = authorizeAndReopen(db, issueId, { triggerType: "auto", authorizedBy: "policy", now: now(), config });
      if (r.reopened) summary.reopened += 1; else summary.skipped += 1; // idempotent
    } catch {
      summary.failed += 1; // 狀態競爭 / stale：current 不變，下輪再試
    }
  }
  return summary;
}

export function startReevaluationLoop(db, { config, log = () => {} }) {
  if (!config?.enabled) return () => {};
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      const summary = runReevaluationOnce(db, { config });
      if (summary.reopened) log("reevaluation", summary);
    } catch (err) {
      log("reevaluation-error", { error: err?.name || "error" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
