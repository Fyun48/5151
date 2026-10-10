// 驗證「SQL 折疊（window function + preferPrimaryListing 的 SQL 表達）」與讀取端 100% 一致。
// 只連隔離庫，唯讀 + 一張 session TEMP 表（連線關閉即消失，不落 DDL）。
//
// 流程：
//   1. ground truth role = attachSameHouseRoles（讀取端）。
//   2. 用 computeFoldColumns 算 fold_*，寫進 TEMP 表 fold_tmp。
//   3. 跑 SQL role 查詢（first-incident-edge + SQL 版 preferPrimaryListing 贏家）。
//   4. 全表逐列比對 role 與 primary_offline，輸出一致率 + 差異分類。
//
// 用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-role-sql-parity.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { withPgReadSnapshot, readPgRows } from "../src/pgReadSnapshot.js";
import { attachSameHouseRoles, listingSearchBuildContext, buildListRequestContextFromPg, publicSearchSettings, preloadDecorationProviderAsync } from "../src/db.js";
import { createDecorationDataLoader } from "../src/repository/decorationData.js";
import { computeFoldColumns } from "../src/match.js";
import { normalizeCrawlSources } from "../src/crawlSources.js";

assertPgTargetAllowed("fold-role-sql-parity", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const drv = await createPostgresDriver({ env: process.env });
const cols = listingSearchBuildContext().candidateColumns;

const { raw, gtRole, gtPrimaryOffline, enabledSources, now } = await withPgReadSnapshot(drv, async snapshot => {
  await snapshot.query("SET LOCAL statement_timeout = '120s'");
  const exec = (sql, params = [], { batch = false } = {}) => batch
    ? readPgRows(snapshot, toPostgresSql(sql), params)
    : snapshot.query(toPostgresSql(sql), params).then(r => r.rows);
  const ASOF = new Date().toISOString();
  const context = await buildListRequestContextFromPg(exec, { asOf: ASOF });
  const settings = publicSearchSettings({});
  const raw = await readPgRows(snapshot, toPostgresSql(`SELECT ${cols} FROM listings ORDER BY post_id`), []);
  const loader = createDecorationDataLoader({ exec, driver: "postgres" });
  const provider = await preloadDecorationProviderAsync({ exec, loader, rows: raw, settings, userId: 0, matchVoteUserId: 0, peers: false, requestContext: context });

  attachSameHouseRoles(raw, 0, provider, context.now);
  const gtRole = new Map();
  const gtPrimaryOffline = new Map();
  for (const r of raw) {
    gtRole.set(Number(r.post_id), r.same_house_role || null);
    gtPrimaryOffline.set(Number(r.post_id), r.same_house_primary_offline ? 1 : 0);
  }
  const enabledSources = normalizeCrawlSources(context.crawlSources.items).filter(x => x.enabled).map(x => x.id);
  return { raw, gtRole, gtPrimaryOffline, enabledSources, now: context.now };
});

// 寫 fold_* 到 TEMP 表
await drv.pool.query("CREATE TEMP TABLE fold_tmp (post_id bigint PRIMARY KEY, fold_rent_num double precision, fold_refresh_kind smallint, fold_refresh_rel_ms bigint, fold_refresh_abs_ms bigint)");
{
  const client = await drv.pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < raw.length; i++) {
      const f = computeFoldColumns(raw[i]);
      await client.query(
        "INSERT INTO fold_tmp (post_id, fold_rent_num, fold_refresh_kind, fold_refresh_rel_ms, fold_refresh_abs_ms) VALUES ($1,$2,$3,$4,$5)",
        [Number(raw[i].post_id), f.fold_rent_num, f.fold_refresh_kind, f.fold_refresh_rel_ms, f.fold_refresh_abs_ms],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// SQL role 查詢
const SQL_ROLE = `
WITH fold AS (
  SELECT
    l.post_id,
    l.source, l.source_id, l.url, l.last_seen_at, l.offline, l.match_post_id, l.match_verdict,
    f.fold_rent_num, f.fold_refresh_kind, f.fold_refresh_rel_ms, f.fold_refresh_abs_ms,
    (l.source = ANY($1::text[]) AND (l.source <> 'houseprice' OR COALESCE(p.display_ready, 0) = 1)) AS display_ready,
    (CASE WHEN f.fold_refresh_kind = 1 THEN $2::bigint - f.fold_refresh_rel_ms ELSE f.fold_refresh_abs_ms END) AS refresh_ms,
    (l.source || ':' || COALESCE(NULLIF(l.source_id,''), NULLIF(l.url,''), NULLIF(l.post_id,0)::text, '') || ':' || l.post_id::text) AS tie_key
  FROM listings l
  LEFT JOIN listing_prep p ON p.post_id = l.post_id
  LEFT JOIN fold_tmp f ON f.post_id = l.post_id
),
edges AS (
  SELECT post_id AS src, match_post_id AS dst FROM fold
  WHERE match_post_id IS NOT NULL AND match_post_id > 0 AND COALESCE(match_verdict,'') <> 'no'
),
eff AS (
  SELECT e.src, e.dst
  FROM edges e
  JOIN fold s ON s.post_id = e.src
  JOIN fold d ON d.post_id = e.dst
  WHERE s.display_ready AND d.display_ready AND COALESCE(d.match_verdict,'') <> 'no'
),
inc AS (
  SELECT src AS x, src AS ord, src, dst FROM eff
  UNION ALL
  SELECT dst AS x, src AS ord, src, dst FROM eff
),
rk AS (
  SELECT x, src, dst, row_number() OVER (PARTITION BY x ORDER BY ord ASC, dst ASC) AS rn FROM inc
),
fe AS (SELECT x, src, dst FROM rk WHERE rn = 1),
winner AS (
  SELECT fe.x,
    CASE
      WHEN a.fold_rent_num IS NOT NULL AND b.fold_rent_num IS NULL THEN a.post_id
      WHEN b.fold_rent_num IS NOT NULL AND a.fold_rent_num IS NULL THEN b.post_id
      WHEN a.fold_rent_num IS NOT NULL AND b.fold_rent_num IS NOT NULL AND a.fold_rent_num <> b.fold_rent_num
        THEN CASE WHEN a.fold_rent_num < b.fold_rent_num THEN a.post_id ELSE b.post_id END
      WHEN a.refresh_ms <> b.refresh_ms
        THEN CASE WHEN a.refresh_ms > b.refresh_ms THEN a.post_id ELSE b.post_id END
      WHEN COALESCE(b.last_seen_at,'') <> COALESCE(a.last_seen_at,'')
        THEN CASE WHEN COALESCE(b.last_seen_at,'') < COALESCE(a.last_seen_at,'') THEN a.post_id ELSE b.post_id END
      WHEN a.tie_key <> b.tie_key
        THEN CASE WHEN a.tie_key < b.tie_key THEN a.post_id ELSE b.post_id END
      ELSE CASE WHEN a.post_id <= b.post_id THEN a.post_id ELSE b.post_id END
    END AS winner_id,
    a.offline AS a_offline, b.offline AS b_offline
  FROM fe
  JOIN fold a ON a.post_id = fe.src
  JOIN fold b ON b.post_id = fe.dst
)
SELECT
  x,
  (CASE WHEN winner_id = x THEN 'primary' ELSE 'affiliate' END) AS role,
  (CASE WHEN winner_id = fe.src THEN fe.a_offline ELSE fe.b_offline END) AS primary_offline
FROM (SELECT w.x, w.winner_id, w.a_offline, w.b_offline, fe.src, fe.dst FROM winner w JOIN fe ON fe.x = w.x) fe
`;

const sqlResult = await drv.pool.query(SQL_ROLE, [enabledSources, now]);
const sqlRole = new Map();
const sqlPrimaryOffline = new Map();
for (const r of sqlResult.rows) {
  sqlRole.set(Number(r.x), r.role);
  sqlPrimaryOffline.set(Number(r.x), Number(r.primary_offline) === 1 ? 1 : 0);
}

// compare (only nodes that GT or SQL assigned a role matter; nodes with no role in both are trivially equal)
let total = 0, roleMatch = 0, roleMismatch = 0, offlineMismatch = 0;
const roleDiffs = [];
const offlineDiffs = [];
for (const x of gtRole.keys()) {
  const gt = gtRole.get(x) || null;
  const sq = sqlRole.get(x) || null;
  total += 1;
  if (gt === sq) roleMatch += 1;
  else { roleMismatch += 1; roleDiffs.push({ post_id: x, gt, sq }); }
  const gto = gtPrimaryOffline.get(x);
  const sqo = sqlPrimaryOffline.has(x) ? sqlPrimaryOffline.get(x) : 0;
  if (gto !== sqo && gt !== null) offlineMismatch += 1;
}

const buckets = {};
for (const d of roleDiffs) {
  let k;
  if (d.gt === "affiliate" && d.sq === null) k = "sql_missed_affiliate";
  else if (d.gt === null && d.sq === "affiliate") k = "sql_extra_affiliate";
  else if (d.gt === "primary" && d.sq === "affiliate") k = "primary_flipped";
  else if (d.gt === "affiliate" && d.sq === "primary") k = "affiliate_flipped";
  else k = "other:" + d.gt + "_vs_" + d.sq;
  buckets[k] = (buckets[k] || 0) + 1;
}

console.log(JSON.stringify({
  total,
  roleMatch,
  roleMismatch,
  pct: (roleMatch / total * 100).toFixed(4) + "%",
  offlineMismatch,
  buckets,
  enabledSources,
  now,
  sample: roleDiffs.slice(0, 40),
}, null, 2));

await drv.pool.end();
