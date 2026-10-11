// 每請求「全域統計」四條查詢的 EXPLAIN (ANALYZE, BUFFERS) 取證腳本（唯讀）。
//
// 目的（P2 選路依據）：把會員列表每請求跑一次的四條全域統計，用**真實參數**在量測庫上
// 逐條量計畫與緩衝區，並把候選寫法（合併多聚合／索引-only／改寫形狀）擺在同一份輸出裡比較。
//
// 用法：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   export PG_URL="$PG_LIVE_REPRO_URL"
//   node v3/scripts/member-list-aux-explain.mjs [--uid 1] [--json out.json]
//
// 只送 `EXPLAIN (ANALYZE, BUFFERS)` 與唯讀 SELECT；不寫任何資料、不建任何索引。
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};

process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";
const { buildListRequestContextFromPg, listingStatsBuildContext } = await import("../src/db.js");
const { sharedPgDriver, closeSharedPgDriver } = await import("../src/pgSharedDriver.js");
const { toPostgresSql } = await import("../src/sqlDialect.js");
const { prepareStatsScope } = await import("../src/repository/listingStats.js");
const { districtKeyLists, districtKeyPrefixExpression } = await import("../src/listDistrictSql.js");
const { loadDistrictPrefilterIds } = await import("../src/listingDistrictPrefilter.js");

const uid = Number(flag("uid", 1)) || 1;
const driver = await sharedPgDriver();
const exec = (sql, params = []) => driver.query(toPostgresSql(sql), params).then((r) => r.rows);
const one = async (sql, params = []) => (await exec(sql, params))[0] ?? null;

const requestContext = await buildListRequestContextFromPg(exec, { asOf: null, resolvedSearchKeys: undefined });
const settings = requestContext.settingsForUser(uid);
const searchKeys = (await exec("SELECT DISTINCT search_key FROM listings WHERE COALESCE(search_key,'') <> ''")).map((r) => r.search_key);
const scope = await prepareStatsScope(listingStatsBuildContext(), { searchKeys, settings, requestContext, run: exec });

const statusWhere = `WHERE ${[...scope.baseClauses, "COALESCE(offline, 0) != 0"].join(" AND ")}`;
const STATUS_SQL = `SELECT
    SUM(CASE WHEN COALESCE(offline, 0) != 0 AND COALESCE(offline_confirmed, 0) = 0 THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN COALESCE(offline, 0) != 0 AND COALESCE(offline_confirmed, 0) != 0 THEN 1 ELSE 0 END) AS confirmed
    FROM listings ${statusWhere}`;
const PRODUCT_SQL = `SELECT COUNT(*) AS n FROM listings WHERE ${requestContext.isolation.sql}`;

// 行政區投影驗證（listingDistrictPrefilter.districtProjectionVerified 的同一條 SQL）
const pref = await loadDistrictPrefilterIds(exec, { districtNames: scope.districtNames });
const { allowed, allKeys } = districtKeyLists(scope.districtNames);
const prefix = districtKeyPrefixExpression("pg");
const placeholders = (n, offset) => Array.from({ length: n }, (_, i) => `$${i + offset}`).join(",");
const PROOF_SQL = `SELECT
       (SELECT COUNT(*) FROM listings l WHERE NOT EXISTS (
          SELECT 1 FROM listing_search_projection p WHERE p.post_id = l.post_id)) AS missing,
       (SELECT COUNT(*) FROM listing_search_projection p
         WHERE (p.district = ANY($${allowed.length + 1}::text[])) IS NOT TRUE
           AND EXISTS (
             SELECT 1 FROM listings l
             WHERE l.post_id = p.post_id
               AND (${prefix} IN (${placeholders(allowed.length, 1)}))
           )) AS mismatched`;
const PROOF_PARAMS = [...allowed, scope.districtNames];
const DISTINCT_SQL = "SELECT DISTINCT search_key FROM listings";

// ── 候選寫法 ────────────────────────────────────────────────────────────────
// (a) 合併「產品可見總數」與「DISTINCT search_key」為一趟掃描的多聚合：
//     同一趟 `listings` 掃描同時算 COUNT(*) 與 array_agg(DISTINCT search_key)。
const MERGED_SQL = `SELECT COUNT(*) AS n, (SELECT array_agg(DISTINCT search_key) FROM listings) AS keys
    FROM listings WHERE ${requestContext.isolation.sql}`;
// (b) 產品總數改走 fixture_namespace 覆蓋索引（index-only）：只投影索引內既有欄位。
const PRODUCT_INDEXONLY_SQL = `SELECT COUNT(*) AS n FROM listings
    WHERE fixture_namespace IS NULL OR fixture_namespace = ''`;
// (c) 投影「缺列」證明改成 listings 側驅動的 merge anti-join（不再對 listings 做 anti-join 子查詢）。
const PROOF_MISSING_ANTI_SQL = `SELECT COUNT(*) AS n FROM listings l
    LEFT JOIN listing_search_projection p ON p.post_id = l.post_id WHERE p.post_id IS NULL`;
// (d) 狀態計數：把 SUM(CASE) 改成 FILTER 聚合（同樣的掃描、少一次 CASE 求值）。
const STATUS_FILTER_SQL = `SELECT
    COUNT(*) FILTER (WHERE COALESCE(offline_confirmed, 0) = 0) AS pending,
    COUNT(*) FILTER (WHERE COALESCE(offline_confirmed, 0) != 0) AS confirmed
    FROM listings ${statusWhere}`;
// (e) 狀態計數：只投影覆蓋索引能回答的欄位（index-only 的前提：新增覆蓋索引；
//     這裡先量「同樣的述詞＋只有 search_key/offline 的投影」能不能走 index-only）。
const STATUS_INDEXONLY_SQL = `SELECT COUNT(*)::int AS n FROM listings WHERE ${scope.baseClauses.join(" AND ")} AND offline <> 0`;

const CASES = [
  ["1-status-counts(before)", STATUS_SQL, scope.baseParams],
  ["1-status-counts(filter)", STATUS_FILTER_SQL, scope.baseParams],
  ["1-status-counts(indexonly-projection)", STATUS_INDEXONLY_SQL, scope.baseParams],
  ["2-product-count(before)", PRODUCT_SQL, requestContext.isolation.params || []],
  ["2-product-count(index-only-predicate)", PRODUCT_INDEXONLY_SQL, []],
  ["3-distinct-search-key(before)", DISTINCT_SQL, []],
  ["4-projection-proof(before)", PROOF_SQL, PROOF_PARAMS],
  ["4-projection-proof(anti-join-missing-only)", PROOF_MISSING_ANTI_SQL, []],
  ["5-merged(count+distinct)", MERGED_SQL, requestContext.isolation.params || []],
];

// 計畫摘要（避免把整份計畫倒進對話）：節點種類、掃描方式、Buffers、Execution Time。
function summarizePlan(rows) {
  const nodes = [];
  for (const line of rows) {
    const m = /^\s*->\s+(.*?)\s{2}\(/.exec(line);
    if (m) nodes.push(m[1].replace(/\s+/g, " "));
  }
  const pick = (re) => { const hit = rows.find((l) => re.test(l)); return hit ? hit.trim() : null; };
  const buffers = pick(/^\s*Buffers: shared/);
  const exec = pick(/Execution Time:/);
  const planning = pick(/Planning Time:/);
  const jit = pick(/^\s*JIT:/);
  const rowsLine = rows.filter((l) => /rows=\d+ loops=\d+/.test(l)).slice(0, 2).join(" || ").trim();
  return { nodes, buffers, exec, planning, jit, rowsLine };
}

// 與請求內一致：讀取快照會下 `SET LOCAL jit = off`（pgReadSnapshot.js:58），EXPLAIN 也照做，
// 否則 Celeron 上光是 JIT 編譯就要 0.7–0.9 秒，量到的不是查詢本身。
await driver.query("SET jit = off");

const out = [];
for (const [name, sql, params] of CASES) {
  let rows = null, error = null, ms = 0;
  const started = performance.now();
  try {
    const res = await driver.query(toPostgresSql(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`), params);
    rows = res.rows.map((r) => r["QUERY PLAN"]);
  } catch (e) { error = e.message; }
  ms = Math.round(performance.now() - started);
  const summary = rows ? summarizePlan(rows) : null;
  out.push({ name, ms, error, summary, plan: rows });
  console.log(`\n### ${name}  (${ms}ms, params=${params.length})`);
  if (error) { console.log(`  ERROR: ${error}`); continue; }
  console.log("  nodes : " + summary.nodes.join(" | "));
  console.log("  rows  : " + (summary.rowsLine || "-"));
  console.log("  " + (summary.buffers || "-"));
  console.log("  " + (summary.exec || "-") + "   " + (summary.planning || ""));
}

const payload = {
  uid, districts: scope.districtNames, allowedDistrictKeys: allowed.length, allDistrictKeys: allKeys.length,
  searchKeys: searchKeys.length, baseParams: scope.baseParams.length,
  productIsolation: requestContext.isolation.sql,
  isolationParams: requestContext.isolation.params,
  prefilterIds: pref ? pref.postIds.length : null,
  cases: out,
};
const outPath = flag("json");
if (outPath) { writeFileSync(outPath, JSON.stringify(payload, null, 2)); console.log(`\nwrote ${outPath}`); }
await closeSharedPgDriver();
process.exit(0);
