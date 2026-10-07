// listing_enrich 時鐘（2026-10-07）的離線尺規。
// 意圖：這支佇列原本只靠事件 kick，所以「加了時鐘」這件事本身要釘住四點：
//   ① 預設值要禮貌（每輪 4 筆、30 秒），誤設成掃射來源的数字要夾住；
//   ② 空轉要退避、上一輪沒結束不准疊加、失敗不能把時鐘弄死；
//   ③ 註冊點必須在 startWorkerLoops() 內（roleRunsWorker 才跑得到，web 節點永遠不會起時鐘）；
//   ④ 時鐘要走**同一條** worker（wakeListingEnrichWorker），不能另開第二條跟事件 kick 搶 claim。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichClockConfig, startListingEnrichClock, ENRICH_CLOCK_DEFAULTS } from "../src/listingEnrichClock.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("config：預設禮貌、可關、亂設要夾住", () => {
  const d = enrichClockConfig({});
  assert.equal(d.enabled, true, "預設啟用（Owner 2026-10-07 決定：資料要開始變新）");
  assert.equal(d.intervalMs, 30_000);
  assert.equal(d.tickLimit, 4, "每輪筆數要與事件版同量級，不是一次放幾百筆去壓來源");
  assert.equal(ENRICH_CLOCK_DEFAULTS.idleTicksBeforeBackoff, 3);

  assert.equal(enrichClockConfig({ LISTING_ENRICH_CLOCK: "0" }).enabled, false, "要留一條不用重 deploy 就能關的路");

  const wild = enrichClockConfig({ LISTING_ENRICH_INTERVAL_MS: "1", LISTING_ENRICH_TICK_LIMIT: "5000" });
  assert.equal(wild.intervalMs, 5_000, "間隔下限 5 秒（夾住）");
  assert.equal(wild.tickLimit, 12, "每輪上限 12 筆（夾住）：這數字直接決定打外部站台的頻率");

  const junk = enrichClockConfig({ LISTING_ENRICH_INTERVAL_MS: "abc", LISTING_ENRICH_TICK_LIMIT: "-2" });
  assert.equal(junk.intervalMs, 30_000, "非數字要回預設，不能留 NaN 給 setInterval");
  assert.equal(junk.tickLimit, 4);
});

function fakeTimer() {
  const fns = [];
  return {
    fns,
    setIntervalImpl: (fn) => { fns.push(fn); return { id: fns.length, unref() {} }; },
    clearIntervalImpl: () => { fns.length = 0; },
    fire(i = 0) { if (fns[i]) fns[i](); },
  };
}

test("時鐘：上一輪還沒結束就不疊加（重入保護）", async () => {
  const t = fakeTimer();
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const clock = startListingEnrichClock(() => { calls += 1; return gate.then(() => 1); }, {}, {
    setIntervalImpl: t.setIntervalImpl, clearIntervalImpl: t.clearIntervalImpl, log() {},
  });
  t.fire();
  t.fire();
  t.fire();
  assert.equal(calls, 1, "in-flight 時後面的 tick 要直接跳過，不能疊成幾十條並行");
  assert.equal(clock.isRunning(), true);
  release();
  await gate;
  await new Promise((r) => setImmediate(r));   // finish() 是掛在 then 上的，要排一次巨工作
  assert.equal(clock.isRunning(), false);
  clock.stop();
});

test("時鐘：空轉要退避、有工作就歸零", () => {
  const t = fakeTimer();
  let n = 0;
  const clock = startListingEnrichClock(() => n, {}, {
    setIntervalImpl: t.setIntervalImpl, clearIntervalImpl: t.clearIntervalImpl, log() {},
  });
  for (let i = 0; i < 6; i += 1) { n = 0; t.fire(); }
  assert.ok(clock.idleTicks() >= 3, `連續空轉要累計（現在 ${clock.idleTicks()}）`);
  n = 5;
  // 退避中只會在每第 4 個 tick 真的跑一次，所以要連按到那一次（這是設計，不是 bug）。
  for (let k = 0; k < 4 && clock.idleTicks() > 0; k += 1) t.fire();
  assert.equal(clock.idleTicks(), 0, "一旦真的處理到東西，idle 計數要歸零（恢復正常節奏）");
  clock.stop();
});

test("時鐘：失敗要吞掉並繼續活著，不能讓 interval 炸掉整個 worker", () => {
  const t = fakeTimer();
  const fails = [];
  const clock = startListingEnrichClock(() => { throw new Error("boom"); }, {}, {
    setIntervalImpl: t.setIntervalImpl, clearIntervalImpl: t.clearIntervalImpl,
    log() {}, fail: (e) => fails.push(e.message),
  });
  t.fire();
  assert.deepEqual(fails, ["boom"]);
  assert.equal(clock.isRunning(), false, "失敗後要釋放 running，下一輪照跑");
  assert.equal(clock.idleTicks(), 0, "失敗不算空轉（不要把來源出錯退成慢節奏）");
  clock.stop();
});

test("時鐘：reject 的 Promise 也要被接住", async () => {
  const t = fakeTimer();
  const fails = [];
  const clock = startListingEnrichClock(() => Promise.reject(new Error("nope")), {}, {
    setIntervalImpl: t.setIntervalImpl, clearIntervalImpl: t.clearIntervalImpl,
    log() {}, fail: (e) => fails.push(e.message),
  });
  t.fire();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fails, ["nope"]);
  assert.equal(clock.isRunning(), false);
  clock.stop();
});

test("server.js 接線：註冊點在 startWorkerLoops 內、走同一條 worker、有 kill switch", () => {
  const s = read("v3/src/server.js");
  const start = s.indexOf("function startWorkerLoops() {");
  assert.ok(start > 0, "startWorkerLoops 要在");
  const body = s.slice(start, s.indexOf("\n}", start));
  assert.match(body, /enrichClockConfig\(process\.env\)/, "時鐘要在 worker 角色的迴圈裡起（web 節點不准起）");
  // 「只 import 沒註冊」與「用 if (false) 包起來」都算沒上線，所以要釘守衛與註冊相鄰。
  assert.match(body, /if \(enrichClock\.enabled\) \{\s*\n\s*startListingEnrichClock\(/,
    "註冊要在 enabled 守衛裡面（且守衛真的是 enrichClock.enabled）");
  assert.doesNotMatch(body, /if \(false\)/, "不准用常數false 把註冊變裝飾");
  assert.match(body, /await kickListingEnrich\(\{ limit: tickLimit, stats \}\)/, "要走同一條 kickListingEnrich（不得另開第二條 worker）");
  assert.match(body, /LISTING_ENRICH_CLOCK=0/, "啟動 log 要把關掉的方法講清楚");

  const i = s.indexOf("function kickListingEnrich(");
  const fn = s.slice(i, s.indexOf("\n}", i));
  assert.match(fn, /^function kickListingEnrich\(\{ limit = 4, stats = null \} = \{\}\)/, "參數要預設安全：舊呼叫完全不變");
  assert.match(fn, /wakeListingEnrichWorker\(/, "serialize 靠它，不能繞過");
  assert.match(fn, /if \(stats\) stats\.attempted \+= Number\(result\?\.attempted\) \|\| 0/, "計數要用 Number 守 NaN");
  assert.match(fn, /\{ limit \}/, "batch 要吃傳進來的 limit，不是寫死 4");

  const mod = read("v3/src/listingEnrichClock.js");
  assert.equal((mod.match(/setInterval\(/g) || []).length, 1, "只准一处起 interval");
  assert.match(mod, /unref/, "時鐘不該讓程序無法退出");
});
