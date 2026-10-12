// 逐列對稱差（Owner 2026-10-12 裁決，L-0845）：**不用加總恒等式**，直接把
// 「只有 Node」「只有 SQL」兩個集合的 post_id 一個一個列出來並歸因，兩者都必須是空集合。
// 35 個 combo 與 fold-endpoint-parity.mjs 同一份定義（totalMatched／前 20 筆順序）。
//
// 只連隔離庫、唯讀。用法：PG_URL=$PG_SNAPSHOT_REPRO2_URL node v3/scripts/fold-endpoint-symmetric-diff.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { withPgReadSnapshot, readPgRows } from "../src/pgReadSnapshot.js";
import { listingSearchBuildContext, buildListRequestContextFromPg, publicSearchSettings, buildPublicListingsClauses, buildPublicListingsRowsAsync, preloadDecorationProviderAsync } from "../src/db.js";
import { districtClosureIds } from "../src/listingSearchNodePg.js";
import { buildPublicListingsFoldSql } from "../src/listingSearchSql.js";
import { createDecorationDataLoader } from "../src/repository/decorationData.js";
import { normalizeCrawlSources } from "../src/crawlSources.js";

assertPgTargetAllowed("fold-endpoint-symmetric-diff", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });
const drv = await createPostgresDriver({ env: process.env });
const cols = listingSearchBuildContext().candidateColumns;

const COMBOS = [
  { name: "baseline", kind: "", q: "", districts: [], sort: "newest" },
  { name: "q=套房", kind: "", q: "套房", districts: [], sort: "newest" },
  { name: "q=大安", kind: "", q: "大安", districts: [], sort: "newest" },
  { name: "q=電梯", kind: "", q: "電梯", districts: [], sort: "newest" },
  { name: "q=編號", kind: "", q: "__POST_ID__", districts: [], sort: "newest" },
  { name: "q=101", kind: "", q: "101", districts: [], sort: "newest" },
  { name: "q=15000", kind: "", q: "15000", districts: [], sort: "newest" },
  { name: "q=2699", kind: "", q: "2699", districts: [], sort: "newest" },
  { name: "q=2699975575(完整ID)", kind: "", q: "2699975575", districts: [], sort: "newest" },
  { name: "q=15000+kind=whole", kind: "whole", q: "15000", districts: [], sort: "newest" },
  { name: "district=西屯區", kind: "", q: "", districts: ["西屯區"], sort: "newest" },
  { name: "district=中正區", kind: "", q: "", districts: ["中正區"], sort: "newest" },
  { name: "district=西屯區+中正區", kind: "", q: "", districts: ["西屯區", "中正區"], sort: "newest" },
  { name: "kind=whole", kind: "whole", q: "", districts: [], sort: "newest" },
  { name: "kind=suite_shared", kind: "suite_shared", q: "", districts: [], sort: "newest" },
  { name: "kind=apartment", kind: "apartment", q: "", districts: [], sort: "newest" },
  { name: "kind=elevator", kind: "elevator", q: "", districts: [], sort: "newest" },
  { name: "kind=shop", kind: "shop", q: "", districts: [], sort: "newest" },
  { name: "kind=suite", kind: "suite", q: "", districts: [], sort: "newest" },
  { name: "sort=price_asc", kind: "", q: "", districts: [], sort: "price_asc" },
  { name: "sort=price_desc", kind: "", q: "", districts: [], sort: "price_desc" },
  { name: "excludeRooftop=false", kind: "", q: "", districts: [], sort: "newest", excludeRooftop: false },
  { name: "excludeLowFloors=false", kind: "", q: "", districts: [], sort: "newest", excludeLowFloors: false },
  { name: "hasParking=true", kind: "", q: "", districts: [], sort: "newest", hasParking: true },
  { name: "wholeFloorOnly=true", kind: "", q: "", districts: [], sort: "newest", wholeFloorOnly: true },
  { name: "priceMax=20000", kind: "", q: "", districts: [], sort: "newest", priceMax: 20000 },
  { name: "areaMax=30", kind: "", q: "", districts: [], sort: "newest", areaMax: 30 },
  { name: "kind=whole+sort=price_asc", kind: "whole", q: "", districts: [], sort: "price_asc" },
  { name: "q=套房+kind=whole", kind: "whole", q: "套房", districts: [], sort: "newest" },
  { name: "q=套房+district=西屯區", kind: "", q: "套房", districts: ["西屯區"], sort: "newest" },
  { name: "kind=whole+district=西屯區", kind: "whole", q: "", districts: ["西屯區"], sort: "newest" },
  { name: "q=套房+kind=whole+district=西屯區", kind: "whole", q: "套房", districts: ["西屯區"], sort: "newest" },
  { name: "district=西屯區+sort=price_asc", kind: "", q: "", districts: ["西屯區"], sort: "price_asc" },
  { name: "kind=whole+q=電梯+district=中正區+price_desc", kind: "whole", q: "電梯", districts: ["中正區"], sort: "price_desc" },
  { name: "excludeLowFloors=false+hasParking=true", kind: "", q: "", districts: [], sort: "newest", excludeLowFloors: false, hasParking: true },
];

const sampleId = await (async () => {
  const c = await drv.pool.connect();
  try { const r = await c.query("SELECT post_id FROM listings ORDER BY post_id LIMIT 1"); return String(Number(r.rows[0]?.post_id || 0)).slice(0, 4); }
  finally { c.release(); }
})();

/** 對差異列逐一歸因：只讀 listings ＋ listing_prep，把「為什麼這一列只在某一邊」講清楚。 */
async function attribute(snapshot, ids) {
  if (!ids.length) return [];
  const rows = (await snapshot.query(
    `SELECT l.post_id, l.fold_component_root, l.offline, l.offline_confirmed, l.hidden, l.match_verdict,
            l.match_post_id, l.source, COALESCE(p.display_ready, 0) AS display_ready
     FROM listings l LEFT JOIN listing_prep p ON p.post_id = l.post_id
     WHERE l.post_id = ANY($1::bigint[]) ORDER BY l.post_id`,
    [ids],
  )).rows;
  const comps = (await snapshot.query(
    `SELECT l.post_id, l.fold_component_root FROM listings l
     WHERE l.fold_component_root = ANY($1::bigint[]) ORDER BY l.post_id`,
    [[...new Set(rows.map((r) => Number(r.fold_component_root)).filter(Boolean))]],
  )).rows;
  const sizeByRoot = new Map();
  for (const r of comps) sizeByRoot.set(Number(r.fold_component_root), (sizeByRoot.get(Number(r.fold_component_root)) || 0) + 1);
  return rows.map((r) => ({
    post_id: Number(r.post_id),
    root: r.fold_component_root == null ? null : Number(r.fold_component_root),
    comp_size: r.fold_component_root == null ? 1 : sizeByRoot.get(Number(r.fold_component_root)) || 1,
    offline: Number(r.offline) || 0,
    offline_confirmed: Number(r.offline_confirmed) || 0,
    hidden: Number(r.hidden) || 0,
    match_verdict: r.match_verdict || null,
    match_post_id: r.match_post_id == null ? null : Number(r.match_post_id),
    source: r.source,
    display_ready: Number(r.display_ready) === 1,
  }));
}

async function runCombo(combo) {
  return withPgReadSnapshot(drv, async snapshot => {
    await snapshot.query("SET LOCAL statement_timeout = '180s'");
    const exec = (sql, params = [], { batch = false } = {}) => batch
      ? readPgRows(snapshot, toPostgresSql(sql), params)
      : snapshot.query(toPostgresSql(sql), params).then(r => r.rows);
    const ASOF = new Date().toISOString();
    const context = await buildListRequestContextFromPg(exec, { asOf: ASOF });
    const deps = { ...listingSearchBuildContext({ asOf: ASOF }), resolveUserId: () => 0, visibilityContext: context };
    const q = combo.q === "__POST_ID__" ? sampleId : (combo.q || "");
    const args = { kind: combo.kind || "", q, districts: combo.districts || [], sort: combo.sort || "newest" };
    const settings = publicSearchSettings({ ...args, ...combo });

    const closure = await districtClosureIds(exec, { districtNames: args.districts, userId: 0 });
    const built = buildPublicListingsClauses({ districts: args.districts, settings, q, context, districtIds: closure ?? null }, { sqliteDb: null });
    const raw = await readPgRows(snapshot, toPostgresSql(`SELECT ${cols} FROM listings ${built.where} ORDER BY post_id`), built.params);
    const loader = createDecorationDataLoader({ exec, driver: "postgres" });
    const provider = await preloadDecorationProviderAsync({ exec, loader, rows: raw, settings, userId: 0, matchVoteUserId: 0, peers: false, foldGroups: true, requestContext: context });
    const survivors = await buildPublicListingsRowsAsync(raw, { settings, kind: args.kind, sources: args.sources || "", sort: args.sort, districtSet: built.districtSet, provider, now: context.now, requireProvider: true });
    const nodeOrder = survivors.map(r => Number(r.post_id));

    const enabledSources = normalizeCrawlSources(context.crawlSources.items).filter(x => x.enabled).map(x => x.id);
    const builtSql = buildPublicListingsFoldSql({ kind: args.kind, q, districts: args.districts, districtIds: closure ?? null, sort: args.sort, settings, enabledSources, now: context.now }, deps);
    if (!builtSql.ok) return { name: combo.name, nodeTotal: nodeOrder.length, sqlReason: "out_of_envelope:" + builtSql.reason, onlyNode: [], onlySql: [] };

    const countRes = await snapshot.query(toPostgresSql(builtSql.countQuery.sql), builtSql.countQuery.params);
    const sqlTotal = Number(countRes.rows[0]?.n) || 0;
    const fullRes = await snapshot.query(toPostgresSql(builtSql.fullQuery.sql), builtSql.fullQuery.params);
    const sqlOrder = fullRes.rows.map(r => Number(r.post_id));

    const nodeSet = new Set(nodeOrder);
    const sqlSet = new Set(sqlOrder);
    const onlyNode = nodeOrder.filter(id => !sqlSet.has(id));
    const onlySql = sqlOrder.filter(id => !nodeSet.has(id));
    const orderMismatchAt = (() => {
      for (let i = 0; i < Math.min(sqlOrder.length, nodeOrder.length); i += 1) if (sqlOrder[i] !== nodeOrder[i]) return i;
      return sqlOrder.length === nodeOrder.length ? null : Math.min(sqlOrder.length, nodeOrder.length);
    })();
    return {
      name: combo.name,
      nodeTotal: nodeOrder.length,
      sqlTotal,
      onlyNode,
      onlySql,
      onlyNodeAttr: await attribute(snapshot, onlyNode.slice(0, 20)),
      onlySqlAttr: await attribute(snapshot, onlySql.slice(0, 20)),
      orderMismatchAt,
      ok: sqlTotal === nodeOrder.length && sqlOrder.length === nodeOrder.length && onlyNode.length === 0 && onlySql.length === 0 && orderMismatchAt === null,
    };
  });
}

const results = [];
for (const combo of COMBOS) {
  const r = await runCombo(combo);
  results.push(r);
  console.log(JSON.stringify({ ...r, onlyNodeAttr: undefined, onlySqlAttr: undefined }));
  if (r.onlyNodeAttr?.length) console.log(JSON.stringify({ name: r.name, onlyNodeAttr: r.onlyNodeAttr }));
  if (r.onlySqlAttr?.length) console.log(JSON.stringify({ name: r.name, onlySqlAttr: r.onlySqlAttr }));
}
const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({
  total: results.length,
  allOk: failed.length === 0,
  onlyNodeTotal: results.reduce((n, r) => n + (r.onlyNode?.length || 0), 0),
  onlySqlTotal: results.reduce((n, r) => n + (r.onlySql?.length || 0), 0),
  failed: failed.map(r => r.name),
}));
await drv.pool.end();
process.exit(failed.length === 0 ? 0 : 1);
