// astra6 §0.1 續：把 30 秒定位到「階段」（真實路徑、唯讀）。
//
// 為什麼要這支：`pg-explain-forensics.mjs` 已證明**候選 SQL 只要 0.4–1.0 秒**（專用連線、3 秒閘門），
// 因此 30 秒不可能是候選 SQL，一定是路徑上的其他階段。app 內建 markStage 階段計時，
// 可直接把時間定位到 prepare / sql / preload / preload_page / sort / hydrate。
//
// 用法：
//   REMOTE_DIR=/app/tmpkk bash v3/scripts/run-in-container.sh v3/scripts/pg-stage-forensics.mjs
import { createPostgresDriver } from "./src/dbDriverPostgres.js";
import { listingSearchBuildContext } from "./src/db.js";
import { searchListingsNodePg } from "./src/listingSearchNodePg.js";

const drv = await createPostgresDriver({ env: process.env });
const deps = listingSearchBuildContext();
const district = process.env.DISTRICTS || "西屯區";
const RUNS = Math.max(1, Number(process.env.RUNS) || 1);
const ABILITIES = [
  { label: "baseline", args: {} },
  { label: "q=電梯", args: { q: "電梯" } },
  { label: "kind=whole", args: { kind: "whole" } },
  { label: "sources=591", args: { sources: "591" } },
  { label: "areaMax=30", args: { areaMax: 30 } },
  { label: "wholeFloorOnly=1", args: { wholeFloorOnly: 1 } },
];

for (const item of ABILITIES) {
  const args = {
    filter: "all", sort: "newest", limit: 50, offset: 0, districts: [district],
    userId: 0, matchVoteUserId: 0, settings: {}, ...item.args,
  };
  const rec = { label: item.label, runs: RUNS, ms: [] };
  let last = null;
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = Date.now();
    try {
      // pgDriver 帶 pool ⇒ 走單一快照（REPEATABLE READ READ ONLY）
      last = await searchListingsNodePg(args, { pgDriver: { query: (s, p) => drv.query(s, p), pool: drv.pool }, deps });
      rec.ms.push(Date.now() - t0);
      rec.outcome = "ok";
    } catch (err) {
      rec.ms.push(Date.now() - t0);
      rec.outcome = `error(${err?.code || err?.name || "?"}): ${String(err?.message || "").slice(0, 140)}`;
      break;
    }
  }
  const sorted = [...rec.ms].sort((a, b) => a - b);
  rec.p50 = sorted[Math.floor(sorted.length / 2)];
  rec.p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
  rec.cold = rec.ms[0];
  rec.warm = rec.ms.length > 1 ? Math.round(rec.ms.slice(1).reduce((s, v) => s + v, 0) / (rec.ms.length - 1)) : null;
  rec.candidates = last?.queryDetails?.candidates ?? null;
  rec.totalMatched = last?.totalMatched ?? null;
  rec.returned = last?.listings?.length ?? null;
  // 每請求的 PG 查詢數（單一快照下仍可數）
  console.log(`PGSTAGE ${JSON.stringify(rec)}`);
}

await drv.pool.end();
