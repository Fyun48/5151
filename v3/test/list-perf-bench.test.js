import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "list-perf-"));

const { listListings, upsertListing, listingCount } = await import("../src/db.js");

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

function measure(label, sameHouse) {
  const samples = [];
  let last = { matched: 0, returned: 0 };
  for (let i = 0; i < 6; i += 1) {
    const t0 = performance.now();
    last = listListings({
      filter: "all",
      sort: "price_asc",
      limit: 500,
      userId: 1,
      sameHouse,
    });
    samples.push(performance.now() - t0);
  }
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

test("listListings benchmark: skip unused same-house decorate on 400 listings", () => {
  seed(400);
  const before = measure("sameHouse-all", true);
  const after = measure("sameHouse-needed-only", false);
  assert.equal(before.dataset, 400);
  assert.ok(after.p50 <= before.p50 + 5, `after p50 ${after.p50} should not regress vs ${before.p50}`);
  console.log(JSON.stringify({ before, after }, null, 2));
});
