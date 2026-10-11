// 背景輔助查詢的 EXPLAIN 證據（唯讀；索引那一半用交易區塊量完就回滾，不留在庫裡）。
//
// 用法（PG 一律用隔離庫）：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   node v3/evidence/background-aux-diet-20261012/explain.mjs [--out plan.json]
//
// ⚠️ `SET jit = off`：JIT 編譯會把 20ms 量成 873ms（L-0700）。
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};

const url = process.env.PG_LIVE_REPRO_URL || process.env.PG_URL;
if (!url) {
  console.error("需要 PG_LIVE_REPRO_URL（隔離庫）；不要用正式庫。");
  process.exit(2);
}

const pg = (await import("pg")).default;
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("SET jit = off");

const plan = async (label, sql, params) => {
  const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
  const lines = result.rows.map((row) => row["QUERY PLAN"]);
  const execution = Number((lines.find((line) => /^Execution Time/.test(line)) || "").replace(/[^0-9.]/g, "")) || 0;
  console.log(`\n== ${label}（${execution} ms）==\n${lines.join("\n")}`);
  return { label, ms: execution, plan: lines };
};

const userIds = (await client.query(
  "SELECT id FROM users WHERE deleted_at IS NULL OR deleted_at = '' ORDER BY id",
)).rows.map((row) => Number(row.id));
const sample = (await client.query("SELECT post_id, type FROM user_events ORDER BY id DESC LIMIT 1")).rows[0];
const postIds = (await client.query("SELECT post_id FROM listing_enrich_jobs LIMIT 40")).rows.map((row) => Number(row.post_id));

const LAST_DETAIL_SQL = `SELECT user_id, detail FROM user_events
  WHERE user_id = ANY($1::bigint[]) AND post_id = $2 AND type = $3
  ORDER BY user_id, id DESC`;
const LAST_DETAIL_ONE_SQL = `SELECT detail FROM user_events
  WHERE user_id = $1 AND post_id = $2 AND type = $3 ORDER BY id DESC LIMIT 1`;
const ENRICH_SQL = "SELECT * FROM listing_enrich_jobs WHERE post_id = ANY($1::bigint[])";

const out = { generatedAt: new Date().toISOString(), users: userIds.length, plans: [] };
out.plans.push(await plan("去重批次（現況，無索引）", LAST_DETAIL_SQL, [userIds, Number(sample.post_id), String(sample.type)]));
out.plans.push(await plan("去重逐會員版（改動前；× 會員數＝每事件成本）", LAST_DETAIL_ONE_SQL, [userIds[0], Number(sample.post_id), String(sample.type)]));
out.plans.push(await plan("補欄位集合式（現況，無索引）", ENRICH_SQL, [postIds]));

// 索引版本：在同一個交易區塊裡建索引、量完回滾（repro 與正式庫都不會被改動）。
await client.query("BEGIN");
await client.query("CREATE INDEX idx_probe_enrich_post ON listing_enrich_jobs (post_id)");
await client.query("CREATE INDEX idx_probe_ue ON user_events (user_id, post_id, type, id)");
out.plans.push(await plan("去重批次（migration 006 的索引）", LAST_DETAIL_SQL, [userIds, Number(sample.post_id), String(sample.type)]));
out.plans.push(await plan("補欄位集合式（migration 006 的索引）", ENRICH_SQL, [postIds]));
await client.query("ROLLBACK");

const leftovers = await client.query(
  "SELECT count(*) AS n FROM pg_indexes WHERE indexname IN ('idx_probe_enrich_post', 'idx_probe_ue')",
);
out.leftoverProbeIndexes = Number(leftovers.rows[0].n);
console.log(`\n回滾後殘留的探針索引：${out.leftoverProbeIndexes}（必須是 0）`);
const outPath = flag("out");
if (outPath) writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
await client.end();
process.exit(out.leftoverProbeIndexes === 0 ? 0 : 1);
