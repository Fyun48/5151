import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCachedPublicListings,
  guestCacheNamespace,
  normalizePublicQuery,
  publicListingsCacheSize,
  resetPublicListingsCache,
  resolveGuestCacheNamespace,
} from "../src/publicListings.js";

// PG 訪客快取的 revision-generation 行為：這一批把「PG 模式 namespace 永遠 null ⇒ 永不命中」
// 修成「以 data_revision 的 MAX(id) 當 generation」，並釘住 fail-closed 與個人化隔離。
// （cold/warm 毫秒與「寫入後不命中」的 live 驗證在隔離庫端到端做，這裡只釘純函式語意。）

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

test("bumping the revision changes the generation and forces a miss", async () => {
  resetPublicListingsCache();
  const ns1 = await resolveGuestCacheNamespace({ driver: "postgres", readRevision: async () => 7 });
  const ns2 = await resolveGuestCacheNamespace({ driver: "postgres", readRevision: async () => 8 });
  assert.equal(ns1, "pg:guest:v7");
  assert.equal(ns2, "pg:guest:v8");
  assert.notEqual(ns1, ns2);
  await getCachedPublicListings({}, async () => ({ listings: [1] }), { namespace: ns1 });
  const hit = await getCachedPublicListings({}, async () => assert.fail("same generation must hit"), { namespace: ns1 });
  assert.equal(hit.cache_hit, true);
  const miss = await getCachedPublicListings({}, async () => ({ listings: [2] }), { namespace: ns2 });
  assert.equal(miss.cache_hit, false);
  assert.deepEqual(miss.listings, [2]);
});

test("revision read failure is fail-closed: miss + correct fresh data, never an empty/fake payload", async () => {
  resetPublicListingsCache();
  const ns = await resolveGuestCacheNamespace({
    driver: "postgres",
    readRevision: async () => { throw new Error("pg down"); },
  });
  assert.equal(ns, null);
  // null namespace ⇒ no hit and no write, but the real payload must still be served.
  const payload = { listings: [{ post_id: 11 }] };
  const first = await getCachedPublicListings({}, async () => payload, { namespace: ns });
  assert.equal(first.cache_hit, false);
  assert.deepEqual(first.listings, payload.listings);
  const second = await getCachedPublicListings({}, async () => ({ listings: [{ post_id: 22 }] }), { namespace: ns });
  assert.equal(second.cache_hit, false);
  assert.deepEqual(second.listings, [{ post_id: 22 }]);
  assert.equal(publicListingsCacheSize(), 0, "fail-closed must never write into the cache");
});

test("guest cache key is user-agnostic and never keyed by personal fields", async () => {
  resetPublicListingsCache();
  // 個人化欄位（uid／starred／hidden）不是訪客快取鍵的一部分：兩個訪客問同一組公開參數，
  // 鍵必須相同（訪客結果本來就相同）；帶個人欄位不得產生不同鍵。
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

test("sqlite namespace path is verbatim and never consults the revision", async () => {
  resetPublicListingsCache();
  assert.equal(guestCacheNamespace({ driver: "sqlite" }), "sqlite:guest:v2");
  assert.equal(guestCacheNamespace({ driver: "sqlite", revision: 123 }), "sqlite:guest:v2");
  assert.equal(
    await resolveGuestCacheNamespace({ driver: "sqlite", readRevision: async () => { throw new Error("must not be called"); } }),
    "sqlite:guest:v2",
  );
  // sqlite 路徑仍照舊寫入同一代（v2），不改 namespace。
  const first = await getCachedPublicListings({}, async () => ({ listings: ["sqlite"] }), { namespace: "sqlite:guest:v2" });
  assert.equal(first.cache_hit, false);
  const hit = await getCachedPublicListings({}, async () => assert.fail("sqlite v2 must hit"), { namespace: "sqlite:guest:v2" });
  assert.equal(hit.cache_hit, true);
});
