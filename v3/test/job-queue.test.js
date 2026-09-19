import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureJobQueueSchema,
  enqueueJob,
  claimJobs,
  completeJob,
  failJob,
  reclaimExpiredLeases,
  tryAcquireSchedulerLock,
  releaseSchedulerLock,
  JOB_PRIORITY,
  JOB_STATE,
  DEFAULT_LEASE_MS,
  POSTGRES_CLAIM_JOBS_SQL,
  POSTGRES_TRY_ADVISORY_LOCK_SQL,
} from "../src/jobQueue.js";

function memDb() {
  const db = new DatabaseSync(":memory:");
  ensureJobQueueSchema(db);
  return db;
}

test("enqueue + claim + complete", () => {
  const db = memDb();
  const job = enqueueJob(db, { jobType: "geo", payload: { postId: 7 }, now: 1000 });
  assert.equal(job.state, JOB_STATE.PENDING);
  assert.deepEqual(job.payload, { postId: 7 });

  const claimed = claimJobs(db, { workerId: "worker-A", limit: 10, now: 2000 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].state, JOB_STATE.LEASED);
  assert.equal(claimed[0].lease_owner, "worker-A");

  // already leased -> no re-claim
  assert.equal(claimJobs(db, { workerId: "worker-B", limit: 10, now: 2000 }).length, 0);

  // complete only by the lease owner
  assert.equal(completeJob(db, { jobId: job.id, workerId: "worker-B", now: 3000 }), false);
  assert.equal(completeJob(db, { jobId: job.id, workerId: "worker-A", now: 3000 }), true);

  assert.equal(db.prepare("SELECT state FROM job_queue WHERE id = ?").get(job.id).state, JOB_STATE.DONE);
  db.close();
});

test("claim respects priority order and job-type filter", () => {
  const db = memDb();
  const low = enqueueJob(db, { jobType: "backfill", priority: JOB_PRIORITY.HISTORICAL_BACKFILL, now: 1000 });
  const high = enqueueJob(db, { jobType: "geo", priority: JOB_PRIORITY.ON_SCREEN_LISTING, now: 1000 });
  const mid = enqueueJob(db, { jobType: "enrich", priority: JOB_PRIORITY.ENRICHMENT, now: 1000 });

  const claimed = claimJobs(db, { workerId: "w", limit: 10, now: 2000 });
  assert.deepEqual(claimed.map((j) => j.id), [high.id, mid.id, low.id]);

  // job-type filter
  const geoOnly = claimJobs(db, { workerId: "w", jobTypes: ["geo"], limit: 10, now: 2000 });
  assert.equal(geoOnly.length, 0); // already leased by previous claim
  db.close();
});

test("idempotency key prevents duplicate enqueue", () => {
  const db = memDb();
  const a = enqueueJob(db, { jobType: "enrich", idempotencyKey: "post-42", payload: { n: 1 }, now: 1000 });
  const b = enqueueJob(db, { jobType: "enrich", idempotencyKey: "post-42", payload: { n: 2 }, now: 1000 });
  assert.equal(a.id, b.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_queue").get().n, 1);
  db.close();
});

test("fail requeues with exponential backoff, then dead-letters", () => {
  const db = memDb();
  const job = enqueueJob(db, { jobType: "geo", maxAttempts: 3, now: 1000 });

  let t = 2000;
  claimJobs(db, { workerId: "w", now: t });
  const r1 = failJob(db, { jobId: job.id, workerId: "w", now: t });
  assert.equal(r1.state, JOB_STATE.PENDING);
  assert.equal(r1.attempts, 1);
  assert.equal(r1.availableAt, t + 1000); // 1000ms backoff

  t = r1.availableAt;
  claimJobs(db, { workerId: "w", now: t });
  const r2 = failJob(db, { jobId: job.id, workerId: "w", now: t });
  assert.equal(r2.attempts, 2);
  assert.equal(r2.availableAt, t + 2000); // 2000ms backoff

  t = r2.availableAt;
  claimJobs(db, { workerId: "w", now: t });
  const r3 = failJob(db, { jobId: job.id, workerId: "w", now: t });
  assert.equal(r3.state, JOB_STATE.DEAD); // attempts 3 >= max 3
  assert.equal(r3.attempts, 3);
  assert.equal(db.prepare("SELECT state FROM job_queue WHERE id = ?").get(job.id).state, JOB_STATE.DEAD);
  db.close();
});

test("expired leases are reclaimed for another worker", () => {
  const db = memDb();
  const job = enqueueJob(db, { jobType: "geo", now: 1000 });
  claimJobs(db, { workerId: "dead-worker", leaseDurationMs: 1000, now: 1000 });

  // before expiry: still leased, no reclaim
  assert.equal(reclaimExpiredLeases(db, { now: 1500 }), 0);
  assert.equal(claimJobs(db, { workerId: "worker-B", now: 1500 }).length, 0);

  // after expiry: reclaim and re-claim by another worker
  assert.equal(reclaimExpiredLeases(db, { now: 2500 }), 1);
  const re = claimJobs(db, { workerId: "worker-B", now: 2500 });
  assert.equal(re.length, 1);
  assert.equal(re[0].lease_owner, "worker-B");
  assert.equal(re[0].id, job.id);
  db.close();
});

test("scheduler lock grants exactly one owner until expiry", () => {
  const db = memDb();
  assert.equal(tryAcquireSchedulerLock(db, { key: "crawl-schedule", owner: "crawler-A", now: 1000 }), true);
  assert.equal(tryAcquireSchedulerLock(db, { key: "crawl-schedule", owner: "crawler-B", now: 1000 }), false);

  // still held at 1000..<61s
  assert.equal(tryAcquireSchedulerLock(db, { key: "crawl-schedule", owner: "crawler-B", now: 61000 - 1 }), false);
  // after lease expiry, another owner can take it
  assert.equal(tryAcquireSchedulerLock(db, { key: "crawl-schedule", owner: "crawler-B", now: 62000 }), true);

  releaseSchedulerLock(db, { key: "crawl-schedule", owner: "crawler-B" });
  assert.equal(tryAcquireSchedulerLock(db, { key: "crawl-schedule", owner: "crawler-A", now: 63000 }), true);
  db.close();
});

test("PostgreSQL claim uses FOR UPDATE SKIP LOCKED and advisory locks", () => {
  assert.match(POSTGRES_CLAIM_JOBS_SQL, /FOR UPDATE SKIP LOCKED/);
  assert.match(POSTGRES_CLAIM_JOBS_SQL, /ORDER BY priority DESC, created_at ASC, id ASC/);
  assert.match(POSTGRES_TRY_ADVISORY_LOCK_SQL, /pg_try_advisory_lock/);
});
