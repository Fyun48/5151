// F3（PR-B）：sources／areaMax 的 SQL 下推——**依隔離實測關回外框外**。
//
// 背景（2026-09-24 隔離實測，生產資料；每個案例用全新 driver 連線以排除連線池串聯污染）：
//   baseline 989ms ✓、q=電梯 878ms ✓
//   sources=591 30,042ms ✗、areaMax=35 30,054ms ✗、wholeFloorOnly 30,066ms ✗（皆被逾時中止）
// 原因：現行查詢結構（`p.*` 條件搭配 `post_id IN (SELECT …)`）在這些條件下讓 plan 崩掉。
// F2 已移除回退 ⇒ 若維持開啟，會員帶這些設定的搜尋會變成 503 ⇒ 因此關回外框外，改走 PG-fed Node。
//
// 等價性證據仍然有效（sources 授權在呼叫端、areaMax 依 floors.js:412-415 的 NULL 語意），
// 缺的是**可索引的表達**（B6）；屆時以「等價性 ＋ 效能」兩項一起驗收才開放。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListingSearchSql } from "../src/listingSearchSql.js";

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
  return new Proxy(base, { get: (t, n) => (n in t ? t[n] : () => {}), has: () => true });
}

const ARGS = { districts: ["中山區"], allowAllDistricts: true };

test("sources：依實測關回外框外（30,042ms 逾時；改走 PG-fed Node）", () => {
  const built = buildListingSearchSql({ ...ARGS, sources: "591,sinyi" }, stubDeps());
  assert.equal(built?.ok, false);
  assert.equal(built.reason, "sources");
});

test("sources：未指定時仍在外框內，且不產生來源條件（既有行為不變）", () => {
  const built = buildListingSearchSql({ ...ARGS, sources: "" }, stubDeps());
  assert.notEqual(built?.ok, false);
  assert.doesNotMatch(JSON.stringify(built), /p\.source IN/);
});

test("areaMax：依實測關回外框外（30,054ms 逾時）", () => {
  const built = buildListingSearchSql({ ...ARGS }, stubDeps({ getSettings: () => ({ areaMax: 35 }) }));
  assert.equal(built?.ok, false);
  assert.equal(built.reason, "settings");
});

test("areaMax：0／未設定時仍在外框內，且不產生面積條件（既有行為不變）", () => {
  const built = buildListingSearchSql({ ...ARGS }, stubDeps({ getSettings: () => ({ areaMax: 0 }) }));
  assert.notEqual(built?.ok, false);
  assert.doesNotMatch(JSON.stringify(built), /p\.area IS NULL/);
});

test("q 仍在外框內（實測 878ms ✓，是唯一通過效能閘門的 F3 能力）", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "電梯" }, stubDeps());
  assert.notEqual(built?.ok, false);
  assert.match(JSON.stringify(built), /lower\(title\) LIKE lower\(\?\)/);
});
