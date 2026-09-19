import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createJobQueue,
  ensureJobQueueSchema,
  JOB_STATE,
  JOB_PRIORITY,
} from "../src/jobQueue.js";

test("createJobQueue(sqlite) drives the full lifecycle through the factory", async () => {
  const db = new DatabaseSync(":memory:");
  ensureJobQueueSchema(db);
  const queue = createJobQueue({ sqliteDb: db });
  assert.equal(queue.name, "sqlite");

  const job = await queue.enqueue({ jobType: "geo", payload: { postId: 1 }, now: 1000 });
  assert.equal(job.state, JOB_STATE.PENDING);

  const claimed = await queue.claim({ workerId: "w", limit: 10, now: 2000 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].lease_owner, "w");

  assert.equal(await queue.complete({ jobId: job.id, workerId: "w", now: 3000 }), true);
  assert.equal(db.prepare("SELECT state FROM job_queue WHERE id = 1").get().state, JOB_STATE.DONE);
  db.close();
});

test("createJobQueue factory selects driver and requires the matching backend", () => {
  const db = new DatabaseSync(":memory:");
  assert.throws(() => createJobQueue({ driver: "postgres" }), /requires pgPool/);
  assert.throws(() => createJobQueue({ sqliteDb: null }), /requires sqliteDb/);
  assert.equal(createJobQueue({ sqliteDb: db }).name, "sqlite");
  db.close();
});

test("createJobQueue(postgres) uses FOR UPDATE SKIP LOCKED and $n placeholders", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      // default rows for claim/complete/reclaim; enqueue returns one row
      return { rows: [], rowCount: 1 };
    },
  };
  const queue = createJobQueue({ driver: "postgres", pgPool: pool });
  await queue.enqueue({ jobType: "geo", priority: JOB_PRIORITY.WATCHED, now: 1000 });
  await queue.claim({ workerId: "w", jobTypes: ["geo"], limit: 5, now: 2000 });
  await queue.complete({ jobId: 1, workerId: "w", now: 3000 });
  await queue.reclaimExpired({ now: 4000 });

  const enqueueSql = calls[0].sql;
  assert.match(enqueueSql, /\$1, \$2::jsonb/);
  assert.match(enqueueSql, /ON CONFLICT \(idempotency_key\) DO NOTHING/);

  const claimSql = calls[1].sql;
  assert.match(claimSql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(calls[1].params, [2000, ["geo"], 5, "w", 2000 + 5 * 60 * 1000]);

  assert.match(calls[2].sql, /WHERE id = \$1 AND state = 'leased' AND lease_owner = \$2/);
  assert.match(calls[3].sql, /WHERE state = 'leased' AND lease_until < \$1/);
});
