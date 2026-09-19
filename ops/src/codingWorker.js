import { createCodingTask, claimCodingTaskBatch, executeCodingTask, codingConfigFromEnv } from "./codingTask.js";
import { issueWriteDecision } from "./insightConsent.js";
import { makeCodingProvider } from "./coding/provider.js";
import { makeCodingRepo } from "./coding/gitRepo.js";
import { makePrGateway } from "./coding/prGateway.js";

// Phase 10 背景 worker：從 ACTIVE 授權建立 Coding Task，並 claim/執行。
// 成本控制：只有在 provider.available 時才會真的呼叫 coding provider；否則 task 留 pending。
// 安全預設：CODING_PROVIDER 未設 → provider 不可用；OPS_CODING_REPO_PATH 未設 → repo 不可用 → 完全不建/不跑。

export function codingWorkerConfigFromEnv(env = process.env) {
  return { ...codingConfigFromEnv(env), intervalMs: Math.max(2000, Number(env.CODING_WORKER_INTERVAL_MS) || 30000) };
}

// 為尚無「未取消 task」的 active 授權建立 Coding Task（需 repo 可用以解析 base SHA）。
export function createTasksForActiveAuthorizations(db, { provider, repo, env = process.env, now = new Date(), limit = 5 } = {}) {
  if (!repo || !repo.available) return [];
  const rows = db.prepare(
    `SELECT a.* FROM development_authorization a
     JOIN state_entity e ON e.id = 'issue:' || a.issue_id
     WHERE a.status='active' AND e.state IN ('APPROVED_FOR_DEVELOPMENT','DEVELOPING')
       AND NOT EXISTS (SELECT 1 FROM development_coding_task t WHERE t.development_authorization_id = a.id AND t.status != 'cancelled')
     ORDER BY a.id ASC LIMIT ?`,
  ).all(Math.max(1, limit));
  const created = [];
  for (const a of rows) {
    if (!issueWriteDecision(db, a.issue_id).ok) continue;
    try { created.push(createCodingTask(db, { issueId: a.issue_id, authorizationId: a.id, provider, repo, env, now })); }
    catch { /* 個別授權建立失敗不影響其它；保留安全 */ }
  }
  return created;
}

export async function runCodingOnce(db, { provider, repo, pr, selfTest = null, config = codingWorkerConfigFromEnv(), now = () => new Date() } = {}) {
  const at = typeof now === "function" ? now() : now;
  createTasksForActiveAuthorizations(db, { provider, repo, env: process.env, now: at });
  const claimed = claimCodingTaskBatch(db, { now: at, staleMs: config.claimStaleMs, limit: config.concurrency });
  const results = [];
  for (const task of claimed) {
    results.push(await executeCodingTask(db, task, { provider, repo, pr, selfTest, now: at }));
  }
  return { claimed: claimed.length, results };
}

export function startCodingLoop(db, { provider = makeCodingProvider(), repo = makeCodingRepo(), pr = makePrGateway(), selfTest = null, config = codingWorkerConfigFromEnv(), log = () => {} } = {}) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { const r = await runCodingOnce(db, { provider, repo, pr, selfTest, config }); if (r.claimed) log("coding.tick", r); }
    catch (err) { log("coding.error", { error: err.message }); }
    if (!stopped) setTimeout(tick, config.intervalMs);
  };
  setTimeout(tick, config.intervalMs);
  return { stop() { stopped = true; } };
}
