// F3（PR-B）：kind 篩選下推 PG SQL。
//
// 述詞逐行鏡射 floors.js:matchesHousingKind（rentalMode／appearance 群組／commercial 群組／
// elevatorRequired），每個 has(key) = kind_keys LIKE '%,key,%'。
// 等價性已在真實資料上驗證：v3/scripts/kind-parity-probe.mjs（14 種查詢 × 2,000 列，mismatch=0）。
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
  return new Proxy(base, {
    get: (target, name) => (name in target ? target[name] : () => {}),
    has: () => true,
  });
}

const ARGS = { districts: ["中山區"], allowAllDistricts: true };
const build = (kind) => buildListingSearchSql({ ...ARGS, kind }, stubDeps());

test("kind 空字串：不產生任何 kind_keys 條件（既有行為不變）", () => {
  assert.doesNotMatch(JSON.stringify(build("")), /kind_keys/);
});

test("kind=apartment：改以 apartment_huaxia 比對（kindsToQuery 的正規化）", () => {
  const result = build("apartment");
  assert.notEqual(result?.ok, false, `不該落在外框外：${JSON.stringify(result)?.slice(0, 160)}`);
  const text = JSON.stringify(result);
  assert.match(text, /kind_keys LIKE \?/);
  assert.match(text, /%,apartment_huaxia,%/);
});

test("kind=whole：要求 ,whole, 集合（整層）", () => {
  const text = JSON.stringify(build("whole"));
  assert.match(text, /%,whole,%/);
});

test("kind=building：外觀群組 + elevatorRequired 的合取條件都要出現", () => {
  const text = JSON.stringify(build("building"));
  assert.match(text, /%,building,%/);
  assert.match(text, /%,elevator,%/);
});

test("kind=suite,yafang：legacy 模式只要求 legacy key ＋ 外觀特例群組（不要求 suite）", () => {
  // 實測語意：kindsToQuery() 會把 yafang 歸為 legacy rental（rentalMode=legacy, legacyRental=yafang），
  // 且因為 appearance/commercial 皆空、rentalOn 為真 → effectiveAppearanceCategories() 回傳特例
  // [building, apartment_huaxia]。這與 kind-parity-probe.mjs 的述詞一致（mismatch=0）。
  const text = JSON.stringify(build("suite,yafang"));
  assert.match(text, /%,yafang,%/);
  assert.match(text, /\(p\.kind_keys LIKE \? OR p\.kind_keys LIKE \?\)/);
  assert.match(text, /%,building,%/);
  assert.match(text, /%,apartment_huaxia,%/);
  assert.doesNotMatch(text, /%\,\s*suite\s*,%/);
});

test("kind=shop,warehouse：commercial 群組以 OR 串接", () => {
  const text = JSON.stringify(build("shop,warehouse"));
  assert.match(text, /\(p\.kind_keys LIKE \? OR p\.kind_keys LIKE \?\)/);
  assert.match(text, /%,shop,%/);
  assert.match(text, /%,warehouse,%/);
});

test("wholeFloorOnly：kind 為空時套用整層過濾（等效 isWholeFloorHome）", () => {
  const deps = stubDeps({ getSettings: () => ({ wholeFloorOnly: true }) });
  const result = buildListingSearchSql({ ...ARGS }, deps);
  assert.notEqual(result?.ok, false, `不該落在外框外：${JSON.stringify(result)?.slice(0, 160)}`);
  assert.match(JSON.stringify(result), /%,whole,%/);
});

test("wholeFloorOnly：kind 有值時**不**套用整層過濾（Node 會 skipWholeFloor）", () => {
  // db.js:6480 / 7183：passesDisplayFilters(row, settings, { skipWholeFloor: Boolean(kind) })
  const deps = stubDeps({ getSettings: () => ({ wholeFloorOnly: true }) });
  const result = buildListingSearchSql({ ...ARGS, kind: "suite" }, deps);
  assert.notEqual(result?.ok, false, `不該落在外框外：${JSON.stringify(result)?.slice(0, 160)}`);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /%,whole,%/);
  assert.match(text, /kind_keys LIKE/); // kind 條件本身仍在
});
