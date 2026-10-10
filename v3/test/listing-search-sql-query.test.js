// F3（PR-B）：q（關鍵字）下推。
//
// 語意來源：db.js 的四個比對（title／address／post_id／watch_note）。
// 關鍵差異：Node 路徑在 SQLite 用 `LIKE`（ASCII 不分大小寫），PG 的 LIKE 分大小寫
// ⇒ 直接下推會讓 ASCII 查詢在兩個 driver 得到不同結果（實測 6 案中 4 案不一致）。
// 因此一律包 `lower(x) LIKE lower(?)`：實測兩邊 6 案全部一致（含 CJK 與重音字）。
//
// 2026-10-10 回退（#694/#695 的 numeric-q 回歸）：q 無論是否純數字，都必須同時含
// `lower(title) LIKE`、`lower(address) LIKE`、`CAST(post_id AS TEXT) LIKE` 三項；
// 訪客 uid=0 無 watch_note，會員 uid>0 保留 watch_note 比對。
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

// 三項 OR 的硬性斷言：q 無論是否純數字都必須同時存在（缺任一個就是漏結果的回歸）。
function assertThreeTermOr(text, q, uid) {
  assert.match(text, /lower\(title\) LIKE lower\(\?\)/, `q=${q} uid=${uid} 應有 title 比對`);
  assert.match(text, /lower\(address\) LIKE lower\(\?\)/, `q=${q} uid=${uid} 應有 address 比對`);
  assert.match(text, /CAST\(post_id AS TEXT\)/, `q=${q} uid=${uid} 應有 post_id 子字串比對`);
  assert.doesNotMatch(text, /post_id = \?/, `q=${q} uid=${uid} 不該走 post_id = ? 精確命中`);
}

test("q：非純數字（訪客 uid=0）三項 OR 都在，且不含 watch_note", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "Park" }, stubDeps());
  assert.notEqual(built?.ok, false, `不該落在外框外：${JSON.stringify(built)?.slice(0, 160)}`);
  const text = JSON.stringify(built);
  assertThreeTermOr(text, "Park", 0);
  assert.doesNotMatch(text, /watch_note/);
  assert.match(text, /%Park%/);
});

test("q：非純數字（會員 uid>0）三項 OR 都在，並保留 watch_note 比對", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "Park" }, stubDeps({ resolveUserId: () => 7 }));
  const text = JSON.stringify(built);
  assertThreeTermOr(text, "Park", 7);
  assert.match(text, /watch_note/);
  const params = built.countQuery?.params || built.params || [];
  const likes = params.filter((p) => p === "%Park%").length;
  assert.equal(likes, 4, `應有 4 個 %Park%（title/address/post_id/watch_note）：${JSON.stringify(params)}`);
  assert.ok(params.includes(7), `user_id 應在參數內：${JSON.stringify(params)}`);
});

test("q：純數字（訪客 uid=0）仍走三項 OR，不再 post_id 精確命中", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "101" }, stubDeps());
  const text = JSON.stringify(built);
  assertThreeTermOr(text, "101", 0);
  const params = built.countQuery?.params || built.params || [];
  const likes = params.filter((p) => p === "%101%").length;
  assert.equal(likes, 3, `應有 3 個 %101%（title/address/post_id）：${JSON.stringify(params)}`);
});

test("q：純數字（會員 uid>0）仍走三項 OR + watch_note，不再 post_id 精確命中", () => {
  for (const q of ["101", "15000", "2699", "2699975575"]) {
    const built = buildListingSearchSql({ ...ARGS, q }, stubDeps({ resolveUserId: () => 7 }));
    const text = JSON.stringify(built);
    assertThreeTermOr(text, q, 7);
    assert.match(text, /watch_note/);
    const params = built.countQuery?.params || built.params || [];
    assert.equal(params.filter((p) => p === `%${q}%`).length, 4, `q=${q} 應有 4 個 like 參數：${JSON.stringify(params)}`);
  }
});

test("q：超大數字仍走三項 OR（不誤走 post_id 精確比對）", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "99999999999999999999999" }, stubDeps());
  const text = JSON.stringify(built);
  assertThreeTermOr(text, "99999999999999999999999", 0);
});

test("q：空字串不產生關鍵字條件（既有行為不變）", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "" }, stubDeps());
  assert.doesNotMatch(JSON.stringify(built), /watch_note/);
  assert.doesNotMatch(JSON.stringify(built), /post_id = \?/);
});

test("q：CJK 關鍵字也走同一條（lower() 對 CJK 無影響，兩邊一致）", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "電梯" }, stubDeps());
  assert.match(JSON.stringify(built), /%電梯%/);
  assertThreeTermOr(JSON.stringify(built), "電梯", 0);
});
