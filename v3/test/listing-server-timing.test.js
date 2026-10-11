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
    assert.deepEqual(Object.keys(body.timing.stages).sort(), Object.keys(TIMING.stages).sort());
    // 度量名（cand/filter/rows）不得出現在 payload 任何一層
    const serialized = JSON.stringify(body);
    for (const name of ["stats_cand", "stats_provider", "stats_count"]) {
      assert.equal(serialized.includes(name), false, `${name} 不得進 payload`);
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
