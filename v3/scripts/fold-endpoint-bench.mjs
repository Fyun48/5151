// 端對端延遲量測：off（Node 路徑）vs on（SQL 折疊路徑），各 5 次，報 p50/p95。
// 只連隔離庫，唯讀。用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-endpoint-bench.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { searchPublicListingsAsync } from "../src/publicListingSearchAsync.js";

assertPgTargetAllowed("fold-endpoint-bench", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const drv = await createPostgresDriver({ env: process.env });
const QUERIES = [
  { name: "baseline", kind: "", q: "", districts: [] },
  { name: "kind=whole", kind: "whole", q: "", districts: [] },
  { name: "q=套房", kind: "", q: "套房", districts: [] },
  { name: "districts+priceMax", kind: "", q: "", districts: ["西屯區"], priceMax: 20000 },
];

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100));
  return sorted[i];
}

const report = [];
for (const q of QUERIES) {
  for (const mode of ["off", "on"]) {
    process.env.PUBLIC_LISTINGS_SQL_FIRST = mode === "on" ? "1" : "0";
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const r = await searchPublicListingsAsync({ ...q, sort: "newest", limit: 5 }, { driver: "postgres", pgDriver: drv });
      const ms = Date.now() - t0;
      samples.push({ ms, total: r.totalMatched, engine: r.queryDetails?.engine });
    }
    samples.sort((a, b) => a.ms - b.ms);
    report.push({ name: q.name, mode, p50: pct(samples.map(s => s.ms), 50), p95: pct(samples.map(s => s.ms), 95), total: samples[0].total, engine: samples[0].engine, samples: samples.map(s => s.ms) });
    console.log(JSON.stringify(report[report.length - 1]));
  }
}
await drv.pool.end();
