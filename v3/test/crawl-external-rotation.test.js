// 外站跨輪輪轉的尺規（2026-10-08）。
//
// 這一包要守住的是**一個政策**：外站不能再用寫死順序依序跑。
// 正式站實測（`settings.crawlScheduleV1.sourceStreaks`）：租租通／好房網 `fails=117`、
// `lastSuccessAt` 從未成功、`listings.last_seen_at` 停在 2026-09-22（15 天）；
// 住商則整批 `第 N 頁 [23]：The operation was aborted due to timeout`
// —— `[23]` 是 DOMException 的 TIMEOUT 碼，也就是**被我們自己的輪次取消訊號打死**，
// 不是對方擋人。六家寫死排在 591 後面，40 分鐘預算根本裝不下 5 家外站。
//
// 所以這裡驗四件事：
// 1. 排序看 `lastSuccessAt`（越久沒成功越前面），**不是**看 `lastFailureAt`／`fails`；
// 2. 延後（deferred）與失敗是分開的兩件事；
// 3. 冷卻期的家既不 running 也不 deferred；
// 4. `watcher.js` 真的接上輪轉、且舊的寫死呼叫不能再復活（結構釘法）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXTERNAL_SOURCES_PER_RUN_DEFAULT,
  externalSourceStaleness,
  externalSourcesPerRun,
  pickExternalSources,
  externalPhaseBudgetMs,
  rankExternalSources,
} from "../src/externalRotation.js";

const NOW = Date.parse("2026-10-08T01:00:00.000Z");
const TASKS = ["hbhousing", "sinyi", "houseprice", "ddroom", "housefun", "rakuya"]
  .map((id) => ({ id, label: id, enabled: true, invoke: () => [] }));

test("每輪排幾家：預設 1，可用環境變數調寬，但不會變成 0 或超出上限", () => {
  assert.equal(EXTERNAL_SOURCES_PER_RUN_DEFAULT, 1);
  assert.equal(externalSourcesPerRun({}), 1);
  assert.equal(externalSourcesPerRun({ CRAWL_EXTERNAL_SOURCES_PER_RUN: "3" }), 3);
  // 0 或負數會變成「一家都不排」⇒ 外站完全停擺，這種設定必須無效
  assert.equal(externalSourcesPerRun({ CRAWL_EXTERNAL_SOURCES_PER_RUN: "0" }), 1);
  assert.equal(externalSourcesPerRun({ CRAWL_EXTERNAL_SOURCES_PER_RUN: "-5" }), 1);
  // 超過來源數上限：避免「每輪都排 99 家」回到原本會爆預算的老路
  assert.equal(externalSourcesPerRun({ CRAWL_EXTERNAL_SOURCES_PER_RUN: "99" }), 6);
  assert.equal(externalSourcesPerRun({ CRAWL_EXTERNAL_SOURCES_PER_RUN: "abc" }), 1);
  assert.equal(externalSourcesPerRun(undefined), 1);
});

test("餓的排前面：從未排過 > 最久沒被排到 > 最近排過的（失敗也算排過）；同分維持目錄順序", () => {
  const streaks = {
    hbhousing: { lastSuccessAt: new Date(NOW - 2 * 3600_000).toISOString() },
    // 一直失敗，但剛剛才被排到 ⇒ 這一輪要讓位（lastFailureAt 就是「上次被排到」的證據）
    ddroom: { fails: 117, lastFailureAt: new Date(NOW - 60_000).toISOString(), lastSuccessAt: "" },
    sinyi: { lastSuccessAt: new Date(NOW - 30 * 24 * 3600_000).toISOString() },
    houseprice: { lastSuccessAt: new Date(NOW - 10 * 3600_000).toISOString() },
    housefun: {},
    rakuya: { lastSuccessAt: new Date(NOW - 5 * 3600_000).toISOString() },
  };
  const ids = rankExternalSources(TASKS, streaks, { now: NOW }).map((task) => task.id);
  assert.deepEqual(ids, ["housefun", "sinyi", "houseprice", "rakuya", "hbhousing", "ddroom"],
    "從未排過的先；其餘按上次被排到（成功／失敗取較大者）由舊到新；剛失敗過的退到最後");
  assert.equal(externalSourceStaleness({}, NOW), Number.POSITIVE_INFINITY, "沒有任何時間欄＝無限餓");
  assert.ok(Number.isFinite(externalSourceStaleness({ lastFailureAt: new Date(NOW - 3600_000).toISOString() }, NOW)));
});

// 沙盒實測抓到的設計錯誤（2026-10-08 連兩輪都只排到 hbhousing）：
// 用「最後成功時間」排序時，永遠抓不通的家永遠最餓 ⇒ 每輪都吃掉那個名額，
// 其他家照樣等死——跟改動前的寫死順序一樣糟，只是換了人質。
test("回歸：連續幾輪要輪到不同的家，永遠失敗的那家不能霸占每一輪", () => {
  const streaks = {};
  for (const task of TASKS) {
    streaks[task.id] = { fails: 0, lastError: "", lastFailureAt: "", lastSuccessAt: "", blockedUntil: "" };
  }
  // 六家都「從未排過」→ 同分，依目錄順序；之後每排一家就把它踢到最後。
  const chosen = [];
  for (let round = 0; round < 6; round += 1) {
    const at = NOW + round * 3600_000;
    const pick = pickExternalSources(TASKS, streaks, { perRun: 1, now: at });
    const id = pick.running[0].id;
    chosen.push(id);
    streaks[id] = { ...streaks[id], lastFailureAt: new Date(at).toISOString() };
  }
  assert.equal(new Set(chosen).size, chosen.length, `六輪應輪到六個不同的家，實際 ${chosen.join(",")}`);
  assert.deepEqual(chosen, ["hbhousing", "sinyi", "houseprice", "ddroom", "housefun", "rakuya"],
    "同分按目錄順序輪轉；排過（哪怕失敗）就排到最後，六輪剛好六家");
});

test("剛排過就要讓位：失敗次數多寡不給優先權，15 天沒被排到的家比較重要", () => {
  const streaks = {
    hbhousing: { fails: 117, lastFailureAt: new Date(NOW).toISOString(), lastSuccessAt: new Date(NOW - 2 * 3600_000).toISOString() },
    ddroom: { fails: 0, lastFailureAt: "", lastSuccessAt: new Date(NOW - 15 * 24 * 3600_000).toISOString() },
  };
  const ids = rankExternalSources(TASKS, streaks, { now: NOW }).map((task) => task.id);
  assert.ok(ids.indexOf("ddroom") < ids.indexOf("hbhousing"), "15 天沒成功要排在 2 小時前成功過的前面，不管失敗次數");
});

test("挑本輪要跑的：running／deferred 分開，冷卻期的家兩邊都不進", () => {
  const streaks = { hbhousing: { lastSuccessAt: new Date(NOW - 3600_000).toISOString() } };
  const cooling = new Set(["sinyi"]);
  const pick = pickExternalSources(TASKS, streaks, { perRun: 2, cooling, now: NOW });
  assert.equal(pick.running.length, 2);
  assert.deepEqual(pick.cooling.map((task) => task.id), ["sinyi"], "冷卻期要單獨列出來");
  assert.ok(!pick.running.some((task) => task.id === "sinyi"), "冷卻中的家不能被排進本輪");
  assert.ok(!pick.deferred.some((task) => task.id === "sinyi"), "冷卻中的家也不該出現在延後（延後＝下一輪還要它）");
  assert.deepEqual(
    [...pick.running, ...pick.deferred].map((task) => task.id).sort(),
    ["ddroom", "hbhousing", "housefun", "houseprice", "rakuya"],
    "除冷卻外，每輪都要在 running 或 deferred 之一，不能憑空消失",
  );
  // 上限要真的有效果：故意給 8 家的超長清單（以後多掛來源也不會一次全排），
  // 否則 `perRun: 99` 這種設定又會讓一輪塞滿外站，回到爆預算的老路。
  const EIGHT = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, label: `S${i}`, enabled: true, invoke: () => [] }));
  assert.equal(pickExternalSources(EIGHT, {}, { perRun: 99, now: NOW }).running.length, 6, "running 不能超過 EXTERNAL_SOURCES_PER_RUN_MAX");
  assert.equal(pickExternalSources(EIGHT, {}, { perRun: 99, now: NOW }).deferred.length, 2, "多出來的 2 家要進 deferred（延後，不是失敗）");
  assert.equal(pickExternalSources(EIGHT, {}, { perRun: 2, now: NOW }).running.length, 2, "perRun 小於上限時照 perRun");
  assert.equal(pickExternalSources(TASKS, {}, { perRun: 99, now: NOW }).running.length, 6);
  assert.equal(pickExternalSources([], {}, { now: NOW }).running.length, 0);
});

test("watcher.js 真的走輪轉，舊的寫死呼叫不能再復活", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/watcher.js", import.meta.url)), "utf8");
  assert.match(src, /import \{[^}]*pickExternalSources[^}]*externalPhaseBudgetMs[^}]*\} from "[^"]*externalRotation\.js";/, "watcher 要 import 輪轉與階段預算（少一個就是接線沒做完）");
  assert.match(src, /const externalRotation = pickExternalSources\(/);
  const runLoop = src.slice(src.indexOf("for (const task of externalRotation.running)"), src.indexOf("if (externalRotation.deferred.length)"));
  assert.ok(runLoop.length > 40 && runLoop.includes("await collectExternal(task.id, task.label, task.invoke, phaseMs);"),
    "排到的家要照順序跑，而且一定要帶上階段預算 phaseMs（少了它＝每家沒有上限，一家就能吃光整輪）");
  assert.ok(/const phaseMs = Number\(options\.externalPhaseBudgetMs\) > 0[\s\S]{0,220}externalPhaseBudgetMs\(\{ remainingMs, env: process\.env \}\)/.test(runLoop),
    "階段預算要取「注入值」與「本輪剩餘時間」兩者，測試才可以打 fake 時間");
  assert.ok(runLoop.includes("if (!phaseMs) {"), "不夠時間時要有整輪不碰外站的分支");
  // 舊寫死順序（六家各自一個 if ＋直接呼叫 fetchXCoveringListings）必須消失
  for (const id of ["hbhousing", "sinyi", "houseprice", "ddroom", "housefun"]) {
    assert.doesNotMatch(src, new RegExp(`if \\(want\\w+ && !cooling\\.has\\("${id}"\\)\\)`), `${id} 不該再被寫死排程`);
  }
  // 延後≠失敗：deferred 只能被記日誌，绝不能進 noteSourceRound／collectExternal
  const deferredBlock = src.slice(src.indexOf("if (externalRotation.deferred.length)"), src.indexOf("if (externalRotation.deferred.length)") + 620);
  assert.match(deferredBlock, /console\.log\(/);
  assert.doesNotMatch(deferredBlock, /noteSourceRound\(|collectExternal\(/, "延後的家不能被記成失敗輪（會累 fails、誤裝冷卻期）");
  // 六家都還是要有 invoke（少一家就是悄悄停擺）
  for (const id of ["hbhousing", "sinyi", "houseprice", "ddroom", "housefun", "rakuya"]) {
    assert.match(src, new RegExp(`id: "${id}"[\\s\\S]{0,260}?invoke:`), `${id} 要留在輪轉清單裡`);
  }
  // streaks 要真的被留下來當排序輸入（只拿它算 cooling 就會回到寫死順序）
  assert.match(src, /let sourceStreaks = \{\};[\s\S]{0,120}?sourceStreaks = streaks \|\| \{\};/);
});

// 政策的另一半在存儲層：延後的家這一輪「不出現在 rounds」，
// `applySourceRound` 必須原樣保留它的 streak（不歸零、也不累加 fails）。
// 少這條，輪轉就會被誤實成「連續失敗」而裝上冷卻期，整個改動适得其反。
test("延後的家在 rounds 缺席時，streak 原樣保留（不歸零、不累加 fails）", async () => {
  const { applySourceRound } = await import("../src/crawlSourceStreaks.js");
  const before = {
    ddroom: { fails: 117, lastError: "", lastAttemptAt: "", lastFailureAt: "2026-10-08T00:28:50.426Z", lastSuccessAt: "", blockedUntil: "" },
    hbhousing: { fails: 3, lastError: "x", lastAttemptAt: "", lastFailureAt: "2026-10-01T00:00:00.000Z", lastSuccessAt: "2026-10-08T00:00:00.000Z", blockedUntil: "" },
  };
  const at = "2026-10-08T01:00:00.000Z";
  const applied = applySourceRound(before, [{ source: "hbhousing", covered: 6, total: 6, errors: [] }], { at });
  assert.deepEqual(applied.streaks.ddroom, before.ddroom, "這一輪沒排到 ddroom，它的 streak 必須逐字不變");
  assert.equal(applied.streaks.hbhousing.lastSuccessAt, at, "有排到的才該更新");
});

// 2026-10-08 正式站實測：輪轉成「一輪一家」之後還是爆過預算（591 花 13 分鐘，
// 5168 一家花 27 分鐘且零落地，整輪 40 分鐘被砍）⇒ 每家要有「本輪剩餘時間」綁定的階段預算。
test("階段預算：綁在本輪剩餘時間上，留 2 分鐘收尾；不足 3 分鐘就整輪不碰外站", () => {
  const MIN = 60_000;
  assert.equal(externalPhaseBudgetMs({ remainingMs: 0 }) / MIN, 10, "沒有外層 context（手動跑一輪）⇒ 用上限 10 分");
  assert.equal(externalPhaseBudgetMs({ remainingMs: 30 * MIN }) / MIN, 10, "剩很多 ⇒ 還是上限 10 分，不是把整輪給一家");
  assert.equal(externalPhaseBudgetMs({ remainingMs: 8 * MIN }) / MIN, 6, "剩 8 分 ⇒ 扣掉 2 分鐘收尾 = 6 分");
  assert.equal(externalPhaseBudgetMs({ remainingMs: 2.5 * MIN }), 0, "剩不到 3 分鐘 ⇒ 0（這一輪別再跑外站）");
  assert.equal(externalPhaseBudgetMs({ remainingMs: -5 }) / MIN, 10, "負值是「拿不到 deadline」，不是「沒時間」");
  assert.equal(externalPhaseBudgetMs({ env: { CRAWL_EXTERNAL_PHASE_MAX_MINUTES: "3" } }) / MIN, 3);
  assert.equal(externalPhaseBudgetMs({ env: { CRAWL_EXTERNAL_PHASE_MAX_MINUTES: "99" } }) / MIN, 20, "上限要釘死，不然調成 99 分就等于沒有預算");
  assert.equal(externalPhaseBudgetMs({ env: { CRAWL_EXTERNAL_PHASE_MAX_MINUTES: "0" } }) / MIN, 3, "0 不合法，收斂到最小 3 分");
});

test("餓的定義要看 lastAttemptAt：剛被排過（哪怕是部分完成）就要讓位", () => {
  const at = Date.parse("2026-10-08T06:00:00.000Z");
  const justPartial = { lastAttemptAt: "2026-10-08T05:59:00.000Z", lastSuccessAt: "", lastFailureAt: "" };
  const neverTouched = {};
  assert.equal(Math.round(externalSourceStaleness(justPartial, at) / 1000), 60, "部分完成也算排過");
  assert.ok(externalSourceStaleness(neverTouched, at) > externalSourceStaleness(justPartial, at));
  const TWO = [{ id: "hbhousing", label: "hbhousing", enabled: true, invoke: () => [] },
    { id: "ddroom", label: "ddroom", enabled: true, invoke: () => [] }];
  const pick = pickExternalSources(TWO, {
    hbhousing: { lastAttemptAt: "2026-10-08T05:59:00.000Z", lastFailureAt: "2026-10-01T00:00:00.000Z" },
    ddroom: { lastAttemptAt: "2026-10-08T04:00:00.000Z" },
  }, { perRun: 1, now: at });
  assert.equal(pick.running[0].id, "ddroom", "ddroom 上次被排到比較久（连 hbhousing 有舊的 lastFailureAt 也不該贏）");
});

test("watcher 要真的把階段預算包進去，而且整輪取消時不可以被誤判成「只跑一半」", () => {
  const watcherSrc = readFileSync(new URL("../src/watcher.js", import.meta.url), "utf8");
  const src = watcherSrc;
  assert.match(src, /batches = phaseBudgetMs > 0\s*\n\s*\? await withBudget\(run, phaseBudgetMs,/, "外站階段要用巢状的 withBudget（context 是 AsyncLocalStorage，巢状才接得掉）");
  assert.match(src, /if \(isCrawlCancelled\(\)\) throw error;/, "catch 第一行要先讓「整輪取消」往上丟（AGENTS 第三條）");
  assert.match(src, /const partial = phaseTimedOut \|\| batches\.some/, "階段用盡要走 partial 語意＝不算失敗");
  assert.match(src, /if \(!phaseMs\) \{[\s\S]{0,320}?break;\s*\n\s*\}/, "不夠時間時這一家以後全部延後（不是硬跑也不是記失敗）");
  assert.match(src, /await collectExternal\(task\.id, task\.label, task\.invoke, phaseMs\);/);
  assert.match(src, /Number\(options\.externalPhaseBudgetMs\) > 0/, "要有測試用的注入點（不然離線測不到這條路）");
});
