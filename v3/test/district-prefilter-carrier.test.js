// 「投影預篩」**載體形狀**的護欄（2026-10-13）。
//
// 這一包原本要把行政區預篩從 `post_id = ANY($n::bigint[])`（Node 先取回 id 們）改成查詢內
// semi-join（`EXISTS (SELECT 1 FROM listing_search_projection p WHERE p.post_id = listings.post_id
// AND p.district = ANY($k::text[]))`）。**實測不可行、已否決**：
//
//   | 寫法 | exec 中位（隔離靶、同一組述詞、5 輪交替） | 讀取 block | 逐列結果 |
//   |---|---|---|---|
//   | `post_id = ANY(bigint[])`（現況） | 111–145ms | 0–18k | 基準 |
//   | `EXISTS (相關子查詢)` | 376–403ms | 43,922 | 逐列相同 |
//   | `post_id IN (子查詢)` | 377–384ms | 43,922 | 逐列相同 |
//   | `post_id = ANY(ARRAY(子查詢))` | 1441ms | 23,222 | 逐列相同 |
//
// 原因（EXPLAIN 可證，重跑指令見 v3/evidence/district-prefilter-semijoin-20261013/README.md）：
// id 陣列形式讓 PG 能替「行政區」建 bitmap（`Bitmap Index Scan on listings_pkey`），再與
// `idx_listings_search` 做 **BitmapAnd**，把 heap 掃描縮到 1 萬列；改寫成子查詢後那個 bitmap
// 建不起來，行政區條件退化成 heap filter（`Rows Removed by Filter = 169,359`），
// 讀取 block 從 ~18k 暴增到 43,922。
//
// 所以這支測試**鎖住載體形狀**：預篩必須維持「單一 bigint 陣列參數」，不准變成子查詢／EXISTS。
// 真要再試 semi-join 的人，請先跑上面那支探針並把新數字寫進證據包——不要只憑「少搬 id 應該更快」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendDistrictProjectedCandidates } from "../src/listDistrictSql.js";

const IDS = [11, 22, 33];
const RELATED = [44, 55];

test("投影預篩：維持 bigint 陣列參數（不是子查詢／EXISTS）", () => {
  const clauses = [];
  const params = [];
  const handled = appendDistrictProjectedCandidates(["大安區"], clauses, params, {
    driver: "postgres", projectedIds: IDS, relatedIds: RELATED,
  });
  assert.equal(handled, true, "有 projectedIds 時必須接手");
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0], "(post_id = ANY(?::bigint[]) OR post_id = ANY(?::bigint[]))",
    "形狀必須逐字維持（BitmapAnd 少了這一項就會退化成 heap filter）");
  assert.deepEqual(params, [IDS, RELATED], "兩個參數都必須是 id 陣列");
  assert.doesNotMatch(clauses[0], /EXISTS|IN\s*\(SELECT|listing_search_projection/i,
    "預篩不得變成查詢內子查詢（實測慢 2.3–2.5 倍）");
});

test("投影預篩：沒有 projectedIds 就退回舊路徑（絕不靜默少算）", () => {
  const clauses = [];
  const params = [];
  const handled = appendDistrictProjectedCandidates(["大安區"], clauses, params, {
    driver: "postgres", projectedIds: null, relatedIds: RELATED,
  });
  assert.equal(handled, false, "拿不到投影 id ⇒ 交回呼叫端走 split_part 完整表達式");
  assert.deepEqual(clauses, []);
  assert.deepEqual(params, []);
});

test("投影預篩：SQLite 不走這一條；行政區全選時不縮減", () => {
  const clauses = [];
  const params = [];
  assert.equal(appendDistrictProjectedCandidates(["大安區"], clauses, params, {
    driver: "sqlite", projectedIds: IDS,
  }), false, "PG 專屬子句不得出現在 SQLite 路徑");

  const all = [];
  const allParams = [];
  assert.equal(appendDistrictProjectedCandidates(
    ["大安區", "中山區", "信義區", "松山區", "內湖區", "文山區", "中正區", "萬華區", "士林區", "北投區", "大同區"],
    all, allParams, { driver: "postgres", projectedIds: IDS },
  ), true, "選滿全部行政區時不縮減（與舊路徑同語意）");
});
