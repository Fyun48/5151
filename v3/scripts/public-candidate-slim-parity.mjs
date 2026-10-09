// PG 公開列表候選查詢瘦身（42 → 36 欄）的逐條件 parity ＋ 端對端計時工具。
// 唯讀：只連隔離庫 repro/crawl_sandbox（經 assertPgTargetAllowed）。
//
// 原理：同一筆 pipeline（buildPublicListingsRowsAsync ＋ decoratePublicListingsPage）完全不動，
// 只把「候選查詢」分別用 42 欄（LIST_CANDIDATE_COLUMNS）與 36 欄（PUBLIC_LISTING_CANDIDATE_COLUMNS）
// 各跑一遍，再逐欄位比對。若 36 欄有任何被 pipeline 讀到、會影響結果的欄位被漏掉，這裡會立刻抓出。
//
// 用法：
//   PG_URL=<repro 或 crawl_sandbox> node v3/scripts/public-candidate-slim-parity.mjs
//   PARITY_ONLY=1  只跑 parity（跳過計時）
//   TIMING_ONLY=1  只跑計時（baseline/kind=whole/q=套房）
//   MAX_COMBOS=n   限制 parity combo 數（預設全跑）
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { withPgReadSnapshot, readPgRows } from "../src/pgReadSnapshot.js";
import {
  buildListRequestContextFromPg, publicSearchSettings, buildPublicListingsClauses,
  buildPublicListingsRowsAsync, preloadDecorationProviderAsync, decoratePublicListingsPage,
  GUEST_MAX_DISTRICTS,
} from "../src/db.js";
import { districtClosureIds } from "../src/listingSearchNodePg.js";
import { createDecorationDataLoader } from "../src/repository/decorationData.js";
import { LIST_CANDIDATE_COLUMNS, PUBLIC_LISTING_CANDIDATE_COLUMNS } from "../src/listingCandidateRow.js";

assertPgTargetAllowed("public-candidate-slim-parity", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const drv = await createPostgresDriver({ env: process.env });

// 遞迴排序物件 key，得到與 key 順序無關的 canonical 字串（陣列順序仍保留）。
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runPipeline(combo, columns) {
  return withPgReadSnapshot(drv, async snapshot => {
    const exec = (sql, params = [], { batch = false } = {}) => batch
      ? readPgRows(snapshot, toPostgresSql(sql), params)
      : snapshot.query(toPostgresSql(sql), params).then(r => r.rows);
    const asOf = combo.__asOf;
    const context = await buildListRequestContextFromPg(exec, { asOf });
    const args = { kind: combo.kind || "", q: combo.q || "", districts: combo.districts || [], sort: combo.sort || "newest" };
    const settings = publicSearchSettings({ ...args, ...combo });
    const districts = (Array.isArray(args.districts) ? args.districts : String(args.districts || "").split(","))
      .map(x => String(x).trim()).filter(Boolean).slice(0, GUEST_MAX_DISTRICTS);
    const districtIds = await districtClosureIds(exec, { districtNames: districts, userId: 0 });
    const built = buildPublicListingsClauses({ districts, settings, q: args.q, context, districtIds }, { sqliteDb: null });
    const raw = await readPgRows(snapshot, toPostgresSql(`SELECT ${columns} FROM listings ${built.where} ORDER BY post_id`), built.params);
    const loader = createDecorationDataLoader({ exec, driver: "postgres" });
    const provider = await preloadDecorationProviderAsync({ exec, loader, rows: raw, settings,
      userId: 0, matchVoteUserId: 0, peers: false, requestContext: context });
    const rows = await buildPublicListingsRowsAsync(raw, { settings, kind: args.kind, sources: combo.sources || "",
      sort: args.sort, districtSet: built.districtSet, provider, now: context.now, requireProvider: true });
    const limit = Math.max(1, Math.min(Number(combo.limit) || 40, 50));
    const start = Math.max(0, Number(combo.offset) || 0);
    const page = rows.slice(start, start + limit);
    const fullRows = page.length ? await exec("SELECT * FROM listings WHERE post_id = ANY(?::bigint[])", [page.map(row => row.post_id)]) : [];
    const pageProvider = await preloadDecorationProviderAsync({ exec, loader, rows: page, settings,
      userId: 0, matchVoteUserId: 0, requestContext: context });
    const listings = decoratePublicListingsPage(page, fullRows, { settings, provider: pageProvider,
      now: context.now, requireProvider: true });
    return { listings, totalMatched: rows.length, hasMore: start + limit < rows.length, nextOffset: start + limit, candidates: raw.length };
  });
}

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
  { name: "kind=warehouse", kind: "warehouse", q: "", districts: [], sort: "newest" },
  { name: "kind=share", kind: "share", q: "", districts: [], sort: "newest" },
  { name: "kind=coliving", kind: "coliving", q: "", districts: [], sort: "newest" },
  { name: "kind=yafang", kind: "yafang", q: "", districts: [], sort: "newest" },
  { name: "sort=price_asc", kind: "", q: "", districts: [], sort: "price_asc" },
  { name: "sort=price_desc", kind: "", q: "", districts: [], sort: "price_desc" },
  { name: "sort=commute_asc", kind: "", q: "", districts: [], sort: "commute_asc" },
  { name: "sort=commute_desc", kind: "", q: "", districts: [], sort: "commute_desc" },
  { name: "sort=fit_desc", kind: "", q: "", districts: [], sort: "fit_desc" },
  { name: "excludeRooftop=false", kind: "", q: "", districts: [], sort: "newest", excludeRooftop: false },
  { name: "excludeLowFloors=false", kind: "", q: "", districts: [], sort: "newest", excludeLowFloors: false },
  { name: "hasParking=true", kind: "", q: "", districts: [], sort: "newest", hasParking: true },
  { name: "wholeFloorOnly=true", kind: "", q: "", districts: [], sort: "newest", wholeFloorOnly: true },
  { name: "priceMax=20000", kind: "", q: "", districts: [], sort: "newest", priceMax: 20000 },
  { name: "priceMin=15000+priceMax=30000", kind: "", q: "", districts: [], sort: "newest", priceMin: 15000, priceMax: 30000 },
  { name: "priceMaxIncludesExtras=true+priceMax=20000", kind: "", q: "", districts: [], sort: "newest", priceMaxIncludesExtras: true, priceMax: 20000 },
  { name: "areaMax=30", kind: "", q: "", districts: [], sort: "newest", areaMax: 30 },
  { name: "minBuildingFloors=10", kind: "", q: "", districts: [], sort: "newest", minBuildingFloors: 10 },
  { name: "kind=whole+sort=price_asc", kind: "whole", q: "", districts: [], sort: "price_asc" },
  { name: "q=套房+kind=whole", kind: "whole", q: "套房", districts: [], sort: "newest" },
  { name: "q=套房+district=西屯區", kind: "", q: "套房", districts: ["西屯區"], sort: "newest" },
  { name: "kind=whole+district=西屯區", kind: "whole", q: "", districts: ["西屯區"], sort: "newest" },
  { name: "q=套房+kind=whole+district=西屯區", kind: "whole", q: "套房", districts: ["西屯區"], sort: "newest" },
  { name: "district=西屯區+sort=price_asc", kind: "", q: "", districts: ["西屯區"], sort: "price_asc" },
  { name: "kind=whole+q=電梯+district=中正區+price_desc", kind: "whole", q: "電梯", districts: ["中正區"], sort: "price_desc" },
  { name: "excludeLowFloors=false+hasParking=true", kind: "", q: "", districts: [], sort: "newest", excludeLowFloors: false, hasParking: true },
  { name: "baseline+limit=50", kind: "", q: "", districts: [], sort: "newest", limit: 50 },
  { name: "baseline+offset=100", kind: "", q: "", districts: [], sort: "newest", offset: 100 },
  { name: "q=套房+offset=40+limit=50", kind: "", q: "套房", districts: [], sort: "newest", offset: 40, limit: 50 },
  { name: "kind=whole+sort=fit_desc", kind: "whole", q: "", districts: [], sort: "fit_desc" },
];

// q=編號 用一個真實 post_id 的前 4 碼
const sampleId = await (async () => {
  const c = await drv.pool.connect();
  try { const r = await c.query("SELECT post_id FROM listings ORDER BY post_id LIMIT 1"); return String(Number(r.rows[0]?.post_id || 0)).slice(0, 4); }
  finally { c.release(); }
})();

function resolveCombo(combo) {
  const q = combo.q === "__POST_ID__" ? sampleId : (combo.q || "");
  return { ...combo, q };
}

const onlyParity = process.env.PARITY_ONLY === "1";
const onlyTiming = process.env.TIMING_ONLY === "1";

// ── Parity ──────────────────────────────────────────────────────────────────
if (!onlyTiming) {
  const maxCombos = Number(process.env.MAX_COMBOS) || COMBOS.length;
  let fail = 0;
  for (const rawCombo of COMBOS.slice(0, maxCombos)) {
    const combo = resolveCombo(rawCombo);
    combo.__asOf = new Date().toISOString();
    const full = await runPipeline(combo, LIST_CANDIDATE_COLUMNS);
    const slim = await runPipeline(combo, PUBLIC_LISTING_CANDIDATE_COLUMNS);
    const idsFull = full.listings.map(r => Number(r.post_id));
    const idsSlim = slim.listings.map(r => Number(r.post_id));
    const orderOk = JSON.stringify(idsFull) === JSON.stringify(idsSlim);
    const totalOk = full.totalMatched === slim.totalMatched;
    const hasMoreOk = full.hasMore === slim.hasMore && full.nextOffset === slim.nextOffset;
    const valuesOk = orderOk && JSON.stringify(full.listings.map(stableStringify)) === JSON.stringify(slim.listings.map(stableStringify));
    const ok = orderOk && totalOk && hasMoreOk && valuesOk;
    if (!ok) fail += 1;
    console.log(JSON.stringify({
      name: combo.name, ok, candidates: [full.candidates, slim.candidates],
      totalMatched: [full.totalMatched, slim.totalMatched],
      orderOk, totalOk, hasMoreOk, valuesOk,
      firstMismatch: !orderOk ? { full: idsFull.slice(0, 10), slim: idsSlim.slice(0, 10) } : undefined,
    }));
  }
  console.log(JSON.stringify({ __parity_summary__: { total: Math.min(maxCombos, COMBOS.length), fail } }));
}

// ── 計時（baseline / kind=whole / q=套房，各 5 次，改前 42 欄 vs 改後 36 欄）──
if (!onlyParity) {
  const timingCombos = [
    { name: "baseline", kind: "", q: "", districts: [], sort: "newest" },
    { name: "kind=whole", kind: "whole", q: "", districts: [], sort: "newest" },
    { name: "q=套房", kind: "", q: "套房", districts: [], sort: "newest" },
  ];
  const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); const i = Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1)); return s[i]; };
  for (const rawCombo of timingCombos) {
    const combo = resolveCombo(rawCombo);
    for (const [label, columns] of [["full42", LIST_CANDIDATE_COLUMNS], ["slim36", PUBLIC_LISTING_CANDIDATE_COLUMNS]]) {
      const samples = [];
      for (let i = 0; i < 5; i++) {
        combo.__asOf = new Date().toISOString();
        const t0 = performance.now();
        await runPipeline(combo, columns);
        samples.push(Math.round(performance.now() - t0));
      }
      console.log(JSON.stringify({ __timing__: true, name: combo.name, mode: label, samples, p50: pct(samples, 0.5), p95: pct(samples, 0.95) }));
    }
  }
}

await drv.pool.end();
