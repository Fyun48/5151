// 「階段取樣診斷」契約測試（裁決 §4.1 P4）。
//
// 要固定的三件事：
//   1. 各階段（prepare／cand／filter／rows／stats_cand…）會被鏡射成 `Server-Timing` 度量。
//   2. `list;dur` 與 `stats;dur` 的數字與語意**不變**（量測腳本靠它們）。
//   3. 新欄位**只進 header**：JSON payload 的鍵集合與內容逐字不變。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import { buildListingServerTimingHeader, listingStageMetrics } from "../src/listingStageTiming.js";

const TIMING = Object.freeze({
  query_ms: 1234,
  stats_ms: 567,
  total_ms: 1900,
  dataset: 977,
  stages: Object.freeze({
    prepare_ms: 10, sql_ms: 20, preload_ms: 30, profile_ms: 40, relations_ms: 50,
    display_ms: 60, sort_ms: 70, preload_page_ms: 80, hydrate_ms: 90,
    candidates: 11928, engine: "node_pg", asOf: "2026-10-11T00:00:00.000Z",
  }),
  stats_stages: Object.freeze({
    status_ms: 21, district_ms: 30, candidates_ms: 518, normalize_ms: 1, auxiliary_ms: 35,
    provider_ms: 191, profile_sync_ms: 204, count_sync_ms: 24, reduce_ms: 249,
    driver: "postgres", candidates: 12712,
    // 2026-10-12 新增的**獨立**階段：共趟掃描（先前只以「總和」的形式躲在 stats_ms 裡）。
    scan_ms: 173,
  }),
});

function headerMap(header) {
  return new Map(String(header).split(",").map(part => {
    const [name, dur] = part.trim().split(";dur=");
    return [name, Number(dur)];
  }));
}

test("Server-Timing 逐階段度量：既有總量不變、新階段是各子階段的和", () => {
  const map = headerMap(buildListingServerTimingHeader(TIMING));
  // 1. 既有度量語意不變
  assert.equal(map.get("list"), 1234);
  assert.equal(map.get("stats"), 567);
  // 2. 新階段度量確實來自 queryDetails／stats_stages
  assert.equal(map.get("prepare"), 10);
  assert.equal(map.get("cand"), 20);
  assert.equal(map.get("filter"), 40 + 50 + 60);
  assert.equal(map.get("rows"), 30 + 70 + 80 + 90);
  assert.equal(map.get("stats_cand"), 21 + 30 + 518 + 1 + 35);
  assert.equal(map.get("stats_provider"), 191);
  assert.equal(map.get("stats_count"), 204 + 24 + 249);
  // 3. 2026-10-12 新增鍵：`scan;dur` 直接鏡射 `stats_stages.scan_ms`（不從任何既有度量扣除）。
  assert.equal(map.get("scan"), 173);
});

test("新增 scan;dur 不得改變既有度量：stats_cand 不含 scan_ms、stats_ms 仍是原本那個數字", () => {
  const withScan = Object.freeze({
    query_ms: 1000, stats_ms: 500, total_ms: 1600,
    stages: Object.freeze({ sql_ms: 20 }),
    stats_stages: Object.freeze({ status_ms: 10, candidates_ms: 90, scan_ms: 300 }),
  });
  const withoutScan = Object.freeze({
    ...withScan,
    stats_stages: Object.freeze({ status_ms: 10, candidates_ms: 90 }),
  });
  const a = headerMap(buildListingServerTimingHeader(withScan));
  const b = headerMap(buildListingServerTimingHeader(withoutScan));
  // `scan_ms` 只能多出 `scan;dur` 一個頭；其他每一個度量的數字逐字不變。
  const extra = [...a.keys()].filter((name) => !b.has(name));
  assert.deepEqual(extra, ["scan"], "唯一新增的度量就是 scan");
  for (const [name, dur] of b) assert.equal(a.get(name), dur, `${name};dur 不得因為新增 scan 而改變`);
  assert.equal(a.get("stats"), 500, "stats;dur 仍是 stats_ms（不扣除掃描）");
  assert.equal(a.get("stats_cand"), 100, "scan_ms 不得被併進 stats_cand");
  assert.equal(a.get("list"), 1000);
});

test("scan_ms 缺席時不得輸出 scan;dur（未知／缺少的階段一律略過）", () => {
  const map = headerMap(buildListingServerTimingHeader({
    query_ms: 5, stats_ms: 3, stats_stages: { candidates_ms: 1, scan_ms: null },
  }));
  assert.equal(map.has("scan"), false);
  assert.doesNotMatch(buildListingServerTimingHeader({ stats_stages: { scan_ms: "" } }), /scan/);
});

test("來源護欄：共趟掃描只以新增鍵掃進 stats_stages，stats_ms 的算式與數字不得動", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/listingSearchPage.js", import.meta.url), "utf8");
  // 新增：只把 runScopeScan 的耗時寫進**新鍵** scan_ms。
  assert.match(page, /statsArgs\.diagnostics\.scan_ms = Math\.round\(performance\.now\(\) - scanStarted\)/);
  // 既有語意與數字不變：stats_ms 仍是 `statsPrepareMs + (now - statsStarted)`，
  // 而且 scan_ms 不得出現在這個算式裡（不得從 stats;dur 扣除掃描）。
  const statsMsLine = page.split("\n").find((line) => line.includes("stats_ms:"));
  assert.match(statsMsLine, /stats_ms:statsPrepareMs\+performance\.now\(\)-statsStarted/);
  assert.equal(statsMsLine.includes("scan"), false, "stats_ms 的算式不得引用 scan_ms");
  const queryMsLine = page.split("\n").find((line) => line.includes("query_ms:"));
  assert.equal(queryMsLine.includes("scan"), false, "query_ms（list;dur）的算式不得引用 scan_ms");
});

test("缺欄位／非數值一律略過，不得輸出 NaN", () => {
  const header = buildListingServerTimingHeader({
    query_ms: 5, stats_ms: undefined,
    stages: { sql_ms: null, profile_ms: "x" }, stats_stages: {},
  });
  assert.equal(header, "list;dur=5");
  assert.doesNotMatch(header, /NaN|undefined|null/);
  const names = listingStageMetrics({ query_ms: 5, stages: { sql_ms: null }, stats_stages: {} }).map(m => m.name);
  assert.deepEqual(names, ["list"]);
});

test("完全沒有度量時回傳空字串（呼叫端不設標頭）", () => {
  assert.equal(buildListingServerTimingHeader({}), "");
  assert.equal(buildListingServerTimingHeader(undefined), "");
});

// 輸出契約（2026-10-11 第二刀新增）：payload 的欄位集合是**逐字固定**的常數，不是
// 「跟輸入物件比」的循環論證。`timing` 與其下的階段欄位屬於 #714 既有的診斷契約，
// 不得因為新增階段取樣而多一個鍵；階段計時**只能**出現在這裡（或 header），
// 不得被複製到 payload 的頂層／`stats`／`listings`。
const EXPECTED_PAYLOAD_KEYS = Object.freeze(["hasMore", "listings", "nextCursor", "nextOffset", "queryVersion", "stats", "timing"]);
const EXPECTED_TIMING_KEYS = Object.freeze(["dataset", "query_ms", "stages", "stats_ms", "stats_stages", "total_ms"]);

test("輸出契約：payload／timing 欄位集合是固定常數", () => {
  assert.deepEqual([...EXPECTED_PAYLOAD_KEYS].sort(), ["hasMore", "listings", "nextCursor", "nextOffset", "queryVersion", "stats", "timing"]);
  assert.deepEqual([...EXPECTED_TIMING_KEYS].sort(), ["dataset", "query_ms", "stages", "stats_ms", "stats_stages", "total_ms"]);
});

// HTTP 層：header 有階段、body 逐字不變（鍵集合與序列化內容都不含新度量）。
test("新欄位只進 header：JSON payload 不出現任何 Server-Timing 度量鍵", async () => {
  const page = Object.freeze({
    stats: Object.freeze({ total: 1 }),
    listings: Object.freeze([]),
    hasMore: false,
    nextOffset: 0,
    nextCursor: null,
    queryVersion: 2,
    timing: TIMING,
  });
  const pageKeys = Object.keys(page).sort();
  const timingKeys = Object.keys(page.timing).sort();
  const app = express();
  app.get("/api/listings", (_req, res) => {
    res.setHeader("Server-Timing", buildListingServerTimingHeader(page.timing));
    res.json(page);
  });
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/listings`);
    const header = response.headers.get("Server-Timing");
    assert.ok(header.includes("cand;dur="), "header 應帶階段度量");
    assert.ok(header.includes("filter;dur="), "header 應帶階段度量");
    assert.ok(header.includes("rows;dur="), "header 應帶階段度量");
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), pageKeys, "payload 頂層鍵集合不變");
    assert.deepEqual(Object.keys(body.timing).sort(), timingKeys, "payload timing 鍵集合不變");
    // 對照固定常數（前面那兩行是「與輸入同構」，這裡才是真正的契約）。
    assert.deepEqual(Object.keys(body).sort(), [...EXPECTED_PAYLOAD_KEYS].sort(), "payload 頂層欄位集合必須逐字不變");
    assert.deepEqual(Object.keys(body.timing).sort(), [...EXPECTED_TIMING_KEYS].sort(), "timing 欄位集合必須逐字不變");
    assert.deepEqual(Object.keys(body.timing.stages).sort(), Object.keys(TIMING.stages).sort());
    // 度量名（cand/filter/rows）不得出現在 payload 任何一層
    const serialized = JSON.stringify(body);
    for (const name of ["stats_cand", "stats_provider", "stats_count"]) {
      assert.equal(serialized.includes(name), false, `${name} 不得進 payload`);
    }
    // 階段計時的鍵只能住在 `timing.stages`／`timing.stats_stages`：
    // 把它們從 timing 拿掉之後，payload 其餘部分不得再出現任何階段鍵名。
    const withoutTimingStages = JSON.stringify({
      stats: body.stats,
      listings: body.listings,
      hasMore: body.hasMore,
      nextOffset: body.nextOffset,
      nextCursor: body.nextCursor,
      queryVersion: body.queryVersion,
      timing: { ...body.timing, stages: undefined, stats_stages: undefined },
    });
    for (const key of ["prepare_ms", "sql_ms", "stats_cand", "stats_provider", "stats_count",
      "profile_sync_ms", "count_sync_ms", "reduce_ms", "provider_ms"]) {
      assert.equal(withoutTimingStages.includes(`"${key}"`), false, `${key} 只能進 header／timing.stages`);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// 來源層護欄：這條路由不得再自己組 Server-Timing 字串，也不得把階段塞回 timing。
test("server.js 的 /api/listings 透過 listingStageTiming 產生 header（不得手寫字串）", () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /buildListingServerTimingHeader\(page\.timing\)/);
  assert.equal(/res\.setHeader\("Server-Timing", `list;dur=/.test(source), false,
    "不得再手寫 Server-Timing 字串");
});
