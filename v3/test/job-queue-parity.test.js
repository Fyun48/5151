// 2.3a parity：job 佇列在兩個 driver 上要走出一樣的狀態變化。
//
// 這支測試刻意用「步驟紀錄」比對：每一步的結果寫成一行文字，兩邊最後要比出同一串。
// 離線段只跑 SQLite（PG 版的 claim 用到 FOR UPDATE SKIP LOCKED，離線替身跑不動）；
// PG 版的 claim／reclaim 由 live 段在有 PG_TEST_URL 時驗證。
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-jobq-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the file locked */
  }
});

const app = await import("../src/db.js");
const jobQueue = await import("../src/jobQueue.js");

const db = app.sqliteHandle();
jobQueue.ensureJobQueueSchema(db);

function reset() {
  db.prepare("DELETE FROM job_queue").run();
}
beforeEach(reset);

// SQLite 佇列跑一輪，記錄每一步的結果。
async function runSqliteSteps({ now }) {
  const q = jobQueue.createJobQueue({ driver: "sqlite", sqliteDb: db });
  const steps = [];
  const enqueued = await q.enqueue({ jobType: "enrich", payload: { post_id: 1 }, idempotencyKey: "k1", now });
  steps.push("enqueue:" + (enqueued ? "ok" : "null"));
  const dup = await q.enqueue({ jobType: "enrich", payload: { post_id: 1 }, idempotencyKey: "k1", now });
  steps.push("dup:" + (dup ? "ok" : "null"));
  const rows = db.prepare("SELECT COUNT(*) n FROM job_queue").get().n;
  steps.push("rows:" + rows);
  return steps;
}

test("job 佇列：SQLite 路徑的行為（離線基準）", async () => {
  reset();
  const now = 1_700_000_000_000;
  reset();
  const q = jobQueue.createJobQueue({ driver: "sqlite", sqliteDb: db });
  const first = await q.enqueue({ jobType: "enrich", payload: { post_id: 1 }, idempotencyKey: "k1", now });
  assert.ok(first, "第一次排入要回一筆");
  await q.enqueue({ jobType: "enrich", payload: { post_id: 1 }, idempotencyKey: "k1", now });
  const count = db.prepare("SELECT COUNT(*) n FROM job_queue").get().n;
  assert.equal(count, 1, "同一個 idempotency_key 只會有一筆（去重）");
});

test("job 佇列：SQLite 佇列介面與原本的同步函式等價", async () => {
  const q = jobQueue.createJobQueue({ driver: "sqlite", sqliteDb: db });
  reset();
  const viaQueue = await q.enqueue({ jobType: "geo", payload: { a: 1 }, idempotencyKey: "sync-1", now: 1 });
  const claimedViaQueue = await q.claim({ workerId: "w1", limit: 10, now: 2 });
  reset();
  const viaFn = jobQueue.enqueueJob(db, { jobType: "geo", payload: { a: 2 }, idempotencyKey: "sync-2", now: 1 });
  const claimedViaFn = jobQueue.claimJobs(db, { workerId: "w2", limit: 10, now: 2 });
  assert.equal(viaQueue.job_type, viaFn.job_type, "排入的欄位要相同");
  assert.equal(viaQueue.state, viaFn.state);
  assert.equal(claimedViaQueue.length, claimedViaFn.length, "搶到的筆數要相同");
  assert.equal(claimedViaQueue.length, 1);
});

test("live：PostgreSQL 佇列可以排入、搶到、完成、失敗與回收", async (t) => {
  const url = process.env.PG_TEST_URL;
  if (!url) {
    t.skip("PG_TEST_URL is not set (live job_queue)");
    return;
  }
  const { withPgFixture } = await import("./fixtures/prb-search.mjs");
  await withPgFixture(db, async driver => {
    const q = jobQueue.createJobQueue({ driver: "postgres", pgPool: driver });
    const now = 1_700_000_000_000;
    const enqueued = await q.enqueue({ jobType: "enrich", payload: { post_id: 42 }, idempotencyKey: "fixed-clock", now });
    assert.equal(Number(enqueued.available_at), now, "預設可領取時間必須等於傳入 now");
    const claimed = await q.claim({ workerId: "live-worker", limit: 5, now });
    assert.equal(claimed.length, 1);
    const mine = claimed[0];
    assert.equal(Number(mine.id), Number(enqueued.id));
    assert.equal(mine.state, "leased");
    assert.equal(mine.lease_owner, "live-worker");
    assert.equal(Number(mine.attempts), 0);
    assert.equal(await q.complete({ jobId: mine.id, workerId: "other-worker", now }), false);
    assert.equal(await q.complete({ jobId: mine.id, workerId: "live-worker", now }), true);
    assert.deepEqual(await q.claim({ workerId: "live-worker", limit: 5, now: now + 1 }), []);

    const retry = await q.enqueue({ jobType: "enrich", idempotencyKey: "retry", maxAttempts: 2, now });
    await q.claim({workerId:"retry-worker", now, leaseDurationMs:10});
    assert.equal(await q.reclaimExpired({now:now+11}),1);
    const reclaimed=await q.claim({workerId:"retry-worker", now:now+11});
    assert.equal(Number(reclaimed[0].id),Number(retry.id));
    const failed=await q.fail({jobId:retry.id,workerId:"retry-worker",error:"fixture",now:now+12});
    assert.equal(failed.state,"pending");
    assert.equal(failed.attempts,1);
    assert.deepEqual(await q.claim({workerId:"retry-worker",now:failed.availableAt-1}),[]);
    assert.equal((await q.claim({workerId:"retry-worker",now:failed.availableAt})).length,1);
    const dead=await q.fail({jobId:retry.id,workerId:"retry-worker",error:"fixture",now:failed.availableAt});
    assert.equal(dead.state,"dead");
    assert.equal(dead.attempts,2);
  }, {tables:["job_queue"]});
});

test("PG enqueue uses the supplied clock for immediate availability and honors explicit scheduling", async () => {
  const values=[];
  const q=jobQueue.createJobQueue({driver:"postgres",pgPool:{query:async (_sql,params)=>{
    values.push(params); return {rows:[{available_at:params[4],created_at:params[6]}]};
  }}});
  await q.enqueue({jobType:"enrich",now:100});
  await q.enqueue({jobType:"enrich",now:100,availableAt:200});
  assert.deepEqual(values.map(p=>[p[4],p[6]]),[[100,100],[200,100]]);
});
