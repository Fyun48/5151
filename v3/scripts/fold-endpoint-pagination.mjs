// 分頁穩定性實測（Owner 2026-10-12 裁決）：代表列會隨篩選而變 ⇒ 分頁必須是**同一份有序集合的
// 切段**：合併各頁＝完整有序集合、無重複、無遺漏；每一頁的 total_count 必須相同。
// 對每個 combo 用兩種翻頁方式各跑一輪：
//   offset 模式：pageWithCountQuery({limit, offset})，limit ∈ {7, 40, 500}
//   cursor 模式：pageWithCountQuery({limit, cursor})，limit ∈ {7, 500}（cursor 由上一頁最後一列推得）
// 期望集合＝同一支 query 的 fullQuery（不加 LIMIT）的有序 post_id 序列。
//
// 只連隔離庫、唯讀。用法：PG_URL=$PG_SNAPSHOT_REPRO2_URL node v3/scripts/fold-endpoint-pagination.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { withPgReadSnapshot } from "../src/pgReadSnapshot.js";
import { listingSearchBuildContext, buildListRequestContextFromPg, publicSearchSettings, buildPublicListingsClauses } from "../src/db.js";
import { districtClosureIds } from "../src/listingSearchNodePg.js";
import { buildPublicListingsFoldSql } from "../src/listingSearchSql.js";
import { normalizeCrawlSources } from "../src/crawlSources.js";

assertPgTargetAllowed("fold-endpoint-pagination", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });
const drv = await createPostgresDriver({ env: process.env });

// 每個 combo 都是**一次請求一個完整有序序列**的比對（同一個 read snapshot、同一個 ASOF／now、
// 同一個排序鍵）。為什麼挑這幾個：涵蓋三種排序鍵（newest／price_asc／price_desc）＋候選層篩選
// （q／kind），且大小在「每頁都真的重跑一次折疊 CTE」的可接受成本內（最大的 4,803 列）。
const COMBOS = [
  // 最大的一個 combo（全量訪客列表 88,938 列）只跑 offset limit=500（178 頁）——證明「合併各頁
  // ＝完整有序集合」在最大集合上也成立。
  { name: "baseline", kind: "", q: "", districts: [], sort: "newest" },
  { name: "q=101", kind: "", q: "101", districts: [], sort: "newest" },
  { name: "q=15000+kind=whole", kind: "whole", q: "15000", districts: [], sort: "newest" },
  { name: "district=西屯區", kind: "", q: "", districts: ["西屯區"], sort: "newest" },
  { name: "district=西屯區+sort=price_asc", kind: "", q: "", districts: ["西屯區"], sort: "price_asc" },
  { name: "district=西屯區+sort=price_desc", kind: "", q: "", districts: ["西屯區"], sort: "price_desc" },
];

async function runCombo(combo) {
  return withPgReadSnapshot(drv, async snapshot => {
    await snapshot.query("SET LOCAL statement_timeout = '300s'");
    await snapshot.query("SET LOCAL work_mem = '64MB'");
    const exec = (sql, params = []) => snapshot.query(toPostgresSql(sql), params).then(r => r.rows);
    const ASOF = new Date().toISOString();
    const context = await buildListRequestContextFromPg(exec, { asOf: ASOF });
    const deps = { ...listingSearchBuildContext({ asOf: ASOF }), resolveUserId: () => 0, visibilityContext: context };
    const q = combo.q || "";
    const args = { kind: combo.kind || "", q, districts: combo.districts || [], sort: combo.sort || "newest" };
    const settings = publicSearchSettings({ ...args, ...combo });
    const closure = await districtClosureIds(exec, { districtNames: args.districts, userId: 0 });
    const enabledSources = normalizeCrawlSources(context.crawlSources.items).filter(x => x.enabled).map(x => x.id);
    const built = buildPublicListingsFoldSql({ kind: args.kind, q, districts: args.districts, districtIds: closure ?? null, sort: args.sort, settings, enabledSources, now: context.now }, deps);
    if (!built.ok) return { name: combo.name, skipped: built.reason };

    const execSql = (plan) => snapshot.query(toPostgresSql(plan.sql), plan.params).then(r => r.rows);
    const expected = (await execSql(built.fullQuery)).map(r => Number(r.post_id));
    const expectedSet = new Set(expected);

    const checks = [];
    const verify = (label, pages, totals) => {
      const merged = pages.flat();
      const ids = merged.map(r => Number(r.post_id));
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      const missing = expected.filter(id => !ids.includes(id));
      const extra = ids.filter(id => !expectedSet.has(id));
      const orderOk = ids.every((id, i) => id === expected[i]);
      const totalOk = totals.every(t => t === expected.length);
      checks.push({
        label,
        rows: ids.length,
        expected: expected.length,
        dup: dup.length,
        missing: missing.length,
        extra: extra.length,
        orderOk,
        totalOk,
        ok: dup.length === 0 && missing.length === 0 && extra.length === 0 && orderOk && totalOk,
        dupSample: dup.slice(0, 5),
        missingSample: missing.slice(0, 5),
      });
    };

    const sizes = expected.length <= 200 ? [7, 40, 500] : [500];
    for (const limit of sizes) {
      const pages = [];
      const totals = [];
      let offset = 0;
      // 上限保護：頁數過多時視為失敗（不無限翻）
      for (let guard = 0; guard < Math.ceil(expected.length / limit) + 3; guard += 1) {
        const plan = built.pageWithCountQuery({ limit, offset });
        const rows = await execSql(plan);
        if (!rows.length) break;
        totals.push(Number(rows[0].total_count) || 0);
        pages.push(rows.map(({ total_count, ...row }) => row));
        offset += rows.length;
        if (offset >= expected.length) break;
      }
      verify(`offset limit=${limit}`, pages, totals);
    }

    for (const limit of (expected.length <= 200 ? [7, 500] : [500])) {
      const pages = [];
      const totals = [];
      let cursor = null;
      for (let guard = 0; guard < Math.ceil(expected.length / limit) + 3; guard += 1) {
        const plan = built.pageWithCountQuery({ limit, cursor });
        const rows = await execSql(plan);
        if (!rows.length) break;
        totals.push(Number(rows[0].total_count) || 0);
        pages.push(rows.map(({ total_count, ...row }) => row));
        cursor = built.cursorOf(rows[rows.length - 1]);
        if (pages.flat().length >= expected.length) break;
      }
      verify(`cursor limit=${limit}`, pages, totals);
    }

    return {
      name: combo.name,
      // 口徑（Owner R1）：同一 read snapshot、同一 ASOF(=now)、同一排序鍵 ⇒ 跨請求可宣稱。
      // 「翻頁中途改篩選」不在保證範圍（改篩選＝重開分頁），本腳本不測那件事。
      provenance: { asOf: ASOF, sort: combo.sort || "newest", now: context.now, checks: checks.length },
      expectedRows: expected.length,
      checks,
      ok: checks.every(c => c.ok),
    };
  });
}

const results = [];
for (const combo of COMBOS) {
  const r = await runCombo(combo);
  results.push(r);
  console.log(JSON.stringify(r));
}
const failed = results.filter(r => r.ok !== true);
console.log(JSON.stringify({ total: results.length, allOk: failed.length === 0, failed: failed.map(r => r.name), checks: results.reduce((n, r) => n + (r.checks?.length || 0), 0) }));
await drv.pool.end();
process.exit(failed.length === 0 ? 0 : 1);
