import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureJobQueueSchema, JOB_STATE } from "../src/jobQueue.js";
import {
  CRM_JOB_TYPE,
  enqueueCrmDeliveryJob,
  runCrmDeliveryConvergedBatch,
  enqueueEnrichJob,
  runEnrichConvergedBatch,
  enrichRetryError,
} from "../src/workerConvergence.js";

function memDb() {
  const db = new DatabaseSync(":memory:");
  ensureJobQueueSchema(db);
  return db;
}

test("converged CRM worker delivers and completes jobs through the durable queue", async () => {
  const db = memDb();
  enqueueCrmDeliveryJob(db, { deliveryId: "d1", payload: { n: 1 }, now: 1000 });
  enqueueCrmDeliveryJob(db, { deliveryId: "d2", payload: { n: 2 }, now: 1000 });
  const delivered = [];
  const results = await runCrmDeliveryConvergedBatch(db, {
    deliver: async (job) => { delivered.push(job.payload.n); },
  });
  assert.equal(results.length, 2);
  assert.deepEqual(delivered.sort(), [1, 2]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE state = ?").get(JOB_STATE.DONE).n, 2);
  db.close();
});

test("converged CRM enqueue is idempotent by deliveryId", () => {
  const db = memDb();
  enqueueCrmDeliveryJob(db, { deliveryId: "d1", payload: { n: 1 }, now: 1000 });
  enqueueCrmDeliveryJob(db, { deliveryId: "d1", payload: { n: 1 }, now: 1000 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_queue").get().n, 1);
  db.close();
});

test("converged CRM worker retries then dead-letters after max attempts", async () => {
  const db = memDb();
  enqueueCrmDeliveryJob(db, { deliveryId: "d1", maxAttempts: 2, now: 1000 });
  const fail = async () => { throw new Error("boom"); };
  await runCrmDeliveryConvergedBatch(db, { deliver: fail });
  assert.equal(db.prepare("SELECT state, attempts FROM job_queue WHERE id = 1").get().state, JOB_STATE.PENDING);
  db.prepare("UPDATE job_queue SET available_at = 0 WHERE state = 'pending'").run(); // advance past backoff
  await runCrmDeliveryConvergedBatch(db, { deliver: fail });
  assert.equal(db.prepare("SELECT state FROM job_queue WHERE id = 1").get().state, JOB_STATE.DEAD);
  db.close();
});

test("converged enrich worker claims higher-priority (click) jobs first", async () => {
  const db = memDb();
  enqueueEnrichJob(db, { postId: 1, via: "", now: 1000 });       // normal priority
  enqueueEnrichJob(db, { postId: 2, via: "click", now: 1000 });  // click priority
  const order = [];
  await runEnrichConvergedBatch(db, { processEnrich: async (job) => { order.push(job.payload.postId); } });
  assert.deepEqual(order, [2, 1]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE state = ?").get(JOB_STATE.DONE).n, 2);
  db.close();
});

test("converged enrich enqueue is idempotent by postId", () => {
  const db = memDb();
  enqueueEnrichJob(db, { postId: 1, via: "click", now: 1000 });
  enqueueEnrichJob(db, { postId: 1, via: "watch", now: 1000 }); // dup, higher priority
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_queue").get().n, 1);
  db.close();
});

test("enrich source_limited failure honors the 12h cooldown via retryAfterMs", async () => {
  const db = memDb();
  enqueueEnrichJob(db, { postId: 1, via: "click", now: 1000 });
  const before = Date.now();
  await runEnrichConvergedBatch(db, { processEnrich: async () => { throw enrichRetryError("source_limited"); } });
  const row = db.prepare("SELECT state, available_at FROM job_queue WHERE id = 1").get();
  assert.equal(row.state, JOB_STATE.PENDING);
  assert.ok(Number(row.available_at) - before >= 11 * 60 * 60 * 1000, "12h cooldown expected");
  db.close();
});
