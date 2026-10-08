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

test("餓的排前面：從未成功 > 最久沒成功 > 最近有成功；同分維持目錄順序", () => {
  const streaks = {
    hbhousing: { lastSuccessAt: new Date(NOW - 2 * 3600_000).toISOString() },
    // 沒有任何 lastSuccessAt ⇒ 从未成功，視為無限舊（這正是租租通／好房網的實況）
    ddroom: { fails: 117, lastFailureAt: new Date(NOW - 60_000).toISOString(), lastSuccessAt: "" },
    sinyi: { lastSuccessAt: new Date(NOW - 30 * 24 * 3600_000).toISOString() },
    houseprice: { lastSuccessAt: new Date(NOW - 10 * 3600_000).toISOString() },
    housefun: {},
    rakuya: { lastSuccessAt: new Date(NOW - 5 * 3600_000).toISOString() },
  };
  const ids = rankExternalSources(TASKS, streaks, { now: NOW }).map((task) => task.id);
  assert.deepEqual(ids.slice(0, 2), ["ddroom", "housefun"], "從未成功的兩家要排最前，且兩者同分時按目錄順序");
  assert.deepEqual(ids.slice(2), ["sinyi", "houseprice", "rakuya", "hbhousing"], "其餘依最後成功時間由舊到新");
  assert.ok(Number.isFinite(externalSourceStaleness({ lastSuccessAt: new Date(NOW - 3600_000).toISOString() }, NOW)));
});

test("排序只看最後成功時間：失敗很多次但剛成功過的，要排在很久沒成功的後面", () => {
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
  assert.match(src, /import \{ pickExternalSources, externalSourcesPerRun \} from "\.\/externalRotation\.js";/);
  assert.match(src, /const externalRotation = pickExternalSources\(/);
  assert.match(src, /for \(const task of externalRotation\.running\) \{\s*\n\s*await collectExternal\(task\.id, task\.label, task\.invoke\);/);
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
