// B3 效能量測：PG-fed Node 搜尋路徑（真實資料、唯讀）。
//
// 依 astra6 決策 §3 要求量：p95、RSS、event-loop lag、PG 查詢數。
// 用法（容器內，經 run-in-container.sh 會先同步 src）：
//   DISTRICTS=西屯區 RUNS=5 node listingSearchNodePgPerf.mjs
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createPostgresDriver } from "/app/src/dbDriverPostgres.js";
import { listingSearchBuildContext } from "./src/db.js";
import { searchListingsNodePg } from "./src/listingSearchNodePg.js";

const RUNS = Math.max(1, Number(process.env.RUNS) || 5);
const district = process.env.DISTRICTS || "西屯區";

const drv = await createPostgresDriver({ env: process.env });
let pgQueries = 0;
const counted = {
  query: (sql, params) => { pgQueries += 1; return drv.query(sql, params); },
  pool: drv.pool,
};

const deps = listingSearchBuildContext();
const args = {
  filter: "all", kind: "", sources: "", q: "", sort: "newest",
  limit: 80, offset: 0, districts: [district],
  userId: 0, matchVoteUserId: 0, settings: {},
};

const rssStart = process.memoryUsage().rss;
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

const timings = [];
let last = null;
for (let i = 0; i < RUNS; i += 1) {
  const before = pgQueries;
  const t0 = performance.now();
  last = await searchListingsNodePg(args, { pgDriver: counted, deps });
  timings.push(Math.round(performance.now() - t0));
  if (i === 0) last.firstRunQueries = pgQueries - before;
}
histogram.disable();
const rssEnd = process.memoryUsage().rss;

const sorted = [...timings].sort((a, b) => a - b);
const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
const mean = Math.round(timings.reduce((s, v) => s + v, 0) / timings.length);

console.log(`NODEPG-PERF ${JSON.stringify({
  district,
  runs: RUNS,
  candidates: last?.queryDetails?.candidates ?? null,
  totalMatched: last?.totalMatched ?? null,
  returned: last?.listings?.length ?? null,
  ms: { mean, p95, min: sorted[0], max: sorted[sorted.length - 1], all: timings },
  pgQueriesTotal: pgQueries,
  pgQueriesPerRun: Math.round((pgQueries / RUNS) * 10) / 10,
  firstRunQueries: last?.firstRunQueries ?? null,
  rssMB: Math.round((rssEnd / 1024 / 1024) * 10) / 10,
  rssDeltaMB: Math.round(((rssEnd - rssStart) / 1024 / 1024) * 10) / 10,
  eventLoopLagMs: {
    mean: Math.round((histogram.mean / 1e6) * 10) / 10,
    p99: Math.round((histogram.percentile(99) / 1e6) * 10) / 10,
    max: Math.round((histogram.max / 1e6) * 10) / 10,
  },
})}`);
await drv.pool.end();
