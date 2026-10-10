// 端點級 parity：Node 路徑 vs SQL 折疊路徑（buildPublicListingsFoldSql），30 combo。
// 對每個 combo 檢查 total_ok（totalMatched 一致）與 order_ok（排序後 post_id 序列一致）。
// 只連隔離庫，唯讀。用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-endpoint-parity.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { withPgReadSnapshot, readPgRows } from "../src/pgReadSnapshot.js";
import { listingSearchBuildContext, buildListRequestContextFromPg, publicSearchSettings, buildPublicListingsClauses, buildPublicListingsRowsAsync, preloadDecorationProviderAsync } from "../src/db.js";
import { districtClosureIds } from "../src/listingSearchNodePg.js";
import { buildPublicListingsFoldSql } from "../src/listingSearchSql.js";
import { createDecorationDataLoader } from "../src/repository/decorationData.js";
import { normalizeCrawlSources } from "../src/crawlSources.js";

assertPgTargetAllowed("fold-endpoint-parity", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });
const drv = await createPostgresDriver({ env: process.env });
const cols = listingSearchBuildContext().candidateColumns;

const COMBOS = [
  { name: "baseline", kind: "", q: "", districts: [], sort: "newest" },
  { name: "q=套房", kind: "", q: "套房", districts: [], sort: "newest" },
  { name: "q=大安", kind: "", q: "大安", districts: [], sort: "newest" },
  { name: "q=電梯", kind: "", q: "電梯", districts: [], sort: "newest" },
  { name: "q=編號", kind: "", q: "__POST_ID__", districts: [], sort: "newest" },
  // 2026-10-10 回退（#694/#695 numeric-q 回歸）：數字 q 也必須三項 OR，下面這幾組是回歸釘子。
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

async function runCombo(combo) {
  return withPgReadSnapshot(drv, async snapshot => {
    await snapshot.query("SET LOCAL statement_timeout = '60s'");
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
    const provider = await preloadDecorationProviderAsync({ exec, loader, rows: raw, settings, userId: 0, matchVoteUserId: 0, peers: false, requestContext: context });
    const survivors = await buildPublicListingsRowsAsync(raw, { settings, kind: args.kind, sources: args.sources || "", sort: args.sort, districtSet: built.districtSet, provider, now: context.now, requireProvider: true });
    const nodeOrder = survivors.map(r => Number(r.post_id));

    const enabledSources = normalizeCrawlSources(context.crawlSources.items).filter(x => x.enabled).map(x => x.id);
    const builtSql = buildPublicListingsFoldSql({ kind: args.kind, q, districts: args.districts, districtIds: closure ?? null, sort: args.sort, settings, enabledSources, now: context.now }, deps);
    if (!builtSql.ok) return { name: combo.name, nodeTotal: nodeOrder.length, sqlReason: "out_of_envelope:" + builtSql.reason };

    try {
      const countRes = await snapshot.query(toPostgresSql(builtSql.countQuery.sql), builtSql.countQuery.params);
      const sqlTotal = Number(countRes.rows[0]?.n) || 0;
      const fullRes = await snapshot.query(toPostgresSql(builtSql.fullQuery.sql), builtSql.fullQuery.params);
      const sqlOrder = fullRes.rows.map(r => Number(r.post_id));
      const totalOk = sqlTotal === nodeOrder.length;
      // 硬性比對：totalMatched 相等 ＋「前 20 筆 post_id 順序」逐筆相等（缺任一就 fail）。
      const prefix = Math.min(20, nodeOrder.length, sqlOrder.length);
      const orderOk = sqlOrder.length === nodeOrder.length && nodeOrder.slice(0, prefix).every((id, i) => id === sqlOrder[i]);
      return { name: combo.name, nodeTotal: nodeOrder.length, sqlTotal, totalOk, orderOk, orderMismatchAt: orderOk ? null : (() => { for (let i = 0; i < Math.min(sqlOrder.length, nodeOrder.length); i++) if (sqlOrder[i] !== nodeOrder[i]) return i; return Math.min(sqlOrder.length, nodeOrder.length); })() };
    } catch (e) {
      return { name: combo.name, nodeTotal: nodeOrder.length, sqlError: String(e?.message || e).slice(0, 160) };
    }
  });
}

const results = [];
for (const combo of COMBOS) {
  const r = await runCombo(combo);
  results.push(r);
  console.log(JSON.stringify(r));
}
const missing = results.filter(r => !(r.totalOk === true && r.orderOk === true));
const allOk = missing.length === 0;
console.log(JSON.stringify({ total: results.length, allOk, failed: missing.map(r => r.name) }));
await drv.pool.end();
// 硬性門檻：任何組合 totalMatched 或前 20 筆順序不符（或根本沒產出這兩欄）都 exit 1。
process.exit(allOk ? 0 : 1);
