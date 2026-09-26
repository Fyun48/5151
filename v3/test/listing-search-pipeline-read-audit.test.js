// 管線級候選欄位讀取審計（PR-B §4.2「優先縮減候選欄位」的取證步驟）。
//
// 為什麼需要它（更正上一輪結論 ✗）：`computeListingProjection` 只覆蓋**推導欄位** ✓；
// 真正決定「候選 SELECT 必須抓哪些欄位」的是候選階段：
//   ① `buildListListingsRows`（屬性／顯示篩選、行政區、類型、來源、角色、列表 filter）
//   ② `paginateListListingsRows`（排序＋分頁）
//   ③ `decorateListListingsPage`（只碰**頁面列** ⇒ 由 `SELECT *` hydration 提供 ✓，不算候選欄位 ✓）
//
// 手法：把候選列包 `Proxy` 記錄 `get`／`has`／`ownKeys`／`set` ✓，用**真實管線 ＋ 假 provider**
// （照 `listing-score.test.js` 的 `spyProvider` ✓）⇒ 記錄此 fixture 實際走過的欄位；不能推論其他分支不需要的欄位。
//
// 實測紅線：`provider=null` 會落同步 SQLite ✗（`attachSameHouseRoles` 的
// `provider || sqliteDecorationProvider()` ✓）；`settings.commuteKm>0` 觸發 `warmRouteCache` ✗；
// `sort="fit_desc"` 讀 `route_km` 並寫 `fit_score` ✗ ⇒ 審計一律避開這三者 ✓。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildListListingsRows, paginateListListingsRows } from "../src/db.js";

function spyProvider(record) {
  const emptyIndex = { groupKey: () => "", peers: () => [], agrees: () => true, size: 0 };
  const note = (label) => (arg) => {
    const id = Number(Array.isArray(arg) ? arg[0] : arg);
    if (id) record.calls.push({ label, id });
    return label === "extras" ? new Map() : null;
  };
  const value = {
    driver: "sqlite",
    userId: 0,
    personalIndex: () => emptyIndex,
    personalGroupAgrees: () => true,
    splitPairs: () => new Set(),
    prep: note("prep"),
    groupId: () => "",
    groupMemberRows: () => [],
    peerRows: (ids) => { for (const id of (ids || [])) record.calls.push({ label: "peerRows", id: Number(id) }); return []; },
    extras: note("extras"),
    personalFlags: () => null,
  };
  return new Proxy(value, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => null;
    },
  });
}

function candidateColumns() {
  const source = readFileSync(new URL("../src/db.js", import.meta.url), "utf8");
  const match = source.match(/const LIST_CANDIDATE_COLUMNS = `([\s\S]*?)`;/);
  assert.ok(match, "應能在 db.js 找到 LIST_CANDIDATE_COLUMNS");
  return new Set(match[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
}
function candidateRow(overrides = {}) {
  return {
    post_id: 1, source: "591", source_id: "8", source_key: "1|8||台中市西屯區測試路1號",
    url: "https://example.test/1", price: "20000元", price_num: 20000,
    extra_fee: 1000, extra_fees: "[]", extra_fee_text: "管理費1000元", price_contain_text: "",
    title: "電梯大樓 2房", address: "台中市西屯區測試路1號", address_norm: "台中市西屯區測試路1號",
    area_name: "10坪", layout: "2房1廳", floor_name: "5/10", kind_name: "整層住家/電梯大樓",
    tags: "[]", role_name: "", contact_name: "", contact_role: "", contact_uid: 0, agency: "",
    lat: 24.18, lng: 120.64, geo_source: "address", location_class: "address",
    match_post_id: 0, match_level: 0, match_verdict: "", match_rejected: 0,
    offline: 0, offline_confirmed: 0, hidden: 0, hidden_at: null, last_event: "",
    first_seen_at: "2026-09-01T00:00:00.000Z", last_seen_at: "2026-09-01T00:00:00.000Z",
    refresh_time: "2026-09-01T00:00:00.000Z", listed_by_user_id: 0, self_status: "",
    ...overrides,
  };
}
const ROWS = [
  candidateRow(),
  candidateRow({ post_id: 2, price: "30000元", price_num: 30000, area_name: "40坪", floor_name: "8/10" }),
];

function auditingRows(rows, reads, spreads) {
  return rows.map((row) => new Proxy(row, {
    get(target, prop, receiver) {
      if (typeof prop === "string") reads.add(prop);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string") reads.add(prop);
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      spreads.push("ownKeys");
      return Reflect.ownKeys(target);
    },
    set(target, prop, value, receiver) {
      if (typeof prop === "string") reads.add(prop);
      return Reflect.set(target, prop, value, receiver);
    },
  }));
}

test("審計：候選階段（篩選＋分頁）對候選列實際讀取哪些欄位", () => {
  const reads = new Set();
  const spreads = [];
  const perMode = [];
  const record = { calls: [] };
  const provider = spyProvider(record);

  // 模式矩陣：每個 filter／sort 走的是**不同的分支** ⇒ 必須各量一次才知道最終欄位集 ✓
  // （已知限制：只用單一模式量會低估 ✗。）
  const MODES = [
    { filter: "all", sort: "price_asc" },
    { filter: "watched", sort: "price_asc" },
    { filter: "offline", sort: "price_asc" },
    { filter: "suspected", sort: "price_asc" },
    { filter: "all", sort: "fit_desc" },
    { filter: "all", sort: "refresh_desc", kind: "整層住家", sources: "591" },
  ];
  for (const mode of MODES) {
    const modeReads = new Set();
    const modeSpreads = [];
    const filtered = buildListListingsRows(auditingRows(ROWS, modeReads, modeSpreads), {
      filter: mode.filter, kind: mode.kind || "", sources: mode.sources ?? "", sort: mode.sort,
      uid: 0, voteUid: 0, settings: { areaMax: 30 }, districtSet: new Set(), provider, flagMap: new Map(),
    });
    paginateListListingsRows(auditingRows(filtered, modeReads, modeSpreads), {
      sort: mode.sort, filter: mode.filter, settings: {}, limit: 1, offset: 0,
    });
    for (const key of modeReads) reads.add(key);
    spreads.push(...modeSpreads);
    perMode.push({ mode, modeReads, spreadCount: modeSpreads.length });
    console.log(`PIPE-MODE ${JSON.stringify(mode)} READS=${modeReads.size} SPREAD=${modeSpreads.length}`);
  }
  const base = perMode[0].modeReads;
  for (const entry of perMode.slice(1)) {
    const extra = [...entry.modeReads].filter((key) => !base.has(key)).sort();
    console.log(`PIPE-MODE-EXTRA ${JSON.stringify(entry.mode)} ${JSON.stringify(extra)}`);
  }

  const all = [...reads].sort();
  const candidate = candidateColumns();
  // 已登錄：裝飾／hydration、provider 別名、personal overlay、以及管線自建的欄位 ✓
  // （實測逼出的 6 個：fixture_namespace＝fixture 隔離設定 ✓；same_house_split＝同戶裝飾 ✓；
  //   viewed／viewed_at／watched／watched_at＝`overlayRowsPersonal(flags)` 疊加的個人狀態 ✓）
  const known = new Set([
    "commute_km", "route_km", "source_updated_at", "source_published_at",
    "buildingType", "building_type", "caseTypeName", "listing_kind",
    "region_id", "regionid", "section_id", "sectionid", "shape", "shape_name",
    "district", "fit_score", "same_house_role", "self_role", "roles",
    "peers", "personal_flags", "group_key", "primary_listing_id", "watch_note", "note",
    "fixture_namespace", "same_house_split",
    "viewed", "viewed_at", "watched", "watched_at",
  ]);
  const missing = all.filter((key) => !candidate.has(key) && !known.has(key));

  console.log(`PIPE-READ-ALL ${JSON.stringify(all)}`);
  console.log(`PIPE-READ-COUNT ${all.length} PIPE-SPREAD ${spreads.length ? "yes" : "no"}`);
  console.log(`PIPE-READ-IN-CANDIDATE ${JSON.stringify(all.filter((k) => candidate.has(k)))}`);
  console.log(`PIPE-READ-UNREGISTERED ${JSON.stringify(missing)}`);
  console.log(`PIPE-PROVIDER-CALLS ${JSON.stringify(record.calls.slice(0, 6))}`);

  assert.ok(all.length > 0, "審計應量到至少一個欄位讀取");
  assert.deepEqual(missing, [], `候選階段讀到未登錄的欄位：${missing.join(", ")}`);
  // The measured memory optimization builds the complete personal-overlay
  // object in one spread. In-place additions to wide PG rows made V8 use much
  // larger dictionary properties; zero spreads is not a useful performance gate.
  // Keep auditing every copied field, and require the full candidate contract.
  for (const entry of perMode) {
    assert.equal(entry.spreadCount, ROWS.length, 'each input row is copied once for personal flags');
    for (const key of candidate) assert.ok(entry.modeReads.has(key), `full candidate copy includes ${key}`);
  }
  assert.ok(ROWS.every(row => !Object.hasOwn(row, 'viewed') && !Object.hasOwn(row, 'watched')),
    'personal flags do not mutate the canonical input rows');

});

