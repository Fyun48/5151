import { createReleaseCandidate, validateReleaseChain, retryReleaseNotification } from "./releaseCandidate.js";
import { releaseConfigFromEnv } from "./release/releasePolicy.js";
import { makeCodingRepo } from "./coding/gitRepo.js";
import { issueWriteDecision } from "./insightConsent.js";

// Phase 13 背景 worker：為「fresh QA PASS + fresh Staging PASS」的 coding task 決定性組裝 Release Candidate + 排通知。
// 不用 LLM（不可變 provenance 由本地決定性組裝）。安全預設：repo 不可用 → 不建。不部署、不 merge、不呼叫 coding provider。

export function releaseWorkerConfigFromEnv(env = process.env) { return releaseConfigFromEnv(env); }

export function createReleaseCandidatesForEligible(db, { repo, env = process.env, now = new Date(), limit = 5 } = {}) {
  if (!repo || !repo.available) return [];
  // 候選：coding task changes_ready，且 QA current=PASS 且 Staging current=PASS，且尚無「當前 head 的 RC」。
  const rows = db.prepare(
    `SELECT t.id FROM development_coding_task t
     JOIN development_qa_current qc ON qc.coding_task_id=t.id AND qc.final_result='PASS'
     JOIN development_staging_current sc ON sc.coding_task_id=t.id AND sc.validation_result='PASS'
     WHERE t.status='changes_ready'
       AND NOT EXISTS (SELECT 1 FROM development_release_candidate r WHERE r.coding_task_id=t.id AND r.head_sha=t.head_sha AND r.status!='cancelled')
     ORDER BY t.id ASC LIMIT ?`,
  ).all(Math.max(1, limit));
  const created = [];
  for (const r of rows) {
    try {
      const { task } = validateReleaseChain(db, r.id, { repo, env });
      if (!issueWriteDecision(db, task.issue_id, { expectedGeneration: task.subscription_generation }).ok) continue;
      created.push(createReleaseCandidate(db, { codingTaskId: r.id, repo, env, now }));
    }
    catch { /* 不合格（QA/Staging 非 fresh PASS 等）→ 跳過 */ }
  }
  return created;
}

export async function runReleaseOnce(db, { repo, config = releaseWorkerConfigFromEnv(), now = () => new Date() } = {}) {
  const at = typeof now === "function" ? now() : now;
  const created = createReleaseCandidatesForEligible(db, { repo, env: process.env, now: at });
  const pending = db.prepare("SELECT id FROM release_notification WHERE status='pending' ORDER BY id ASC LIMIT 20").all();
  let notified = 0;
  for (const n of pending) {
    const r = await retryReleaseNotification(db, n.id, { actor: "system", now: at });
    if (r.status === "sent") notified += 1;
  }
  return { created: created.length, notified };
}

export function startReleaseLoop(db, { repo = makeCodingRepo(), config = releaseWorkerConfigFromEnv(), log = () => {} } = {}) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { const r = await runReleaseOnce(db, { repo, config }); if (r.created) log("release.tick", r); }
    catch (err) { log("release.error", { error: err.message }); }
    if (!stopped) setTimeout(tick, config.intervalMs);
  };
  setTimeout(tick, config.intervalMs);
  return { stop() { stopped = true; } };
}
