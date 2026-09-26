// F3（PR-B）：q（關鍵字）下推。
//
// 語意來源：db.js:6446-6456 的四個比對（title／address／post_id／watch_note）。
// 關鍵差異：Node 路徑在 SQLite 用 `LIKE`（ASCII 不分大小寫），PG 的 LIKE 分大小寫
// ⇒ 直接下推會讓 ASCII 查詢在兩個 driver 得到不同結果（實測 6 案中 4 案不一致）。
// 因此一律包 `lower(x) LIKE lower(?)`：實測兩邊 6 案全部一致（含 CJK 與重音字）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListingSearchSql } from "../src/listingSearchSql.js";

function stubDeps(overrides = {}) {
  const base = {
    resolveUserId: () => 0,
    getSettings: () => ({}),
    memberRegionDistrictNames: () => ["中正區"],
    searchWhere: () => {},
    listingVisibilityClauses: () => {},
    appendDistrictCandidates: () => {},
    appendPriceCeilingCandidates: () => {},
    ...overrides,
  };
  return new Proxy(base, { get: (t, n) => (n in t ? t[n] : () => {}), has: () => true });
}

const ARGS = { districts: ["中正區"] };

test("q：不再落在外框外，四個比對都包 lower()", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "Park" }, stubDeps());
  assert.notEqual(built?.ok, false, `不該落在外框外：${JSON.stringify(built)?.slice(0, 160)}`);
  const text = JSON.stringify(built);
  assert.match(text, /lower\(title\) LIKE lower\(\?\)/);
  assert.match(text, /lower\(address\) LIKE lower\(\?\)/);
  assert.match(text, /lower\(CAST\(post_id AS TEXT\)\) LIKE lower\(\?\)/);
  assert.match(text, /watch_note/);
  assert.match(text, /%Park%/);
});

test("q：參數依子句順序（三個 like、user_id、再一個 like）", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "Park" }, stubDeps({ resolveUserId: () => 7 }));
  const params = built.countQuery?.params || built.params || [];
  const likes = params.filter((p) => p === "%Park%").length;
  assert.equal(likes, 4, `應有 4 個 %Park%：${JSON.stringify(params)}`);
  assert.ok(params.includes(7), `user_id 應在參數內：${JSON.stringify(params)}`);
  const first = params.indexOf("%Park%");
  const uidAt = params.indexOf(7);
  assert.ok(uidAt > first, "user_id 應排在 watch_note 的 like 之前");
});

test("q：空字串不產生關鍵字條件（既有行為不變）", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "" }, stubDeps());
  assert.doesNotMatch(JSON.stringify(built), /watch_note/);
});

test("q：CJK 關鍵字也走同一條（lower() 對 CJK 無影響，兩邊一致）", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "電梯" }, stubDeps());
  assert.match(JSON.stringify(built), /%電梯%/);
});
