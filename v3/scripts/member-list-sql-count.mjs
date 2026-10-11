// 會員列表「每請求 SQL 次數」量測（唯讀）。
//
// 目的：把 `loadListingPage()` 一次呼叫到底對 PostgreSQL 送了哪些語句、各幾次，逐條列出來，
// 作為「輔助查詢瘦身」前後對照的可重跑證據。做法是 patch `pg.Client.prototype.query`
// （含 `pool.connect()` 後的 cursor 路徑，那裡是直接呼叫 client.query）記錄每一條 SQL 的
// 起訖時間，再依「正規化後的指紋」分組。
//
// 用法：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   export PG_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres
//   node v3/scripts/member-list-sql-count.mjs --label before [--out v3/evidence/<包>/sql-count-before.json]
//   node v3/scripts/member-list-sql-count.mjs --compare before.json after.json
//
// 注意：`--compare` 只比對「每請求次數」與「欄位層級的輸出契約」，不比 SQL 文字
//（瘦身本來就會改 SQL 文字）。
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};

// ── 比對模式：純檔案操作 ─────────────────────────────────────────────────────
if (flag("compare")) {
  const beforePath = flag("compare");
  const afterPath = argv[argv.indexOf("--compare") + 2];
  if (!afterPath) { console.error("usage: --compare <before.json> <after.json>"); process.exit(2); }
  const before = JSON.parse(readFileSync(beforePath, "utf8"));
  const after = JSON.parse(readFileSync(afterPath, "utf8"));
  const failures = [];
  const key = (r) => `${r.case}`;
  const byAfter = new Map(after.scenarios.map((s) => [key(s), s]));
  for (const b of before.scenarios) {
    const a = byAfter.get(key(b));
    if (!a) { failures.push(`${b.case}: 改動後缺這個情境`); continue; }
    if (JSON.stringify(a.pageKeys) !== JSON.stringify(b.pageKeys)) failures.push(`${b.case}: payload 頂層欄位集合不同`);
    if (JSON.stringify(a.timingKeys) !== JSON.stringify(b.timingKeys)) failures.push(`${b.case}: timing 欄位集合不同`);
    if (a.totalMatched !== b.totalMatched) failures.push(`${b.case}: totalMatched ${b.totalMatched} -> ${a.totalMatched}`);
    if (JSON.stringify(a.pageIds) !== JSON.stringify(b.pageIds)) failures.push(`${b.case}: 第一頁 post_id 序列不同`);
  }
  const beforeTotal = before.scenarios.reduce((s, x) => s + x.queries, 0);
  const afterTotal = after.scenarios.reduce((s, x) => s + x.queries, 0);
  const report = { scenarios: before.scenarios.length, identical: failures.length === 0, failures,
    queriesBefore: beforeTotal, queriesAfter: afterTotal, savedPerScenario: Math.round(((beforeTotal - afterTotal) / Math.max(1, before.scenarios.length)) * 100) / 100 };
  console.log(JSON.stringify(report, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";

const pg = (await import("pg")).default;
const log = [];
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function patchedQuery(config, ...rest) {
  const sql = typeof config === "string" ? config : (config && config.text) || "";
  const started = performance.now();
  const params = Array.isArray(config?.values) ? config.values : (Array.isArray(rest[0]) ? rest[0] : []);
  const result = originalQuery.call(this, config, ...rest);
  const record = () => log.push({ sql, params, ms: performance.now() - started });
  if (result && typeof result.then === "function") {
    result.then(() => record(), () => record());
  } else if (typeof rest[rest.length - 1] === "function") {
    // callback 形式：包一層（目前 repo 沒用到，但別讓它靜默漏記）
    const cb = rest.pop();
    return originalQuery.call(this, config, ...rest, (...args) => { record(); return cb(...args); });
  }
  return result;
};

const { buildListRequestContextFromPg } = await import("../src/db.js");
const { sharedPgDriver, closeSharedPgDriver } = await import("../src/pgSharedDriver.js");
const { toPostgresSql } = await import("../src/sqlDialect.js");
const { loadListingPage } = await import("../src/listingSearchPage.js");

const uid = Number(process.env.MEMBER_UID || 1) || 1;
const label = String(flag("label", "run"));
const outPath = flag("out");
const quiet = process.env.COUNT_QUIET === "1";

const driver = await sharedPgDriver();
const exec = (sql, params = []) => driver.query(toPostgresSql(sql), params).then((r) => r.rows);
const probe = await buildListRequestContextFromPg(exec, { asOf: null, resolvedSearchKeys: undefined });
const baseSettings = probe.settingsForUser(uid);
const allKeys = (await exec("SELECT DISTINCT search_key FROM listings WHERE COALESCE(search_key,'') <> ''")).map((r) => r.search_key);
const settings = { ...baseSettings, searchKeys: undefined };

// 8 個會員情境（與正式站量測同一批）
const SCENARIOS = [
  { name: "default", args: { districts: [], sort: "newest" } },
  { name: "district_zhongshan", args: { districts: ["中山區"], sort: "newest" } },
  { name: "districts_two", args: { districts: ["中山區", "大安區"], sort: "newest" } },
  { name: "price_asc", args: { districts: [], sort: "price_asc" } },
  { name: "unseen", args: { districts: [], sort: "newest", filter: "unseen" } },
  { name: "same_house_off", args: { districts: [], sort: "newest", sameHouse: false } },
  { name: "q_text", args: { districts: [], sort: "newest", q: "新莊" } },
  { name: "multi_filter", args: { districts: ["大安區"], sort: "price_asc", kind: "whole" } },
];

// 指紋：把字面值換成 `?`，壓掉空白，取前 72 字（與 pg_stat_statements 的口徑相近）
function fingerprint(sql) {
  return String(sql)
    .replace(/'[^']*'/g, "?")
    .replace(/\b\d+\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
}

const scenarios = [];
for (const scenario of SCENARIOS) {
  const queryArgs = {
    filter: "all", kind: "", sources: "", q: "", limit: 20, offset: 0,
    userId: uid, matchVoteUserId: uid, sameHouse: true,
    settings, ...(allKeys.length ? { searchKeys: allKeys } : {}), ...scenario.args,
  };
  const before = log.length;
  const page = await loadListingPage(queryArgs, { driver: "postgres", pgDriver: driver });
  await new Promise((r) => setTimeout(r, 50)); // 讓 promise 形式的紀錄全部落地
  const slice = log.slice(before);
  const groups = new Map();
  for (const entry of slice) {
    const fp = fingerprint(entry.sql);
    const row = groups.get(fp) || { fingerprint: fp, calls: 0, ms: 0, text: String(entry.sql).replace(/\s+/g, " ").trim().slice(0, 400), sigs: {} };
    row.calls += 1;
    row.ms += entry.ms;
    // 參數簽名：只記「形狀」（陣列長度／前兩個值），用來判斷同一條 SQL 的多次呼叫是否同參數。
    const shape = (entry.params || []).map((p) => Array.isArray(p) ? `arr[${p.length}]:${String(p[0])},${String(p[1])}` : `${typeof p}:${String(p).slice(0, 24)}`).join(" | ");
    row.sigs[shape] = (row.sigs[shape] || 0) + 1;
    groups.set(fp, row);
  }
  const rows = [...groups.values()].sort((a, b) => b.ms - a.ms || b.calls - a.calls)
    .map((r) => ({ ...r, ms: Math.round(r.ms * 10) / 10 }));
  const record = {
    case: scenario.name,
    queries: slice.length,
    wall_ms: Math.round(page.timing.total_ms),
    list_ms: Math.round(page.timing.query_ms),
    stats_ms: Math.round(page.timing.stats_ms),
    totalMatched: page.timing.dataset,
    statsTotal: page.stats?.total ?? null,
    pageKeys: Object.keys(page).sort(),
    timingKeys: Object.keys(page.timing || {}).sort(),
    pageIds: page.listings.map((r) => Number(r.post_id)),
    sql: rows,
  };
  scenarios.push(record);
  if (!quiet) {
    console.log(`\n── ${scenario.name}: queries=${record.queries} wall=${record.wall_ms}ms (list=${record.list_ms} stats=${record.stats_ms}) matched=${record.totalMatched}`);
    for (const r of rows) console.log(`   ${String(r.calls).padStart(4)}x ${String(r.ms).padStart(8)}ms  ${r.fingerprint}`);
  }
}

const payload = {
  label, memberUid: uid, onePass: process.env.MEMBER_LIST_ONEPASS ?? "(default on)",
  prefilter: process.env.MEMBER_DISTRICT_PREFILTER ?? "(default on)",
  generatedAt: new Date().toISOString(),
  totals: {
    scenarios: scenarios.length,
    queries: scenarios.reduce((s, x) => s + x.queries, 0),
    perScenario: Math.round((scenarios.reduce((s, x) => s + x.queries, 0) / Math.max(1, scenarios.length)) * 10) / 10,
  },
  scenarios,
};
if (outPath) { writeFileSync(outPath, JSON.stringify(payload, null, 2)); console.log(`\nwrote ${outPath}（每情境平均 ${payload.totals.perScenario} 條 SQL）`); }
else console.log(JSON.stringify(payload, null, 2));
await closeSharedPgDriver();
process.exit(0);
