// Durable-queue worker loop (Phase 4 convergence). The reference pattern every
// background worker (geo / enrich / notify / CRM / OPS / wish) migrates onto:
// claim (lease) -> process -> complete | fail (retry/backoff) with automatic
// expired-lease reclaim so a dead worker's jobs are picked up by another.
import { claimJobs, completeJob, failJob, reclaimExpiredLeases } from "./jobQueue.js";

export function runWorkerBatch({
  db,
  workerId,
  jobTypes = null,
  limit = 10,
  handler = null,
  now = Date.now(),
} = {}) {
  // Crash recovery: reclaim jobs whose lease expired (e.g. a dead worker).
  reclaimExpiredLeases(db, { now });
  const jobs = claimJobs(db, { workerId, jobTypes, limit, now });
  const results = [];
  for (const job of jobs) {
    try {
      const out = handler ? handler(job) : undefined;
      completeJob(db, { jobId: job.id, workerId, now: Date.now() });
      results.push({ id: Number(job.id), state: "done", out });
    } catch (error) {
      failJob(db, { jobId: job.id, workerId, error: error?.message || String(error), now: Date.now() });
      results.push({ id: Number(job.id), state: "failed", error: error?.message || String(error) });
    }
  }
  return results;
}

export async function runWorkerBatchAsync({
  db,
  workerId,
  jobTypes = null,
  limit = 10,
  handler = null,
  now = Date.now(),
} = {}) {
  // Crash recovery: reclaim jobs whose lease expired (e.g. a dead worker).
  reclaimExpiredLeases(db, { now });
  const jobs = claimJobs(db, { workerId, jobTypes, limit, now });
  const results = [];
  for (const job of jobs) {
    try {
      const out = handler ? await handler(job) : undefined;
      completeJob(db, { jobId: job.id, workerId, now: Date.now() });
      results.push({ id: Number(job.id), state: "done", out });
    } catch (error) {
      failJob(db, { jobId: job.id, workerId, error: error?.message || String(error), now: Date.now() });
      results.push({ id: Number(job.id), state: "failed", error: error?.message || String(error) });
    }
  }
  return results;
}

export function startWorkerLoop({
  db,
  workerId,
  jobTypes = null,
  handler = null,
  limit = 10,
  pollIntervalMs = 5000,
  log = () => {},
} = {}) {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const results = runWorkerBatch({ db, workerId, jobTypes, limit, handler });
      if (results.length) log(`${workerId} processed ${results.length} job(s)`);
    } catch (error) {
      log(`${workerId} error: ${error?.message || error}`);
    }
  }, pollIntervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
