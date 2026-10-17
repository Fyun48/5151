// 補通勤路線迴圈的牆鐘預算／連續失敗上限（2026-10-17）。
//
// 背景：`queueGeoBackfill()` 的兩個 `for (round < 80)` 迴圈沒有時間上限，失敗時每輪再睡 1.5 秒
// ⇒ 單次背景 job 最壞 120 秒、最多 1600 筆路線計算，正式站與開發站都曾因此 OOM／斷線。
// 這裡只測「煞車」本身（純離線、假時鐘），不連資料庫、不對外抓取。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BUDGET_MS,
  MAX_BUDGET_MS,
  MIN_BUDGET_MS,
  createBackfillDeadline,
  resolveBackfillBudgetMs,
  runBackfillRounds,
} from "../src/backfillBudget.js";

const serverSrc = readFileSync(fileURLToPath(new URL("../src/server.js", import.meta.url)), "utf8");

test("ROUTE_BACKFILL_BUDGET_MS：預設 8 秒，非正數回預設，一律 clamp 在 1–30 秒", () => {
  assert.equal(DEFAULT_BUDGET_MS, 8_000);
  assert.equal(resolveBackfillBudgetMs({}), 8_000);
  assert.equal(resolveBackfillBudgetMs({ ROUTE_BACKFILL_BUDGET_MS: "" }), 8_000);
  assert.equal(resolveBackfillBudgetMs({ ROUTE_BACKFILL_BUDGET_MS: "abc" }), 8_000);
  assert.equal(resolveBackfillBudgetMs({ ROUTE_BACKFILL_BUDGET_MS: "-5" }), 8_000);
  assert.equal(resolveBackfillBudgetMs({ ROUTE_BACKFILL_BUDGET_MS: "500" }), MIN_BUDGET_MS);
  assert.equal(resolveBackfillBudgetMs({ ROUTE_BACKFILL_BUDGET_MS: "999999" }), MAX_BUDGET_MS);
  assert.equal(resolveBackfillBudgetMs({ ROUTE_BACKFILL_BUDGET_MS: "12000" }), 12_000);
});

test("(a) 預算用完就提前收手，並留一行 route-backfill-budget-exhausted", async () => {
  let clock = 0;
  const lines = [];
  const rounds = [];
  const deadline = createBackfillDeadline({ budgetMs: 8_000, now: () => clock });
  const stats = await runBackfillRounds(async () => {
    rounds.push(clock);
    clock += 4_000; // 每輪真的花 4 秒
    return { attempted: 20, located: 20, postIds: [], fingerprint: "" };
  }, {
    deadline,
    maxRounds: 80,
    label: "route-backfill",
    stage: "routes",
    log: (line) => lines.push(line),
  });

  assert.equal(rounds.length, 2, "兩輪（0ms、4000ms）之後就該到點，不該跑滿 80 輪");
  assert.equal(stats.rounds, 2);
  assert.equal(stats.stoppedBy, "budget");
  assert.equal(stats.elapsedMs, 8_000);
  assert.equal(stats.failures, 0);
  const out = lines.join("\n");
  assert.match(out, /route-backfill-budget-exhausted stage=routes rounds=2 elapsed_ms=8000 budget_ms=8000/);
  assert.match(out, /last_attempted=20/, "收手時要能看出上一輪還想補 20 筆（＝沒補完）");
});

test("(b) 連續失敗 3 次就停止重試：不再 sleep、不再跑滿 80 輪", async () => {
  const lines = [];
  let sleeps = 0;
  let calls = 0;
  const stats = await runBackfillRounds(async () => {
    calls += 1;
    const error = new Error("connect ETIMEDOUT 203.0.113.9:443");
    error.name = "TimeoutError";
    error.code = "ETIMEDOUT";
    throw error;
  }, {
    maxRounds: 80,
    maxConsecutiveFailures: 3,
    retrySleepMs: 1_500,
    label: "route-backfill",
    stage: "routes",
    log: (line) => lines.push(line),
    sleep: async () => { sleeps += 1; },
  });

  assert.equal(calls, 3, "第 3 次失敗就收手，不該繼續第 4 輪");
  assert.equal(stats.rounds, 3);
  assert.equal(stats.failures, 3);
  assert.equal(stats.stoppedBy, "failures");
  assert.equal(sleeps, 2, "只有前兩次失敗後睡；第三次失敗不再 sleep 1.5 秒");
  const out = lines.join("\n");
  assert.equal((out.match(/route-backfill-failed/g) || []).length, 3);
  assert.match(out, /route-backfill-failed stage=routes round=0 consecutive=1 name=TimeoutError code=ETIMEDOUT/);
  assert.match(out, /route-backfill-gave-up stage=routes failures=3 consecutive=3 rounds=3/);
});

test("(c) 正常情況（少量待補）行為不變：輪數、attempted／located 統計與物件形狀都照原樣", async () => {
  // 這就是 `backfillListingRoutes()` 的回傳形狀（`routeBackfill` 廣播用的欄位）。
  const firstResult = {
    attempted: 4,
    located: 3,
    listings: [{ post_id: 11 }, { post_id: 12 }],
    postIds: [11, 12],
    fingerprint: "25.03,121.52|scooter",
  };
  const seen = [];
  let calls = 0;
  const stats = await runBackfillRounds(async () => {
    calls += 1;
    return calls === 1 ? firstResult : { attempted: 0, located: 0, listings: [], postIds: [], fingerprint: "" };
  }, {
    deadline: createBackfillDeadline({ budgetMs: 8_000 }),
    maxRounds: 80,
    label: "route-backfill",
    stage: "routes",
    onResult: (result) => seen.push(result),
    shouldStop: (result) => !result?.attempted,
    log: (line) => { throw new Error(`正常情況不該有收手日誌：${line}`); },
  });

  assert.equal(calls, 2, "第一輪補完、第二輪 attempted=0 後正常收手");
  assert.equal(stats.stoppedBy, "idle");
  assert.equal(stats.failures, 0);
  assert.equal(stats.attempted, 4);
  assert.equal(stats.located, 3);
  assert.equal(seen[0], firstResult, "每一輪的結果要原樣傳給呼叫端（不能改形狀）");
  assert.deepEqual(Object.keys(firstResult), ["attempted", "located", "listings", "postIds", "fingerprint"]);
  assert.equal(firstResult.listings.length, 2);
  assert.deepEqual(firstResult.postIds, [11, 12]);
  assert.equal(firstResult.fingerprint, "25.03,121.52|scooter");
});

test("server.js 接線：四個迴圈都套用 runBackfillRounds，路線／座標共用單一截止時間、routeBackfill 廣播形狀不變", () => {
  assert.match(
    serverSrc,
    /import \{ createBackfillDeadline, resolveBackfillBudgetMs, runBackfillRounds \} from "\.\/backfillBudget\.js";/,
  );
  assert.equal(
    (serverSrc.match(/createBackfillDeadline\(/g) || []).length,
    1,
    "路線與座標迴圈必須共用同一個截止時間（不是各給一份預算）",
  );
  assert.equal(
    (serverSrc.match(/runBackfillRounds\(/g) || []).length,
    4,
    "補路線／補定位（牆鐘預算）與補地址／補捷運（失敗上限）四個迴圈都要套用",
  );
  for (const stage of ["routes", "coords", "address", "mrt"]) {
    assert.match(serverSrc, new RegExp(`stage: "${stage}"`), `缺 stage=${stage} 的接線`);
  }
  // 只有前兩個（路線／座標）帶 deadline；地址／捷運沿用原語意，只加失敗上限。
  assert.equal(
    (serverSrc.match(/deadline: commuteBackfillDeadline/g) || []).length,
    2,
    "地址／捷運迴圈不該有牆鐘預算（只加失敗上限）",
  );
  assert.match(serverSrc, /maxRounds: 40/);
  assert.match(serverSrc, /maxRounds: 80/);
  assert.match(serverSrc, /broadcast\(\{ type: "geo", routeBackfill: routes \}\)/);
  assert.match(serverSrc, /if \(commuteBackfillDeadline\.expired\(\)\) \{/);
});

test("(d) 補捷運迴圈：label=backfill／stage=mrt 連續失敗 3 次就停，日誌可 grep", async () => {
  const lines = [];
  let sleeps = 0;
  let calls = 0;
  const stats = await runBackfillRounds(async () => {
    calls += 1;
    const error = new Error("canceling statement due to statement timeout");
    error.code = "57014";
    throw error;
  }, {
    maxRounds: 80,
    label: "backfill",
    stage: "mrt",
    log: (line) => lines.push(line),
    sleep: async () => { sleeps += 1; },
  });
  assert.equal(calls, 3);
  assert.equal(stats.stoppedBy, "failures");
  assert.equal(stats.failures, 3);
  assert.equal(sleeps, 2);
  const out = lines.join("\n");
  assert.match(out, /backfill-failed stage=mrt round=0 consecutive=1 .*code=57014/);
  assert.match(out, /backfill-gave-up stage=mrt failures=3 consecutive=3 rounds=3/);
});

test("(e) 補地址迴圈：正常情況（attempted>0 → attempted=0）行為不變、沒有收手日誌", async () => {
  let calls = 0;
  const seen = [];
  const stats = await runBackfillRounds(async () => {
    calls += 1;
    return calls === 1
      ? { attempted: 12, located: 5 }
      : { attempted: 0, located: 0 };
  }, {
    maxRounds: 40,
    label: "backfill",
    stage: "address",
    onResult: (result) => seen.push(result),
    shouldStop: (result) => !result?.attempted,
    log: (line) => { throw new Error(`正常情況不該有收手日誌：${line}`); },
  });
  assert.equal(calls, 2);
  assert.equal(stats.stoppedBy, "idle");
  assert.equal(stats.failures, 0);
  assert.equal(stats.attempted, 12);
  assert.equal(stats.located, 5);
  assert.equal(seen[0].located, 5);
  assert.deepEqual(seen[1], { attempted: 0, located: 0 });
});
