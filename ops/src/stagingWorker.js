import { createStagingDeployment, claimStagingBatch, executeStagingDeployment, stagingRunConfigFromEnv, validateCodingTaskForStaging } from "./stagingDeploy.js";
import { makeCodingRepo } from "./coding/gitRepo.js";
import { makeStagingProvider } from "./staging/provider.js";

// Phase 12 背景 worker：為「有 fresh QA PASS」的 coding task 建立/執行隔離 Staging 部署。
// 安全預設：provider 未設（STAGING_PROVIDER 未設）或 repo 不可用（OPS_CODING_REPO_PATH 未設）→ 不建/不跑。
// 絕不部署 Production、不 merge、不假 READY。

export function stagingWorkerConfigFromEnv(env = process.env) { return stagingRunConfigFromEnv(env); }

export function createStagingForReadyTasks(db, { repo, env = process.env, now = new Date(), limit = 5 } = {}) {
  if (!repo || !repo.available) return [];
  // 候選：coding task changes_ready 且其 canonical QA 為 PASS，且尚無「當前 head 未取消」的部署。
  const rows = db.prepare(
    `SELECT t.id FROM development_coding_task t
     JOIN development_qa_current qc ON qc.coding_task_id = t.id AND qc.final_result = 'PASS'
     WHERE t.status='changes_ready'
       AND NOT EXISTS (SELECT 1 FROM development_staging_deployment s WHERE s.coding_task_id=t.id AND s.head_sha=t.head_sha AND s.status!='cancelled')
     ORDER BY t.id ASC LIMIT ?`,
  ).all(Math.max(1, limit));
  const created = [];
  for (const r of rows) {
    try { validateCodingTaskForStaging(db, r.id, { env }); created.push(createStagingDeployment(db, { codingTaskId: r.id, repo, env, now })); }
    catch { /* 不合格（QA 非 fresh PASS 等）→ 跳過 */ }
  }
  return created;
}

export async function runStagingOnce(db, { repo, provider, config = stagingWorkerConfigFromEnv(), now = () => new Date() } = {}) {
  const at = typeof now === "function" ? now() : now;
  createStagingForReadyTasks(db, { repo, env: process.env, now: at });
  const claimed = claimStagingBatch(db, { now: at, staleMs: config.claimStaleMs, limit: config.concurrency });
  const results = [];
  for (const dep of claimed) results.push(await executeStagingDeployment(db, dep, { repo, provider, now: at }));
  return { claimed: claimed.length, results };
}

export function startStagingLoop(db, { repo = makeCodingRepo(), provider = makeStagingProvider(), config = stagingWorkerConfigFromEnv(), log = () => {} } = {}) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { const r = await runStagingOnce(db, { repo, provider, config }); if (r.claimed) log("staging.tick", r); }
    catch (err) { log("staging.error", { error: err.message }); }
    if (!stopped) setTimeout(tick, config.intervalMs);
  };
  setTimeout(tick, config.intervalMs);
  return { stop() { stopped = true; } };
}
