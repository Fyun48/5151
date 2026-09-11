import { createQaRun, claimQaBatch, executeQaRun, qaRunConfigFromEnv, validateCodingTaskForQa } from "./qaRun.js";
import { makeCodingRepo } from "./coding/gitRepo.js";
import { makeQaReviewProvider } from "./qa/reviewProvider.js";
import { issueWriteDecision } from "./insightConsent.js";

// Phase 11 背景 worker：為 CHANGES_READY 的 Coding Task 建立 QA run，並 claim/執行。
// 決定性檢核預設就跑；optional AI reviewer 預設關閉。安全預設：repo 不可用（OPS_CODING_REPO_PATH 未設）→ 不建/不跑。

export function qaWorkerConfigFromEnv(env = process.env) { return qaRunConfigFromEnv(env); }

// 為尚無「當前 head 對應 run」的 changes_ready task 建立 QA run（需 repo 解析 diff）。
export function createQaForReadyTasks(db, { repo, env = process.env, now = new Date(), limit = 5 } = {}) {
  if (!repo || !repo.available) return [];
  const rows = db.prepare(
    `SELECT t.* FROM development_coding_task t
     WHERE t.status='changes_ready'
       AND NOT EXISTS (SELECT 1 FROM development_qa_run q WHERE q.coding_task_id=t.id AND q.head_sha=t.head_sha AND q.status!='cancelled')
     ORDER BY t.id ASC LIMIT ?`,
  ).all(Math.max(1, limit));
  const created = [];
  for (const t of rows) {
    if (!issueWriteDecision(db, t.issue_id, { expectedGeneration: t.subscription_generation }).ok) continue;
    try { validateCodingTaskForQa(db, t.id); created.push(createQaRun(db, { codingTaskId: t.id, repo, env, now })); }
    catch { /* 個別不合格不影響其它 */ }
  }
  return created;
}

export async function runQaOnce(db, { repo, reviewProvider = null, config = qaWorkerConfigFromEnv(), now = () => new Date() } = {}) {
  const at = typeof now === "function" ? now() : now;
  createQaForReadyTasks(db, { repo, env: process.env, now: at });
  const claimed = claimQaBatch(db, { now: at, staleMs: config.claimStaleMs, limit: config.concurrency });
  const results = [];
  for (const run of claimed) results.push(await executeQaRun(db, run, { repo, reviewProvider, now: at }));
  return { claimed: claimed.length, results };
}

export function startQaLoop(db, { repo = makeCodingRepo(), reviewProvider = makeQaReviewProvider(), config = qaWorkerConfigFromEnv(), log = () => {} } = {}) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { const r = await runQaOnce(db, { repo, reviewProvider, config }); if (r.claimed) log("qa.tick", r); }
    catch (err) { log("qa.error", { error: err.message }); }
    if (!stopped) setTimeout(tick, config.intervalMs);
  };
  setTimeout(tick, config.intervalMs);
  return { stop() { stopped = true; } };
}
