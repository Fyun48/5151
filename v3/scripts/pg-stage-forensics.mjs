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
// astra 2026-09-25 §4.1：能力參數必須進 **settings**（顯示篩選讀 settings），
// 且 wholeFloorOnly 要 boolean；並輸出每個 queryDetails 階段與每請求 PG 查詢數。
const ABILITIES = [
  { label: "baseline", args: {}, settings: {} },
  { label: "q=電梯", args: { q: "電梯" }, settings: {} },
  { label: "kind=whole", args: { kind: "whole" }, settings: {} },
  { label: "sources=591", args: { sources: "591" }, settings: {} },
  { label: "areaMax=30", args: {}, settings: { areaMax: 30 } },
  { label: "wholeFloorOnly=1", args: {}, settings: { wholeFloorOnly: true } },
];
let baseline = null;
const STAGE_KEYS = [
  "prepare_ms", "sql_ms", "preload_ms", "profile_ms", "relations_ms",
  "display_ms", "sort_ms", "preload_page_ms", "hydrate_ms",
];

for (const item of ABILITIES) {
  const args = {
    filter: "all", sort: "newest", limit: 50, offset: 0, districts: [district],
    userId: 0, matchVoteUserId: 0, settings: item.settings || {}, ...item.args,
  };
  const rec = { label: item.label, runs: RUNS, ms: [] };
  let last = null;
  for (let i = 0; i < RUNS; i += 1) {
    // astra §4.1：每請求的 PG 查詢數 —— 包在**回傳 client 的 query**（單一快照實際用的路徑），
    // 並把交易控制語句與資料查詢分開；`wrapperQueries` 必須為 0（不得繞過快照）。
    let connects = 0;
    let clientQueries = 0;
    let txnQueries = 0;
    let wrapperQueries = 0;
    const counting = {
      query: (s, p) => { wrapperQueries += 1; return drv.query(s, p); },
      pool: {
        connect: async (...a) => {
          connects += 1;
          const client = await drv.pool.connect(...a);
          return {
            query: (s, p) => {
              if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET\s)/i.test(String(s))) txnQueries += 1;
              else clientQueries += 1;
              return client.query(s, p);
            },
            release: (...r) => client.release(...r),
          };
        },
      },
    };
    const t0 = Date.now();
    try {
      // pgDriver 帶 pool ⇒ 走單一快照（REPEATABLE READ READ ONLY）
      last = await searchListingsNodePg(args, { pgDriver: counting, deps });
      rec.ms.push(Date.now() - t0);
      rec.outcome = "ok";
    } catch (err) {
      rec.ms.push(Date.now() - t0);
      rec.outcome = `error(${err?.code || err?.name || "?"}): ${String(err?.message || "").slice(0, 140)}`;
      rec.snapshot = { connects, clientQueries, txnQueries, wrapperQueries };
      break;
    }
    rec.snapshot = { connects, clientQueries, txnQueries, wrapperQueries };
  }
  const sorted = [...rec.ms].sort((a, b) => a - b);
  rec.p50 = sorted[Math.floor(sorted.length / 2)];
  rec.p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
  rec.cold = rec.ms[0];
  rec.warm = rec.ms.length > 1 ? Math.round(rec.ms.slice(1).reduce((s, v) => s + v, 0) / (rec.ms.length - 1)) : null;
  rec.candidates = last?.queryDetails?.candidates ?? null;
  rec.totalMatched = last?.totalMatched ?? null;
  rec.returned = last?.listings?.length ?? null;
  // astra §4.1：把 queryDetails 的各階段數值輸出（原本只輸出 candidates ⇒ 無法定位 preload / Node 耗時）。
  const qd = last?.queryDetails || {};
  rec.stages = Object.fromEntries(STAGE_KEYS.filter((k) => qd[k] != null).map((k) => [k, qd[k]]));
  if (baseline === null) baseline = { candidates: rec.candidates, totalMatched: rec.totalMatched };
  rec.effective = item.label === "baseline"
    ? null
    : (rec.candidates !== baseline.candidates || rec.totalMatched !== baseline.totalMatched);
  console.log(`PGSTAGE ${JSON.stringify(rec)}`);
}

await drv.pool.end();
