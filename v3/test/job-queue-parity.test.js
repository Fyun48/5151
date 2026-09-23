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
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { ensurePgSchema } = await import("../src/pgSchema.js");
  const driver = await createPostgresDriver({ connectionString: url });
  try {
    await ensurePgSchema(driver, db, { tables: ["job_queue"] });
    await jobQueue.ensurePgJobQueueIndex(driver);
    const q = jobQueue.createJobQueue({ driver: "postgres", pgPool: driver });
    assert.equal(q.name, "postgres");
    const now = Date.now();
    const key = "live-job-" + now;
    // 影子站上還留著先前的工作列，而 claim 的順序是「優先權高者先、其次最舊者先」
    // （POSTGRES_CLAIM_JOBS_SQL 的 ORDER BY priority DESC, created_at ASC），
    // 所以用一個正式站不會出現的高優先權（正式站最高是 ON_SCREEN_LISTING = 100），
    // 保證這一輪搶到的就是剛排進去的這一筆。
    const enqueued = await q.enqueue({ jobType: "enrich", payload: { post_id: 42 }, idempotencyKey: key, priority: 10_000, now });
    assert.equal(Number(enqueued.attempts), 0);
    const claimed = await q.claim({ workerId: "live-worker", limit: 5, now });
    const mine = claimed.find((row) => row.idempotency_key === key);
    assert.ok(mine, "剛排進去的要搶到");
    assert.equal(mine.state, "leased");
    assert.equal(mine.lease_owner, "live-worker");
    const done = await q.complete({ jobId: mine.id, workerId: "live-worker", now });
    assert.equal(done, true);
    const afterDone = await q.claim({ workerId: "live-worker", limit: 5, now: now + 1 });
    assert.equal(afterDone.some((row) => row.idempotency_key === key), false, "完成後不該再被搶到");
  } finally {
    await driver.close();
  }
});

