// (C) tie-break 字串層的 collation 量化探針（唯讀）：docs/same-house-fold-spec.md §6.10 軸二。
// 回答四件事（全部是「數字」，不是敘述）：
//   ① 多成員群中，排名比較走到「last_seen_at 字串層」與「tie-break key 字串層」的群數／列數；
//   ② 對每個多成員群，SQL 的 ORDER BY 用預設 collation（en_US.utf8）與 COLLATE "C" 選出的代表列
//      有無不同（不同群數＝0 就是實證安全）；
//   ③ 同批 key 用 Node 的 localeCompare（預設 locale）與 code-point 比較（≈ C）算一遍，
//      與 PG 預設／PG C 做四方比對，列出分歧；
//   ④ last_seen_at 的格式是否定寬 ISO8601（字串序＝時間序）——這比 collation 更底層。
// 只 SELECT。用法：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   PG_URL=<15435/repro> node v3/scripts/fold-tiebreak-collation-probe.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { buildListRequestContextFromPg } from "../src/db.js";
import { normalizeCrawlSources } from "../src/crawlSources.js";
import { listingTieBreakKey } from "../src/match.js";

assertPgTargetAllowed("fold-tiebreak-collation-probe", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });
const drv = await createPostgresDriver({ env: process.env });
const exec = (sql, params = []) => drv.pool.query(toPostgresSql(sql), params).then((r) => r.rows);

const context = await buildListRequestContextFromPg(exec, { asOf: new Date().toISOString() });
const enabledSources = normalizeCrawlSources(context.crawlSources.items).filter((x) => x.enabled).map((x) => x.id);
const NOW = context.now;

// 與 listingSearchSql.js 的 foldRoleCte 逐字對齊的三個排序運算式（別名可換）。
const KEY = (a) => `(COALESCE(NULLIF(${a}.source,''),'591') || ':' || COALESCE(NULLIF(${a}.source_id,''), NULLIF(${a}.url,''), NULLIF(${a}.post_id,0)::text, '') || ':' || COALESCE(${a}.post_id,0)::text)`;
const SEEN = (a) => `COALESCE(${a}.last_seen_at, '')`;

const CAND = `
  SELECT l.post_id, l.fold_component_root AS croot, l.source, l.source_id, l.url, l.last_seen_at,
         l.fold_rent_num,
         COALESCE(CASE WHEN l.fold_refresh_kind = 1 THEN ?::bigint - l.fold_refresh_rel_ms ELSE l.fold_refresh_abs_ms END, 0) AS refreshv,
         ${KEY("l")} AS key
  FROM listings l
  LEFT JOIN listing_prep p ON p.post_id = l.post_id
  WHERE l.fold_component_root IS NOT NULL
    AND l.offline_confirmed IS DISTINCT FROM 1
    AND (COALESCE(NULLIF(l.source,''),'591') = ANY(?::text[])
         AND (COALESCE(NULLIF(l.source,''),'591') <> 'houseprice' OR COALESCE(p.display_ready, 0) = 1))`;

// ── ④ last_seen_at 格式（定寬 ISO8601？）────────────────────────────────────
const fmt = await exec(
  `SELECT COALESCE(octet_length(last_seen_at), -1) AS octets, count(*) AS n
   FROM listings GROUP BY 1 ORDER BY 1`,
);
const fmtBad = await exec(
  `SELECT count(*) AS n FROM listings
   WHERE last_seen_at IS NOT NULL
     AND last_seen_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{3})?Z$'`,
);
const fmtGrouped = await exec(
  `SELECT count(*) AS n FROM (
     SELECT l.fold_component_root FROM listings l WHERE l.fold_component_root IS NOT NULL
     GROUP BY 1 HAVING count(DISTINCT octet_length(l.last_seen_at)) > 1) t`,
);

// ── ①②③ 逐群統計 ───────────────────────────────────────────────────────────
const rows = await exec(
  `WITH cand AS (${CAND}),
   g AS (SELECT croot FROM cand GROUP BY croot HAVING count(*) >= 2)
   SELECT c.croot, c.post_id, c.source, c.source_id, c.url, c.last_seen_at, c.fold_rent_num, c.refreshv, c.key,
     row_number() OVER (PARTITION BY c.croot ORDER BY (c.fold_rent_num IS NULL), c.fold_rent_num, c.refreshv DESC, ${SEEN("c")} DESC, c.key, c.post_id) AS rn_def,
     row_number() OVER (PARTITION BY c.croot ORDER BY (c.fold_rent_num IS NULL), c.fold_rent_num, c.refreshv DESC, ${SEEN("c")} COLLATE "C" DESC, c.key COLLATE "C", c.post_id) AS rn_c
   FROM cand c JOIN g ON g.croot = c.croot
   ORDER BY c.croot, c.post_id`,
  [NOW, enabledSources],
);

const byGroup = new Map();
for (const r of rows) {
  if (!byGroup.has(r.croot)) byGroup.set(r.croot, []);
  byGroup.get(r.croot).push({ ...r, croot: String(r.croot), post_id: Number(r.post_id), refreshv: Number(r.refreshv) });
}

const numKeyOf = (r) => `${r.fold_rent_num == null ? "null" : Number(r.fold_rent_num)}|${r.refreshv}`;
// 與 match.js preferPrimaryListing 的**字串層**逐字對齊（租金／更新時間已平手時）。
const jsWinner = (list, cmpKey) => list.reduce((best, cur) => {
  if (!best) return cur;
  const sd = String(cur.last_seen_at || "").localeCompare(String(best.last_seen_at || ""));
  if (sd !== 0) return sd > 0 ? cur : best;
  const kd = cmpKey(cur, best);
  if (kd !== 0) return kd < 0 ? cur : best;
  return Number(cur.post_id) <= Number(best.post_id) ? cur : best;
}, null);

let winDiffDefaultVsC = 0;
let seenLayerGroups = 0, seenLayerRows = 0, keyLayerGroups = 0, keyLayerRows = 0;
let nodeVsDefault = 0, nodeVsC = 0, nodeIcuVsCode = 0;
const divergences = [];

for (const [croot, list] of byGroup) {
  const def = list.find((r) => Number(r.rn_def) === 1);
  const cw = list.find((r) => Number(r.rn_c) === 1);
  if (Number(def.post_id) !== Number(cw.post_id)) {
    winDiffDefaultVsC += 1;
    divergences.push({ croot: String(croot), axis: "PG-default vs PG-C winner", pgDefault: Number(def.post_id), pgC: Number(cw.post_id) });
  }
  const sorted = [...list].sort((a, b) => Number(a.rn_def) - Number(b.rn_def));
  const tied = sorted.filter((r) => numKeyOf(r) === numKeyOf(sorted[0]));   // 租金＋更新時間平手的那一疊
  if (tied.length < 2) continue;                                            // 數字鍵就分出勝負 ⇒ 碰不到字串層
  seenLayerGroups += 1; seenLayerRows += tied.length;
  const seenSet = new Set(tied.map((r) => SEENVAL(r)));
  if (seenSet.size === 1) { keyLayerGroups += 1; keyLayerRows += tied.length; }
  const jsIcu = jsWinner(tied, (a, b) => listingTieBreakKey(a).localeCompare(listingTieBreakKey(b)));
  const jsCode = jsWinner(tied, (a, b) => (listingTieBreakKey(a) < listingTieBreakKey(b) ? -1 : listingTieBreakKey(a) > listingTieBreakKey(b) ? 1 : 0));
  if (Number(jsIcu.post_id) !== Number(def.post_id)) nodeVsDefault += 1;
  if (Number(jsIcu.post_id) !== Number(cw.post_id)) nodeVsC += 1;
  if (Number(jsIcu.post_id) !== Number(jsCode.post_id)) nodeIcuVsCode += 1;
  if (Number(jsIcu.post_id) !== Number(def.post_id) || Number(jsCode.post_id) !== Number(cw.post_id) || Number(jsIcu.post_id) !== Number(jsCode.post_id)) {
    divergences.push({
      croot: String(croot), axis: "string-layer winner",
      tiedKeys: tied.map((r) => listingTieBreakKey(r)).sort(),
      tiedPostIds: tied.map((r) => Number(r.post_id)).sort((x, y) => x - y),
      tiedSeen: [...seenSet].sort(),
      pgDefault: Number(def.post_id), pgC: Number(cw.post_id), nodeLocaleCompare: Number(jsIcu.post_id), nodeCodePoint: Number(jsCode.post_id),
    });
  }
}
function SEENVAL(r) { return String(r.last_seen_at || ""); }

// ── ①（純 SQL 交叉驗算，與上面 JS 逐群判定互相獨立）─────────────────────────
const sqlCross = (await exec(
  `WITH cand AS (${CAND}),
   g AS (SELECT croot, count(*) AS n FROM cand GROUP BY croot HAVING count(*) >= 2),
   k AS (SELECT c.croot, (c.fold_rent_num IS NULL) AS rn, c.fold_rent_num, c.refreshv, ${SEEN("c")} AS seen
         FROM cand c JOIN g ON g.croot = c.croot)
   SELECT (SELECT count(*) FROM g) AS multi_member_groups,
          (SELECT count(*) FROM (SELECT croot FROM k GROUP BY croot, rn, fold_rent_num, refreshv HAVING count(*) > 1) t) AS seen_layer_groups_any_position,
          (SELECT count(*) FROM (SELECT croot FROM k GROUP BY croot, rn, fold_rent_num, refreshv, seen HAVING count(*) > 1) t) AS key_layer_groups`,
  [NOW, enabledSources],
))[0];

const meta = (await exec("SELECT current_database() AS db, (SELECT datcollate FROM pg_database WHERE datname=current_database()) AS collate"))[0];
console.log(JSON.stringify({
  target: { db: meta.db, collate: meta.collate },
  enabledSources,
  last_seen_at_format: { widthHistogram: fmt, notIsoFixedWidth: Number(fmtBad[0].n), groupsWithMixedWidths: Number(fmtGrouped[0].n) },
  counts: {
    multi_member_groups: byGroup.size,
    multi_member_rows: rows.length,
    groups_reaching_last_seen_at_string_layer: seenLayerGroups,
    rows_at_last_seen_at_string_layer: seenLayerRows,
    groups_reaching_tiebreak_key_layer: keyLayerGroups,
    rows_at_tiebreak_key_layer: keyLayerRows,
  },
  sql_crosscheck: {
    multi_member_groups: Number(sqlCross.multi_member_groups),
    seen_layer_groups_any_position: Number(sqlCross.seen_layer_groups),
    key_layer_groups: Number(sqlCross.key_layer_groups),
  },
  winnerDiffs: { pgDefault_vs_pgC: winDiffDefaultVsC, nodeLocaleCompare_vs_pgDefault: nodeVsDefault, nodeLocaleCompare_vs_pgC: nodeVsC, nodeLocaleCompare_vs_nodeCodePoint: nodeIcuVsCode },
  divergencesTotal: divergences.length,
  divergences: divergences.slice(0, 20),
}, null, 0));

await drv.pool.end();
