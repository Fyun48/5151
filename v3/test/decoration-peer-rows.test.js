// astra6 2026-09-25 §0.2 的護欄：peer 列載入**不得整批截斷**。
//
// 背景：`loadPeerRows` 原本在整批共用一個 `LIMIT 8` ✗（80 個頁面 id 只會拿到 8 筆 peer 列），
// 使角色／total 的計算看到被截斷的資料。這裡用假的 exec 檢查送出的 SQL 不含 LIMIT，
// 且回傳所有列（由 exec 決定），以固定這個契約。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPeerRows } from "../src/repository/decorationData.js";

test("loadPeerRows：SQL 不含 LIMIT（不得整批截斷）", async () => {
  const seen = [];
  const exec = async (sql, params) => {
    seen.push({ sql: String(sql), params });
    return [];
  };
  await loadPeerRows(exec, [1, 2, 3], "sqlite");
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0].sql, /LIMIT/i, `不應有 LIMIT：${seen[0].sql}`);
  assert.deepEqual(seen[0].params, [1, 2, 3, 1, 2, 3]);
});

test("loadPeerRows：回傳 exec 給的全部列（不自行再截斷）", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ post_id: i + 1, match_post_id: 100 + i }));
  const exec = async () => rows;
  const out = await loadPeerRows(exec, [1, 2], "postgres");
  assert.equal(out.length, 12);
});

test("loadPeerRows：空 ids 不查詢", async () => {
  let calls = 0;
  const out = await loadPeerRows(async () => { calls += 1; return []; }, [], "sqlite");
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});
