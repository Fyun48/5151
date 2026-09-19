// Before/after comparison for the commute-sort SQL-first path.
// Run: node --no-warnings v3/benchmark-commute-sqlfirst.mjs [rows]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const count = Number(process.argv[2]) || 10000;
const WORK_LAT = 25.05781;
const WORK_LNG = 121.6184;
const dataDir = mkdtempSync(path.join(tmpdir(), "5151-commute-bench-"));
process.env.DATA_DIR = dataDir;
const app = await import("./src/db.js");
const uid = app.ensureUser("commute-bench@example.test", { role: "admin" });
const settings = {
  ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
  priceMin: 0, priceMax: 0, priceMaxIncludesExtras: true, commuteKm: 25,
  wholeFloorOnly: false, excludeLowFloors: false, excludeRooftop: false, hasParking: false,
  excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
  areaMax: 0, minBuildingFloors: 0, workLat: WORK_LAT, workLng: WORK_LNG, commuteMode: "scooter",
};

app.db.exec("BEGIN");
for (let i = 1; i <= count; i++) {
  const lat = 25.05 + (i % 500) * 0.0001;
  const lng = 121.5 + Math.floor(i / 500) * 0.0001;
  const stamp = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
  app.upsertListing({
    post_id: i, source: "591", source_id: String(i),
    source_key: "1|8|" + i, search_key: "https://example.test/search",
    title: `通勤${i}`, url: `https://example.test/listing/${i}`,
    price: "20000元", price_num: 20000, extra_fee: 0, extra_fees: [],
    address: `台北市士林區測試路${i}號`, area_name: "20坪", layout: "2房1廳1衛",
    floor_name: "5/12", kind_name: "整層住家/電梯大樓", role_name: "", cover: "",
    tags: "[]", refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    lat, lng, geo_source: "591",
  });
}
app.db.exec("COMMIT");

// seed route_cache for every listing (all within the 25km budget)
for (let i = 1; i <= count; i++) {
  const lat = 25.05 + (i % 500) * 0.0001;
  const lng = 121.5 + Math.floor(i / 500) * 0.0001;
  app.setCachedRoute(lat, lng, WORK_LAT, WORK_LNG, [3 + (i % 17)], null, "scooter", "to_work");
}

function bench(fn, n = 15) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p = (q) => times[Math.min(times.length - 1, Math.ceil((q / 100) * times.length) - 1)];
  return { p50: +p(50).toFixed(2), p95: +p(95).toFixed(2) };
}

for (const sort of ["commute_asc", "commute_desc"]) {
  const base = { userId: uid, searchKeys: [], settings, sort, limit: 50 };
  const old = bench(() => app.listListings(base));
  const neo = bench(() => app.listListingsCommuteSqlFirst(base));
  console.log(`${sort}: node p50=${old.p50}ms p95=${old.p95}ms | sql-first p50=${neo.p50}ms p95=${neo.p95}ms`);
}

app.db.close();
rmSync(dataDir, { recursive: true, force: true });
