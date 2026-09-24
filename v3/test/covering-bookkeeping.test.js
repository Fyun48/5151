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
} = await import("../src/coveringBookkeepingAsync.js");

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
