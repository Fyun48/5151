import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUCKET_MS,
  MAX_STALE_MS,
  TTL_MS,
  getCachedPublicListings,
  guestCacheNamespace,
  normalizePublicQuery,
  publicListingsCacheSize,
  resetPublicListingsCache,
  resolveGuestCacheNamespace,
} from "../src/publicListings.js";

// PG 訪客快取的 revision-generation（粗粒度 bucket）＋ single-flight 行為。
// cold/warm 毫秒與「bucket 內寫入仍回舊結果」的 live 驗證在隔離庫端到端做，這裡釘純函式語意。

test("SWR 陳舊上限被釘住：MAX_STALE_MS = 45s，且不超過現行 45s 政策", () => {
  assert.equal(BUCKET_MS, 20_000);
  assert.equal(TTL_MS, 20_000);
  assert.equal(MAX_STALE_MS, 45_000);
  assert.ok(MAX_STALE_MS <= 45_000, `MAX_STALE_MS=${MAX_STALE_MS} 必須 ≤ 45_000`);
});

test("guest cache: first miss then same-parameter hit within the generation", async () => {
  resetPublicListingsCache();
  const ns = "pg:guest:v5";
  const query = { districts: ["中山區"], sort: "newest", limit: 40 };
  const first = await getCachedPublicListings(query, async () => ({ listings: [{ post_id: 1 }] }), { namespace: ns });
  assert.equal(first.cache_hit, false);
  assert.deepEqual(first.listings, [{ post_id: 1 }]);
  const second = await getCachedPublicListings(query, async () => assert.fail("same generation must reuse the cached success"), { namespace: ns });
  assert.equal(second.cache_hit, true);
  assert.deepEqual(second.listings, [{ post_id: 1 }]);
});

test("bucket 邊界（假時鐘 20s/21s）：bucket 內沿用同一 generation（hit），跨 bucket 換代回舊值（SWR）", async () => {
  resetPublicListingsCache();
  let t = 0;
  const now = () => t;
  const ns1 = await resolveGuestCacheNamespace({ driver: "postgres", readRevision: async () => 5, now });
  assert.equal(ns1, "pg:guest:v5");
  await getCachedPublicListings({ q: "x" }, async () => ({ listings: [1] }), { namespace: ns1, now });

  // bucket 內（t=10s < 20s）：不重讀 revision，沿用 v5 ⇒ hit。
  t = 10_000;
  const ns2 = await resolveGuestCacheNamespace({ driver: "postgres", readRevision: async () => { throw new Error("must not re-read within bucket"); }, now });
  assert.equal(ns2, "pg:guest:v5");
  const hit = await getCachedPublicListings({ q: "x" }, async () => assert.fail("bucket 內同 generation 應 hit"), { namespace: ns2, now });
  assert.equal(hit.cache_hit, true);

  // 跨 bucket（t=21s ≥ 20s）：重讀 revision → 6 ⇒ 換 generation。年齡 21s ≤ 45s ⇒ SWR 回舊值＋背景重算。
  t = 21_000;
  const ns3 = await resolveGuestCacheNamespace({ driver: "postgres", readRevision: async () => 6, now });
  assert.equal(ns3, "pg:guest:v6");
  const swr = await getCachedPublicListings({ q: "x" }, async () => ({ listings: [2] }), { namespace: ns3, now });
  assert.equal(swr.cache_hit, true);
  assert.equal(swr.stale, true);
  assert.deepEqual(swr.listings, [1]);
});

test("revision read failure is fail-closed: miss + correct fresh data, never an old generation", async () => {
  resetPublicListingsCache();
  let t = 0;
  const now = () => t;
  const ns1 = await resolveGuestCacheNamespace({ driver: "postgres", readRevision: async () => 5, now });
  assert.equal(ns1, "pg:guest:v5");
  await getCachedPublicListings({ q: "x" }, async () => ({ listings: [1] }), { namespace: ns1 });

  // 跨 bucket 後 revision 讀取抛錯：不得沿用舊的 v5，要 fail-closed 回 null。
  t = 21_000;
  const ns2 = await resolveGuestCacheNamespace({ driver: "postgres", readRevision: async () => { throw new Error("pg down"); }, now });
  assert.equal(ns2, null, "revision 讀取失敗不得回舊 generation");
  const payload = { listings: [{ post_id: 11 }] };
  const first = await getCachedPublicListings({ q: "x" }, async () => payload, { namespace: ns2 });
  assert.equal(first.cache_hit, false);
  assert.deepEqual(first.listings, payload.listings);
  const second = await getCachedPublicListings({ q: "x" }, async () => ({ listings: [{ post_id: 22 }] }), { namespace: ns2 });
  assert.equal(second.cache_hit, false);
  assert.deepEqual(second.listings, [{ post_id: 22 }]);
  assert.equal(publicListingsCacheSize(), 1, "fail-closed 不得再寫入（只剩前面 v5 那筆）");
});

test("guest cache key is user-agnostic and never keyed by personal fields", async () => {
  resetPublicListingsCache();
  const guestA = normalizePublicQuery({ districts: ["中山區"], sort: "newest" });
  const guestB = normalizePublicQuery({ districts: ["中山區"], sort: "newest", uid: 42, starred: true, hidden: true });
  assert.equal(guestA, guestB);
  const other = normalizePublicQuery({ districts: ["大安區"], sort: "newest" });
  assert.notEqual(guestA, other, "不同公開參數不得共用同一筆快取");

  const payload = { listings: [{ post_id: 7 }], guest: true };
  const first = await getCachedPublicListings({ districts: ["中山區"] }, async () => payload, { namespace: "pg:guest:v9" });
  assert.equal(first.cache_hit, false);
  assert.deepEqual(first.listings, payload.listings);
  const hit = await getCachedPublicListings({ districts: ["中山區"] }, async () => assert.fail("must reuse the uid=0 guest payload"), { namespace: "pg:guest:v9" });
  assert.equal(hit.cache_hit, true);
  assert.equal(hit.guest, true);
  assert.deepEqual(hit.listings, payload.listings);
});

test("single-flight: 同 key 併發只跑一次 load()，後到者共用同一個 in-flight 結果", async () => {
  resetPublicListingsCache();
  let calls = 0;
  let release;
  const load = () => new Promise((resolve) => { calls += 1; release = resolve; });
  const ns = "pg:guest:v1";
  const p1 = getCachedPublicListings({ q: "same" }, load, { namespace: ns });
  const p2 = getCachedPublicListings({ q: "same" }, load, { namespace: ns });
  const p3 = getCachedPublicListings({ q: "same" }, load, { namespace: ns });
  assert.equal(calls, 1, "single-flight：同 key 併發只該算一次 load");
  release({ listings: [42] });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.deepEqual(r1.listings, [42]);
  assert.deepEqual(r2.listings, [42]);
  assert.deepEqual(r3.listings, [42]);
  assert.equal(r1.cache_hit, false);
  assert.equal(r2.cache_hit, false);
  assert.equal(r3.cache_hit, false);
  assert.equal(calls, 1);
  // 完成後才來的請求 → 命中快取（不是 in-flight）。
  const hit = await getCachedPublicListings({ q: "same" }, async () => assert.fail("completed entry must hit"), { namespace: ns });
  assert.equal(hit.cache_hit, true);
});

test("sqlite namespace path is verbatim and never consults the revision", async () => {
  resetPublicListingsCache();
  assert.equal(guestCacheNamespace({ driver: "sqlite" }), "sqlite:guest:v2");
  assert.equal(guestCacheNamespace({ driver: "sqlite", revision: 123 }), "sqlite:guest:v2");
  assert.equal(
    await resolveGuestCacheNamespace({ driver: "sqlite", readRevision: async () => { throw new Error("must not be called"); } }),
    "sqlite:guest:v2",
  );
  const first = await getCachedPublicListings({}, async () => ({ listings: ["sqlite"] }), { namespace: "sqlite:guest:v2" });
  assert.equal(first.cache_hit, false);
  const hit = await getCachedPublicListings({}, async () => assert.fail("sqlite v2 must hit"), { namespace: "sqlite:guest:v2" });
  assert.equal(hit.cache_hit, true);
});
