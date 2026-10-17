// `statsResponseCache.js` 的離線測試（2026-10-17）。
//
// 這一層是 `safeStats()` 的呼叫端快取：POST /api/settings 的統計冷算 38–45 秒，
// 前端 20 秒逾時。測試不需要資料庫或伺服器，全部用注入的假時鐘／假計算函式。
import test from "node:test";
import assert from "node:assert/strict";
import {
  STATS_CACHE_MAX_ENTRIES,
  STATS_CACHE_TTL_MS,
  createStatsCache,
  statsCacheKey,
  statsSettingsFingerprint,
} from "../src/statsResponseCache.js";

const BASE_SETTINGS = {
  watchDistricts: ["4-1", "4-2"],
  searchUrls: ["https://rent.591.com.tw/list?region=4"],
  priceMin: 8000,
  priceMax: 25000,
  priceMaxIncludesExtras: false,
  areaMax: 40,
  minBuildingFloors: 3,
  wholeFloorOnly: false,
  excludeLowFloors: true,
  excludeRooftop: true,
  hasParking: false,
  excludeKeywords: ["頂加"],
  excludeAgents: [],
  excludeAgentIds: [],
  excludeBoxes: [],
  commuteKm: 8,
  workLat: 24.8,
  workLng: 120.9,
  commuteMode: "scooter",
  // 以下欄位與統計無關，改動不應該讓快取失效
  hiddenCityIds: [2],
  housing_kinds: ["whole"],
  listing_sources: ["591"],
  discordWebhook: "https://discord.example/webhook",
  notificationsPaused: false,
};

function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

function countedCompute(value = { total: 7 }) {
  const fn = async () => {
    fn.calls += 1;
    return value;
  };
  fn.calls = 0;
  return fn;
}

test("TTL 內同一個 key 只算一次（第二次是快取命中）", async () => {
  const clock = fakeClock();
  const cache = createStatsCache({ ttlMs: STATS_CACHE_TTL_MS, maxEntries: 5, now: clock.now });
  const compute = countedCompute();

  const first = await cache.getOrCompute("u1:abc", compute);
  assert.equal(first.cached, false);
  assert.equal(first.shared, false);

  clock.advance(STATS_CACHE_TTL_MS - 1);
  const second = await cache.getOrCompute("u1:abc", compute);
  assert.equal(second.cached, true);
  assert.equal(second.shared, false);
  assert.equal(second.value, first.value);
  assert.equal(compute.calls, 1);
  assert.deepEqual(cache.counters(), { hits: 1, misses: 1, shared: 0, evictions: 0 });
});

test("TTL 到期後重算，回傳新的值", async () => {
  const clock = fakeClock();
  const cache = createStatsCache({ ttlMs: 45_000, maxEntries: 5, now: clock.now });
  let calls = 0;
  const compute = async () => {
    calls += 1;
    return { total: calls };
  };

  assert.equal((await cache.getOrCompute("u1:abc", compute)).value.total, 1);
  clock.advance(45_000); // 到期時間是「算完 + TTL」，剛好等於 TTL ⇒ 視為過期
  const again = await cache.getOrCompute("u1:abc", compute);
  assert.equal(again.cached, false);
  assert.equal(again.value.total, 2);
  assert.equal(calls, 2);
  assert.equal(cache.counters().misses, 2);
});

test("設定改變 ⇒ 指紋／key 改變，不會回舊值", async () => {
  const baseKey = statsCacheKey(1, BASE_SETTINGS);
  // 會影響統計的欄位：每一個都要讓 key 改變
  const relevantChanges = [
    { watchDistricts: ["4-1"] },
    { searchUrls: [] },
    { priceMin: 9000 },
    { priceMax: 30000 },
    { priceMaxIncludesExtras: true },
    { areaMax: 30 },
    { minBuildingFloors: 1 },
    { wholeFloorOnly: true },
    { excludeLowFloors: false },
    { excludeRooftop: false },
    { hasParking: true },
    { excludeKeywords: ["西曬"] },
    { excludeAgents: ["房仲"] },
    { excludeAgentIds: [42] },
    { excludeBoxes: [{ south: 24.7, west: 120.8, north: 24.9, east: 121.0, enabled: true }] },
    { commuteKm: 10 },
    { workLat: 25.0 },
    { workLng: 121.5 },
    { commuteMode: "car" },
  ];
  for (const patch of relevantChanges) {
    const changed = { ...BASE_SETTINGS, ...patch };
    assert.notEqual(statsCacheKey(1, changed), baseKey, `設定 ${Object.keys(patch)[0]} 改變應產生新 key`);
  }
  // 與統計無關的欄位：key 不變（避免無謂失效）
  for (const patch of [
    { hiddenCityIds: [2, 3] },
    { housing_kinds: ["suite"] },
    { listing_sources: ["sinyi"] },
    { discordWebhook: "https://discord.example/other" },
    { notificationsPaused: true },
  ]) {
    assert.equal(statsCacheKey(1, { ...BASE_SETTINGS, ...patch }), baseKey, `設定 ${Object.keys(patch)[0]} 不應影響統計 key`);
  }
  // 同一組設定的陣列順序不影響指紋（watchDistricts／searchUrls／關鍵字）
  const reordered = {
    ...BASE_SETTINGS,
    watchDistricts: [...BASE_SETTINGS.watchDistricts].reverse(),
    excludeKeywords: [...BASE_SETTINGS.excludeKeywords].reverse(),
  };
  assert.equal(statsSettingsFingerprint(reordered), statsSettingsFingerprint(BASE_SETTINGS));

  // 快取本身：舊 key 有值，換 key 一定重算，不會把舊值回給新設定
  const cache = createStatsCache({ ttlMs: 45_000, maxEntries: 5 });
  let calls = 0;
  const computeFor = (total) => async () => {
    calls += 1;
    return { total };
  };
  await cache.getOrCompute(baseKey, computeFor(7));
  const changedKey = statsCacheKey(1, { ...BASE_SETTINGS, watchDistricts: ["4-1"] });
  const changed = await cache.getOrCompute(changedKey, computeFor(3));
  assert.equal(changed.cached, false);
  assert.equal(changed.value.total, 3);
  assert.equal(calls, 2);
});

test("single-flight：同一個 key 併發只算一次，其他人等同一份", async () => {
  const cache = createStatsCache({ ttlMs: 45_000, maxEntries: 5 });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const compute = async () => {
    calls += 1;
    await gate;
    return { total: 42 };
  };

  const first = cache.getOrCompute("u9:same", compute);
  const second = cache.getOrCompute("u9:same", compute);
  const third = cache.getOrCompute("u9:same", compute);
  // 讓 microtask 跑一輪：三個都已經登記在同一個 in-flight 上
  await Promise.resolve();
  release();
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.equal(calls, 1);
  assert.deepEqual([a.value.total, b.value.total, c.value.total], [42, 42, 42]);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(b.shared, true);
  assert.equal(c.shared, true);
  assert.equal(cache.counters().shared, 2);

  // 不同 key 不共享
  const other = await cache.getOrCompute("u9:other", async () => ({ total: 1 }));
  assert.equal(other.cached, false);
});

test("上限淘汰：最多保留 N 個 key，最久沒用的先走（LRU）", async () => {
  const cache = createStatsCache({ ttlMs: 45_000, maxEntries: 3 });
  const compute = countedCompute({ total: 1 });

  await cache.getOrCompute("k1", compute);
  await cache.getOrCompute("k2", compute);
  await cache.getOrCompute("k3", compute);
  assert.equal(cache.size(), 3);

  // 命中 k1 ⇒ 變成最新；再放 k4 ⇒ 最舊的 k2 應被淘汰
  await cache.getOrCompute("k1", compute);
  await cache.getOrCompute("k4", compute);
  assert.equal(cache.size(), 3);
  assert.equal(cache.counters().evictions, 1);

  const k2 = await cache.getOrCompute("k2", compute);
  assert.equal(k2.cached, false, "k2 已被淘汰，必須重算");
  const k1 = await cache.getOrCompute("k1", compute);
  assert.equal(k1.cached, true, "k1 在 LRU 更新後仍應保留");
  assert.ok(cache.size() <= 3);
});

test("命中時回傳形狀與未命中完全相同（同一份 value、同樣的欄位）", async () => {
  const cache = createStatsCache({ ttlMs: 45_000, maxEntries: 5 });
  const shape = {
    total: 120,
    unseen: 30,
    watched: 12,
    watchedTotal: 14,
    same_source: 3,
    hidden: 2,
    offline: 1,
    offlineConfirmed: 0,
    suspected: 4,
    suspectedPending: 1,
    elevator: 60,
    stored: 120,
    filteredOut: 8,
    missingGeo: 9,
    missingRoute: 5,
    dbTotal: 20000,
  };
  const compute = async () => ({ ...shape });
  const fresh = await cache.getOrCompute("u3:shape", compute);
  const hit = await cache.getOrCompute("u3:shape", compute);
  assert.equal(fresh.cached, false);
  assert.equal(hit.cached, true);
  assert.deepEqual(hit.value, fresh.value);
  assert.deepEqual(Object.keys(hit.value), Object.keys(shape));
  assert.equal(JSON.stringify(hit.value), JSON.stringify(fresh.value));
});

test("計算失敗不快取：錯誤往外丟，下一次會重試", async () => {
  const cache = createStatsCache({ ttlMs: 45_000, maxEntries: 5 });
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("listingStatsAsync 掛了");
  };
  await assert.rejects(() => cache.getOrCompute("u4:err", failing), /listingStatsAsync 掛了/);
  assert.equal(cache.inflightSize(), 0, "失敗後 in-flight 必須清掉，不能卡住後續請求");
  assert.equal(cache.size(), 0, "失敗的結果不得進快取");
  await assert.rejects(() => cache.getOrCompute("u4:err", failing), /listingStatsAsync 掛了/);
  assert.equal(calls, 2);
});
