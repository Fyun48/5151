// Quick before/after comparison for the SQL-first search path (Phase 7).
// Run: node --no-warnings v3/benchmark-sqlfirst.mjs [rows]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const count = Number(process.argv[2]) || 50000;
const dataDir = mkdtempSync(path.join(tmpdir(), "5151-sqlfirst-bench-"));
process.env.DATA_DIR = dataDir;
const app = await import("./src/db.js");
const uid = app.ensureUser("sqlfirst-bench@example.test", { role: "admin" });
const settings = {
  ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
  priceMin: 0, priceMax: 0, priceMaxIncludesExtras: true, commuteKm: 0,
  wholeFloorOnly: false, excludeLowFloors: false, excludeRooftop: false, hasParking: false,
  excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
  areaMax: 0, minBuildingFloors: 0,
};

app.db.exec("BEGIN");
for (let i = 1; i <= count; i++) {
  const inScope = i % 3 !== 0;
  const stamp = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
  app.upsertListing({
    post_id: i, source: "591", source_id: String(i),
    source_key: (inScope ? "1|8|" : "1|9|") + i, search_key: "https://example.test/search",
    title: `測試住宅${i}`, url: `https://example.test/listing/${i}`,
    price: `${12000 + (i * 137) % 48000}元`, price_num: 12000 + (i * 137) % 48000,
    extra_fee: i % 4 === 0 ? 2000 : 0, extra_fees: [],
    address: (inScope ? "台北市士林區" : "台北市北投區") + `測試路${i}號`,
    area_name: "20坪", layout: "2房1廳1衛", floor_name: "5/12",
    kind_name: "整層住家/電梯大樓", role_name: "", cover: "https://example.test/c.png",
    tags: "[]", refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
  });
}
app.db.exec("COMMIT");

function bench(fn, n = 20) {
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

for (const sort of ["newest", "price_asc"]) {
  const base = { userId: uid, searchKeys: [], settings, sort, limit: 50 };
  const old = bench(() => app.listListings(base));
  const neo = bench(() => app.listListingsSqlFirst(base));
  console.log(`${sort}: node p50=${old.p50}ms p95=${old.p95}ms | sql-first p50=${neo.p50}ms p95=${neo.p95}ms`);
}

app.db.close();
rmSync(dataDir, { recursive: true, force: true });
