// 一趟掃描的「旗標參數去重」護欄（2026-10-14）。
//
// 背景：版本預讀那一趟是 `SELECT <version 欄><旗標> FROM listings <主查詢的 WHERE>`，
// 兩個旗標（`in_list_scope`／`in_stats_scope`）原本各自把「其餘述詞」的參數**再綁一次**，
// 於是同一組 bigint 陣列（會員七區 16,600 個 id、請求行政區 5,142 個 id、關係閉包 5,575 個 id）
// 在同一條語句裡出現兩次 ⇒ 每個請求多送 ~330KB 的陣列文字、PG 也多解析一次。
//
// 改法：旗標**沿用 WHERE 裡同一組 `$n`**，`extraColumns.params` 因此變空。
// 這支測試把契約釘住：
//   • 旗標片段只准引用主查詢已經有的編號（1..k），不得自帶參數
//   • 兩個片段的編號互不重疊（各自是 statsRest／listRest 在主查詢裡的那一段）
//   • 主查詢的參數數量仍等於它的 `?` 數（不得少送或多送）
// 改動前這支測試會紅（`extraColumns.params` 有 3 個元素）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScopeScan, buildScopeScanQuery } from "../src/listingScopeScan.js";
import { LIST_CANDIDATE_COLUMNS } from "../src/listingCandidateRow.js";

// 兩個範圍共用一條 COMMON，其餘述詞各自帶參數（stats 1 個、list 2 個）
const statsScope = { clauses: ["search_key = ?", "price_num <= ?"], params: ["k1", 100] };
const listScope = { clauses: ["search_key = ?", "(district = ? AND price_num <= ?)"], params: ["k1", "d1", 200] };

function fakeDriver(rowCount = 2) {
  const calls = [];
  const driver = {
    readRows: async (sql, params, options = {}) => {
      calls.push({ sql, params, options });
      const rows = Array.from({ length: rowCount }, (_, i) => ({ post_id: i + 1 }));
      if (options.extraColumns) {
        for (let i = 0; i < rowCount; i += 1) options.extraColumns.onRow([i !== rowCount - 1, true]);
      }
      return rows;
    },
  };
  return { driver, calls };
}

test("一趟掃描：旗標沿用 WHERE 的編號，不重複綁定參數", async () => {
  const { driver, calls } = fakeDriver(3);
  const scanned = await runScopeScan(driver, {
    candidateColumns: LIST_CANDIDATE_COLUMNS, statsScope, listScope,
  });
  assert.equal(calls.length, 1, "旗標走版本預讀那一趟（只有一次讀取）");
  const [call] = calls;
  const query = buildScopeScanQuery({ candidateColumns: LIST_CANDIDATE_COLUMNS, statsScope, listScope });

  assert.equal(call.params.length, query.params.length, "主查詢的參數不得少送");
  assert.equal(call.params.length, 4, "COMMON 1 ＋ statsRest 1 ＋ listRest 2 ＝ 4 個參數");
  assert.deepEqual(call.options.extraColumns.params, [],
    "旗標不得再帶一份自己的參數（去重的重點）");

  const flagRefs = [...String(call.options.extraColumns.selectSql).matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(flagRefs.length >= 3, `旗標必須引用 WHERE 的編號（實際 ${flagRefs.join(",")}）`);
  for (const n of flagRefs) {
    assert.ok(n >= 1 && n <= call.params.length, `旗標引用了不存在的參數 $${n}（只有 ${call.params.length} 個）`);
  }
  assert.equal(new Set(flagRefs).size, flagRefs.length, `旗標之間的編號不得重疊（${flagRefs.join(",")}）`);
  // list 的其餘述詞在主查詢裡是後兩個（$3,$4），stats 的是 $2
  assert.match(call.options.extraColumns.selectSql, /AS in_list_scope/);
  assert.match(call.options.extraColumns.selectSql, /\$3/);
  assert.match(call.options.extraColumns.selectSql, /\$4/);
  // 兩個旗標各自只引用自己那一段（文字順序：list 先、stats 後）
  const selectSql = String(call.options.extraColumns.selectSql);
  const [beforeList, afterList] = selectSql.split("AS in_list_scope");
  assert.match(beforeList, /\$3/, `list 旗標要用到 $3：${beforeList}`);
  assert.match(beforeList, /\$4/, `list 旗標要用到 $4：${beforeList}`);
  assert.doesNotMatch(beforeList, /\$2\b/, `list 旗標不得引用 stats 的 $2：${beforeList}`);
  assert.match(afterList, /\$2/, `stats 旗標要用到 $2：${afterList}`);
  assert.doesNotMatch(afterList, /\$[34]\b/, `stats 旗標不得引用 list 的參數：${afterList}`);

  // 列與旗標逐列對齊（旗標來自 onRow，本測試用最後一列 list=false 驗證分派）
  assert.equal(scanned.rows.length, 3);
  assert.equal(scanned.statsRows.length, 3, "每一列都在 stats 範圍");
  assert.equal(scanned.listRows.length, 2, "只有前兩列在 list 範圍");
});

test("一趟掃描：某側沒有其餘述詞時，旗標仍對得上（不撞號）", async () => {
  const noRest = { clauses: ["search_key = ?"], params: ["k1"] };
  const { driver, calls } = fakeDriver(1);
  await runScopeScan(driver, {
    candidateColumns: LIST_CANDIDATE_COLUMNS, statsScope: noRest, listScope,
  });
  const [call] = calls;
  assert.equal(call.params.length, 3, "COMMON 1 ＋ statsRest 0 ＋ listRest 2 ＝ 3");
  assert.deepEqual(call.options.extraColumns.params, []);
  for (const m of String(call.options.extraColumns.selectSql).matchAll(/\$(\d+)/g)) {
    assert.ok(Number(m[1]) <= 3, `旗標引用了不存在的參數 ${m[0]}`);
  }
});
