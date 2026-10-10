import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_STALE_MS,
  getCachedPublicListings,
  publicListingsCacheSize,
  resetPublicListingsCache,
} from "../src/publicListings.js";

// SWR（stale-while-revalidate）訪客快取語意（2026-10-10）。
// 用假時鐘釘住「generation 換代但年齡 ≤ 45s → 回舊值＋背景重算一次」、
// 「> 45s → 同步重算」「背景重算 single-flight」「revision 讀取失敗 fail-closed」。

test("SWR 常數：MAX_STALE_MS = 45s，且不超過現行 45s 政策上限", () => {
  assert.equal(MAX_STALE_MS, 45_000);
  assert.ok(MAX_STALE_MS <= 45_000);
});

test("① 年齡 ≤ 45s 且 generation 已換 ⇒ 立刻回舊值＋背景重算被發起一次", async () => {
  resetPublicListingsCache();
  let t = 0;
  const now = () => t;
  let loads = 0;
  const load = async () => {
    const n = ++loads;
    await Promise.resolve();
    return { listings: [n] };
  };
  const first = await getCachedPublicListings({}, load, { namespace: "v1", now });
  assert.equal(first.cache_hit, false);
  assert.deepEqual(first.listings, [1]);

  t = 44_000; // 44s ≤ 45s
  const second = getCachedPublicListings({}, load, { namespace: "v2", now });
  // 回舊值必須是同步的（毫秒量級），不是等待重算的 promise。
  assert.equal(typeof second.then, "undefined", "SWR 回舊值不得回 promise（不得等重算）");
  assert.equal(second.cache_hit, true);
  assert.equal(second.stale, true);
  assert.deepEqual(second.listings, [1], "必須回舊值，不是重算後的新值");
  assert.equal(loads, 2, "背景重算只被發起一次（冷算 + 1 次背景）");

  // 等背景重算完成 → entry 換成新代。
  await new Promise((resolve) => setTimeout(resolve, 5));
  const third = await getCachedPublicListings({}, load, { namespace: "v2", now });
  assert.equal(third.cache_hit, true);
  assert.equal(third.stale, undefined);
  assert.deepEqual(third.listings, [2]);
  assert.equal(loads, 2, "同 generation 新鮮命中不得再重算");
});

test("② 年齡 > 45s ⇒ 同步重算（回到現行行為）", async () => {
  resetPublicListingsCache();
  let t = 0;
  const now = () => t;
  let loads = 0;
  const load = async () => {
    const n = ++loads;
    await Promise.resolve();
    return { listings: [n] };
  };
  const first = await getCachedPublicListings({}, load, { namespace: "v1", now });
  assert.equal(first.cache_hit, false);

  t = 46_000; // 46s > 45s
  const second = await getCachedPublicListings({}, load, { namespace: "v2", now });
  assert.equal(second.cache_hit, false, "超過 MAX_STALE_MS 必須同步重算");
  assert.equal(second.stale, undefined);
  assert.deepEqual(second.listings, [2]);
  assert.equal(loads, 2);
});

test("③ 背景重算 single-flight：同 key 併發只起一個重算", async () => {
  resetPublicListingsCache();
  let t = 0;
  const now = () => t;
  let loads = 0;
  const releases = [];
  const load = () => {
    loads += 1;
    return new Promise((resolve) => releases.push(resolve));
  };
  const p1 = getCachedPublicListings({}, load, { namespace: "v1", now });
  assert.equal(loads, 1);
  releases[0]({ listings: ["v1"] });
  await p1;

  t = 44_000;
  const s1 = getCachedPublicListings({}, load, { namespace: "v2", now });
  const s2 = getCachedPublicListings({}, load, { namespace: "v2", now });
  assert.equal(s1.stale, true);
  assert.equal(s2.stale, true);
  assert.deepEqual(s1.listings, ["v1"]);
  assert.deepEqual(s2.listings, ["v1"]);
  assert.equal(loads, 2, "併發的兩個 SWR 請求只起一個背景重算（single-flight）");

  releases[1]({ listings: ["v2"] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fresh = await getCachedPublicListings({}, load, { namespace: "v2", now });
  assert.equal(fresh.cache_hit, true);
  assert.equal(fresh.stale, undefined);
  assert.deepEqual(fresh.listings, ["v2"]);
  assert.equal(loads, 2, "背景重算完成後不得再起重算");
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
    const first = await getCachedPublicListings({}, load, { namespace: "v1", now });
    assert.equal(first.cache_hit, false);

    t = 10_000;
    const second = getCachedPublicListings({}, load, { namespace: "v2", now });
    assert.equal(second.cache_hit, true);
    assert.equal(second.stale, true);
    assert.deepEqual(second.listings, ["old"], "背景重算失敗仍回舊值");
    // 等背景重算失敗被吞掉（不得 unhandled rejection）。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = getCachedPublicListings({}, load, { namespace: "v2", now });
    assert.equal(third.cache_hit, true);
    assert.equal(third.stale, true);
    assert.deepEqual(third.listings, ["old"], "重算失敗不寫入，仍回舊值");
  } finally {
    console.error = originalError;
  }
});

test("背景重算失敗時，年齡 > 45s 的同步重算 joiner 拿到錯誤而非 undefined", async () => {
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
    const p1 = getCachedPublicListings({}, load, { namespace: "v1", now });
    assert.equal(loads, 1);
    releases[0].resolve({ listings: ["old"] });
    await p1;

    // age 44s：換代 → SWR 回舊值，背景重算掛起（load #2）。
    t = 44_000;
    const stale = getCachedPublicListings({}, load, { namespace: "v2", now });
    assert.equal(stale.stale, true);
    assert.equal(loads, 2);

    // age 46s：超過 MAX_STALE_MS → 同步重算，但 single-flight 已有 in-flight revalidate → 共用。
    t = 46_000;
    const joiner = getCachedPublicListings({}, load, { namespace: "v2", now });
    assert.equal(typeof joiner.then, "function", "joiner 應共用 in-flight promise");
    assert.equal(loads, 2, "不得起第三個 load");

    // 背景重算失敗 → joiner 拿到 reject（不是 undefined）。
    releases[1].reject(new Error("pg down"));
    await assert.rejects(joiner, /pg down/);
  } finally {
    console.error = originalError;
  }
});
