// 量 SQL 折疊自身成本（EXPLAIN ANALYZE）＋同屋源群結構統計（union-find，可終止、帶環）。
// 只連隔離庫，唯讀 + session TEMP 表。
// 用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-role-sql-explain.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { withPgReadSnapshot, readPgRows } from "../src/pgReadSnapshot.js";
import { listingSearchBuildContext, buildListRequestContextFromPg, publicSearchSettings, preloadDecorationProviderAsync } from "../src/db.js";
import { createDecorationDataLoader } from "../src/repository/decorationData.js";
import { computeFoldColumns } from "../src/match.js";
import { normalizeCrawlSources } from "../src/crawlSources.js";

assertPgTargetAllowed("fold-role-sql-explain", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });
const drv = await createPostgresDriver({ env: process.env });
const cols = listingSearchBuildContext().candidateColumns;

const { raw, enabledSources, now } = await withPgReadSnapshot(drv, async snapshot => {
  const exec = (sql, params = [], { batch = false } = {}) => batch
    ? readPgRows(snapshot, toPostgresSql(sql), params)
    : snapshot.query(toPostgresSql(sql), params).then(r => r.rows);
  const context = await buildListRequestContextFromPg(exec, { asOf: new Date().toISOString() });
  const settings = publicSearchSettings({});
  const raw = await readPgRows(snapshot, toPostgresSql(`SELECT ${cols} FROM listings ORDER BY post_id`), []);
  const loader = createDecorationDataLoader({ exec, driver: "postgres" });
  await preloadDecorationProviderAsync({ exec, loader, rows: raw, settings, userId: 0, matchVoteUserId: 0, peers: false, requestContext: context });
  const enabledSources = normalizeCrawlSources(context.crawlSources.items).filter(x => x.enabled).map(x => x.id);
  return { raw, enabledSources, now: context.now };
});

// TEMP fold 表
await drv.pool.query("CREATE TEMP TABLE fold_tmp (post_id bigint PRIMARY KEY, fold_rent_num double precision, fold_refresh_kind smallint, fold_refresh_rel_ms bigint, fold_refresh_abs_ms bigint)");
{
  const c = await drv.pool.connect();
  try {
    await c.query("BEGIN");
    for (let i = 0; i < raw.length; i++) {
      const f = computeFoldColumns(raw[i]);
      await c.query("INSERT INTO fold_tmp VALUES ($1,$2,$3,$4,$5)", [Number(raw[i].post_id), f.fold_rent_num, f.fold_refresh_kind, f.fold_refresh_rel_ms, f.fold_refresh_abs_ms]);
    }
    await c.query("COMMIT");
  } finally { c.release(); }
}

const SQL_ROLE = `
WITH fold AS (
  SELECT l.post_id, l.source, l.source_id, l.url, l.last_seen_at, l.offline, l.match_post_id, l.match_verdict,
    f.fold_rent_num, f.fold_refresh_kind, f.fold_refresh_rel_ms, f.fold_refresh_abs_ms,
    (l.source = ANY($1::text[]) AND (l.source <> 'houseprice' OR COALESCE(p.display_ready,0)=1)) AS display_ready,
    (CASE WHEN f.fold_refresh_kind = 1 THEN $2::bigint - f.fold_refresh_rel_ms ELSE f.fold_refresh_abs_ms END) AS refresh_ms,
    (l.source || ':' || COALESCE(NULLIF(l.source_id,''), NULLIF(l.url,''), NULLIF(l.post_id,0)::text, '') || ':' || l.post_id::text) AS tie_key
  FROM listings l LEFT JOIN listing_prep p ON p.post_id = l.post_id LEFT JOIN fold_tmp f ON f.post_id = l.post_id
),
edges AS (SELECT post_id AS src, match_post_id AS dst FROM fold WHERE match_post_id IS NOT NULL AND match_post_id > 0 AND COALESCE(match_verdict,'') <> 'no'),
eff AS (
  SELECT e.src, e.dst FROM edges e JOIN fold s ON s.post_id = e.src JOIN fold d ON d.post_id = e.dst
  WHERE s.display_ready AND d.display_ready AND COALESCE(d.match_verdict,'') <> 'no'
),
inc AS (SELECT src AS x, src AS ord, src, dst FROM eff UNION ALL SELECT dst AS x, src AS ord, src, dst FROM eff),
rk AS (SELECT x, src, dst, row_number() OVER (PARTITION BY x ORDER BY ord ASC, dst ASC) AS rn FROM inc),
fe AS (SELECT x, src, dst FROM rk WHERE rn = 1),
winner AS (
  SELECT fe.x,
    CASE
      WHEN a.fold_rent_num IS NOT NULL AND b.fold_rent_num IS NULL THEN a.post_id
      WHEN b.fold_rent_num IS NOT NULL AND a.fold_rent_num IS NULL THEN b.post_id
      WHEN a.fold_rent_num IS NOT NULL AND b.fold_rent_num IS NOT NULL AND a.fold_rent_num <> b.fold_rent_num
        THEN CASE WHEN a.fold_rent_num < b.fold_rent_num THEN a.post_id ELSE b.post_id END
      WHEN a.refresh_ms <> b.refresh_ms THEN CASE WHEN a.refresh_ms > b.refresh_ms THEN a.post_id ELSE b.post_id END
      WHEN COALESCE(b.last_seen_at,'') <> COALESCE(a.last_seen_at,'') THEN CASE WHEN COALESCE(b.last_seen_at,'') < COALESCE(a.last_seen_at,'') THEN a.post_id ELSE b.post_id END
      WHEN a.tie_key <> b.tie_key THEN CASE WHEN a.tie_key < b.tie_key THEN a.post_id ELSE b.post_id END
      ELSE CASE WHEN a.post_id <= b.post_id THEN a.post_id ELSE b.post_id END
    END AS winner_id
  FROM fe JOIN fold a ON a.post_id = fe.src JOIN fold b ON b.post_id = fe.dst
)
SELECT count(*) AS n FROM winner`;

const t0 = Date.now();
const plan = await drv.pool.query(`EXPLAIN (ANALYZE, BUFFERS) ` + SQL_ROLE, [enabledSources, now]);
const t1 = Date.now();
const execMs = plan.rows.find(r => String(r["QUERY PLAN"] || "").includes("Execution Time"));
console.log("fold total query wall:", (t1 - t0) + "ms");
console.log("fold plan summary (last 12 lines):");
for (const r of plan.rows.slice(-12)) console.log("  " + r["QUERY PLAN"]);

// ---- union-find 群結構統計 ----
// 邊（含 verdict/no/display 過濾前，用全表 match 關係，report 同屋源群結構）
const uf = new Map();
const find = (x) => { let r = x; while (uf.get(r) !== r) r = uf.get(r); while (uf.get(x) !== x) { const n = uf.get(x); uf.set(x, r); x = n; } return r; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) uf.set(ra, rb); };
const nodes = new Set();
const dirEdges = [];
for (const r of raw) {
  const id = Number(r.post_id); const mid = Number(r.match_post_id) || 0;
  if (mid && String(r.match_verdict || "") !== "no") {
    nodes.add(id); nodes.add(mid);
    if (!uf.has(id)) uf.set(id, id); if (!uf.has(mid)) uf.set(mid, mid);
    union(id, mid);
    dirEdges.push([id, mid]);
  }
}
const comps = new Map();
for (const n of nodes) { const root = find(n); if (!comps.has(root)) comps.set(root, []); comps.get(root).push(n); }
// directed cycle detection + max depth per component (acyclic → longest path; cyclic → mark)
function componentStats(members) {
  const s = new Set(members);
  const adj = new Map();
  for (const [a, b] of dirEdges) if (s.has(a) && s.has(b)) { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); }
  // detect directed cycle via DFS colors
  const color = new Map();
  let cyclic = false;
  const visit = (n) => { color.set(n, 1); for (const m of (adj.get(n) || [])) { if (color.get(m) === 1) cyclic = true; else if (color.get(m) === undefined) visit(m); } color.set(n, 2); };
  for (const n of members) if (color.get(n) === undefined) visit(n);
  // max depth via longest path memo (works for acyclic; for cyclic, still gives a number but we mark cyclic)
  const dp = new Map();
  const dfs = (n) => { if (dp.has(n)) return dp.get(n); let best = 0; for (const m of (adj.get(n) || [])) best = Math.max(best, 1 + dfs(m)); dp.set(n, best); return best; };
  let maxDepth = 0; for (const n of members) maxDepth = Math.max(maxDepth, dfs(n));
  return { size: members.length, cyclic, maxDepth };
}
const stats = [];
for (const [root, members] of comps) stats.push({ root, ...componentStats(members) });
stats.sort((a, b) => b.size - a.size);
const cyclicComps = stats.filter(s => s.cyclic);
console.log(JSON.stringify({
  groupsWithLinks: stats.length,
  maxGroupSize: stats.length ? stats[0].size : 0,
  maxDepthOverall: stats.length ? Math.max(...stats.map(s => s.maxDepth)) : 0,
  cyclicGroupCount: cyclicComps.length,
  cyclicLargest: cyclicComps.length ? cyclicComps[0].size : 0,
  cyclicSamples: cyclicComps.slice(0, 20).map(s => ({ size: s.size, maxDepth: s.maxDepth })),
  largestGroupSampleIds: stats[0] ? stats[0].root : null,
}, null, 2));

await drv.pool.end();
