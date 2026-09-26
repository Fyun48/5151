// 只量「規模」，不跑完整管線（便宜、可在短時間內完成）。
// 目的：量化 PG-fed Node 路徑的候選/closure 大小，解釋為何完整管線會太慢。
import { createPostgresDriver } from "/app/src/dbDriverPostgres.js";
import { districtKeyLists, districtKeyPrefixExpression } from "./src/listDistrictSql.js";
import { toPostgresSql } from "./src/sqlDialect.js";

const drv = await createPostgresDriver({ env: process.env });
// 注意：必須套用 toPostgresSql（`?` → `$n`），否則 PG 會直接語法錯誤——
// 先前那次「syntax error at or near )」就是本行漏了轉換造成的，不是被測程式的問題。
const exec = (sql, params = []) => drv.query(toPostgresSql(sql), params).then((r) => r.rows);
const district = process.env.DISTRICT || "西屯區";
const marks = (n) => Array.from({ length: n }, () => "?").join(",");

const { allowed, allKeys } = districtKeyLists([district]);
const prefix = districtKeyPrefixExpression("pg");

let t = Date.now();
const seedRows = await exec(
  `SELECT post_id FROM listings WHERE (${prefix} IN (${marks(allowed.length)}) OR ${prefix} NOT IN (${marks(allKeys.length)}))`,
  [...allowed, ...allKeys]);
const seedMs = Date.now() - t;
const seeds = seedRows.map((r) => Number(r.post_id)).filter(Boolean);

t = Date.now();
const edges = (await exec("SELECT post_id, match_post_id FROM listings WHERE COALESCE(match_post_id, 0) <> 0"))
  .map((r) => [Number(r.post_id) || 0, Number(r.match_post_id) || 0]).filter(([a, b]) => a && b);
const edgesMs = Date.now() - t;

t = Date.now();
const parent = new Map();
const find = (x) => { let r = x; while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r); return r; };
for (const [a, b] of edges) {
  parent.set(a, parent.get(a) ?? a); parent.set(b, parent.get(b) ?? b);
  const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb);
}
const roots = new Set(seeds.map((id) => (parent.has(id) ? find(id) : id)));
const ids = new Set(seeds);
for (const [a, b] of edges) {
  if (roots.has(find(a))) { ids.add(a); ids.add(b); }
  if (roots.has(find(b))) { ids.add(a); ids.add(b); }
}
const closureMs = Date.now() - t;

t = Date.now();
const [[anyRow]] = [await exec("SELECT COUNT(*)::int AS n FROM listings WHERE post_id = ANY(?)", [[...ids]])];
const anyMs = Date.now() - t;

console.log(`NODE-PG-SCALE ${JSON.stringify({
  district, districtKeys: allowed.length, allKeys: allKeys.length,
  seedCount: seeds.length, edgeCount: edges.length, closureSize: ids.size,
  probeAnyCount: Number(anyRow.n),
  ms: { seed: seedMs, edges: edgesMs, closure: closureMs, anyProbe: anyMs },
})}`);
await drv.pool.end();
