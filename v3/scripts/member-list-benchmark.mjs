// 會員列表路徑（GET /api/listings）的唯讀效能量測入口。
//
// 為什麼存在：這一包（候選查詢瘦身＋stats 單趟化）的驗收是「數字真的降了」，
// 需要一支可以在**隔離量測庫**上重跑、且與正式站同一條服務層（loadListingPage）的腳本。
//
// 用法：
//   PG_URL=<隔離庫連線字串> MEMBER_UID=<使用者 id> node v3/scripts/member-list-benchmark.mjs
//   （連線字串只從環境變數讀，腳本不印出、不落地。）
//
// 輸出：每個情境的 cold／warm 的 list_ms（Server-Timing 的 list）、stats_ms、total_ms、
//       candidates、totalMatched，以及候選 SQL 的 EXPLAIN (ANALYZE, BUFFERS) 摘要。
import { performance } from "node:perf_hooks";
import { buildListRequestContextFromPg } from "../src/db.js";
import { sharedPgDriver, closeSharedPgDriver } from "../src/pgSharedDriver.js";

process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";

const { loadListingPage } = await import("../src/listingSearchPage.js");
const { toPostgresSql } = await import("../src/sqlDialect.js");
const { readPgRows } = await import("../src/pgReadSnapshot.js");

const uid = Number(process.env.MEMBER_UID || 1) || 1;
const runs = Math.max(1, Number(process.env.RUNS) || 2);
const quiet = process.env.BENCH_QUIET === "1";

const SCENARIOS = [
  { name: "default", args: {} },
  { name: "district=中山區", args: { districts: ["中山區"] } },
  { name: "rent 3000-8000", args: { priceMin: 3000, priceMax: 8000 } },
  { name: "q=新莊", args: { q: "新莊" } },
  { name: "multi(district+q+price_asc)", args: { districts: ["中山區"], q: "新莊", sort: "price_asc" } },
];

const pg = await sharedPgDriver();
const exec = (sql, params = []) => pg.query(toPostgresSql(sql), params).then((r) => r.rows);

// BENCH_ALL_KEYS=1：把該庫全部 search_key 當成這個會員的已展開清單 ＝ 正式站「20 個 crawler URL
// 覆蓋 100% 的列」那個 worst case。不設則用量測庫裡 uid 自己的設定。
const allKeys = process.env.BENCH_ALL_KEYS === "1"
  ? (await exec("SELECT DISTINCT search_key FROM listings WHERE COALESCE(search_key, '') <> ''")).map((r) => r.search_key)
  : null;

// 由 PG 建一次 context 取得 settings（價格情境要覆寫 priceMax）。
const probe = await buildListRequestContextFromPg(exec, { asOf: null, resolvedSearchKeys: undefined });
let baseSettings = probe.settingsForUser(uid);

// BENCH_BROAD_REGIONS=1：把會員的 watchDistricts 設成「全台所有行政區」⇒ 行政區子句不縮減候選，
// 重現正式站那位「20 個 crawler URL 覆蓋 100% 的列、候選 17 萬」的會員 worst case。
if (process.env.BENCH_BROAD_REGIONS === "1") {
  const { CITIES } = await import("../src/regions.js");
  const keys = CITIES.flatMap(city => city.districts.map(d => `${city.id}|${d.id}`));
  baseSettings = { ...baseSettings, watchDistricts: keys, searchUrls: [] };
}

async function once(label, args) {
  const started = performance.now();
  const page = await loadListingPage({ filter: "all", kind: "", sources: "", q: "", sort: "newest",
    limit: 80, offset: 0, districts: [], userId: uid, matchVoteUserId: uid, sameHouse: true,
    ...(allKeys ? { searchKeys: allKeys } : {}), ...args }, { driver: "postgres", pgDriver: pg });
  const wall = Math.round(performance.now() - started);
  return {
    label, wall_ms: wall,
    list_ms: Math.round(page.timing.query_ms),
    stats_ms: Math.round(page.timing.stats_ms),
    total_ms_from_route: Math.round(page.timing.total_ms),
    candidates: page.timing.stages?.candidates ?? null,
    totalMatched: page.timing.dataset ?? null,
    returned: page.listings.length,
    stages: page.timing.stages,
    stats_stages: page.timing.stats_stages,
  };
}

const out = [];
for (const scenario of SCENARIOS) {
  let args = { ...scenario.args };
  if (args.priceMin != null) {
    args = { ...args, settings: { ...baseSettings, priceMin: args.priceMin, priceMax: args.priceMax } };
    delete args.priceMin; delete args.priceMax;
  } else if (!args.settings) {
    args.settings = baseSettings;
  }
  const cold = await once("cold", args);
  const warms = [];
  for (let i = 0; i < runs; i += 1) warms.push(await once("warm", args));
  const warm = warms[warms.length - 1];
  out.push({ scenario: scenario.name, args: Object.keys(scenario.args), cold, warm,
    warm_all_list_ms: warms.map((w) => w.list_ms), warm_all_stats_ms: warms.map((w) => w.stats_ms),
    warm_all_total_ms: warms.map((w) => w.total_ms_from_route) });
  if (!quiet) {
    console.log(`SCENARIO ${scenario.name}: cold list=${cold.list_ms} stats=${cold.stats_ms} total=${cold.total_ms_from_route} | ` +
      `warm list=${warm.list_ms} stats=${warm.stats_ms} total=${warm.total_ms_from_route} | cand=${warm.candidates} matched=${warm.totalMatched}`);
  }
}

// EXPLAIN (ANALYZE, BUFFERS)：候選 SQL 的讀取量（改前＝寬欄整表；改後＝窄查詢）。
async function explain(sql, params) {
  const rows = await exec(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const plan = rows[0]["QUERY PLAN"][0];
  const flat = [];
  const walk = (node) => {
    flat.push(node);
    for (const child of node.Plans || []) walk(child);
  };
  walk(plan.Plan);
  return {
    planning_ms: plan["Planning Time"], execution_ms: plan["Execution Time"],
    buffers: {
      hit: flat.reduce((s, n) => s + (n["Shared Hit Blocks"] || 0), 0),
      read: flat.reduce((s, n) => s + (n["Shared Read Blocks"] || 0), 0),
      written: flat.reduce((s, n) => s + (n["Shared Written Blocks"] || 0), 0),
    },
    temp_kb: Math.max(...flat.map((n) => n["Sort Space Used"] || 0)),
    nodes: flat.map((n) => `${n["Node Type"]}${n["Relation Name"] ? ":" + n["Relation Name"] : ""} rows=${n["Actual Rows"] ?? ""}`),
  };
}

if (process.env.BENCH_EXPLAIN === "1") {
  const { buildListListingsClauses } = await import("../src/db.js");
  const context = await buildListRequestContextFromPg(exec, { asOf: null, resolvedSearchKeys: undefined });
  const settings = baseSettings;
  for (const scenario of SCENARIOS) {
    const args = { ...scenario.args };
    if (args.priceMin != null) Object.assign(args, { settings: { ...settings, priceMin: 3000, priceMax: 8000 } });
    const built = buildListListingsClauses({
      filter: "all", kind: "", sources: "", q: args.q || "", searchKeys: allKeys || undefined,
      districts: args.districts || [], settings: args.settings || settings, uid, voteUid: uid,
      context, districtRelatedIds: [],
    }, { sqliteDb: null });
    const columns = process.env.BENCH_EXPLAIN_COLUMNS || "post_id";
    const res = await explain(`SELECT ${columns} FROM listings ${built.where} ORDER BY post_id`, built.params);
    out.find((row) => row.scenario === scenario.name).explain = res;
    console.log(`EXPLAIN ${scenario.name}: exec=${Math.round(res.execution_ms)}ms buffers read=${res.buffers.read} hit=${res.buffers.hit} temp=${res.temp_kb}kB`);
  }
}

console.log(JSON.stringify({ memberUid: uid, runs, scenarios: out }, null, 2));
await closeSharedPgDriver();
