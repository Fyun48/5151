// F3（PR-B）：kind 篩選——**依實測結果關回外框外**。
//
// 背景（2026-09-24 實測，生產資料）：
//   • kind=""           → count 查詢 388ms ✓
//   • kind=whole／apartment／building → count 查詢 **30,0xx ms** ✗ 被連線逾時中止
//   原因：`p.kind_keys LIKE '%,key,%'` 無法使用索引；而 F2 已移除回退 ⇒ 若維持下推，
//   線上帶分類晶片的搜尋會變成 503。
//   ⇒ 暫時關回外框外，改走 PG-fed Node 路徑（實測正確、約 1.3 秒）。
//   ⇒ 待 B6 提供可索引的 kind 表達（例如投影布林欄位）後，再以「A/B 對照 + 效能」兩項一起驗收才開放。
//
// 本檔保留「關回外框外」的回歸護欄；述詞結構的等價性證據（探針 mismatch=0、生產資料 5,000/5,000、
// 端到端 12 案一致）仍然有效，只是**效能**不允許它走 SQL-first。
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

test("kind 一律回外框外（實測 30 秒逾時；改走 PG-fed Node）", () => {
  for (const kind of ["whole", "apartment", "apartment,building", "suite,yafang", "shop,warehouse", "elevator"]) {
    const built = buildListingSearchSql({ ...ARGS, kind }, stubDeps());
    assert.equal(built?.ok, false, `${kind} 應回外框外`);
    assert.equal(built.reason, "kind");
  }
});

test("kind 為空字串時仍在外框內，且不產生 kind_keys 條件（既有行為不變）", () => {
  const built = buildListingSearchSql({ ...ARGS, kind: "" }, stubDeps());
  assert.notEqual(built?.ok, false);
  assert.doesNotMatch(JSON.stringify(built), /kind_keys/);
});

test("外框外的原因字串穩定（呼叫端可依賴）", () => {
  assert.equal(buildListingSearchSql({ ...ARGS, kind: "whole" }, stubDeps())?.reason, "kind");
});
