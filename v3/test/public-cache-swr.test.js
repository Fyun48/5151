import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_STALE_MS,
  MAX_STALE_MS_CEILING,
  TTL_MS,
  getCachedPublicListings,
  guestSwrMaxStaleMs,
  publicListingsCacheSize,
  resetPublicListingsCache,
} from "../src/publicListings.js";

// SWR（stale-while-revalidate）訪客快取語意。
// 2026-10-10 建立（陳舊上界 45s）；2026-10-16 放寬到 600s（10 分鐘，對齊爬蟲約 20 分鐘一輪）。
// 用假時鐘釘住：
//   ① 年齡 5 分鐘、同 generation ⇒ 回舊值（非 promise）＋背景重算一次，**不得**同步重算；
//   ② 年齡 11 分鐘 ⇒ 超過上界，同步重算；
//   ③ 背景重算 single-flight：同 key 併發只有一次 compute；
//   ④ SWR 期間回的是「上一次成功計算的完整結果」（不是空值／半成品）；
//   ⑤ generation 換代 ⇒ 仍在 SWR（先回舊值）；沒有 entry ⇒ 仍同步計算（已知殘留）；
//   ⑥ 陳舊上界可以被環境變數調小，但有硬上界 clamp。

test("SWR 常數：MAX_STALE_MS = 600s（10 分鐘），TTL 不變，且 600s 是硬上界", () => {
  assert.equal(MAX_STALE_MS, 600_000);
  assert.equal(MAX_STALE_MS_CEILING, 600_000);
  assert.equal(TTL_MS, 20_000, "TTL 不變：仍是同 generation 的『零背景工作』新鮮窗口");
  assert.ok(MAX_STALE_MS <= MAX_STALE_MS_CEILING);
});

test("⑥ 陳舊上界環境變數：只能調小，超過 10 分鐘被 clamp 回 600s", () => {
  assert.equal(guestSwrMaxStaleMs({}), 600_000, "未設 ⇒ 預設 10 分鐘");
  assert.equal(guestSwrMaxStaleMs({ GUEST_SWR_MAX_STALE_MS: "120000" }), 120_000, "調小要生效");
  assert.equal(
    guestSwrMaxStaleMs({ GUEST_SWR_MAX_STALE_MS: "999999999" }),
    MAX_STALE_MS_CEILING,
    "調大於 Owner 核可的 10 分鐘 ⇒ 夾回硬上界",
  );
  assert.equal(guestSwrMaxStaleMs({ GUEST_SWR_MAX_STALE_MS: "1000" }), TTL_MS, "不得小於新鮮窗口 TTL_MS");
  assert.equal(guestSwrMaxStaleMs({ GUEST_SWR_MAX_STALE_MS: "abc" }), 600_000);
  assert.equal(guestSwrMaxStaleMs({ GUEST_SWR_MAX_STALE_MS: "" }), 600_000);
  assert.equal(guestSwrMaxStaleMs({ GUEST_SWR_MAX_STALE_MS: "-5" }), 600_000);
});

test("① 年齡 5 分鐘、同 generation ⇒ 立刻回舊值＋背景重算一次（不得同步重算）", async () => {
  resetPublicListingsCache();
  let t = 0;
  const now = () => t;
  let loads = 0;
  const load = async () => {
    const n = ++loads;
    await Promise.resolve();
    return { listings: [n] };
  };
  const first = await getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
  assert.equal(first.cache_hit, false);
  assert.deepEqual(first.listings, [1]);

  t = 300_000; // 5 分鐘：> TTL(20s)、≤ 600s 上界，且 generation 沒有換
  const second = getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
  // 回舊值必須是同步的（毫秒量級）；同步重算會回 promise，這裡若回 promise 就是慢掉。
  assert.equal(typeof second.then, "undefined", "5 分鐘（同 generation）不得同步重算");
  assert.equal(second.cache_hit, true);
  assert.equal(second.stale, true);
  assert.deepEqual(second.listings, [1], "必須回舊值，不是重算後的新值");
  assert.equal(loads, 2, "背景重算只被發起一次（冷算 + 1 次背景）");

  // 等背景重算完成 → entry 換成同一代的新結果。
  await new Promise((resolve) => setTimeout(resolve, 5));
  const third = await getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
  assert.equal(third.cache_hit, true);
  assert.equal(third.stale, undefined);
  assert.deepEqual(third.listings, [2]);
  assert.equal(loads, 2, "背景重算完成後、年齡回到 0 ⇒ 新鮮命中，不得再重算");
});

test("② 年齡 11 分鐘 ⇒ 超過 600s 上界，同步重算", async () => {
  resetPublicListingsCache();
  let t = 0;
  const now = () => t;
  let loads = 0;
  const load = async () => {
    const n = ++loads;
    await Promise.resolve();
    return { listings: [n] };
  };
  const first = await getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
  assert.equal(first.cache_hit, false);

  t = 660_000; // 11 分鐘 > 600s
  const second = await getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
  assert.equal(second.cache_hit, false, "超過 MAX_STALE_MS 必須同步重算");
  assert.equal(second.stale, undefined);
  assert.deepEqual(second.listings, [2]);
  assert.equal(loads, 2);
});

test("③ 背景重算 single-flight：同 key 併發只起一個 compute", async () => {
  resetPublicListingsCache();
  let t = 0;
  const now = () => t;
  let loads = 0;
  const releases = [];
  const load = () => {
    loads += 1;
    return new Promise((resolve) => releases.push(resolve));
  };
  const p1 = getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
  assert.equal(loads, 1);
  releases[0]({ listings: ["v1"] });
  await p1;

  t = 300_000;
  const s1 = getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
  const s2 = getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
  assert.equal(s1.stale, true);
  assert.equal(s2.stale, true);
  assert.deepEqual(s1.listings, ["v1"]);
  assert.deepEqual(s2.listings, ["v1"]);
  assert.equal(loads, 2, "併發的兩個 SWR 請求只起一個背景重算（single-flight）");

  releases[1]({ listings: ["v2"] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fresh = await getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
  assert.equal(fresh.cache_hit, true);
  assert.equal(fresh.stale, undefined);
  assert.deepEqual(fresh.listings, ["v2"]);
  assert.equal(loads, 2, "背景重算完成後不得再起重算");
});

test("④ SWR 期間回的是上一次成功計算的完整結果（不是空值／半成品）", async () => {
  resetPublicListingsCache();
  let t = 0;
  const now = () => t;
  let resolveRevision;
  const full = {
    listings: [{ post_id: 11 }, { post_id: 22 }],
    hasMore: true,
    nextOffset: 40,
    totalMatched: 12_345,
    queryVersion: 2,
  };
  const first = await getCachedPublicListings({}, async () => full, { namespace: "pg:guest:v9", now });
  assert.deepEqual(first.listings, full.listings);

  t = 300_000;
  // 背景重算刻意卡住（永遠不 resolve）⇒ 這個請求只能拿到舊值，證明它不是等重算。
  const hanging = () => new Promise((resolve) => { resolveRevision = resolve; });
  const second = getCachedPublicListings({}, hanging, { namespace: "pg:guest:v9", now });
  assert.equal(typeof second.then, "undefined");
  assert.deepEqual(
    { listings: second.listings, hasMore: second.hasMore, nextOffset: second.nextOffset, totalMatched: second.totalMatched, queryVersion: second.queryVersion },
    full,
    "SWR 回應必須是完整的上一份結果（含 hasMore／nextOffset／totalMatched／queryVersion）",
  );
  assert.equal(second.cache_age_ms, 300_000);
  resolveRevision({ ...full, listings: [{ post_id: 33 }] });
});

test("⑤ generation 換代但仍在 10 分鐘上界內 ⇒ 一樣 SWR 先回舊值", async () => {
  resetPublicListingsCache();
  let t = 0;
  const now = () => t;
  let loads = 0;
  const load = async () => {
    const n = ++loads;
    await Promise.resolve();
    return { listings: [n] };
  };
  const first = await getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
  assert.equal(first.cache_hit, false);

  t = 599_000; // 換代、且還在 600s 上界內
  const second = getCachedPublicListings({}, load, { namespace: "pg:guest:v2", now });
  assert.equal(typeof second.then, "undefined");
  assert.equal(second.cache_hit, true);
  assert.equal(second.stale, true);
  assert.deepEqual(second.listings, [1]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual((await getCachedPublicListings({}, load, { namespace: "pg:guest:v2", now })).listings, [2]);
});

test("⑤ 沒有 entry 的第一次查詢仍是同步計算（已知殘留，不改語意）", async () => {
  resetPublicListingsCache();
  let calls = 0;
  const load = async () => {
    calls += 1;
    await Promise.resolve();
    return { listings: ["cold"] };
  };
  const cold = getCachedPublicListings({ district: "新查詢形狀" }, load, { namespace: "pg:guest:v1" });
  assert.equal(typeof cold.then, "function", "沒有 entry ⇒ 必須同步計算（回 promise 讓呼叫端等）");
  const awaited = await cold;
  assert.equal(awaited.cache_hit, false);
  assert.deepEqual(awaited.listings, ["cold"]);
  assert.equal(calls, 1);
});

test("④ 間隔 150 秒連續 12 發（同 generation）⇒ 每一發都回舊值，不得有任何一發同步重算", async () => {
  resetPublicListingsCache();
  let t = 0;
  const now = () => t;
  let loads = 0;
  const load = async () => {
    const n = ++loads;
    await Promise.resolve();
    return { listings: [n] };
  };
  // 冷啟動（第一發）：沒有 entry ⇒ 同步計算，這是我方接受的已知殘留。
  assert.deepEqual((await getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now })).listings, [1]);
  const syncHits = [];
  for (let shot = 0; shot < 12; shot += 1) {
    t += 150_000;
    const resp = getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
    if (typeof resp.then === "function") syncHits.push(shot);
    else assert.equal(resp.cache_hit, true);
    // 讓背景重算落地（entry 年齡歸零），再跑下一發。
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(syncHits, [], "12 發（跨 1800 秒）都必須走 SWR；出現同步重算的那一發就是低流量站的卡頓來源");
  assert.equal(loads, 13, "冷算 1 次 ＋ 每發各 1 次背景重算");
});

test("④ revision 讀取失敗 ⇒ fail-closed：不回舊值、不寫入", async () => {
  resetPublicListingsCache();
  // 先寫一筆 v5 的 entry。
  await getCachedPublicListings({ q: "x" }, async () => ({ listings: [1] }), { namespace: "pg:guest:v5" });
  assert.equal(publicListingsCacheSize(), 1);

  // namespace: null 表示 revision 讀取失敗（resolveGuestCacheNamespace 已 fail-closed）。
  // 即使有舊 entry，也必須走全新 load、不回舊值、不寫入。
  const a = await getCachedPublicListings({ q: "x" }, async () => ({ listings: ["A"] }), { namespace: null });
  assert.equal(a.cache_hit, false);
  assert.equal(a.stale, undefined);
  assert.deepEqual(a.listings, ["A"]);
  const b = await getCachedPublicListings({ q: "x" }, async () => ({ listings: ["B"] }), { namespace: null });
  assert.equal(b.cache_hit, false);
  assert.deepEqual(b.listings, ["B"]);
  assert.equal(publicListingsCacheSize(), 1, "fail-closed 不得寫入（只剩 v5 那筆）");
});

test("SWR 背景重算拋錯不得影響已回出的舊值", async () => {
  resetPublicListingsCache();
  const originalError = console.error;
  console.error = () => {};
  try {
    let t = 0;
    const now = () => t;
    let loads = 0;
    const load = async () => {
      loads += 1;
      await Promise.resolve();
      if (loads >= 2) throw new Error("revalidate boom");
      return { listings: ["old"] };
    };
    const first = await getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
    assert.equal(first.cache_hit, false);

    t = 300_000;
    const second = getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
    assert.equal(second.cache_hit, true);
    assert.equal(second.stale, true);
    assert.deepEqual(second.listings, ["old"], "背景重算失敗仍回舊值");
    // 等背景重算失敗被吞掉（不得 unhandled rejection）。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
    assert.equal(third.cache_hit, true);
    assert.equal(third.stale, true);
    assert.deepEqual(third.listings, ["old"], "重算失敗不寫入，仍回舊值");
  } finally {
    console.error = originalError;
  }
});

test("背景重算失敗時，年齡 > 600s 的同步重算 joiner 拿到錯誤而非 undefined", async () => {
  resetPublicListingsCache();
  const originalError = console.error;
  console.error = () => {};
  try {
    let t = 0;
    const now = () => t;
    let loads = 0;
    const releases = [];
    const load = () => {
      loads += 1;
      return new Promise((resolve, reject) => releases.push({ resolve, reject }));
    };
    const p1 = getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
    assert.equal(loads, 1);
    releases[0].resolve({ listings: ["old"] });
    await p1;

    // age 300s：仍在 600s 上界內 → SWR 回舊值，背景重算掛起（load #2）。
    t = 300_000;
    const stale = getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
    assert.equal(stale.stale, true);
    assert.equal(loads, 2);

    // age 601s：超過 MAX_STALE_MS → 同步重算，但 single-flight 已有 in-flight revalidate → 共用。
    t = 601_000;
    const joiner = getCachedPublicListings({}, load, { namespace: "pg:guest:v1", now });
    assert.equal(typeof joiner.then, "function", "joiner 應共用 in-flight promise");
    assert.equal(loads, 2, "不得起第三個 load");

    // 背景重算失敗 → joiner 拿到 reject（不是 undefined）。
    releases[1].reject(new Error("pg down"));
    await assert.rejects(joiner, /pg down/);
  } finally {
    console.error = originalError;
  }
});
