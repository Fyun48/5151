// 會員列表效能的「≥20 案例矩陣」回歸腳本（裁決 §4.2／§4.3 的驗收入口）。
//
// 用途（兩個都要能跑）：
//   1. **等價**：對同一組矩陣輸出 `totalMatched` 與回傳頁的 post_id 序列，讓「改動前／後」
//      兩份 JSON 逐案例比對（`--compare before.json after.json`）。不變量是**逐案例完全相同**。
//   2. **效能**：同時記錄各階段耗時（新 `Server-Timing` 度量的來源），供「哪一階梯省多少」的證據。
//
// 用法：
//   PG_URL=<隔離量測庫> node v3/scripts/member-list-parity-matrix.mjs --out v3/evidence/<包>/matrix.json [--label after]
//   node v3/scripts/member-list-parity-matrix.mjs --compare before.json after.json
//
// 連線字串只從環境變數讀，不印出、不落地。唯讀（全部走 loadListingPage 的讀取路徑）。
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { buildListRequestContextFromPg } from "../src/db.js";
import { sharedPgDriver, closeSharedPgDriver } from "../src/pgSharedDriver.js";
import { toPostgresSql } from "../src/sqlDialect.js";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};

// ── 比對模式：純檔案操作，不連 DB ────────────────────────────────────────────
if (flag("compare")) {
  const beforePath = flag("compare");
  const afterPath = argv[argv.indexOf("--compare") + 2];
  if (!afterPath) { console.error("usage: --compare <before.json> <after.json>"); process.exit(2); }
  const before = JSON.parse(readFileSync(beforePath, "utf8"));
  const after = JSON.parse(readFileSync(afterPath, "utf8"));
  const byCase = new Map(after.matrix.map((c) => [c.case, c]));
  const failures = [];
  for (const b of before.matrix) {
    const a = byCase.get(b.case);
    if (!a) { failures.push(`${b.case}: 改動後缺這個案例`); continue; }
    if (a.totalMatched !== b.totalMatched) failures.push(`${b.case}: totalMatched ${b.totalMatched} -> ${a.totalMatched}`);
    if (JSON.stringify(a.pageIds) !== JSON.stringify(b.pageIds)) failures.push(`${b.case}: 回傳頁 post_id 序列不同`);
    if (a.statsTotal !== b.statsTotal) failures.push(`${b.case}: stats.total ${b.statsTotal} -> ${a.statsTotal}`);
    // 輸出契約（第二刀新增）：`timing` 欄位集合與 payload 頂層欄位集合前後必須逐字相同。
    if (JSON.stringify(a.timingKeys) !== JSON.stringify(b.timingKeys)) {
      failures.push(`${b.case}: timing 欄位集合不同 ${JSON.stringify(b.timingKeys)} -> ${JSON.stringify(a.timingKeys)}`);
    }
    if (JSON.stringify(a.pageKeys) !== JSON.stringify(b.pageKeys)) {
      failures.push(`${b.case}: payload 頂層欄位集合不同 ${JSON.stringify(b.pageKeys)} -> ${JSON.stringify(a.pageKeys)}`);
    }
    if (a.payloadHasStageNames !== false || b.payloadHasStageNames !== false) {
      failures.push(`${b.case}: payload 出現階段計時欄位（階段只能進 Server-Timing header）`);
    }
  }
  // 「矩陣不是假表」的證明：比對到的案例數 > 0，且 totalMatched 真的有縮（相異值 > 1）。
  const distinctTotalMatched = new Set(before.matrix.map((c) => c.totalMatched)).size;
  const report = {
    cases: before.matrix.length,
    compared: before.matrix.length,
    identical: failures.length === 0,
    distinctTotalMatched,
    failures,
  };
  if (report.cases === 0) report.identical = false;
  if (distinctTotalMatched <= 1) { report.identical = false; report.failures.push("totalMatched 只有一種值 ⇒ 矩陣沒有真的篩選"); }
  console.log(JSON.stringify(report, null, 2));
  process.exit(failures.length === 0 && report.cases > 0 && distinctTotalMatched > 1 ? 0 : 1);
}

process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";
const { loadListingPage } = await import("../src/listingSearchPage.js");

const uid = Number(process.env.MEMBER_UID || 1) || 1;
const runs = Math.max(1, Number(process.env.RUNS) || 1);
const label = String(flag("label", "run"));
const outPath = flag("out");
const quiet = process.env.MATRIX_QUIET === "1";

const pg = await sharedPgDriver();
const exec = (sql, params = []) => pg.query(toPostgresSql(sql), params).then((r) => r.rows);

const probe = await buildListRequestContextFromPg(exec, { asOf: null, resolvedSearchKeys: undefined });
const baseSettings = probe.settingsForUser(uid);
const allSearchKeys = (await exec("SELECT DISTINCT search_key FROM listings WHERE COALESCE(search_key,'') <> ''"))
  .map((r) => r.search_key);
const { CITIES } = await import("../src/regions.js");
const allDistrictKeys = CITIES.flatMap((city) => city.districts.map((d) => `${city.id}|${d.id}`));

// 5 組會員設定（涵蓋正式站那位會員會走的每一條分支）
const PROFILES = {
  P1_default: () => baseSettings,
  P2_all_search_keys: () => ({ ...baseSettings, searchKeys: undefined }),
  P3_broad_regions: () => ({ ...baseSettings, watchDistricts: allDistrictKeys, searchUrls: [] }),
  P4_no_floor_rules: () => { const s = { ...baseSettings }; delete s.wholeFloorOnly; delete s.minBuildingFloors; delete s.excludeLowFloors; return s; },
  P5_no_commute: () => ({ ...baseSettings, commuteKm: 0, workLat: null, workLng: null }),
};

// 4 組 districts／sort（原矩陣）＋ 4 組 filter／sameHouse／kind／多行政區
// （2026-10-11 第二刀：stats／prepare 的改動必須在**每一條分支**上逐案例相同，
//   所以矩陣從 5×4 擴到 5×8 ＝ 40 案例 ≥ 24）。
const COMBOS = [
  { name: "default_newest", args: { districts: [], sort: "newest" } },
  { name: "district_price_asc", args: { districts: ["中山區"], sort: "price_asc" } },
  { name: "districts_price_desc", args: { districts: ["松山區", "信義區"], sort: "price_desc" } },
  { name: "default_fit_desc", args: { districts: [], sort: "fit_desc" } },
  { name: "unseen_newest", args: { districts: [], sort: "newest", filter: "unseen" } },
  { name: "same_house_off", args: { districts: [], sort: "newest", sameHouse: false } },
  { name: "kind_whole", args: { districts: [], sort: "newest", kind: "whole" } },
  { name: "multi_district", args: { districts: ["中山區", "大安區"], sort: "newest" } },
];

// 輸出契約（不得改變；逐字固定，不是「跟輸入物件比」的循環論證）。
const EXPECTED_PAGE_KEYS = ["hasMore", "listings", "nextCursor", "nextOffset", "queryVersion", "stats", "timing"];
const EXPECTED_TIMING_KEYS = ["dataset", "query_ms", "stages", "stats_ms", "stats_stages", "total_ms"];
// 階段計時**只能**出現在 `timing.stages`／`timing.stats_stages`（#714 既有的診斷欄），
// 不得被複製到 payload 的頂層或 `stats`／`listings` 內。
const FORBIDDEN_PAYLOAD_STAGE_KEYS = [
  "prepare_ms", "sql_ms", "filter_ms", "rows_ms", "cand_ms", "stats_cand_ms", "stats_provider_ms", "stats_count_ms",
];

function timingContractViolations(page) {
  const failures = [];
  const pageKeys = Object.keys(page).sort();
  const timingKeys = Object.keys(page.timing || {}).sort();
  if (JSON.stringify(pageKeys) !== JSON.stringify([...EXPECTED_PAGE_KEYS].sort())) {
    failures.push(`payload 頂層欄位集合改變：${JSON.stringify(pageKeys)}`);
  }
  if (JSON.stringify(timingKeys) !== JSON.stringify([...EXPECTED_TIMING_KEYS].sort())) {
    failures.push(`timing 欄位集合改變：${JSON.stringify(timingKeys)}`);
  }
  const top = JSON.stringify({ ...page, timing: undefined, listings: (page.listings || []).length });
  for (const key of FORBIDDEN_PAYLOAD_STAGE_KEYS) {
    if (top.includes(key)) failures.push(`payload 不得含階段計時欄位：${key}`);
  }
  return { pageKeys, timingKeys, failures };
}

const useAllKeys = process.env.MATRIX_ALL_SEARCH_KEYS !== "0";

async function runCase(name, args, settings, searchKeys) {
  const stats = [];
  let last = null;
  let contract = null;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    const page = await loadListingPage({
      filter: "all", kind: "", sources: "", q: "", limit: 20, offset: 0,
      userId: uid, matchVoteUserId: uid, sameHouse: true,
      settings, ...(searchKeys ? { searchKeys } : {}), ...args,
    }, { driver: "postgres", pgDriver: pg });
    stats.push({
      wall_ms: Math.round(performance.now() - started),
      list_ms: Math.round(page.timing.query_ms),
      stats_ms: Math.round(page.timing.stats_ms),
      total_ms: Math.round(page.timing.total_ms),
      stages: page.timing.stages || {},
      stats_stages: page.timing.stats_stages || {},
    });
    last = page;
    contract = timingContractViolations(page);
  }
  if (contract?.failures.length) throw new Error(`${name}: ${contract.failures.join("；")}`);
  return {
    case: name,
    totalMatched: last.timing.dataset,
    statsTotal: last.stats?.total ?? null,
    hasMore: last.hasMore === true,
    nextOffset: last.nextOffset ?? null,
    listings: last.listings.length,
    pageIds: last.listings.map((row) => Number(row.post_id)),
    // 輸出契約的逐案例證據（`--compare` 會逐案例比對這兩個鍵集合）。
    pageKeys: contract.pageKeys,
    timingKeys: contract.timingKeys,
    payloadHasStageNames: contract.failures.length > 0,
    runs: stats,
    warm: stats[stats.length - 1],
  };
}

const cases = [];
for (const [profileName, makeSettings] of Object.entries(PROFILES)) {
  const settings = makeSettings();
  for (const combo of COMBOS) {
    const name = `${profileName}__${combo.name}`;
    const row = await runCase(name, combo.args, settings, useAllKeys ? allSearchKeys : null);
    cases.push(row);
    if (!quiet) {
      console.log(`${name}: matched=${row.totalMatched} statsTotal=${row.statsTotal} ids=${row.pageIds.length} ` +
        `list=${row.warm.list_ms} stats=${row.warm.stats_ms} total=${row.warm.total_ms}`);
    }
  }
}

const payload = {
  label, memberUid: uid, runs, cases: cases.length,
  // 「矩陣不是假表」的自證：totalMatched 的相異值個數（必須 > 1）。
  distinctTotalMatched: new Set(cases.map((c) => c.totalMatched)).size,
  prefilterEnabled: process.env.MEMBER_DISTRICT_PREFILTER ?? "(default on)",
  allSearchKeys: useAllKeys, generatedAt: new Date().toISOString(), matrix: cases,
};
if (outPath) { writeFileSync(outPath, JSON.stringify(payload, null, 2)); console.log(`wrote ${outPath} (${cases.length} cases)`); }
else console.log(JSON.stringify(payload, null, 2));
await closeSharedPgDriver();
