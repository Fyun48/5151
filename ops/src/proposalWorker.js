import { findEntity } from "./stateMachine.js";
import {
  computeProposalInput, enqueueProposalRow, claimProposalBatch, executeProposalGeneration,
  isProposalStale, currentProposalId,
} from "./proposal.js";

// Phase 8 提案生成背景 worker：非同步、bounded concurrency、retry/backoff、stale 復原、provider timeout。
// - feedback / clustering / impact / evaluation 不等待。
// - provider 未設定 → 略過、不認領、不消耗 attempts、不建假提案。
// - 只在「issue active + 生命週期允許 + 有 fresh PROPOSE 評估 + 目前沒有相同證據的 fresh 提案」時 enqueue（冪等）。
// - 決策後狀態（APPROVED/DEFERRED/REJECTED/BLOCKED/WAITING_OWNER_APPROVAL）不自動再生成。

const DEFAULT_BATCH = 20;
const DEFAULT_CLAIM = 5;
const DEFAULT_CONCURRENCY = 2;

const ELIGIBLE_STATES = new Set([null, undefined, "COLLECTING", "EVALUATING", "PROPOSAL_CHANGES_REQUESTED"]);

export function proposalWorkerConfigFromEnv(env = process.env) {
  const provider = String(env.PROPOSAL_PROVIDER || "").toLowerCase();
  return {
    enabled: provider === "local" || provider === "stub",
    intervalMs: Number(env.PROPOSAL_INTERVAL_MS || 20000),
    timeoutMs: Number(env.PROPOSAL_TIMEOUT_MS || 30000),
    batchSize: Number(env.PROPOSAL_BATCH || DEFAULT_BATCH),
    claimLimit: Number(env.PROPOSAL_CLAIM_LIMIT || DEFAULT_CLAIM),
    concurrency: Number(env.PROPOSAL_CONCURRENCY || DEFAULT_CONCURRENCY),
  };
}

async function runPool(items, concurrency, worker) {
  const results = [];
  let idx = 0;
  const runners = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (idx < items.length) results.push(await worker(items[idx++]));
  });
  await Promise.all(runners);
  return results;
}

function hasInflight(db, issueId) {
  return Boolean(db.prepare("SELECT 1 FROM issue_proposal WHERE issue_id=? AND status IN ('pending','processing','failed_retry') LIMIT 1").get(Number(issueId)));
}

export async function runProposalOnce(db, { provider, config = {}, now = () => new Date(), env = process.env, random = Math.random } = {}) {
  if (!provider || !provider.available) {
    return { enqueued: 0, claimed: 0, completed: 0, failed: 0, failed_retry: 0, deferred: 0, skipped: "no_provider" };
  }
  const batchSize = Math.max(1, Math.min(Number(config.batchSize) || DEFAULT_BATCH, 500));
  const claimLimit = Math.max(1, Math.min(Number(config.claimLimit) || DEFAULT_CLAIM, 50));
  const concurrency = Math.max(1, Number(config.concurrency) || DEFAULT_CONCURRENCY);
  const timeoutMs = Number(config.timeoutMs) || 30000;
  const summary = { enqueued: 0, claimed: 0, completed: 0, failed: 0, failed_retry: 0, deferred: 0 };

  const issues = db.prepare("SELECT id FROM issue_candidate WHERE status='open' ORDER BY id ASC LIMIT ?").all(batchSize);
  for (const it of issues) {
    if (hasInflight(db, it.id)) continue;
    const entity = findEntity(db, `issue:${Number(it.id)}`);
    if (entity && !ELIGIBLE_STATES.has(entity.state)) continue; // 決策後/等待審批狀態不自動再生成
    const input = computeProposalInput(db, it.id, { now: now(), env, provider });
    if (!input.ok) continue; // 非 PROPOSE / 尚未 fresh → 不 enqueue
    // 冪等：已有相同證據的 fresh current 提案 → 略過
    const curId = currentProposalId(db, it.id);
    if (curId) {
      const cur = db.prepare("SELECT input_fingerprint FROM issue_proposal_current WHERE issue_id=?").get(Number(it.id));
      if (cur && cur.input_fingerprint === input.fingerprint && !isProposalStale(db, it.id, { now: now(), env, provider })) continue;
    }
    enqueueProposalRow(db, { issueId: it.id, now: now() });
    summary.enqueued += 1;
  }

  const claimed = claimProposalBatch(db, { limit: claimLimit, now: now() });
  summary.claimed = claimed.length;
  if (!claimed.length) return summary;
  const results = await runPool(claimed, concurrency, (row) => executeProposalGeneration(db, row, { provider, timeoutMs, now, env, random }));
  for (const r of results) {
    if (r === "completed") summary.completed += 1;
    else if (r === "failed") summary.failed += 1;
    else if (r === "deferred") summary.deferred += 1;
    else summary.failed_retry += 1;
  }
  return summary;
}

export function startProposalLoop(db, { provider, config, log = () => {} }) {
  if (!provider?.available || !config?.enabled) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runProposalOnce(db, { provider, config });
      if (summary.enqueued || summary.claimed) log("proposal", summary);
    } catch (err) {
      log("proposal-error", { error: err?.name || "error" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
