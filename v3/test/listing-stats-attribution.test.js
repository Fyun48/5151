// `stats;dur` 的**歸因**契約（2026-10-12）。
//
// 為什麼要有這一條：`statsPrepareMs` 一直把 **list 側的前置工作**（`prepareOnePassScan()` 裡的
// `prepareListScope()`：行政區閉包、種子述詞）也包在同一個量測窗，於是
// `stats_ms = statsPrepareMs + (now − statsStarted)` 報出來的「stats 2.1s」有一部分不是 stats
// 自己的成本（教訓 L-0731／L-0859）。優化照著這個數字打，會一直打錯地方。
//
// 這一包只做**歸因**，不動任何查詢、篩選語意或回傳結構：
//   ① 新 stage `list_prepare_ms` 讓 list 側前置**現身**（同 `scan_ms` 的形狀：只新增鍵）。
//      ⚠️ stage 名 → `Server-Timing` metric 名的對照表住在 `listingStageTiming.js`。那個檔屬於
//      另一包（閉包持久化）的範圍，本包**不得改** ⇒ 本包把新階段曝在
//      `timing.stats_stages.list_prepare_ms`（就是窗口量測腳本讀的那一層，教訓 L-0859 要求
//      「一律同時印 timing.stats_stages」）。header 目前不會多出 `list_prepare;dur`。
//   ② `stats_ms` 只含 stats 自己的工作（不再含 `prepareListScope()`）。
//   ③ `list;dur`（＝`query_ms`）把 `list_prepare_ms` 收進去 ⇒ **沒有任何時間消失**，
//      改動前後的 `stats_ms + query_ms` 逐字相同（下面用注入的假時序證明，不靠真 DB 噪音）。
//   ④ 既有 stage 名稱的契約不變（前端與既有量測腳本讀得到同一組 key）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attributeListingTiming } from "../src/listingSearchPage.js";
import { buildListingServerTimingHeader, listingStageMetrics } from "../src/listingStageTiming.js";

const SOURCE = readFileSync(new URL("../src/listingSearchPage.js", import.meta.url), "utf8");

// 既有量測腳本（/tmp/ab2.mjs）與前端讀的就是這一組名字；對照表在 listingStageTiming.js，
// 本包**不得動**它 ⇒ 這一條就是「名字有沒有變」的守門。
const EXISTING_METRIC_NAMES = Object.freeze([
  "list", "stats", "scan", "stats_cand", "stats_count", "stats_provider", "prepare", "cand", "filter", "rows",
]);

/** `Server-Timing` header → Map。若同一個名稱出現兩次，取**較長**的那一個（`list_prepare` 前綴含 `list`）。 */
function headerMap(header) {
  const map = new Map();
  for (const part of String(header).split(", ")) {
    const [name, dur] = part.trim().split(";dur=");
    if (name && !map.has(name)) map.set(name, Number(dur));
  }
  return map;
}

test("(a) 新 stage `list_prepare_ms` 現身，且不擾動任何既有 metric 的數字", () => {
  assert.ok(typeof attributeListingTiming === "function", "attributeListingTiming 必須是可注入時序的純函式");
  const base = {
    query_ms: 900, stats_ms: 400, stages: { sql_ms: 500 },
    stats_stages: { inputs_ms: 300, scan_ms: 250, status_ms: 5, candidates_ms: 7 },
  };
  const before = headerMap(buildListingServerTimingHeader(base));
  const after = headerMap(buildListingServerTimingHeader({
    ...base,
    // 拆乾淨之後 `prepareListScope()`（list 側前置）以獨立鍵現身。
    stats_stages: { ...base.stats_stages, list_prepare_ms: 173 },
  }));
  // 新階段是**名為 `list_prepare_ms` 的新鍵**，不是把既有鍵改名：既有 metric 一個都不能動。
  for (const [name, dur] of before) {
    assert.equal(after.get(name), dur, `既有度量 \`${name};dur\` 不得因為新階段而改變`);
  }
  assert.equal(after.get("stats"), 400, "stats;dur 仍是 stats_ms 那格（不因新階段改變）");
  assert.equal(after.get("list"), 900, "list;dur 仍是 query_ms 那格（不因新階段改變）");
  // 缺鍵／非數值時不得現身（跟 scan_ms 同一條規矩：缺鍵比寫 0 誠實）。
  const withoutKey = headerMap(buildListingServerTimingHeader({
    ...base, stats_stages: { ...base.stats_stages, list_prepare_ms: null },
  }));
  assert.equal([...withoutKey.keys()].length, [...before.keys()].length, "list_prepare_ms 為 null 時不得多出度量");
  // 真正的新鍵：量測腳本讀 payload 的 `timing.stats_stages.list_prepare_ms`。
  assert.match(SOURCE, /statsArgs\.diagnostics\.list_prepare_ms\s*=\s*Math\.round\(listPrepareMs\)/,
    "新階段必須以 `list_prepare_ms` 這個新鍵寫進 stats_stages");
});

test("(b) `stats_ms` 不再包含 prepareListScope 的時間（注入假時序，不靠真 DB）", () => {
  // 假時序（單位 ms）：舊口徑的準備窗 `statsPrepareMs`＝1000，其中 400 是 list 側前置
  // `prepareListScope()`（＝假裝它是慢的，才看得出有沒有被扣掉）；stats 自己的收尾 200；
  // list 管線（含查詢）7000。舊口徑 stats_ms＝1000＋200＝1200（把 400 算進 stats）。
  const timing = attributeListingTiming({
    statsPrepareMs: 1000, listPrepareMs: 400, statsElapsedMs: 200, listElapsedMs: 7000,
  });
  assert.equal(timing.statsMs, 800, `拆乾淨後 stats 只有自己：(1000−400)＋200＝800（得到 ${timing.statsMs}）`);
  assert.equal(timing.queryMs, 7400, `list;dur 收下 list 側前置：7000＋400＝7400（得到 ${timing.queryMs}）`);
  assert.equal(timing.statsMs + timing.queryMs, 8200, "兩者相加＝舊口徑 1200＋6800＝8000？⇒ 必須逐字相同");
  // 反向紅線①：舊口徑的 stats_ms（1200）不可以再出現；差值必須**恰好**是 list 側前置 400ms。
  const oldStatsMs = 1000 + 200;
  assert.equal(oldStatsMs - timing.statsMs, 400, "扣掉的量必須恰好是 list 側前置，不能是別的");
  // 反向紅線②：總帳不變（舊口徑的 query_ms＝7000、stats_ms＝1200）。
  assert.equal((1000 + 200) + 7000, timing.statsMs + timing.queryMs, "改動前後 stats_ms + query_ms 必須逐字相同");
});

test("(b2) 來源護欄：`list_prepare_ms` 只能寫進新鍵、stats 的算式必須顯式扣掉它", () => {
  const fn = SOURCE.slice(SOURCE.indexOf("export function attributeListingTiming"));
  assert.ok(fn.startsWith("export function attributeListingTiming"), "attributeListingTiming 必須存在於來源");
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  assert.match(body, /numOr\(statsPrepareMs\)\s*-\s*listPrepare/, "stats 的算式必須顯式扣除 list 側前置");
  assert.match(body, /numOr\(listElapsedMs\)\s*\+\s*listPrepare/, "list（query_ms）必須把 list 側前置收進去");
  const statsMsLine = SOURCE.split("\n").find((line) => line.includes("stats_ms:"));
  assert.equal(statsMsLine.includes("scan"), false, "stats_ms 的算式不得引用 scan_ms");
  const queryMsLine = SOURCE.split("\n").find((line) => line.includes("query_ms:"));
  assert.equal(queryMsLine.includes("scan"), false, "query_ms（list;dur）的算式不得引用 scan_ms");
  // list 側前置只准以新鍵落地，不得改寫既有鍵的名字。
  assert.match(SOURCE, /statsArgs\.diagnostics\.list_prepare_ms\s*=\s*Math\.round\(/, "list_prepare_ms 必須是整數毫秒的新鍵");
  assert.equal(/statsArgs\.diagnostics\.(?!list_prepare_ms|scan_ms)\w*(prepare|list)\w*\s*=/.test(SOURCE), false,
    "不得再新增其他前置鍵改寫既有口徑");
});

test("(c) 既有 stage 名稱契約不變：同一組 metric 名與 stats_stages 鍵都還讀得到", () => {
  const names = listingStageMetrics({
    query_ms: 1, stats_ms: 1,
    stages: { prepare_ms: 1, sql_ms: 1, profile_ms: 1, relations_ms: 1, display_ms: 1, sort_ms: 1 },
    stats_stages: { status_ms: 1, district_ms: 1, candidates_ms: 1, auxiliary_ms: 1, provider_ms: 1, profile_sync_ms: 1, reduce_ms: 1, scan_ms: 1 },
  }).map((metric) => metric.name);
  for (const name of EXISTING_METRIC_NAMES) {
    assert.ok(names.includes(name), `既有度量 \`${name};dur\` 必須還在（前端與既有量測腳本靠它）`);
  }
  // payload 的既有 stage 鍵（窗口量測腳本讀 `timing.stats_stages`）不得被改名：本包只准**多**一個
  // `list_prepare_ms`，其餘逐字不變（`inputs_ms`＝stats_prepare;dur、`scan_ms`＝scan;dur）。
  const stageKeys = Object.keys({ inputs_ms: 1, scan_ms: 1, list_prepare_ms: 1, status_ms: 1 });
  for (const key of ["inputs_ms", "scan_ms", "list_prepare_ms"]) {
    assert.ok(stageKeys.includes(key), `stats_stages.${key} 必須是量測腳本讀得到的鍵`);
  }
});

test("(d) 沒有 list 側前置時（兩趟路徑／非 PG），算式與舊口徑逐字相同", () => {
  const timing = attributeListingTiming({ statsPrepareMs: 1000, listElapsedMs: 6000, statsElapsedMs: 200 });
  assert.equal(timing.statsMs, 1200, "listPrepareMs 缺席時，stats_ms 必須與舊算式逐字相同");
  assert.equal(timing.queryMs, 6000, "listPrepareMs 缺席時，query_ms 必須與舊算式逐字相同");
  // 負值／非數值不得讓 header 說謊：一律夾成 0 或忽略。
  assert.equal(attributeListingTiming({ statsPrepareMs: 10, listPrepareMs: -5, statsElapsedMs: 0, listElapsedMs: 0 }).statsMs, 10);
  assert.equal(attributeListingTiming({ statsPrepareMs: 10, listPrepareMs: "x", statsElapsedMs: 0, listElapsedMs: 0 }).queryMs, 0);
});
