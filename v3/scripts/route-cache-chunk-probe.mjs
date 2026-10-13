// route_cache 讀取的「鍵清單分批」量測（唯讀；隔離靶）。
//
// 用途：這一刀（`decorationData.js` 的 `ROUTE_CACHE_KEY_CHUNK`）的依據是**計畫選擇**：
// 整包 key 一起送時 PG 選的是 59MB 表的平行 Seq Scan（每次讀 4,700–4,800 個 block），
// 切成 ≤1024 之後改成 `Bitmap Index Scan on route_cache_pkey`。這支腳本把那組數字重新量一次，
// 並同時驗「兩種送法的回傳列逐列相同」。
//
// 用法（只從環境變數讀連線字串，不印出、不落地）：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   PG_URL="$PG_SNAPSHOT_REPRO2_URL" node v3/scripts/route-cache-chunk-probe.mjs --keys 7422 --rounds 5
//
// 參數：
//   --keys <n>       從 route_cache 抽 n 個鍵（預設 7422）
//   --chunks <a,b,..> 要對照的分批大小（預設 0,512,1024,1280,1536）；0＝整包一次送
//   --rounds <n>     每個變體跑幾輪取中位（預設 5）
//   --explain 1      額外印每個變體 EXPLAIN (ANALYZE, BUFFERS) 的計畫與讀取 block 數
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const pg = require("pg");

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const KEYS = Math.max(1, Number(flag("keys", 7422)));
const CHUNKS = String(flag("chunks", "0,512,1024,1280,1536")).split(",").map(Number);
const ROUNDS = Math.max(1, Number(flag("rounds", 5)));
const EXPLAIN = flag("explain", "0") === "1";
const COLUMNS = "route_key, distances, min_km, min_m, rush_am_min, rush_pm_min, rush_updated_at";

const url = String(process.env.PG_URL || process.env.PG_LIVE_REPRO_URL || "").trim();
if (!url) { console.error("需要 PG_URL（或 PG_LIVE_REPRO_URL）；只接受隔離靶"); process.exit(2); }
const db = (() => { try { return new URL(url).pathname.replace(/^\//, ""); } catch { return ""; } })();
if (!/^(repro|repro2|tracker_test|mlattr_\d+)$/.test(db)) {
  console.error(`拒絕執行：資料庫 "${db}" 不在隔離清單（repro／repro2／tracker_test／mlattr_<pid>）`);
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("SET jit = off");
const rows = (await client.query(
  `SELECT route_key FROM route_cache ORDER BY route_key LIMIT $1`, [KEYS],
)).rows.map((r) => r.route_key);
console.log(`資料庫 ${db}｜鍵 ${rows.length}｜每種送法 ${ROUNDS} 輪取中位`);

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return Math.round(s[s.length >> 1] * 10) / 10; };

async function timed(keys, chunk) {
  const parts = chunk ? Array.from({ length: Math.ceil(keys.length / chunk) }, (_, i) => keys.slice(i * chunk, (i + 1) * chunk)) : [keys];
  const started = performance.now();
  const map = new Map();
  for (const part of parts) {
    const res = await client.query(`SELECT ${COLUMNS} FROM route_cache WHERE route_key = ANY($1::text[])`, [part]);
    for (const row of res.rows) map.set(String(row.route_key), `${row.min_km}|${row.min_m}|${row.rush_am_min}|${row.rush_pm_min}|${row.rush_updated_at}`);
  }
  return { ms: performance.now() - started, parts: parts.length, map };
}

const timings = new Map();
const maps = new Map();
for (let round = 0; round < ROUNDS; round += 1) {
  for (const chunk of CHUNKS) {
    const r = await timed(rows, chunk);
    if (!timings.has(chunk)) timings.set(chunk, []);
    timings.get(chunk).push(r.ms);
    maps.set(chunk, r.map);
  }
}

const reference = maps.get(CHUNKS[0]);
for (const chunk of CHUNKS) {
  const map = maps.get(chunk);
  let identical = map.size === reference.size;
  if (identical) for (const [key, value] of reference) if (map.get(key) !== value) { identical = false; break; }
  const runs = timings.get(chunk);
  const label = chunk === 0 ? "整包" : `chunk=${chunk}`;
  const base = median(timings.get(CHUNKS[0]));
  const ms = median(runs);
  console.log(`${label.padEnd(12)} 語句數=${String(Math.ceil(rows.length / (chunk || rows.length))).padStart(3)} `
    + `中位=${String(ms).padStart(7)}ms 降幅=${String(Math.round((1 - ms / base) * 100)).padStart(4)}% `
    + `逐列相同=${identical} 原始值=${runs.map((x) => Math.round(x)).join(",")}`);
}

if (EXPLAIN) {
  for (const chunk of CHUNKS) {
    const part = chunk ? rows.slice(0, chunk) : rows;
    const res = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT ${COLUMNS} FROM route_cache WHERE route_key = ANY($1::text[])`, [part]);
    const plan = res.rows[0]["QUERY PLAN"][0];
    const flat = []; const walk = (n) => { flat.push(n); for (const child of n.Plans || []) walk(child); }; walk(plan.Plan);
    const nodes = flat.map((n) => n["Node Type"] + (n["Index Name"] ? ` ${n["Index Name"]}` : "")).join(" > ");
    console.log(`EXPLAIN chunk=${chunk || "all"} 鍵=${part.length} exec=${plan["Execution Time"].toFixed(1)}ms `
      + `read=${flat.reduce((s, n) => s + (n["Shared Read Blocks"] || 0), 0)} hit=${flat.reduce((s, n) => s + (n["Shared Hit Blocks"] || 0), 0)} :: ${nodes}`);
  }
}
await client.end();
