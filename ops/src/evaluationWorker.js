import { evaluationRolesConfig } from "./evaluationRoles.js";
import { aggregationConfig } from "./evaluationAggregation.js";
import {
  enqueueEvaluationRun, claimEvaluationBatch, executeEvaluationRun,
  evaluationStaleReasons, computeEvaluationInput,
} from "./evaluation.js";

// Phase 7 背景 worker：非同步、bounded concurrency、retry/backoff、stale 復原、provider timeout 保護。
// - feedback ingestion / clustering / impact 不等待評估。
// - provider 未設定（available=false）→ 直接略過、不認領、不消耗 attempts。
// - 依賴 Phase 6 新鮮度：impact stale/unavailable 時「不」發動評估（executeEvaluationRun 也會 defer）。
// - 冪等：同一 canonical 輸入不重複建立新的成功 run（僅在 stale 且無在途 run 時 enqueue）。

const DEFAULT_BATCH = 20;
const DEFAULT_CLAIM = 5;
const DEFAULT_CONCURRENCY = 2;

export function evaluationWorkerConfigFromEnv(env = process.env, opts = {}) {
  const provider = String(opts.kind || env.EVALUATION_PROVIDER || "").toLowerCase();
  return {
    enabled: provider === "local" || provider === "stub",
    intervalMs: Number(env.EVAL_INTERVAL_MS || 20000),
    timeoutMs: Number(env.EVAL_TIMEOUT_MS || 20000),
    batchSize: Number(env.EVAL_BATCH || DEFAULT_BATCH),
    claimLimit: Number(env.EVAL_CLAIM_LIMIT || DEFAULT_CLAIM),
    concurrency: Number(env.EVAL_CONCURRENCY || DEFAULT_CONCURRENCY),
    deliberationEnabled: env.EVALUATION_DELIBERATION_ENABLED === "1",
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

function hasInflightRun(db, issueId) {
  const row = db.prepare(
    "SELECT 1 FROM issue_evaluation_run WHERE issue_id=? AND status IN ('pending','processing','failed_retry') LIMIT 1",
  ).get(Number(issueId));
  return Boolean(row);
}

export async function runEvaluationOnce(db, { provider, config = {}, aggConfig = aggregationConfig(), roles, now = () => new Date(), random = Math.random } = {}) {
  if (!provider || !provider.available) {
    return { enqueued: 0, claimed: 0, completed: 0, failed: 0, failed_retry: 0, deferred: 0, skipped: "no_provider" };
  }
  const roleList = roles || evaluationRolesConfig().roles;
  const batchSize = Math.max(1, Math.min(Number(config.batchSize) || DEFAULT_BATCH, 500));
  const claimLimit = Math.max(1, Math.min(Number(config.claimLimit) || DEFAULT_CLAIM, 50));
  const concurrency = Math.max(1, Number(config.concurrency) || DEFAULT_CONCURRENCY);
  const timeoutMs = Number(config.timeoutMs) || 20000;
  const deliberationEnabled = Boolean(config.deliberationEnabled);
  const summary = { enqueued: 0, claimed: 0, completed: 0, failed: 0, failed_retry: 0, deferred: 0 };

  // ── enqueue：只對「open + stale + impact fresh + 無在途 run」的 issue 發動 ──
  const issues = db.prepare("SELECT id FROM issue_candidate WHERE status='open' ORDER BY id ASC LIMIT ?").all(batchSize);
  for (const it of issues) {
    if (hasInflightRun(db, it.id)) continue;
    // 用「worker 即將實際執行的政策」判斷新鮮度（provider/aggConfig/roles/deliberation），
    // 確保政策改變會觸發重評、且相同政策維持冪等。
    const reasons = evaluationStaleReasons(db, it.id, { now: now(), roles: roleList, provider, aggConfig, deliberationEnabled });
    if (!reasons.length) continue; // fresh → 冪等略過
    const impactBlocked = reasons.some((r) => r === "impact_stale" || r === "impact_unavailable" || r.startsWith("impact:") || r === "issue_inactive");
    if (impactBlocked) continue; // 依賴 Phase 6 新鮮度：impact 未 fresh 就不評估
    const input = computeEvaluationInput(db, it.id, { now: now(), roles: roleList });
    if (!input.ok) continue;
    enqueueEvaluationRun(db, { issueId: it.id, roles: roleList, deliberationEnabled, fingerprint: input.fingerprint, sourceImpactAssessmentId: input.sourceImpactAssessmentId, now: now() });
    summary.enqueued += 1;
  }

  // ── claim + process ──
  const claimed = claimEvaluationBatch(db, { limit: claimLimit, now: now() });
  summary.claimed = claimed.length;
  if (!claimed.length) return summary;
  const results = await runPool(claimed, concurrency, (run) => executeEvaluationRun(db, run, { provider, aggConfig, roles: roleList, timeoutMs, now, random }));
  for (const r of results) {
    if (r === "completed") summary.completed += 1;
    else if (r === "failed") summary.failed += 1;
    else if (r === "deferred") summary.deferred += 1;
    else summary.failed_retry += 1;
  }
  return summary;
}

export function startEvaluationLoop(db, { provider, config, roles, log = () => {} }) {
  if (!provider?.available || !config?.enabled) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runEvaluationOnce(db, { provider, config, roles });
      if (summary.enqueued || summary.claimed) log("evaluation", summary);
    } catch (err) {
      log("evaluation-error", { error: err?.name || "error" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
