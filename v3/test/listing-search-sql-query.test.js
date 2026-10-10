// F3（PR-B）：q（關鍵字）下推。
//
// 語意來源：db.js 的四個比對（title／address／post_id／watch_note）。
// 關鍵差異：Node 路徑在 SQLite 用 `LIKE`（ASCII 不分大小寫），PG 的 LIKE 分大小寫
// ⇒ 直接下推會讓 ASCII 查詢在兩個 driver 得到不同結果（實測 6 案中 4 案不一致）。
// 因此一律包 `lower(x) LIKE lower(?)`：實測兩邊 6 案全部一致（含 CJK 與重音字）。
//
// 2026-10-10（#694 加速包）：`CAST(post_id AS TEXT) LIKE` 無索引使整個 OR 被迫 Seq Scan，
// 純數字 q 改走 `post_id = ?` 精確命中；否則只走 title/address（訪客 uid=0 無 watch_note，
// 會員 uid>0 保留 watch_note 比對）。
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

test("q：非純數字（訪客 uid=0）只走 title/address 兩項，不再有 post_id CAST LIKE／watch_note", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "Park" }, stubDeps());
  assert.notEqual(built?.ok, false, `不該落在外框外：${JSON.stringify(built)?.slice(0, 160)}`);
  const text = JSON.stringify(built);
  assert.match(text, /lower\(title\) LIKE lower\(\?\)/);
  assert.match(text, /lower\(address\) LIKE lower\(\?\)/);
  assert.doesNotMatch(text, /CAST\(post_id AS TEXT\)/);
  assert.doesNotMatch(text, /watch_note/);
  assert.match(text, /%Park%/);
});

test("q：非純數字（會員 uid>0）保留 watch_note 比對，但不再有 post_id CAST LIKE", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "Park" }, stubDeps({ resolveUserId: () => 7 }));
  const text = JSON.stringify(built);
  assert.match(text, /watch_note/);
  assert.doesNotMatch(text, /CAST\(post_id AS TEXT\)/);
  const params = built.countQuery?.params || built.params || [];
  const likes = params.filter((p) => p === "%Park%").length;
  assert.equal(likes, 3, `應有 3 個 %Park%（title/address/watch_note）：${JSON.stringify(params)}`);
  assert.ok(params.includes(7), `user_id 應在參數內：${JSON.stringify(params)}`);
  const first = params.indexOf("%Park%");
  const uidAt = params.indexOf(7);
  assert.ok(uidAt > first, "user_id 應排在 watch_note 的 like 之前");
});

test("q：純數字走 post_id = ? 精確命中（訪客與會員一致，不再 LIKE）", () => {
  for (const uid of [0, 7]) {
    const built = buildListingSearchSql({ ...ARGS, q: "123" }, stubDeps({ resolveUserId: () => uid }));
    const text = JSON.stringify(built);
    assert.match(text, /post_id = \?/, `uid=${uid} 應有 post_id = ? 子句`);
    assert.doesNotMatch(text, /lower\(title\) LIKE/, `uid=${uid} 純數字不該走 title LIKE`);
    assert.doesNotMatch(text, /watch_note/, `uid=${uid} 純數字不該有 watch_note`);
    const params = built.countQuery?.params || built.params || [];
    assert.ok(params.includes(123), `uid=${uid} 應有 123 參數：${JSON.stringify(params)}`);
  }
});

test("q：純數字含空白仍走 post_id 精確命中（trim 後判定）", () => {
  const built = buildListingSearchSql({ ...ARGS, q: " 456 " }, stubDeps());
  const text = JSON.stringify(built);
  assert.match(text, /post_id = \?/);
  const params = built.countQuery?.params || built.params || [];
  assert.ok(params.includes(456), `應有 456 參數：${JSON.stringify(params)}`);
});

test("q：超大數字（超出安全整數）退回 title/address LIKE，不誤走 post_id 精確比對", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "99999999999999999999999" }, stubDeps());
  const text = JSON.stringify(built);
  assert.doesNotMatch(text, /post_id = \?/);
  assert.match(text, /lower\(title\) LIKE lower\(\?\)/);
});

test("q：空字串不產生關鍵字條件（既有行為不變）", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "" }, stubDeps());
  assert.doesNotMatch(JSON.stringify(built), /watch_note/);
  assert.doesNotMatch(JSON.stringify(built), /post_id = \?/);
});

test("q：CJK 關鍵字也走同一條（lower() 對 CJK 無影響，兩邊一致）", () => {
  const built = buildListingSearchSql({ ...ARGS, q: "電梯" }, stubDeps());
  assert.match(JSON.stringify(built), /%電梯%/);
});
