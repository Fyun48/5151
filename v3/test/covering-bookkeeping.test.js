// 2026-09-24 Production 事故（第二段）的回歸測試。
//
// 整輪抓取完成的紀錄（lastCoveringAt／lastSystemCoveringAt／crawl_covers.last_run_at）只寫進該節點
// 自己的 SQLite，而 isSystemCoveringDue() 讀的是 PG 的 settings → 永遠讀到凍結的舊值
// （實測：PG 的 lastSystemCoveringAt 停在 2026-09-22T05:35Z）→ 系統每分鐘都判定「該抓了」，
// 爬蟲背對背連續全速跑（約 570 筆/分鐘）。
//
// 這支測試釘住 coveringBookkeepingAsync.js：
//   1) PG 分支完成時，兩個時間戳要 upsert 進 settings，並更新 crawl_covers.last_run_at；
//   2) PG 分支的到期判斷讀 PG 的值（凍結的舊值 → 到期、剛跑完 → 不到期）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-covering-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const {
  coveringBookkeepingAsync,
  isSystemCoveringDueAsync,
  markCoveringCompletedAsync,
  markCoveringProgressAsync,
} = await import("../src/coveringBookkeepingAsync.js");
const { COVERING_JOBS_PER_RUN, rotateCoveringJobs } = await import("../src/crawlPolicy.js");

function fakeExec(rowsForQuery = null) {
  const calls = [];
  return {
    calls,
    exec: async (sql, params = []) => {
      calls.push({ sql, params });
      return rowsForQuery ? rowsForQuery(sql, params) : [];
    },
  };
}

const insertCalls = (calls) => calls.filter((call) => /INSERT INTO settings\(key, value\)/.test(call.sql));

test("PG 分支：整輪完成會寫兩個時間戳並更新 crawl_covers.last_run_at", async () => {
  const { calls, exec } = fakeExec();
  const at = "2026-09-24T11:00:00.000Z";
  await markCoveringCompletedAsync({ includedUserIds: [], includeSystem: true, at }, { driver: "postgres", exec });
  assert.deepEqual(insertCalls(calls).map((call) => call.params[0]), ["lastCoveringAt", "lastSystemCoveringAt"]);
  assert.ok(insertCalls(calls).every((call) => call.params[1] === JSON.stringify(at)));
  const touched = calls.find((call) => /UPDATE crawl_covers SET last_run_at/.test(call.sql));
  assert.ok(touched, "要更新 crawl_covers.last_run_at");
  assert.deepEqual(touched.params, [at]);
});

test("PG 分支：includeSystem=false 時不寫 lastSystemCoveringAt（不動全站節奏）", async () => {
  const { calls, exec } = fakeExec();
  await markCoveringCompletedAsync(
    { includedUserIds: [], includeSystem: false, at: "2026-09-24T11:05:00.000Z" },
    { driver: "postgres", exec },
  );
  assert.deepEqual(insertCalls(calls).map((call) => call.params[0]), ["lastCoveringAt"]);
});

test("PG 分支：到期判斷讀 PG 的值，不是讀節點自己的 SQLite", async () => {
  const now = Date.parse("2026-09-24T11:00:00.000Z");
  const stale = fakeExec(() => [{ key: "lastSystemCoveringAt", value: JSON.stringify("2026-09-22T05:35:11.226Z") }]);
  assert.equal(await isSystemCoveringDueAsync(now, { driver: "postgres", exec: stale.exec }), true);
  const fresh = fakeExec(() => [{ key: "lastSystemCoveringAt", value: JSON.stringify("2026-09-24T10:55:00.000Z") }]);
  assert.equal(await isSystemCoveringDueAsync(now, { driver: "postgres", exec: fresh.exec }), false);
  const missing = fakeExec(() => []);
  assert.equal(await isSystemCoveringDueAsync(now, { driver: "postgres", exec: missing.exec }), true);
});

test("SQLite 分支：沿用同步讀（不動原本行為）", async () => {
  const bookkeeping = await coveringBookkeepingAsync({ driver: "sqlite" });
  assert.equal(typeof bookkeeping.lastCoveringAt, "string");
  assert.equal(typeof bookkeeping.lastSystemCoveringAt, "string");
});

test("PG 分支：進度不冒充完成；includeSystem 只更新排程節奏，不動 cover 或會員", async () => {
  const { calls, exec } = fakeExec();
  const at = "2026-09-24T11:40:00.000Z";
  await markCoveringProgressAsync({ at }, { driver: "postgres", exec });
  assert.deepEqual(insertCalls(calls).map((call) => call.params[0]), []);
  assert.equal(calls.some((call) => /UPDATE crawl_covers/.test(call.sql)), false);

  const withSystem = fakeExec();
  await markCoveringProgressAsync({ at, includeSystem: true }, { driver: "postgres", exec: withSystem.exec });
  assert.deepEqual(insertCalls(withSystem.calls).map((call) => call.params[0]), ["lastSystemCoveringAt"]);
});

test("每輪只跑一段覆蓋條件：輪替會接著跑一輪，掃完全部後回到開頭", async () => {
  const jobs = Array.from({ length: 19 }, (_, i) => `job-${i}`);
  const intervalMs = 20 * 60 * 1000;
  const roundAt = (n) => n * intervalMs;
  const first = rotateCoveringJobs(jobs, { now: roundAt(0), intervalMs });
  assert.equal(first.length, COVERING_JOBS_PER_RUN);
  assert.deepEqual(first, jobs.slice(0, COVERING_JOBS_PER_RUN));
  // 下一輪接著上一輪往後一段（不是每輪都重跑前 6 組）。
  const second = rotateCoveringJobs(jobs, { now: roundAt(1), intervalMs });
  assert.deepEqual(second, jobs.slice(COVERING_JOBS_PER_RUN, COVERING_JOBS_PER_RUN * 2));
  // 掃完全部的輪數後會回到開頭，且每一組都會被跑到。
  const windowCount = Math.ceil(jobs.length / COVERING_JOBS_PER_RUN);
  const seen = new Set();
  for (let round = 0; round < windowCount; round += 1) {
    for (const job of rotateCoveringJobs(jobs, { now: roundAt(round), intervalMs })) seen.add(job);
  }
  assert.equal(seen.size, jobs.length);
  assert.deepEqual(rotateCoveringJobs(jobs, { now: roundAt(0), intervalMs }), first);
  // 不超過上限時原樣回傳。
  assert.deepEqual(rotateCoveringJobs(["a", "b"], { now: roundAt(3), intervalMs }), ["a", "b"]);
});

