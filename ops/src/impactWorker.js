import { calculateAndStoreImpact, isImpactStale, impactConfig } from "./impact.js";

// Phase 6 背景 worker：純本地決定性計算，不需外部 AI provider。
// - feedback ingestion / clustering 不等待。
// - 冪等：只在「stale（membership fingerprint 改變）或尚無 current」時重算；否則略過。
// - 失敗（例外）不會取代既有 valid current（calculateAndStoreImpact 為單一交易，失敗即 rollback）。
// - bounded：每輪處理有限數量；stale 復原＝重掃。

const DEFAULT_BATCH = 50;

export function impactWorkerConfigFromEnv(env = process.env) {
  return {
    enabled: env.IMPACT_WORKER !== "0", // 預設開（純本地計算，無外部依賴）
    intervalMs: Number(env.IMPACT_INTERVAL_MS || 20000),
    batchSize: Number(env.IMPACT_BATCH || DEFAULT_BATCH),
  };
}

export function runImpactOnce(db, { now = () => new Date(), batchSize = DEFAULT_BATCH, config = impactConfig() } = {}) {
  const issues = db.prepare("SELECT id FROM issue_candidate WHERE status='open' ORDER BY id ASC LIMIT ?").all(Math.max(1, Math.min(Number(batchSize) || DEFAULT_BATCH, 500)));
  const summary = { scanned: 0, recalculated: 0, skipped: 0, failed: 0 };
  for (const it of issues) {
    summary.scanned += 1;
    if (!isImpactStale(db, it.id, { now: now() })) { summary.skipped += 1; continue; }
    try {
      calculateAndStoreImpact(db, it.id, { now: now(), config });
      summary.recalculated += 1;
    } catch {
      summary.failed += 1; // current 保持不變
    }
  }
  return summary;
}

export function startImpactLoop(db, { config, log = () => {} }) {
  if (!config?.enabled) return () => {};
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      const summary = runImpactOnce(db, { batchSize: config.batchSize });
      if (summary.recalculated) log("impact", summary);
    } catch (err) {
      log("impact-error", { error: err?.name || "error" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
