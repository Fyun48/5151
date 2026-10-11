// 行政區關係閉包（`districtClosureIds`）的等價測試。
//
// 2026-10-11（會員列表效能包）把這段從「Map union-find ＋ 把 100,328 個 endpoint 當成
// `= ANY(?::bigint[])` 參數送進 SQL」改成「Float64Array 邊表 ＋ 緊湊索引 ＋ Int32Array
// parent/size ＋ 種子在 Node 端取交集」。本檔用**同一組合成資料**逐筆比對新舊實作的 id 集合，
// 把「連通分量 ∪ 含種子的分量」這個語意固定住。
//
// ⚠️ 這裡刻意留下 post_id 超過 2^31-1 的案例（repro 實測 2,507,462,476）：舊版用 Int32Array
// 會靜默截斷成負數，新實作必須原樣保留。
import { test } from "node:test";
import assert from "node:assert/strict";
import { districtClosureIds } from "../src/listingSearchNodePg.js";

const BIG_ID = 2507462476; // > 2^31-1（實測值）

// ── 參考實作：b5b1399 的版本逐字複製 ────────────────────────────────────────
function referenceClosure(edgesIn, membersIn, seedsIn) {
  const edges = [...edgesIn];
  if (membersIn.length) {
    const byGroup = new Map();
    for (const row of membersIn) {
      const key = String(row.group_key || "");
      if (!key) continue;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(Number(row.post_id) || 0);
    }
    for (const list of byGroup.values()) for (let i = 1; i < list.length; i += 1) edges.push([list[0], list[i]]);
  }
  const endpoints = [...new Set(edges.flat())];
  if (!endpoints.length) return [];
  const endpointSet = new Set(endpoints);
  const seeds = seedsIn.map((r) => Number(r.post_id)).filter((id) => id && endpointSet.has(id));
  const parent = new Map();
  const size = new Map();
  const find = (x) => {
    let root = parent.get(x) ?? x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (cur !== root) { const next = parent.get(cur) ?? cur; parent.set(cur, root); if (next === cur) break; cur = next; }
    parent.set(x, root);
    return root;
  };
  const union = (a, b) => {
    if (!parent.has(a)) { parent.set(a, a); size.set(a, 1); }
    if (!parent.has(b)) { parent.set(b, b); size.set(b, 1); }
    let ra = find(a); let rb = find(b);
    if (ra === rb) return;
    if ((size.get(ra) || 1) < (size.get(rb) || 1)) { const t = ra; ra = rb; rb = t; }
    parent.set(rb, ra); size.set(ra, (size.get(ra) || 1) + (size.get(rb) || 1));
  };
  for (const [a, b] of edges) union(a, b);
  const seedRoots = new Set();
  const ids = new Set();
  for (const id of seeds) { seedRoots.add(parent.has(id) ? find(id) : id); ids.add(id); }
  for (const [a, b] of edges) {
    if (seedRoots.has(find(a))) { ids.add(a); ids.add(b); }
    if (seedRoots.has(find(b))) { ids.add(a); ids.add(b); }
  }
  return [...ids];
}

/** 合成一組資料：鏈、環、孤立點、兩個互不相連的分量，以及超過 2^31 的 id。 */
function fixture() {
  const edges = [
    [10, 11], [11, 12], [12, 13],       // 鏈
    [20, 21], [21, 22], [22, 20],       // 環
    [30, 31],                            // 另一個分量
    [BIG_ID, 40], [40, 41],              // 大 id 分量
  ];
  const edgeRows = edges.map(([post_id, match_post_id]) => ({ post_id, match_post_id }));
  const edgePairs = edges.map(([a, b]) => [a, b]);
  const members = [{ post_id: 100, group_key: "g1" }, { post_id: 101, group_key: "g1" }, { post_id: 102, group_key: "g1" }];
  // 種子：鏈的頭、環的一點、孤立點（200）、大 id 分量的一點、同戶群組的一點
  const seeds = [10, 22, 200, 41, 100].map((post_id) => ({ post_id }));
  return { edges: edgePairs, edgeRows, members, seeds };
}

function fakeExec({ edgeRows, members, seeds }) {
  return async (sql, params = []) => {
    if (/FROM listings WHERE match_post_id/.test(sql)) return edgeRows;
    if (/FROM user_same_house_members/.test(sql)) return members;
    if (/SELECT post_id FROM listings WHERE/.test(sql)) {
      // seeds 查詢：基底列（行政區前綴相符）＝上面那組加一個不相干的列。
      void params;
      return [...seeds, { post_id: 999 }];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
}

test("新舊閉包實作逐筆相同（鏈／環／孤立點／多分量／>2^31 的 id）", async () => {
  const fx = fixture();
  const expected = referenceClosure(fx.edges, fx.members, fx.seeds).sort((a, b) => a - b);
  const actual = await districtClosureIds(fakeExec(fx), { districtNames: ["中山區"], userId: 1, relatedOnly: true });
  assert.deepEqual([...actual].sort((a, b) => a - b), expected);
});

test("大於 2^31-1 的 post_id 不得被截斷成負數（Int32Array 的坑）", async () => {
  const fx = fixture();
  const actual = await districtClosureIds(fakeExec(fx), { districtNames: ["中山區"], userId: 1, relatedOnly: true });
  assert.ok(actual.includes(BIG_ID), "BIG_ID 必須原樣保留");
  assert.ok(actual.every((id) => id > 0), `不得出現負 id：${actual.filter((id) => id <= 0)}`);
});

test("沒有邊時回傳空陣列；不需要縮減時回傳 null（與舊版一致）", async () => {
  const empty = fakeExec({ edgeRows: [], members: [], seeds: [{ post_id: 1 }] });
  assert.deepEqual(await districtClosureIds(empty, { districtNames: ["中山區"], userId: 1, relatedOnly: true }), []);
  // 選滿全部行政區 ⇒ 不縮減（null），不會去查任何 SQL。
  const explode = async () => { throw new Error("不該被呼叫"); };
  const { CITIES } = await import("../src/regions.js");
  const allNames = CITIES.flatMap((c) => c.districts.map((d) => d.name));
  assert.equal(await districtClosureIds(explode, { districtNames: allNames, userId: 1, relatedOnly: true }), null);
  assert.equal(await districtClosureIds(explode, { districtNames: [], userId: 1, relatedOnly: true }), null);
});
