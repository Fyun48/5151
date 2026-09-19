import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureJobQueueSchema, enqueueJob, JOB_STATE } from "../src/jobQueue.js";
import { runWorkerBatch, startWorkerLoop } from "../src/jobWorker.js";

function memDb() {
  const db = new DatabaseSync(":memory:");
  ensureJobQueueSchema(db);
  return db;
}

test("runWorkerBatch processes and completes jobs", () => {
  const db = memDb();
  enqueueJob(db, { jobType: "enrich", payload: { postId: 1 }, now: 1000 });
  enqueueJob(db, { jobType: "enrich", payload: { postId: 2 }, now: 1000 });
  const processed = [];
  const results = runWorkerBatch({
    db, workerId: "w", jobTypes: ["enrich"], limit: 10, now: 2000,
    handler: (job) => processed.push(job.payload.postId),
  });
  assert.equal(results.length, 2);
  assert.deepEqual(processed.sort(), [1, 2]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE state = ?").get(JOB_STATE.DONE).n, 2);
  db.close();
});

test("a failing job is requeued (not lost)", () => {
  const db = memDb();
  enqueueJob(db, { jobType: "enrich", maxAttempts: 3, now: 1000 });
  const results = runWorkerBatch({
    db, workerId: "w", limit: 10, now: 2000,
    handler: () => { throw new Error("boom"); },
  });
  assert.equal(results[0].state, "failed");
  assert.equal(db.prepare("SELECT state, attempts FROM job_queue WHERE id = 1").get().attempts, 1);
  assert.equal(db.prepare("SELECT state FROM job_queue WHERE id = 1").get().state, JOB_STATE.PENDING);
  db.close();
});

test("two workers never process the same job", () => {
  const db = memDb();
  for (let i = 0; i < 5; i++) enqueueJob(db, { jobType: "geo", payload: { n: i }, now: 1000 });
  const seen = new Set();
  const run = (workerId) => runWorkerBatch({
    db, workerId, jobTypes: ["geo"], limit: 10, now: 2000,
    handler: (job) => { seen.add(job.payload.n); },
  });
  run("worker-A");
  run("worker-B"); // second worker claims whatever remains (none left)
  assert.equal(seen.size, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE state = ?").get(JOB_STATE.DONE).n, 5);
  db.close();
});

test("startWorkerLoop returns a stop function", () => {
  const db = memDb();
  enqueueJob(db, { jobType: "geo", now: 1000 });
  const seen = [];
  const stop = startWorkerLoop({ db, workerId: "w", pollIntervalMs: 10, handler: (j) => seen.push(j.id) });
  return new Promise((resolve) => {
    setTimeout(() => {
      stop();
      assert.ok(seen.length >= 1);
      db.close();
      resolve();
    }, 80);
  });
});
