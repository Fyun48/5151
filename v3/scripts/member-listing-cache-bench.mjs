// 會員列表版本化快取的**量化**量測（2026-10-11）。
//
// 為什麼要這一支：這一包的驗收是「第二次真的省了多少毫秒、少打幾次 PG」，
// 而 `member-list-benchmark.mjs` 量的是冷／暖（同一個請求現算兩次）——那證明不了快取。
// 這裡的控制組與實驗組在**同一個行程**、**同一組參數**下各連打兩次：
//   off：#1 現算　#2 再現算（今天的行為）
//   on ：#1 未命中現算　#2 命中回快取
// 並且把 **PG 端真正送出的查詢次數**（pool 層攔截，含快照交易裡的每一句）一起報出來。
//
// 用法（連線字串只從環境變數讀，腳本不印出、不落地）：
//   PG_URL=<隔離庫連線> MEMBER_UID=1 node v3/scripts/member-listing-cache-bench.mjs
//   （`repro`／`crawl_sandbox` 之類的隔離庫；正式庫請不要用這支。）
//   可選：SCENARIOS=default,district 只跑部分；BENCH_ALL_KEYS=1 用全庫 search_key 當 worst case。
//
// 局限（誠實寫在輸出裡）：這是在**隔離量測庫**上跑，資料量與機器負載都與正式站不同；
// 這裡的能量到的只有「同一台、同一份資料、同一個 generation 內」的命中效果。
import { performance } from "node:perf_hooks";
import { buildListRequestContextFromPg } from "../src/db.js";
import { sharedPgDriver, closeSharedPgDriver } from "../src/pgSharedDriver.js";
import { toPostgresSql } from "../src/sqlDialect.js";

process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";

const { loadListingPage } = await import("../src/listingSearchPage.js");
const { resetMemberListingCache, memberListingCacheCounters, memberListingCacheEnabled } =
  await import("../src/memberListingCachePg.js");

const uid = Number(process.env.MEMBER_UID || 1) || 1;
const only = String(process.env.SCENARIOS || "").split(",").map((s) => s.trim()).filter(Boolean);

const ALL_SCENARIOS = [
  { name: "default", args: {} },
  { name: "district", args: { districts: ["中山區"] } },
  { name: "rent", args: { priceMin: 3000, priceMax: 8000 } },
  { name: "q", args: { q: "新莊" } },
  { name: "multi", args: { districts: ["中山區"], q: "新莊", sort: "price_asc" } },
];
const scenarios = only.length ? ALL_SCENARIOS.filter((s) => only.includes(s.name)) : ALL_SCENARIOS;

const pg = await sharedPgDriver();
const exec = (sql, params = []) => pg.query(toPostgresSql(sql), params).then((r) => r.rows);

// ── PG 查詢計數器：攔 `pool.connect` 一層就好 ────────────────────────────────
// `driver.query()` 走 `pool.query()`，而 `pool.query()` 內部也是 `this.connect()`；
// 只攔 connect 回傳的 client ⇒ 每一句真的送出的 SQL 剛好算一次（不會重複計）。
function instrumentPool(pool) {
  const state = { total: 0, byShape: new Map() };
  const bump = (sql) => {
    const text = typeof sql === "string" ? sql : sql?.text || "";
    const shape = text.replace(/\s+/g, " ").trim().slice(0, 46);
    state.total += 1;
    state.byShape.set(shape, (state.byShape.get(shape) || 0) + 1);
  };
  const patchClient = (client) => {
    if (!client || client.__cacheBenchPatched) return;
    const raw = client.query.bind(client);
    client.query = (sql, ...rest) => { bump(sql); return raw(sql, ...rest); };
    client.__cacheBenchPatched = true;
  };
  const rawConnect = pool.connect.bind(pool);
  pool.connect = (...args) => {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
    if (cb) {
      return rawConnect(...args, (err, client, release) => { if (client) patchClient(client); cb(err, client, release); });
    }
    return rawConnect(...args).then((client) => { patchClient(client); return client; });
  };
  return {
    read() { return state.total; },
    reset() { state.total = 0; state.byShape.clear(); },
    top(n = 6) {
      return [...state.byShape.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
        .map(([shape, count]) => ({ shape, count }));
    },
  };
}
const counter = instrumentPool(pg.pool);

// 量測庫的會員設定（租金情境要覆寫，與 member-list-benchmark.mjs 同一套）。
const probe = await buildListRequestContextFromPg(exec, { asOf: null, resolvedSearchKeys: undefined });
let baseSettings = probe.settingsForUser(uid);
if (process.env.BENCH_ALL_KEYS === "1") {
  const { CITIES } = await import("../src/regions.js");
  baseSettings = { ...baseSettings, watchDistricts: CITIES.flatMap((city) => city.districts.map((d) => `${city.id}|${d.id}`)), searchUrls: [] };
}
const allKeys = process.env.BENCH_ALL_KEYS === "1"
  ? (await exec("SELECT DISTINCT search_key FROM listings WHERE COALESCE(search_key, '') <> ''")).map((r) => r.search_key)
  : null;

async function once(args) {
  const started = performance.now();
  counter.reset();
  const page = await loadListingPage(args, { driver: "postgres", pgDriver: pg });
  const wall = performance.now() - started;
  return {
    ms: Math.round(wall),
    queries: counter.read(),
    list_ms: Math.round(page.timing.query_ms),
    stats_ms: Math.round(page.timing.stats_ms),
    matched: page.timing.dataset,
    returned: page.listings.length,
    cache_hit: page.timing.stages?.cache_hit === true || page.timing.stats_stages?.cache_hit === true,
  };
}

function argsFor(scenario, enabled) {
  process.env.MEMBER_LISTING_CACHE = enabled ? "1" : "0";
  const args = {
    filter: "all", kind: "", sources: "", q: "", sort: "newest", limit: 80, offset: 0,
    districts: [], userId: uid, matchVoteUserId: uid, sameHouse: true,
    ...(allKeys ? { searchKeys: allKeys } : {}),
    ...scenario.args,
  };
  if (args.priceMin != null) {
    args.settings = { ...baseSettings, priceMin: args.priceMin, priceMax: args.priceMax };
    delete args.priceMin; delete args.priceMax;
  } else {
    args.settings = baseSettings;
  }
  return args;
}

console.log(`[cache-bench] driver=postgres uid=${uid} MEMBER_LISTING_CACHE enabled=${memberListingCacheEnabled({ MEMBER_LISTING_CACHE: "1" })}`);
console.log("[cache-bench] 這是隔離量測庫；命中的前提是 generation（data_revision＋pg_stat 版本號）在兩次之間沒變。\n");

const rows = [];
for (const scenario of scenarios) {
  // ⚠️ 每一組的參數物件**只建一次**：`resetMemberListingCache()` 在 argsFor 裡，
  // 若每個 once() 都重建，就會在「未命中」與「命中」之間把快取清掉、永遠量到未命中。
  const offArgs = argsFor(scenario, false);
  resetMemberListingCache();
  const off1 = await once(offArgs);
  const off2 = await once(offArgs);
  const onArgs = argsFor(scenario, true);
  resetMemberListingCache();
  const on1 = await once(onArgs);
  const on2 = await once(onArgs);
  const counters = memberListingCacheCounters();
  process.env.MEMBER_LISTING_CACHE = "0";
  const row = {
    scenario: scenario.name,
    off: { first: off1, second: off2 },
    on: { first: on1, second: on2 },
    saved_ms: off2.ms - on2.ms,
    saved_queries: off2.queries - on2.queries,
    hit: on2.cache_hit,
    matched: on2.matched,
    identical: on1.returned === on2.returned && on1.matched === on2.matched,
    counters,
  };
  rows.push(row);
  console.log(
    `SCENARIO ${row.scenario}: `
    + `off #1 ${off1.ms}ms/${off1.queries}q · #2 ${off2.ms}ms/${off2.queries}q  ||  `
    + `on #1(miss) ${on1.ms}ms/${on1.queries}q · #2(${row.hit ? "HIT" : "MISS"}) ${on2.ms}ms/${on2.queries}q  `
    + `⇒ 第二次省 ${row.saved_ms}ms、少 ${row.saved_queries} 次 PG 查詢（matched=${row.matched}，兩次一致=${row.identical}）`,
  );
}

const totals = rows.reduce((acc, row) => ({
  saved_ms: acc.saved_ms + row.saved_ms,
  saved_queries: acc.saved_queries + row.saved_queries,
  hits: acc.hits + (row.hit ? 1 : 0),
}), { saved_ms: 0, saved_queries: 0, hits: 0 });
console.log(`\n[cache-bench] 合計：${rows.length} 個情境、命中 ${totals.hits}／${rows.length}，`
  + `第二次共省 ${totals.saved_ms}ms、共少 ${totals.saved_queries} 次 PG 查詢`);
console.log(`[cache-bench] JSON ${JSON.stringify({ memberUid: uid, scenarios: rows, totals }, null, 2)}`);

await closeSharedPgDriver();
