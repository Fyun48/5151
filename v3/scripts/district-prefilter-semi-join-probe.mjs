// 「投影預篩改成查詢內 semi-join」的**前後對照探針**（唯讀；隔離靶）。
//
// 背景：會員列表的一趟掃描目前把行政區預篩寫成 `post_id = ANY($n::bigint[])`，而那個 id 陣列是
// Node 端先用 `SELECT post_id FROM listing_search_projection WHERE district = ANY(...)` 取回來的
// （每個請求兩次、7 位會員最貴時 16,600 個 id）。這一包要驗的是「把預篩改寫成查詢內 semi-join」
// 是否真的比較快——**結論是不會**，而且慢很多；這支腳本把那組數字重新量一次。
//
// 它用**真的 builder**（`prepareStatsScope`／`prepareListScope`／`buildScopeScanQuery`）組出
// 一趟掃描實際送出的那條 SQL，然後並排跑四種寫法：
//   V0  現況            `post_id = ANY($n::bigint[])`（id 陣列）
//   F1  `EXISTS (SELECT 1 FROM listing_search_projection p WHERE p.post_id = listings.post_id AND p.district = ANY($k::text[]))`
//   F2  `post_id IN (SELECT p.post_id FROM listing_search_projection p WHERE p.district = ANY($k::text[]))`
//   F3  `post_id = ANY(ARRAY(SELECT p.post_id FROM listing_search_projection p WHERE p.district = ANY($k::text[])))`
// 四種寫法語意相同（逐列比對），差別只在 PostgreSQL 能不能把行政區那一項做成 bitmap 前置縮窄。
//
// 用法：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   PG_URL="$PG_SNAPSHOT_REPRO2_URL" MEMBER_UID=1 node v3/scripts/district-prefilter-semi-join-probe.mjs --district 大安區 --rounds 5
//
// 只讀：整個腳本只有 SELECT／EXPLAIN；不寫任何資料列。
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = require("pg");

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const DISTRICT = String(arg("district", "大安區"));
const ROUNDS = Math.max(1, Number(arg("rounds", 5)));
const UID = Number(process.env.MEMBER_UID || 1) || 1;

const url = String(process.env.PG_URL || process.env.PG_LIVE_REPRO_URL || "").trim();
if (!url) { console.error("需要 PG_URL（或 PG_LIVE_REPRO_URL）；只接受隔離靶"); process.exit(2); }
const db = (() => { try { return new URL(url).pathname.replace(/^\//, ""); } catch { return ""; } })();
if (!/^(repro|repro2|tracker_test|mlattr_\d+)$/.test(db)) {
  console.error(`拒絕執行：資料庫 "${db}" 不在隔離清單（repro／repro2／tracker_test／mlattr_<pid>）`);
  process.exit(2);
}

const { buildListRequestContextFromPg, listingStatsBuildContext } = await import("../src/db.js");
const { prepareStatsScope } = await import("../src/repository/listingStats.js");
const { prepareListScope } = await import("../src/listingSearchNodePg.js");
const { buildScopeScanQuery } = await import("../src/listingScopeScan.js");
const { toPostgresSql, translateSqliteToPg } = await import("../src/sqlDialect.js");
const { LIST_CANDIDATE_COLUMNS } = await import("../src/listingCandidateRow.js");

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("SET jit = off");
const exec = (sql, params = []) => client.query(toPostgresSql(sql), params).then((r) => r.rows);

// 1) 用真的 builder 組出「一趟掃描」的 SQL（與 runScopeScan 內的版本預讀同一個形狀）
const requestContext = await buildListRequestContextFromPg(exec, { asOf: null, resolvedSearchKeys: undefined });
const settings = requestContext.settingsForUser(UID);
const statsScope = await prepareStatsScope(listingStatsBuildContext(), { settings, requestContext, run: exec });
const listScope = await prepareListScope(exec, {
  filter: "all", kind: "", sources: "", q: "", sort: "newest", districts: [DISTRICT],
  limit: 20, offset: 0, userId: UID, matchVoteUserId: UID, sameHouse: true,
}, { settings, context: requestContext, uid: UID, voteUid: UID });
const query = buildScopeScanQuery({
  candidateColumns: LIST_CANDIDATE_COLUMNS,
  statsScope: { clauses: statsScope.clauses, params: statsScope.params },
  listScope: { clauses: listScope.built.clauses, params: listScope.built.params },
});
if (!query) { console.error("兩個範圍沒有共同前綴 ⇒ 不會走一趟掃描"); process.exit(2); }
// 版本預讀那一趟的實際文字＝`SELECT <version 欄><旗標> FROM listings <主查詢的 WHERE>`。
// 這裡用 SQLite 風格一次組完再交給 toPostgresSql 編號（`?` 依文字順序變 `$1..$k`），
// 所以參數陣列順序必須與文字順序一致：旗標在前、主查詢在後。
const PREFIX = `SELECT ${LIST_CANDIDATE_COLUMNS} FROM listings `;
const wherePart = query.sql.startsWith(PREFIX) ? query.sql.slice(PREFIX.length) : query.unionWhere;
const sqliteStyle = `SELECT post_id, xmin::text || '/' || ctid::text AS content_version,`
  + ` (${query.listFlagSql}) AS in_list_scope, (${query.statsFlagSql}) AS in_stats_scope`
  + ` FROM listings ${wherePart}`;
const baseSql = toPostgresSql(sqliteStyle);
const baseParams = [...query.listFlagParams, ...query.statsFlagParams, ...query.params];

// 2) 找出「投影 id 陣列」的那幾個參數（stats 側＝會員行政區、list 側＝請求行政區；關係閉包 id 不動）
const namesFor = (len, statsNames, listNames) => (len === 16600 ? statsNames : listNames);
const statsNames = listScope.districtNames && statsScope.districtNames.length ? statsScope.districtNames : [];
const listNames = listScope.districtNames || [];
const arrayParams = baseParams.filter((v) => Array.isArray(v) && (v.length === 16600 || v.length === 5142));
const swappedPh = new Set(baseParams.map((v, i) => (Array.isArray(v) && (v.length === 16600 || v.length === 5142) ? i + 1 : -1)).filter((i) => i > 0));
if (!arrayParams.length) { console.error("找不到投影 id 陣列參數（此靶的會員設定可能不需要預篩）"); process.exit(2); }
const semiNamesFor = (v) => namesFor(v.length, statsNames, listNames);

function buildForm(form) {
  const useSemi = form !== "V0";          // V0 必須是逐字現況（id 陣列）
  const values = baseParams.slice();
  const swapped = useSemi ? swappedPh : new Set();
  if (useSemi) baseParams.forEach((v, i) => {
    if (Array.isArray(v) && (v.length === 16600 || v.length === 5142)) values[i] = semiNamesFor(v);
  });
  let sql = baseSql;   // 先不改字面，直接換 clause（改字面會讓下面的比對失效）
  if (useSemi) {
    sql = sql.replace(/post_id = ANY\((\$\d+)::bigint\[\]\)/g, (m, ph) => {
      if (!swapped.has(Number(ph.slice(1)))) return m;
      const inner = `SELECT p.post_id FROM listing_search_projection p WHERE p.district = ANY(${ph}::text[])`;
      if (form === "F1") return `EXISTS (SELECT 1 FROM listing_search_projection p WHERE p.post_id = listings.post_id AND p.district = ANY(${ph}::text[]))`;
      if (form === "F2") return `post_id IN (${inner})`;
      if (form === "F3") return `post_id = ANY(ARRAY(${inner}))`;
      return m;
    });
  }
  return { sql, params: values };
}

const rowKey = (r) => `${r.post_id}|${r.in_list_scope === true ? 1 : 0}|${r.in_stats_scope === true ? 1 : 0}`;
async function readRows(sql, params) {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const res = await client.query(sql, params);
  await client.query("ROLLBACK");
  return res.rows;
}
async function explain(sql, params) {
  const started = performance.now();
  const res = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const plan = res.rows[0]["QUERY PLAN"][0];
  const flat = []; const walk = (n) => { flat.push(n); (n.Plans || []).forEach(walk); }; walk(plan.Plan);
  return { exec: plan["Execution Time"], planning: plan["Planning Time"], rows: flat[0]["Actual Rows"],
    read: flat.reduce((s, n) => s + (n["Shared Read Blocks"] || 0), 0),
    hit: flat.reduce((s, n) => s + (n["Shared Hit Blocks"] || 0), 0),
    removed: flat.reduce((s, n) => s + (n["Rows Removed by Filter"] || 0), 0), wall: performance.now() - started, flat };
}
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10; };

console.log(`靶=${db}｜會員 uid=${UID}｜請求行政區=${DISTRICT}`);
console.log(`stats 側行政區（${statsNames.length}）：${statsNames.join(",")}｜list 側（${listNames.length}）：${listNames.join(",")}`);
console.log(`被換成 semi-join 的投影 id 陣列：${arrayParams.map((v) => v.length).join(" / ")} 個 id`);

const forms = ["V0", "F1", "F2", "F3"];
const built = Object.fromEntries(forms.map((f) => [f, buildForm(f)]));
const reference = (await readRows(built.V0.sql, built.V0.params)).map(rowKey).sort();
console.log(`\n| 寫法 | exec 中位 | planning 中位 | 讀取 block 中位 | heap filter 移除列 | 列數 | 逐列相同 |`);
const timings = {};
for (const f of forms) {
  const { sql, params } = built[f];
  const rows = (await readRows(sql, params)).map(rowKey).sort();
  const same = rows.length === reference.length && rows.every((x, i) => x === reference[i]);
  const runs = [];
  for (let r = 0; r < ROUNDS; r += 1) runs.push(await explain(sql, params));
  timings[f] = runs;
  console.log(`| ${f} | ${med(runs.map((x) => x.exec))}ms | ${med(runs.map((x) => x.planning))}ms | ${med(runs.map((x) => x.read))} | `
    + `${med(runs.map((x) => x.removed))} | ${rows.length} | ${same ? "是" : "否"} |`);
}
const base = med(timings.V0.map((x) => x.exec));
for (const f of forms.slice(1)) {
  console.log(`${f} 對 V0 的 exec Δ：${Math.round((1 - med(timings[f].map((x) => x.exec)) / base) * 100)}%（負＝比現況慢）`);
}
console.log("\nV0 計畫節點（前 8）：");
const show = (n, d) => { if (d < 8) { console.log(`   ${"  ".repeat(d)}${n["Node Type"]}${n["Relation Name"] ? " " + n["Relation Name"] : ""}${n["Index Name"] ? " " + n["Index Name"] : ""} rows=${n["Actual Rows"]} loops=${n["Actual Loops"]}${n["Rows Removed by Filter"] ? " removed=" + n["Rows Removed by Filter"] : ""}`); } (n.Plans || []).forEach((x) => show(x, d + 1)); };
show(timings.V0[timings.V0.length - 1].flat[0], 0);
console.log("F1 計畫節點（前 8）：");
show(timings.F1[timings.F1.length - 1].flat[0], 0);
await client.end();
