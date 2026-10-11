// P2 索引候選的「同參數、同資料」A/B 量測（**不改任何資料**）。
//
// 作法是 PostgreSQL 的交易式 DDL：`BEGIN` → `CREATE INDEX`（非 CONCURRENTLY，交易內可行）
// → `ANALYZE` → `EXPLAIN (ANALYZE, BUFFERS)` → `ROLLBACK`。索引不會落地，
// 但 planner 在同一筆交易內就看得到它，所以能取得「有／沒有這顆索引」的真實計畫與耗時。
//
// 用法：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   export PG_URL="$PG_LIVE_REPRO_URL"
//   node v3/scripts/member-list-aux-index-probe.mjs [--json out.json]
//
// 量的是 `repository/listingStats.js` 的離線計數（每請求一次的 SUM(CASE) 那條）。
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};

process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";
const { default: pg } = await import("pg");
const { buildListRequestContextFromPg, listingStatsBuildContext } = await import("../src/db.js");
const { toPostgresSql } = await import("../src/sqlDialect.js");
const { prepareStatsScope } = await import("../src/repository/listingStats.js");

const client = new pg.Client({ connectionString: process.env.PG_URL });
await client.connect();
const exec = (sql, params = []) => client.query(toPostgresSql(sql), params).then((r) => r.rows);

const requestContext = await buildListRequestContextFromPg(exec, { asOf: null, resolvedSearchKeys: undefined });
const settings = requestContext.settingsForUser(Number(flag("uid", 1)) || 1);
const searchKeys = (await exec("SELECT DISTINCT search_key FROM listings WHERE COALESCE(search_key,'') <> ''")).map((r) => r.search_key);
const scope = await prepareStatsScope(listingStatsBuildContext(), { searchKeys, settings, requestContext, run: exec });
const sql = `SELECT
    SUM(CASE WHEN COALESCE(offline, 0) != 0 AND COALESCE(offline_confirmed, 0) = 0 THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN COALESCE(offline, 0) != 0 AND COALESCE(offline_confirmed, 0) != 0 THEN 1 ELSE 0 END) AS confirmed
    FROM listings WHERE ${[...scope.baseClauses, "COALESCE(offline, 0) != 0"].join(" AND ")}`;
const params = scope.baseParams;

// 與請求內一致（pgReadSnapshot.js 會下 SET LOCAL jit = off）；否則 Celeron 上光是 JIT
// 編譯就要 0.7–0.9 秒，量到的不是查詢本身。
await client.query("SET jit = off");

async function measure(label, repeats = 3) {
  const runs = [];
  for (let i = 0; i < repeats; i += 1) {
    const res = await client.query(toPostgresSql(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`), params);
    const lines = res.rows.map((r) => r["QUERY PLAN"]);
    runs.push({
      execMs: Number(/Execution Time: ([\d.]+)/.exec(lines.find((l) => /Execution Time/.test(l)) || "")?.[1]),
      planNodes: lines.map((l) => /^\s*->\s+(.*?)\s{2}\(/.exec(l)?.[1]).filter(Boolean),
      buffers: lines.find((l) => /^\s*Buffers: shared/.test(l))?.trim() || null,
    });
  }
  const warm = runs[runs.length - 1];
  console.log(`${label}\n  exec=${warm.execMs}ms  ${warm.buffers}\n  ${warm.planNodes.join(" | ")}`);
  return { label, runs, warm };
}

const result = { generatedAt: new Date().toISOString(), params: params.length, cases: [] };
result.cases.push(await measure("① baseline（現行計畫）"));

for (const [label, ddl] of [
  ["② 部分索引 (search_key) WHERE COALESCE(offline,0) <> 0", "CREATE INDEX probe_offline_search ON listings (search_key) WHERE COALESCE(offline, 0) <> 0"],
  ["③ 部分覆蓋索引 (search_key, source, self_status, self_expires_at, fixture_namespace, offline_confirmed) WHERE COALESCE(offline,0) <> 0", "CREATE INDEX probe_offline_cover ON listings (search_key, source, self_status, self_expires_at, fixture_namespace, offline_confirmed) WHERE COALESCE(offline, 0) <> 0"],
]) {
  await client.query("BEGIN");
  try {
    await client.query(ddl);
    await client.query("ANALYZE listings");
    result.cases.push(await measure(label));
  } finally {
    await client.query("ROLLBACK");
  }
}

console.log("\n（兩個候選索引都在交易內建立後 ROLLBACK，不會落地）");
const outPath = flag("json");
if (outPath) { writeFileSync(outPath, JSON.stringify(result, null, 2)); console.log(`wrote ${outPath}`); }
await client.end();
process.exit(0);
