// Reproducible runtime baseline harness for the 5151 v3 search path.
//
// Measures the real listListings() + stats() hot path against synthetic
// datasets of 1k / 10k / 50k listings, computing p50/p95/p99 plus stage
// breakdowns (SQL candidate scan, Node filter, sort, hydrate, stats).
//
// Run (single size):
//   node --no-warnings v3/benchmark-runtime.mjs 10000 7
// Run (all sizes + write evidence):
//   node --no-warnings v3/run-baseline.mjs
//
// The harness always uses a fresh temporary DATA_DIR; it never touches a real
// or production database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const r = (v) => Math.round(v * 100) / 100;
  return {
    count: sorted.length,
    min: r(sorted[0]),
    p50: r(percentile(sorted, 50)),
    p95: r(percentile(sorted, 95)),
    p99: r(percentile(sorted, 99)),
    max: r(sorted[sorted.length - 1]),
  };
}

function aggregateStages(runs) {
  const keys = new Set();
  for (const run of runs) for (const key of Object.keys(run || {})) keys.add(key);
  const out = {};
  for (const key of keys) {
    const values = runs.map((run) => run?.[key]).filter((v) => typeof v === "number");
    if (values.length) out[key] = summarize(values);
  }
  return out;
}

// Seed a realistic synthetic dataset through the canonical upsertListing path
// so every column the search path relies on is populated exactly like a real
// crawler/import would. Runs inside one transaction for throughput.
function seedDataset(app, count) {
  const db = app.db;
  db.exec("BEGIN");
  try {
    for (let i = 1; i <= count; i++) {
      // 1-in-3 rows lands in the member's watched district (士林區); the rest
      // land in a neighbouring district so the SQL candidate reduction is real.
      const inScope = i % 3 !== 0;
      const districtKey = inScope ? "1|8" : "1|9";
      const districtName = inScope ? "台北市士林區" : "台北市北投區";
      const price = 12000 + (i * 137) % 48000;
      const floor = 1 + (i % 12);
      const totalFloors = Math.max(floor + 1, 12);
      const stamp = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
      app.upsertListing({
        post_id: i,
        source: "591",
        source_id: String(i),
        source_key: `${districtKey}||${districtName}測試路${i}號`,
        search_key: "https://example.test/search",
        title: `測試住宅${i}`,
        url: `https://example.test/listing/${i}`,
        price: `${price}元`,
        price_num: price,
        extra_fee: 0,
        extra_fees: [],
        address: `${districtName}測試路${i}號`,
        area_name: "25坪",
        layout: "2房1廳1衛",
        floor_name: `${floor}/${totalFloors}`,
        kind_name: i % 5 === 0 ? "套房" : "整層住家/電梯大樓",
        role_name: "",
        cover: `https://example.test/cover/${i}.png`,
        tags: "[]",
        refresh_time: stamp,
        first_seen_at: stamp,
        last_seen_at: stamp,
        last_event: "new",
        lat: 25.09 + (i % 100) * 0.0001,
        lng: 121.51 + (i % 100) * 0.0001,
      });
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export async function runBenchmark({ count = 10000, iterations = 7 } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "5151-runtime-bench-"));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  const realNow = Date.now;
  let app = null;
  try {
    app = await import("./src/db.js");
    const uid = app.ensureUser("runtime-benchmark@example.test", { role: "admin" });
    const settings = {
      ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, priceMaxIncludesExtras: true,
      commuteKm: 0, workLat: 25.1, workLng: 121.52,
      wholeFloorOnly: false, excludeLowFloors: false, excludeRooftop: false,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
    };

    const seedStart = performance.now();
    seedDataset(app, count);
    const seedMs = Math.round(performance.now() - seedStart);

    const sorts = ["newest", "price_asc", "commute_asc", "fit_desc"];
    const listRuns = new Map(sorts.map((s) => [s, []]));
    const statsRuns = [];
    let sample = null;
    let clock = realNow();

    for (let iter = 0; iter < iterations; iter++) {
      for (const sort of sorts) {
        const start = performance.now();
        const page = app.listListings({ userId: uid, searchKeys: [], settings, sort, limit: 50 });
        const ms = performance.now() - start;
        listRuns.get(sort).push({ ms, stages: page.queryDetails || {} });
        sample = { totalMatched: page.totalMatched, returned: page.listings.length };
      }
      const statStart = performance.now();
      const details = {};
      app.stats([], uid, settings, details);
      statsRuns.push({ ms: performance.now() - statStart, stages: details });
      clock += 6000;
      Date.now = () => clock;
    }
    Date.now = realNow;

    const sortResults = {};
    for (const sort of sorts) {
      const runs = listRuns.get(sort);
      sortResults[sort] = {
        latency_ms: summarize(runs.map((run) => run.ms)),
        stages: aggregateStages(runs.map((run) => run.stages)),
      };
    }
    const statsResult = {
      latency_ms: summarize(statsRuns.map((run) => run.ms)),
      stages: aggregateStages(statsRuns.map((run) => run.stages)),
    };

    const digest = sample && sample.returned != null
      ? createHash("sha256").update(JSON.stringify(sample)).digest("hex") : "";
    return {
      summary: {
        rows: count,
        iterations,
        engine: "sqlite",
        node: process.version,
        seed_ms: seedMs,
        sorts: sortResults,
        stats: statsResult,
        sample: { ...sample, digest },
      },
      dataDir,
    };
  } finally {
    process.env.DATA_DIR = prev;
    try { app?.db?.close(); } catch { /* already closed */ }
  }
}

if (process.argv[1] && here === path.resolve(process.argv[1])) {
  const count = Math.max(100, Math.min(Number(process.argv[2]) || 10000, 100000));
  const iterations = Math.max(1, Math.min(Number(process.argv[3]) || 7, 50));
  const { summary, dataDir } = await runBenchmark({ count, iterations });
  console.log(JSON.stringify(summary, null, 2));
  rmSync(dataDir, { recursive: true, force: true });
}

