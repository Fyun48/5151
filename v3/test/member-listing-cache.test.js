// 會員列表版本化快取的離線等價測試（2026-10-11）。
//
// 這一包最重要的一條契約是「**輸出逐字不變**」：加了快取之後，同一個請求在
//   ① 未命中（現算）② 命中（回快取）③ 作廢後（版本換代，重新現算）
// 三條路徑上，回給前端的 `post_id` 序列、`totalMatched`、`hasMore`／`nextOffset`／`nextCursor`
// 必須完全相同。快取只准省時間，不准改語意。
//
// 這支測試用替身驅動（不需要 PG）：`readGeneration` 與 `load` 都是注入的，
// 所以「版本換代」「會員按了不再顯示」這些情境可以在毫秒內重現。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DATA_REVISION_PROBE_SQL,
  MEMBER_LISTING_CACHE_ENV,
  MEMBER_LISTING_CACHE_KEY_VERSION,
  loadMemberListingPage,
  memberListingCacheCounters,
  memberListingCacheEnabled,
  memberListingCacheKey,
  memberListingCacheSize,
  memberListingCacheWeight,
  normalizeMemberListRequest,
  readMemberListingGeneration,
  resetMemberListingCache,
} from "../src/memberListingCachePg.js";

const generation = (revision, { dataVersion = 500, signature = "s:1" } = {}) => ({ revision, dataVersion, signature });

function pageOf(ids, matched = ids.length) {
  return {
    stats: { total: matched, matched },
    listings: ids.map((post_id) => ({ post_id, title: `物件 ${post_id}` })),
    hasMore: false,
    nextOffset: ids.length,
    nextCursor: null,
    queryVersion: 2,
    timing: {
      query_ms: 1234, stats_ms: 567, total_ms: 1801, dataset: matched,
      stages: { sql_ms: 900, candidates: 3456 },
      stats_stages: { inputs_ms: 100 },
    },
  };
}

const idsOf = (page) => page.listings.map((item) => item.post_id);

beforeEach(() => {
  resetMemberListingCache();
});

test("金關預設關閉：只有 1／on／true 才算開", () => {
  assert.equal(MEMBER_LISTING_CACHE_ENV, "MEMBER_LISTING_CACHE");
  assert.equal(memberListingCacheEnabled({}), false);
  assert.equal(memberListingCacheEnabled({ [MEMBER_LISTING_CACHE_ENV]: "" }), false);
  assert.equal(memberListingCacheEnabled({ [MEMBER_LISTING_CACHE_ENV]: "0" }), false);
  assert.equal(memberListingCacheEnabled({ [MEMBER_LISTING_CACHE_ENV]: "yes" }), false);
  assert.equal(memberListingCacheEnabled({ [MEMBER_LISTING_CACHE_ENV]: "1" }), true);
  assert.equal(memberListingCacheEnabled({ [MEMBER_LISTING_CACHE_ENV]: "on" }), true);
  assert.equal(memberListingCacheEnabled({ [MEMBER_LISTING_CACHE_ENV]: "TRUE" }), true);
});

test("三條路徑（未命中／命中／作廢後）的 post_id 序列與計數完全相同", async () => {
  const args = { filter: "all", sort: "newest", limit: 80, userId: 7, districts: ["中山區"], q: "新莊" };
  const pages = [pageOf([11, 22, 33], 3), pageOf([11, 22, 33], 3), pageOf([11, 22, 33], 3)];
  let calls = 0;
  let gen = generation(1001);
  const load = async () => pages[calls++];

  const miss = await loadMemberListingPage({ args, load, deps: { readGeneration: async () => gen } });
  const hit = await loadMemberListingPage({ args, load, deps: { readGeneration: async () => gen } });
  gen = generation(1002); // 版本換代 ⇒ 作廢（不回舊代）
  const revalidated = await loadMemberListingPage({ args, load, deps: { readGeneration: async () => gen } });

  const evidence = `[cache-equivalence] miss=${JSON.stringify(idsOf(miss))} `
    + `hit=${JSON.stringify(idsOf(hit))} revalidated=${JSON.stringify(idsOf(revalidated))}`;
  console.log(evidence);

  assert.deepEqual(idsOf(hit), idsOf(miss), "命中路徑的 post_id 序列必須與未命中相同");
  assert.deepEqual(idsOf(revalidated), idsOf(miss), "作廢後重算的 post_id 序列必須與未命中相同");
  assert.deepEqual(hit.stats, miss.stats, "計數必須相同");
  assert.deepEqual(revalidated.stats, miss.stats, "作廢後的計數必須相同");
  for (const page of [hit, revalidated]) {
    assert.equal(page.hasMore, miss.hasMore);
    assert.equal(page.nextOffset, miss.nextOffset);
    assert.equal(page.nextCursor, miss.nextCursor);
    assert.equal(page.queryVersion, miss.queryVersion);
  }
  assert.deepEqual(Object.keys(hit).sort(), Object.keys(miss).sort(), "回傳欄位集合不准變");
  assert.equal(calls, 2, "命中那一次不可以再現算");
  console.log(`${evidence} identical=true`);
});

test("命中時 timing 誠實：query_ms／stats_ms 歸零，且不會污染快取裡的 entry", async () => {
  const args = { filter: "all", userId: 7 };
  const load = async () => pageOf([1, 2, 3], 3);
  const deps = { readGeneration: async () => generation(9) };
  const miss = await loadMemberListingPage({ args, load, deps });
  const hit = await loadMemberListingPage({ args, load, deps });
  assert.equal(miss.timing.query_ms, 1234);
  assert.equal(hit.timing.query_ms, 0);
  assert.equal(hit.timing.stats_ms, 0);
  assert.equal(hit.timing.stages.cache_hit, true);
  assert.equal(hit.timing.stages.sql_ms, 900, "冷算的階段明細要保留（描述的是這份 payload 的來源）");
  assert.equal(hit.timing.dataset, 3);
  // 呼叫端會就地改 timing（server.js:4939 改 total_ms）⇒ 不能改到 entry 內那一份。
  hit.timing.total_ms = 99999;
  hit.stats.matched = -1;
  const hitAgain = await loadMemberListingPage({ args, load, deps });
  assert.equal(hitAgain.timing.total_ms < 99999, true);
  assert.equal(hitAgain.stats.matched, 3);
  assert.deepEqual(idsOf(hitAgain), [1, 2, 3]);
});

test("請求參數不同 ⇒ 未命中（行政區／租金／q／類型／分頁各自都不能共用）", async () => {
  const base = { filter: "all", sort: "newest", limit: 80, offset: 0, userId: 7 };
  const variants = [
    { districts: ["中山區"] },
    { districts: ["中山區", "大同區"] },
    { filter: "watched" },
    { kind: "套房" },
    { q: "新莊" },
    { sort: "price_asc" },
    { limit: 40 },
    { offset: 80 },
    { sameHouse: false },
    { cursor: { post_id: 123 } },
  ];
  let calls = 0;
  const load = async () => { calls += 1; return pageOf([1, 2], 2); };
  const deps = { readGeneration: async () => generation(77) };
  await loadMemberListingPage({ args: base, load, deps });
  await loadMemberListingPage({ args: base, load, deps }); // 同參數：命中
  assert.equal(calls, 1);
  for (const variant of variants) {
    await loadMemberListingPage({ args: { ...base, ...variant }, load, deps });
  }
  assert.equal(calls, 1 + variants.length, "每一個不同的參數組合都必須各自算一次");
});

test("會員自己的狀態（收藏／隱藏／同戶 fold／設定）變了 ⇒ 未命中", async () => {
  const args = { filter: "all", userId: 7 };
  const loads = [];
  const load = async () => { loads.push(1); return pageOf([1, 2], 2); };
  let gen = generation(50, { signature: "flags_n:2,flags_sig:aaa" });
  await loadMemberListingPage({ args, load, deps: { readGeneration: async () => gen } });
  await loadMemberListingPage({ args, load, deps: { readGeneration: async () => gen } });
  assert.equal(loads.length, 1, "狀態沒變：命中");
  // 會員按了「不再顯示」⇒ user_listing_flags 的簽章改變（data_revision 不會 bump）。
  gen = generation(50, { signature: "flags_n:3,flags_sig:bbb" });
  await loadMemberListingPage({ args, load, deps: { readGeneration: async () => gen } });
  assert.equal(loads.length, 2, "會員狀態變了必須重算，不能回舊的收藏／隱藏狀態");
});

test("路線／快取類資料的版本號（dataVersion）也進 key —— 通勤條件會改變成員", async () => {
  const args = { filter: "all", userId: 7 };
  let loads = 0;
  const load = async () => { loads += 1; return pageOf([1], 1); };
  let gen = generation(60, { dataVersion: 1000 });
  await loadMemberListingPage({ args, load, deps: { readGeneration: async () => gen } });
  await loadMemberListingPage({ args, load, deps: { readGeneration: async () => gen } });
  assert.equal(loads, 1);
  gen = generation(60, { dataVersion: 1001 }); // route_cache／route_jobs 有寫入，但 data_revision 沒動
  await loadMemberListingPage({ args, load, deps: { readGeneration: async () => gen } });
  assert.equal(loads, 2, "非 data_revision 的資料變了也要失效");
});

test("fail-closed：讀不到版本號就完全不快取（不讀也不寫）", async () => {
  const args = { filter: "all", userId: 7 };
  let loads = 0;
  const load = async () => { loads += 1; return pageOf([5], 1); };
  const deps = { readGeneration: async () => null };
  const first = await loadMemberListingPage({ args, load, deps });
  const second = await loadMemberListingPage({ args, load, deps });
  assert.equal(loads, 2, "沒有版本號 ⇒ 每次現算");
  assert.equal(memberListingCacheSize(), 0, "沒有版本號 ⇒ 不寫入");
  assert.equal(memberListingCacheCounters().bypasses, 2);
  assert.deepEqual(idsOf(first), idsOf(second));

  const throwing = { readGeneration: async () => { throw new Error("PG 半死"); } };
  const third = await loadMemberListingPage({ args, load, deps: throwing });
  assert.equal(loads, 3, "版本號查詢拋錯 ⇒ 現算，不得往上炸");
  assert.deepEqual(idsOf(third), idsOf(first));
});

test("併發同一組參數 ⇒ single-flight：只算一次，兩個請求都拿到同一份結果", async () => {
  const args = { filter: "all", userId: 7 };
  let loads = 0;
  const load = async () => { loads += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return pageOf([8, 9], 2); };
  const deps = { readGeneration: async () => generation(11) };
  const [a, b] = await Promise.all([
    loadMemberListingPage({ args, load, deps }),
    loadMemberListingPage({ args, load, deps }),
  ]);
  assert.equal(loads, 1);
  assert.deepEqual(idsOf(a), idsOf(b));
  assert.deepEqual(idsOf(a), [8, 9]);
});

test("算到一半就寫入（版本變了）⇒ 這份結果不進快取", async () => {
  const args = { filter: "all", userId: 7 };
  let loads = 0;
  let gen = generation(1);
  const readGeneration = async () => gen;
  const load = async () => {
    loads += 1;
    gen = generation(2); // 計算期間有寫入
    return pageOf([1], 1);
  };
  await loadMemberListingPage({ args, load, deps: { readGeneration } });
  assert.equal(memberListingCacheSize(), 0, "版本已經不是算這一份時的那個 ⇒ 不得寫入");
  await loadMemberListingPage({ args, load, deps: { readGeneration } });
  assert.equal(loads, 2);
});

test("鍵的組成：版本號＋會員簽章＋uid＋請求參數；自動時鐘不進 key", () => {
  const args = { filter: "all", userId: 7, now: 111, asOf: "2026-10-11T00:00:00.000Z" };
  const a = memberListingCacheKey({ generation: generation(1), args, uid: 7 });
  const b = memberListingCacheKey({ generation: generation(1), args: { ...args, now: 222 }, uid: 7 });
  assert.equal(a, b, "listingRequestTime() 自動產生的 now／asOf 不可以進 key（進去就永不命中）");
  assert.equal(a.includes(MEMBER_LISTING_CACHE_KEY_VERSION), true);
  assert.equal(a.includes("r1"), true);
  assert.notEqual(a, memberListingCacheKey({ generation: generation(2), args, uid: 7 }));
  assert.notEqual(a, memberListingCacheKey({ generation: generation(1), args, uid: 8 }));
  assert.notEqual(a, memberListingCacheKey({
    generation: generation(1, { dataVersion: 999 }), args, uid: 7,
  }));
  assert.notEqual(a, memberListingCacheKey({
    generation: generation(1, { signature: "other" }), args, uid: 7,
  }));
  // 呼叫端明確傳的 asOf 會改變結果 ⇒ 必須進 key。
  const withExplicit = memberListingCacheKey({ generation: generation(1), args, uid: 7, explicitAsOf: "2026-01-01T00:00:00.000Z" });
  assert.notEqual(a, withExplicit);
  assert.equal(memberListingCacheKey({ generation: null, args, uid: 7 }), null);
});

test("記憶體護欄：entry 數與「合計物件筆數」都有上限，單筆過大就整筆不存", async () => {
  const deps = { readGeneration: async () => generation(5), maxEntries: 4, maxListings: 10 };
  const page = (n) => pageOf(Array.from({ length: n }, (_, i) => i + 1), n);
  // 三筆各 4 筆物件 ⇒ 合計 12 > 10 ⇒ 最舊的那一筆必須被淘汰。
  await loadMemberListingPage({ args: { userId: 1, offset: 0 }, load: async () => page(4), deps });
  await loadMemberListingPage({ args: { userId: 1, offset: 4 }, load: async () => page(4), deps });
  await loadMemberListingPage({ args: { userId: 1, offset: 8 }, load: async () => page(4), deps });
  assert.equal(memberListingCacheSize(), 2, "合計筆數超標 ⇒ 淘汰最舊的");
  assert.equal(memberListingCacheWeight(), 8);
  // 單筆 50 筆 > 預算 10 ⇒ 不存（也不要因此把別人擠掉）。
  await loadMemberListingPage({ args: { userId: 1, offset: 99 }, load: async () => page(50), deps });
  assert.equal(memberListingCacheSize(), 2);
  assert.equal(memberListingCacheWeight(), 8);
  // entry 數上限：放寬筆數預算之後，仍然是「先進先出」。
  const wide = { readGeneration: async () => generation(5), maxEntries: 2, maxListings: 1000 };
  for (const offset of [0, 4, 8]) {
    await loadMemberListingPage({ args: { userId: 1, offset }, load: async () => page(4), deps: wide });
  }
  assert.equal(memberListingCacheSize(), 2, "entry 數上限仍然是 2");
  assert.equal(memberListingCacheWeight(), 8);
});

test("normalizeMemberListRequest：行政區排序後才進 key（同一組集合順序不同算同一個 key）", () => {
  const one = normalizeMemberListRequest({ districts: ["中山區", "大同區"], userId: 1 });
  const two = normalizeMemberListRequest({ districts: ["大同區", "中山區", ""], userId: 1 });
  assert.equal(one, two);
  assert.notEqual(one, normalizeMemberListRequest({ districts: ["中山區"], userId: 1 }));
  // 物件（settings 覆寫）用決定性序列化 ⇒ 鍵序不同不算不同 key。
  const s1 = normalizeMemberListRequest({ settings: { a: 1, b: [{ x: 1, y: 2 }] } });
  const s2 = normalizeMemberListRequest({ settings: { b: [{ y: 2, x: 1 }], a: 1 } });
  assert.equal(s1, s2);
  assert.notEqual(s1, normalizeMemberListRequest({ settings: { a: 2, b: [{ x: 1, y: 2 }] } }));
});

test("readMemberListingGeneration：沒有 data_revision 或空表 ⇒ 回 null（不 throw、不缓存）", async () => {
  const probeOnly = async (sql) => {
    assert.equal(sql, DATA_REVISION_PROBE_SQL);
    return [{ has_revision: false }];
  };
  assert.equal(await readMemberListingGeneration(probeOnly, 7), null);

  const noRows = async (sql) => (sql === DATA_REVISION_PROBE_SQL ? [{ has_revision: true }] : [{ revision: null, data_version: 1 }]);
  assert.equal(await readMemberListingGeneration(noRows, 7), null, "空表（MAX(id) IS NULL）沒有可靠版本號");

  const ok = async (sql) => (sql === DATA_REVISION_PROBE_SQL
    ? [{ has_revision: true }]
    : [{
      revision: "123", data_version: "456",
      global_settings_n: 1, global_settings_sig: "g", users_n: 2, users_sig: "u",
      covers_n: 3, covers_sig: "c", member_settings_n: 4, member_settings_sig: "ms",
      flags_n: 5, flags_sig: "f", same_house_n: 6, same_house_sig: "sh",
    }]);
  const gen = await readMemberListingGeneration(ok, 7);
  assert.deepEqual(gen, { revision: 123, dataVersion: 456, signature: "1,g,2,u,3,c,4,ms,5,f,6,sh" });
});

test("resetMemberListingCache：作廢全部 entry 與計數", async () => {
  const args = { filter: "all", userId: 7 };
  const load = async () => pageOf([1], 1);
  const deps = { readGeneration: async () => generation(3) };
  await loadMemberListingPage({ args, load, deps });
  assert.equal(memberListingCacheSize(), 1);
  resetMemberListingCache();
  assert.equal(memberListingCacheSize(), 0);
  assert.deepEqual(memberListingCacheCounters(), { hits: 0, misses: 0, joins: 0, stores: 0, bypasses: 0 });
});
