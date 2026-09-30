// 抓取輪次的「跑得完」保證（2026-09-30，第九十一批）。
//
// 正式站的實際狀態（2026-09-27～09-30）：`crawl_covers.last_run_at` 全部凍結在 09-27 04:05、
// `lastCoveringAt` 也停在同一天，而 `crawlScheduleV1.attempts` 對同一組覆蓋條件累積到近 3000 次
// ——每一輪都在 15 分鐘預算被 `withBudget()` 放棄，完成紀錄（只在整輪結束時寫）永遠寫不進去，
// 於是「該抓了」永遠成立、下一輪又把同一批重跑一次。
//
// 這一包把「跑得完」拆成三個可驗證的性質：
//   1. 預算可用 `CRAWL_TICK_BUDGET_MINUTES` 調整（正式站一輪實測 25 分鐘上下）。
//   2. **逐批記錄完成**：每個批次落地後，只要它的來源全部成功就先記錄，整輪被放棄也不會白跑。
//   3. 排程器在「這一輪還在跑」時回報 busy，而不是重複印上一輪的逾時錯誤。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (file) => readFileSync(path.join(SRC, file), "utf8");

test("抓取預算可用 CRAWL_TICK_BUDGET_MINUTES 覆寫（預設仍是 15 分鐘）", () => {
  const run = (value) => {
    const env = { ...process.env };
    if (value === undefined) delete env.CRAWL_TICK_BUDGET_MINUTES;
    else env.CRAWL_TICK_BUDGET_MINUTES = value;
    return execFileSync(process.execPath, ["-e", `
      const m = await import(${JSON.stringify(path.join(SRC, "crawlWatchdog.js"))});
      console.log(m.TICK_BUDGET_MS);
    `], { encoding: "utf8", env }).trim();
  };
  assert.equal(run(undefined), String(15 * 60 * 1000), "預設不變");
  assert.equal(run("40"), String(40 * 60 * 1000));
  assert.equal(run("7"), String(7 * 60 * 1000));
  assert.equal(run("0"), String(15 * 60 * 1000), "0／負值／非數字都回預設");
  assert.equal(run("abc"), String(15 * 60 * 1000));
  assert.equal(run("-5"), String(15 * 60 * 1000));
});

test("watcher 逐批記錄完成：條件、位置與去重都對", () => {
  const src = read("watcher.js");
  // 判定必須在**收集階段結束之後、落地迴圈之前**算好（否則來源集合還沒收齊）。
  const successSet = src.indexOf("const successfulJobUrls = new Set(");
  const batchLoop = src.indexOf("for (const batch of collected) {");
  assert.ok(successSet > 0 && batchLoop > successSet, "successfulJobUrls 必須在落地迴圈之前算好");
  // 第九十二批：條件從「**每一個**啟用來源都成功」改成「每一個**還在嚴格的**來源都成功」；
  // 連續失敗達門檻的來源由 `sourcePolicy.tolerated` 放行（政策變更經 Owner 同意）。
  const policyAt = src.indexOf("const blockingSources = blockingCrawlSources(sourceSuccess, sourcePolicy.tolerated);");
  assert.ok(policyAt > 0 && policyAt < successSet, "容忍名單必須在 successfulJobUrls 之前算好");
  assert.match(src.slice(successSet, successSet + 200), /isCoveredJob\(job\)/,
    "逐批記錄要沿用同一組判定（不是另外再寫一次）");
  // 逐批記錄：在批次迴圈內、且帶 memberRequirements: []（不推遲會員）。
  const recordAt = src.indexOf("await completeCoveringPlan({ successfulJobs: [job], memberRequirements: [], at: nowIso() });");
  const loopEnd = src.indexOf("// Only advance after those pages have been stored successfully.");
  assert.ok(recordAt > batchLoop && recordAt < loopEnd, "逐批記錄必須在批次迴圈內");
  assert.match(src.slice(recordAt - 400, recordAt), /recordedCoverUrls\.has\(batch\.searchUrl\)/,
    "同一組覆蓋條件在同一輪只能記一次");
  // 整輪結束時的最終記錄仍然要在（帶 memberRequirements）。
  const finalCall = src.lastIndexOf("await completeCoveringPlan({");
  assert.ok(finalCall > recordAt, "最終記錄要留著");
  assert.match(src.slice(finalCall, finalCall + 260), /memberRequirements: plan\.memberRequirements/,
    "最終記錄要帶會員需求（推遲下一輪）");
});

test("排程器遇到「這一輪還在跑」回報 busy，不重印上一輪的逾時錯誤", () => {
  const src = read("server.js");
  const at = src.indexOf("async function tick(reason = \"schedule\")");
  assert.ok(at > 0, "找得到 tick()");
  const guard = src.slice(at, at + 700);
  assert.match(guard, /if \(!tickGate\.isStale\(\)\) \{/, "要有「還在跑」的分支");
  assert.match(guard, /skipped: "busy"/, "要回 busy");
  assert.match(guard, /busy_ms: tickGate\.ageMs\(\)/, "要帶這一輪已跑多久（診斷用）");
  // ⚠️ 這裡的 `\s*` 不能省：變異版把 `{` 與 `skipped` 之間換了行，收斂的字面比對會抓不到（實測漏殺）。
  assert.doesNotMatch(guard, /return lastRun \|\| \{\s*skipped: "busy"/, "不得再回上一輪的 lastRun（會重印逾時錯誤）");
});
