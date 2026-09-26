// astra6 2026-09-25 §3.2 的案例要求：closure 演算法在鏈／星／群組／環等形狀下必須正確，
// 且修正 path compression ＋ union-by-size 後**語意不變**（只改效率）。
//
// 用假的 exec 模擬三種查詢：種子（行政區前綴）、配對邊、個人同屋源群組。
import { test } from "node:test";
import assert from "node:assert/strict";
import { districtClosureIds } from "../src/listingSearchNodePg.js";

function fakeExec({ seeds = [], edges = [], groups = [] } = {}) {
  return async (sql) => {
    const text = String(sql);
    if (/split_part/.test(text)) return seeds.map((post_id) => ({ post_id }));
    if (/match_post_id/.test(text)) return edges.map(([post_id, match_post_id]) => ({ post_id, match_post_id }));
    if (/user_same_house_members/.test(text)) return groups.map(([post_id, group_key]) => ({ post_id, group_key }));
    return [];
  };
}

test("closure：鏈狀（1→2→…→50）含種子即可達全部", async () => {
  const edges = Array.from({ length: 49 }, (_, i) => [i + 1, i + 2]);
  const ids = await districtClosureIds(fakeExec({ seeds: [1], edges }), { districtNames: ["士林區"] });
  assert.equal(ids.length, 50);
  assert.equal(Math.min(...ids), 1);
  assert.equal(Math.max(...ids), 50);
});

test("closure：星狀（中心 1 連到 2..30）", async () => {
  const edges = Array.from({ length: 29 }, (_, i) => [1, i + 2]);
  const ids = await districtClosureIds(fakeExec({ seeds: [30], edges }), { districtNames: ["士林區"] });
  assert.equal(ids.length, 30);
});

test("closure：環狀（1→2→3→1）不會無限迴圈", async () => {
  const ids = await districtClosureIds(fakeExec({ seeds: [1], edges: [[1, 2], [2, 3], [3, 1]] }), { districtNames: ["士林區"] });
  assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2, 3]);
});

test("closure：不相連的分量不會被納入", async () => {
  const ids = await districtClosureIds(fakeExec({ seeds: [1], edges: [[1, 2], [10, 11]] }), { districtNames: ["士林區"] });
  assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2]);
});

test("closure：個人同屋源群組會把同群成員納入（userId > 0）", async () => {
  const ids = await districtClosureIds(
    fakeExec({ seeds: [1], edges: [], groups: [[1, "g1"], [2, "g1"], [3, "g1"]] }),
    { districtNames: ["士林區"], userId: 7 },
  );
  assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2, 3]);
});

test('related-only closure keeps cross-district components and leaves unrelated district IDs in SQL', async () => {
  const seeds = [1, 100, 101, 102];
  const edges = [[1, 99], [2, 99], [2, 3], [20, 21]];
  let seedParams;
  const exec = async (sql, params) => {
    if (/split_part/.test(sql)) {
      assert.match(sql, /post_id = ANY\(\?::bigint\[\]\)/);
      seedParams = params[0];
      return seeds.filter(id => params[0].includes(id)).map(post_id => ({ post_id }));
    }
    if (/match_post_id/.test(sql)) return edges.map(([post_id, match_post_id]) => ({ post_id, match_post_id }));
    return [];
  };
  const ids = await districtClosureIds(exec, { districtNames: ['士林區'], relatedOnly: true });
  assert.deepEqual(ids.sort((a, b) => a - b), [1, 2, 3, 99]);
  assert.ok(!seedParams.includes(100));
  assert.ok(!seedParams.includes(101));
});

test('related-only closure needs no district ID scan when there are no relation edges', async () => {
  const exec = async sql => {
    assert.doesNotMatch(sql, /split_part/);
    return [];
  };
  assert.deepEqual(await districtClosureIds(exec, { districtNames: ['士林區'], relatedOnly: true }), []);
});
