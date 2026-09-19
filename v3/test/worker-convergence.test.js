import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureJobQueueSchema, JOB_STATE } from "../src/jobQueue.js";
import {
  CRM_JOB_TYPE,
  enqueueCrmDeliveryJob,
  runCrmDeliveryConvergedBatch,
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
