// Node 路徑 vs SQL-first 路徑的逐條件差分工具（唯讀，只連隔離庫 repro/crawl_sandbox）。
//
// 用途：把「SQL-first 多算（或少算）」拆成「可定位、可鏡射」的過濾條件清單。
// 對每個 combo 輸出：
//   - Node 過濾鏈每一道淘汰多少列（含 listingMatchesListFilter 的 sub 分解：
//     affiliate／hidden／dup／confirmed）；
//   - SQL-first keeps 集合 vs Node keeps 集合的差集（sqlOnly = SQL 留 Node 殺、
//     nodeOnly = Node 留 SQL 殺）；
//   - 差集歸因（每一筆是被 Node 哪一道殺的）+ 前 20 筆抽樣（關鍵欄位值）。
//
// 用法：
//   PG_URL 指到隔離庫（repro/crawl_sandbox，經 assertPgTargetAllowed）。
//   COMBO='{"kind":"whole","q":"套房","districts":["西屯區"],"sort":"newest"}' node v3/scripts/public-search-diff.mjs
//   不設 COMBO 就跑內建 30 combos，逐行 JSON 輸出（可重導到 .jsonl）。
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { withPgReadSnapshot, readPgRows } from "../src/pgReadSnapshot.js";
import { listingSearchBuildContext, buildListRequestContextFromPg, publicSearchSettings, buildPublicListingsClauses, buildPublicListingsRowsAsync, preloadDecorationProviderAsync } from "../src/db.js";
import { districtClosureIds } from "../src/listingSearchNodePg.js";
import { buildPublicListingSearchSql } from "../src/listingSearchSql.js";
import { createDecorationDataLoader } from "../src/repository/decorationData.js";
import { normalizeListQuery, createAttributeFilter, passesGeoFilters, passesDisplayFilters, matchesHousingKind, matchesListingSources } from "../src/floors.js";
import { listingMatchesListFilter, listingIsMainListAffiliate } from "../src/personalFlags.js";
import { keepSelfListingForViewer } from "../src/selfListings.js";
import { districtNameFromListing } from "../src/regions.js";

assertPgTargetAllowed("public-search-diff", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const drv = await createPostgresDriver({ env: process.env });
const cols = listingSearchBuildContext().candidateColumns;

const COMBOS = [
  { name: "baseline", kind: "", q: "", districts: [], sort: "newest" },
  { name: "q=套房", kind: "", q: "套房", districts: [], sort: "newest" },
  { name: "q=大安", kind: "", q: "大安", districts: [], sort: "newest" },
  { name: "q=電梯", kind: "", q: "電梯", districts: [], sort: "newest" },
  { name: "q=編號", kind: "", q: "__POST_ID__", districts: [], sort: "newest" },
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

// q=編號 用一個真實 post_id 的前 4 碼
const sampleId = await (async () => {
  const c = await drv.pool.connect();
  try { const r = await c.query("SELECT post_id FROM listings ORDER BY post_id LIMIT 1"); return String(Number(r.rows[0]?.post_id || 0)).slice(0, 4); }
  finally { c.release(); }
})();

const combos = process.env.COMBO ? [JSON.parse(process.env.COMBO)] : COMBOS;

async function runCombo(combo) {
  return withPgReadSnapshot(drv, async snapshot => {
    await snapshot.query("SET LOCAL statement_timeout = '25s'");
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
    const nodeKeeps = new Set(survivors.map(r => Number(r.post_id)));

    const { kind: nKind, sources: nSources } = normalizeListQuery("all", args.kind, args.sources || "");
    const attrFilter = createAttributeFilter(settings);
    const stages = [];
    const killedBy = new Map();
    let cur = raw;
    const stage = (name, pred, subs = null) => {
      const keep = [], killed = new Set();
      const subKilled = subs ? new Map(subs.map(([n]) => [n, new Set()])) : null;
      for (const r of cur) {
        if (pred(r)) keep.push(r);
        else {
          const id = Number(r.post_id);
          killed.add(id);
          if (subKilled) for (const [sn, spred] of subs) if (spred(r)) { subKilled.get(sn).add(id); break; }
        }
      }
      const rec = { name, in: cur.length, out: keep.length, killed: killed.size };
      if (subKilled) rec.subs = Object.fromEntries([...subKilled].map(([k, v]) => [k, v.size]));
      stages.push(rec);
      killedBy.set(name, killed);
      cur = keep;
    };
    stage("applyListingFilter", (r) => attrFilter(r) && passesGeoFilters(r, settings, { strict: false }));
    stage("listingMatchesListFilter(all)", (r) => listingMatchesListFilter(r, "all"), [
      ["affiliate", (r) => listingIsMainListAffiliate(r, "all")],
      ["hidden", (r) => Number(r.hidden) === 1],
      ["dup", (r) => String(r.match_verdict || "") === "yes"],
      ["confirmed", (r) => Number(r.offline_confirmed) === 1],
    ]);
    stage("keepSelfListingForViewer", (r) => keepSelfListingForViewer(r, 0, settings, () => true));
    stage("passesDisplayFilters", (r) => passesDisplayFilters(r, settings, { skipWholeFloor: Boolean(nKind) }));
    if (built.districtSet.size) stage("districtSet", (r) => built.districtSet.has(r.district || districtNameFromListing(r)));
    stage("matchesHousingKind", (r) => matchesHousingKind(r, nKind));
    stage("matchesListingSources", (r) => matchesListingSources(r, nSources));

    const builtSql = buildPublicListingSearchSql({ kind: args.kind, q, districts: args.districts, sort: args.sort, settings }, deps);
    let sqlKeeps = null, sqlReason = null;
    if (!builtSql.ok) sqlReason = "out_of_envelope:" + builtSql.reason;
    else {
      try {
        const sqlKeepsSql = toPostgresSql(`SELECT p.post_id FROM listing_search_projection p WHERE p.post_id IN (SELECT post_id FROM listings ${builtSql.where}) ${builtSql.districtWhere ? `AND ${builtSql.districtWhere}` : ""} ${builtSql.displayFilter} ${builtSql.projectionFilter || ""}`);
        sqlKeeps = new Set((await snapshot.query(sqlKeepsSql, builtSql.countQuery.params)).rows.map(r => Number(r.post_id)));
      } catch (e) {
        sqlReason = String(e?.code) === "57014" ? "sql_count_timeout" : "sql_error:" + String(e?.message || e).slice(0, 120);
      }
    }

    let diff = [], nodeOnly = [], attribution = {};
    if (sqlKeeps) {
      diff = [...sqlKeeps].filter(id => !nodeKeeps.has(id));
      nodeOnly = [...nodeKeeps].filter(id => !sqlKeeps.has(id));
      for (const [name, killed] of killedBy) { const n = diff.filter(id => killed.has(id)).length; if (n) attribution[name] = n; }
    }

    let sample = [];
    if (diff.length) {
      const ids = diff.slice(0, 20);
      const ph = ids.map((_, i) => `$${i + 1}`).join(",");
      sample = (await snapshot.query(
        `SELECT l.post_id, l.hidden, l.offline, l.offline_confirmed, l.match_verdict, l.match_post_id, l.source, l.floor_name, l.title,
                p.low_floor, p.rooftop, p.parking, p.kind_keys
         FROM listings l LEFT JOIN listing_search_projection p ON p.post_id = l.post_id
         WHERE l.post_id IN (${ph}) ORDER BY l.post_id`, ids)).rows;
    }

    return { name: combo.name, rawCount: raw.length, nodeKeeps: nodeKeeps.size, sqlKeeps: sqlKeeps ? sqlKeeps.size : null, sqlReason, stages, diffSize: diff.length, nodeOnlySize: nodeOnly.length, attribution, sample };
  });
}

for (const combo of combos) {
  console.log(JSON.stringify(await runCombo(combo)));
}
await drv.pool.end();
