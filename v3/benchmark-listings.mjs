// Reproducible synthetic benchmark. Always uses a new temporary database.
// Run: node v3/benchmark-listings.mjs [row count] [mixed|relations|interactive]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

const dataDir = mkdtempSync(path.join(tmpdir(), "5151-query-benchmark-"));
process.env.DATA_DIR = dataDir;
const realNow = Date.now;
try {
  const app = await import("./src/db.js");
  const uid = app.ensureUser("benchmark@example.test", { role: "admin" });
  const interactive = process.argv[3] === "interactive";
  const otherUid = interactive ? app.ensureUser("second-benchmark@example.test", { role: "admin" }) : uid;
  const settings = {
    ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
    priceMin: 0, priceMax: interactive ? 36000 : 0, commuteKm: 5, workLat: 25.1, workLng: 121.52,
    wholeFloorOnly: false, excludeLowFloors: false, excludeRooftop: false,
    excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
  };
  const seed = new DatabaseSync(path.join(dataDir, "v3.db"));
  const insert = seed.prepare(`INSERT INTO listings
    (post_id, source_key, search_key, title, url, price, price_num, address, area_name,
     layout, floor_name, kind_name, tags, first_seen_at, last_seen_at, lat, lng, geo_source, self_body)
    VALUES (?, ?, 'benchmark', ?, ?, ?, ?, ?, '25坪', '2房1廳1衛', '5/12',
            '整層住家/電梯大樓', '[]', ?, ?, 25.09, 121.51, '591', ?)`);
  const count = Math.max(100, Math.min(Number(process.argv[2]) || 64000, 100000));
  const relations = interactive || process.argv[3] === "relations";
  const mixed = relations || process.argv[3] === "mixed";
  seed.exec("BEGIN");
  for (let i = 1; i <= count; i++) {
    const price = 15000 + (i * 137) % 60000;
    const selected = !mixed || (relations ? Math.floor((i - 1) / 2) % (interactive ? 14 : 40) === 0 : i % 40 === 0);
    const address = `${selected ? "台北市士林區" : "新北市中和區"}測試路${i}號`;
    const stamp = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
    insert.run(i, `${selected ? "1|8" : "3|38"}||${address}`, `測試住宅${i}`, `https://example.test/${i}`,
      String(price), price, address, stamp, stamp, "合成物件說明。".repeat(100));
  }
  seed.exec("COMMIT");
  if (relations) {
    // Many unrelated cross-platform pairs outside the member's districts.
    // Seed both directions, including cycles and unrelated foreign pairs.
    seed.exec(`UPDATE listings SET
      match_post_id = CASE WHEN post_id % 2 = 0 THEN post_id - 1 ELSE post_id + 1 END,
      match_level = 'high' WHERE post_id % 10 < 8`);
  }
  seed.close();
  // Simulate two members operating every six seconds without sleeping. Query
  // duration still uses the real monotonic performance clock.
  let clock = realNow();
  if (interactive) Date.now = () => clock;
  const results = [];
  for (const sort of ["newest", "fit_desc", "price_asc", "commute_asc", "newest"]) {
    const member = interactive && results.length % 2 ? otherUid : uid;
    const start = performance.now();
    const page = app.listListings({ userId: member, searchKeys: [], settings, sort, limit: 50 });
    const listMs = performance.now() - start;
    const statStart = performance.now();
    const statsDetails = {};
    const stats = app.stats([], member, settings, statsDetails);
    results.push({ sort, list_ms: Math.round(listMs), stats_ms: Math.round(performance.now() - statStart),
      stages: page.queryDetails,
      stats_stages: statsDetails,
      matched: page.totalMatched, returned: page.listings.length, stats_total: stats.total,
      first_ids: page.listings.slice(0, 3).map(row => row.post_id),
      page_digest: createHash("sha256").update(JSON.stringify(page.listings.map(row => [
        row.post_id, row.fit_score, row.price_num, row.has_elevator, row.commute_km, row.district,
      ]))).digest("hex") });
    clock += 6000;
  }
  console.log(JSON.stringify({ rows: count, mixed, relations, interactive, results }, null, 2));
} finally {
  Date.now = realNow;
  rmSync(dataDir, { recursive: true, force: true });
}
