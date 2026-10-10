// 折疊單趟化前後 EXPLAIN (ANALYZE, BUFFERS) 對照（repro 唯讀）。
//
// 證明「折疊只出現一次」：舊路徑 countQuery＋pageQuery 各跑一次 fold CTE（兩次折疊）；
// 新路徑 pageWithCountQuery 用 window function 把 count 與分頁併成同一支 statement（一次折疊）。
// 用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-explain.mjs [baseline|whole|suite]
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { withPgReadSnapshot } from "../src/pgReadSnapshot.js";
import { listingSearchBuildContext, buildListRequestContextFromPg, publicSearchSettings } from "../src/db.js";
import { districtClosureIds } from "../src/listingSearchNodePg.js";
import { buildPublicListingsFoldSql } from "../src/listingSearchSql.js";
import { normalizeCrawlSources } from "../src/crawlSources.js";

assertPgTargetAllowed("fold-explain", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const KIND = process.argv[2] || "baseline"; // baseline | whole | suite
const kind = KIND === "baseline" ? "" : KIND === "whole" ? "whole" : "suite_shared";

const drv = await createPostgresDriver({ env: process.env });

await withPgReadSnapshot(drv, async (snapshot) => {
  await snapshot.query("SET LOCAL statement_timeout = '120s'");
  const exec = (sql, params = []) => snapshot.query(toPostgresSql(sql), params).then((r) => r.rows);
  const ASOF = new Date().toISOString();
  const context = await buildListRequestContextFromPg(exec, { asOf: ASOF, resolvedSearchKeys: [] });
  const deps = { ...listingSearchBuildContext({ asOf: ASOF }), resolveUserId: () => 0, visibilityContext: context };
  const settings = publicSearchSettings({ kind });
  const enabledSources = normalizeCrawlSources(context.crawlSources.items).filter((x) => x.enabled).map((x) => x.id);
  const built = buildPublicListingsFoldSql({ kind, q: "", districts: [], districtIds: null, sort: "newest", settings, enabledSources, now: context.now }, deps);
  if (!built.ok) { console.error("out of envelope:", built.reason); return; }

  const runExplain = async (label, sql, params) => {
    const r = await snapshot.query(toPostgresSql(`EXPLAIN (ANALYZE, BUFFERS, SUMMARY) ${sql}`), params);
    const plan = r.rows.map((row) => row["QUERY PLAN"]).join("\n");
    return { label, plan };
  };

  // 舊路徑（雙折疊）：count 一次、分頁一次，各內嵌同一支 fold CTE。
  const oldCount = await runExplain("OLD countQuery (fold #1)", built.countQuery.sql, built.countQuery.params);
  const oldPage = await runExplain("OLD pageQuery (fold #2)", built.pageQuery({ limit: 5, offset: 0 }).sql, built.pageQuery({ limit: 5, offset: 0 }).params);
  // 新路徑（單趟）：count 與分頁同一支 statement。
  const plan = built.pageWithCountQuery({ limit: 5, offset: 0 });
  const combined = await runExplain("NEW pageWithCountQuery (single fold)", plan.sql, plan.params);

  const foldScans = (plan) => {
    const cand = (plan.match(/Seq Scan on listings/g) || []).length;
    const cte = (plan.match(/CTE fold_role|CTE cand|CTE display/g) || []).length;
    return { listingsSeqScans: cand, foldCteRefs: cte };
  };

  for (const item of [oldCount, oldPage, combined]) {
    const s = foldScans(item.plan);
    const time = /Execution Time: ([\d.]+) ms/.exec(item.plan)?.[1] ?? "?";
    console.log(`\n===== ${item.label} ===== execution=${time}ms ${JSON.stringify(s)}`);
    console.log(item.plan);
  }
});

await drv.pool.end();
