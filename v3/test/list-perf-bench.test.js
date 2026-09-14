import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "list-perf-"));

const { listListings, listPublicListings, publicSearchSettings, upsertListing, listingCount, resetPublicListingsDecorateCount, publicListingsDecorateCount } = await import("../src/db.js");
const { getCachedPublicListings, resetPublicListingsCache } = await import("../src/publicListings.js");

function pct(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

function seed(n) {
  const stamp = "2026-09-01T00:00:00.000Z";
  for (let i = 1; i <= n; i += 1) {
    upsertListing({
      post_id: 800000 + i,
      source_key: `1|8||台北市士林區中正路${i}號|3F|12|2房1廳`,
      search_key: "https://rent.591.com.tw/list?region=1&section=8",
      title: `合成物件 ${i}`,
      url: `https://rent.591.com.tw/${800000 + i}`,
      price: String(18000 + (i % 40) * 100),
      price_num: 18000 + (i % 40) * 100,
      extra_fee: 0,
      extra_fees: [],
      address: `台北市士林區中正路${i}號`,
      area_name: "12坪",
      layout: "2房1廳",
      floor_name: "3F/10F",
      kind_name: "整層住家",
      role_name: "屋主",
      cover: i % 7 === 0 ? "" : `https://img.example/${i}.jpg`,
      tags: "[]",
      refresh_time: "2小時前",
      first_seen_at: stamp,
      last_seen_at: stamp,
      last_event: "new",
      source: i % 5 === 0 ? "sinyi" : "591",
      source_id: String(800000 + i),
    });
  }
}

function timeList(sameHouse) {
  const t0 = performance.now();
  const last = listListings({
    filter: "all",
    sort: "price_asc",
    limit: 500,
    userId: 1,
    sameHouse,
  });
  return { ms: performance.now() - t0, last };
}

function summarize(label, samples, last) {
  return {
    label,
    dataset: listingCount(),
    matched: last.totalMatched,
    returned: last.listings.length,
    p50: pct(samples, 0.5),
    p95: pct(samples, 0.95),
    samples,
  };
}

test("guest public listings cache is cheaper than a cold decorate", () => {
  seed(80);
  resetPublicListingsCache();
  resetPublicListingsDecorateCount();
  const query = { districts: ["士林區"], sort: "price_asc", limit: 40, offset: 0 };
  const load = () => listPublicListings({ ...query, settings: publicSearchSettings(query) });
  const coldSamples = [];
  const t0 = performance.now();
  const cold = getCachedPublicListings(query, load);
  coldSamples.push(performance.now() - t0);
  const t1 = performance.now();
  const hot = getCachedPublicListings(query, load);
  const cachedMs = performance.now() - t1;
  assert.equal(cold.cache_hit, false);
  assert.equal(hot.cache_hit, true);
  assert.equal(publicListingsDecorateCount(), 1);
  assert.ok(cachedMs <= coldSamples[0] + 5, `cached ${cachedMs} should not exceed cold ${coldSamples[0]}`);
  console.log(JSON.stringify({ guest_cold_ms: coldSamples[0], guest_cached_ms: cachedMs, returned: cold.listings.length }, null, 2));
});

test("listListings benchmark: skip unused same-house decorate on 400 listings", () => {
  seed(400);
  assert.equal(listingCount(), 400);

  // 合成 400 筆沒有 match_post_id／same_house_role，兩條路徑 decorate 工作量相同。
  // 先暖機再交錯取樣，避免「先量 true、再量 false」把 JIT／GC 波動算成退化。
  for (let i = 0; i < 4; i += 1) {
    timeList(true);
    timeList(false);
  }

  const beforeSamples = [];
  const afterSamples = [];
  let lastBefore = { totalMatched: 0, listings: [] };
  let lastAfter = { totalMatched: 0, listings: [] };
  for (let i = 0; i < 15; i += 1) {
    const beforeRun = timeList(true);
    const afterRun = timeList(false);
    beforeSamples.push(beforeRun.ms);
    afterSamples.push(afterRun.ms);
    lastBefore = beforeRun.last;
    lastAfter = afterRun.last;
  }

  const before = summarize("sameHouse-all", beforeSamples, lastBefore);
  const after = summarize("sameHouse-needed-only", afterSamples, lastAfter);
  const paired = afterSamples.map((ms, i) => ms - beforeSamples[i]);
  const pairedP50 = pct(paired, 0.5);
  assert.equal(before.dataset, 400);
  assert.equal(after.dataset, 400);
  assert.ok(
    after.p50 <= before.p50 + 5,
    `after p50 ${after.p50} should not regress vs ${before.p50}`,
  );
  assert.ok(
    pairedP50 <= 5,
    `paired p50 delta ${pairedP50} should not exceed +5ms`,
  );
  console.log(JSON.stringify({ before, after, paired_p50_ms: pairedP50 }, null, 2));
});
