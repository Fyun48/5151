// PR-B／F3 第一項：`sources` 篩選不再落在外框外。
//
// 背景：`listingSearchSql.js` 的 PG SQL 路徑原本只要帶 kind／sources／q 就 outOfEnvelope → 回退 SQLite（F2）。
// 這裡先把語意最單純的 `sources` 補上：呼叫端（server.js:3759）已用 authorizedListingSources() 驗證與授權，
// 所以 SQL 端只做集合比對，不會繞過權限。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListingSearchSql } from "../src/listingSearchSql.js";

// 依賴清單可能變動 → 用 Proxy 對任何屬性都給 stub（測試只關心 sources 條件本身）。
function stubDeps(overrides = {}) {
  const base = {
    resolveUserId: () => 0,
    getSettings: () => ({}),
    memberRegionDistrictNames: () => ["中山區"],
    searchWhere: () => {},
    listingVisibilityClauses: () => {},
    appendDistrictCandidates: () => {},
    appendPriceCeilingCandidates: () => {},
    ...overrides,
  };
  return new Proxy(base, {
    get: (target, name) => (name in target ? target[name] : () => {}),
    has: () => true,
  });
}

const ARGS = { districts: ["中山區"], allowAllDistricts: true };

test("sources：不再 outOfEnvelope，且產生 p.source IN (?, ?) 與對應參數", () => {
  const result = buildListingSearchSql({ ...ARGS, sources: "591,sinyi" }, stubDeps());
  assert.notEqual(result?.ok, false, `不該落在外框外：${JSON.stringify(result)?.slice(0, 200)}`);
  const text = JSON.stringify(result);
  assert.match(text, /p\.source IN \(\?, \?\)/);
  assert.match(text, /"591"/);
  assert.match(text, /"sinyi"/);
});

test("sources：單一來源只產生一個參數", () => {
  const result = buildListingSearchSql({ ...ARGS, sources: "591" }, stubDeps());
  assert.match(JSON.stringify(result), /p\.source IN \(\?\)/);
});

test("sources：未指定時不產生來源條件（既有行為不變）", () => {
  const result = buildListingSearchSql({ ...ARGS }, stubDeps());
  assert.doesNotMatch(JSON.stringify(result), /p\.source IN/);
});

test("kind／q 仍在外框外（尚未補齊，維持既有回退）", () => {
  assert.equal(buildListingSearchSql({ ...ARGS, kind: "building" }, stubDeps())?.ok, false);
  assert.equal(buildListingSearchSql({ ...ARGS, q: "電梯" }, stubDeps())?.ok, false);
});
