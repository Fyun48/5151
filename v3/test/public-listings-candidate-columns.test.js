// 公開列表候選查詢瘦身（PG 路徑 42 → 36 欄）的離線斷言。
//
// 目標：證明把 `searchPublicListingsAsync` 的候選 SELECT 從 `LIST_CANDIDATE_COLUMNS`
// （42 欄）縮到 `PUBLIC_LISTING_CANDIDATE_COLUMNS`（36 欄）不會改變任何結果，並把
// 「哪一道過濾／排序讀哪些欄」的查證表固化成一組迴歸斷言。
//
// 對照（42 vs 36）的**真實 30＋ 組合 parity** 走 `v3/scripts/public-candidate-slim-parity.mjs`
// （連隔離庫 repro）；本檔用離線 fixture 跑同一套管線的同步版，供 CI 快速迴歸。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPublicListingsRows, decoratePublicListingsPage, listingSearchBuildContext, publicSearchSettings,
} from "../src/db.js";
import { LIST_CANDIDATE_COLUMNS, LIST_CANDIDATE_KEYS, PUBLIC_LISTING_CANDIDATE_COLUMNS } from "../src/listingCandidateRow.js";

// ── 欄位需求查證表（逐道過濾 → 讀哪些欄），以碼為準（檔:行）────────────────────
// applyListingFilter（db.js:6704）
//   → createAttributeFilter/passesAttributeFilters（floors.js:414/419）
//       passesPriceFilter（listingCost.js:209）→ rentAmount(price_num, price)＋extraMonthlyAmount(extra_fees, extra_fee, extra_fee_text, tags)
//       buildingTotalFloors(floor_name)（floors.js:383）
//       areaNum(area_name)（match.js:45）
//   → passesGeoFilters（floors.js:505）→ resolveLocationClass(location_class, geo_source, address)、hasTrustedCoords(lat, lng, geo_source)
// applyGuestStraightLineFilter（db.js:7851）→ geoDistanceM(lat, lng)
// attachSameHouseRoleSteps（db.js:3580）→ post_id, match_post_id, match_verdict, offline,
//       preferPrimaryListing（match.js:363）→ comparableRent(price_num, price, extra_fees, extra_fee, extra_fee_text, tags),
//       listingRefreshAt(refresh_time, last_seen_at), last_seen_at, listingTieBreakKey(source, source_id, url, post_id)
// listingMatchesListFilter(all)（personalFlags.js:306）→ same_house_role, same_house_split, same_house_primary_offline, offline, hidden, offline_confirmed, match_verdict
// keepSelfListingForViewer（selfListings.js:1636）→ listingVisibleOnSurface(fixture_namespace), isSelfListingRow(source, post_id), listed_by_user_id
// passesDisplayFilters（floors.js:398）→ kind_name, floor_name, title, address, tags（via listingFilterHay/isRooftopAddition）
// districtSet（db.js:8046）→ districtNameFromListing(source_key, address, title)（regions.js:52）
// matchesHousingKind（floors.js:322）→ kind_name, title, address, tags, floor_name
// matchesListingSources（floors.js:229）→ source
// sortListingsSteps（db.js:6913）→ post_id, listingEffectiveUpdatedAt(source_updated_at, source_published_at, refresh_time, first_seen_at, last_seen_at),
//       rentSortValue(price_num, price, extra_fees, extra_fee, extra_fee_text, tags), listingCommuteKm(commute_km, route_km)
// listingFitScore/fit_desc（listingScore.js:11）→ price_num, price, extra_fees, extra_fee, extra_fee_text, tags, kind_name, floor_name, title, address, commute_km
// preloadDecorationProviderAsync（db.js:3282）→ post_id, match_post_id, source, lat, lng, geo_source
// listingExtrasSnapshot（repository/decorationData.js:237）→ post_id, source, source_id, url, price, price_num,
//       extra_fee, extra_fees, extra_fee_text, price_contain_text, refresh_time, last_seen_at, hidden, offline, match_verdict, match_level
// decoratePublicListingsPage（db.js:8070）→ post_id, match_post_id, same_house_role, guest_commute_km

const KEPT_COLUMNS = [
  "post_id", "source", "source_id", "source_key", "url", "price", "price_num",
  "extra_fee", "extra_fees", "extra_fee_text", "price_contain_text", "title",
  "address", "area_name", "floor_name", "kind_name", "tags", "role_name",
  "contact_name", "contact_role", "contact_uid", "agency", "lat", "lng",
  "geo_source", "location_class", "match_post_id", "match_level", "match_verdict",
  "offline", "offline_confirmed", "hidden", "first_seen_at", "last_seen_at",
  "refresh_time", "listed_by_user_id",
];
// 這 6 欄在公開候選階段**不會被讀到**：只在「頁面二次 SELECT *」、成員/自我列表、
// 通知、或配對（match）路徑才會用到。
const DROPPED_COLUMNS = ["address_norm", "layout", "match_rejected", "hidden_at", "last_event", "self_status"];

test("PG 公開候選欄位＝42 欄減去 6 欄未用欄，且不超出 42 欄全集", () => {
  const full = LIST_CANDIDATE_KEYS;
  assert.equal(full.length, 42, "canonical candidate 仍為 42 欄");
  const slim = new Set(PUBLIC_LISTING_CANDIDATE_COLUMNS.split(",").map((s) => s.trim()).filter(Boolean));
  assert.equal(slim.size, 36, "公開候選為 36 欄");
  for (const col of KEPT_COLUMNS) assert.ok(slim.has(col), `保留欄位 ${col} 應在公開候選內`);
  for (const col of DROPPED_COLUMNS) assert.ok(!slim.has(col), `未用欄位 ${col} 不應在公開候選內`);
  for (const col of slim) assert.ok(full.includes(col), `公開候選欄位 ${col} 必須是 42 欄子集`);
});

test("sqlite 路徑的候選 SQL 逐字不變（仍是 42 欄 LIST_CANDIDATE_COLUMNS）", () => {
  // sqlite 的 listPublicListings（db.js:8100）與 listListings（db.js:7313）都仍用
  // LIST_CANDIDATE_COLUMNS；listingSearchBuildContext().candidateColumns 也維持 42 欄
  // （供 SQL-first/entry/stats 共用）。本檔只改 searchPublicListingsAsync 那一句。
  assert.equal(LIST_CANDIDATE_COLUMNS, LIST_CANDIDATE_KEYS.join(", "), "LIST_CANDIDATE_COLUMNS 逐字不變");
  assert.equal(listingSearchBuildContext().candidateColumns, LIST_CANDIDATE_COLUMNS,
    "listingSearchBuildContext 仍回 42 欄（SQL-first/entry/stats 不受影響）");
  assert.equal(new Set(LIST_CANDIDATE_COLUMNS.split(",").map((s) => s.trim())).size, 42, "仍為 42 欄");
});

// 離線管線審計：公開候選階段的篩選＋排序實際讀到的 DB 欄位必須 ⊆ 36 欄，且不碰那 6 欄。
function spyProvider(record = { calls: [] }) {
  const emptyIndex = { groupKey: () => "", peers: () => [], agrees: () => true, size: 0 };
  const note = (label) => (arg) => {
    const id = Number(Array.isArray(arg) ? arg[0] : arg);
    if (id) record.calls.push({ label, id });
    return label === "extras" ? new Map() : null;
  };
  const value = {
    driver: "sqlite", userId: 0,
    personalIndex: () => emptyIndex, personalGroupAgrees: () => true, splitPairs: () => new Set(),
    prep: note("prep"), groupId: () => "", groupMemberRows: () => [],
    peerRows: (ids) => { for (const id of (ids || [])) record.calls.push({ label: "peerRows", id: Number(id) }); return []; },
    extras: note("extras"), personalFlags: () => null, routeCache: () => null, mrtCache: () => null,
    routeJob: () => null, sourceEnabled: () => true, systemCrawl: () => ({}),
  };
  return new Proxy(value, { get(target, prop) { if (prop in target) return target[prop]; return () => null; } });
}

function fullFixtureRow(overrides = {}) {
  return {
    post_id: 1, source: "591", source_id: "8", source_key: "1|8||台中市西屯區測試路1號",
    url: "https://example.test/1", price: "20000元", price_num: 20000,
    extra_fee: 1000, extra_fees: "[]", extra_fee_text: "管理費1000元", price_contain_text: "",
    title: "電梯大樓 2房", address: "台中市西屯區測試路1號", address_norm: "台中市西屯區測試路1號",
    area_name: "10坪", layout: "2房1廳", floor_name: "5/10", kind_name: "整層住家/電梯大樓",
    tags: JSON.stringify(["有電梯", "可養寵物"]), role_name: "經紀人", contact_name: "王小姐",
    contact_role: "仲介", contact_uid: 0, agency: "測試房仲",
    lat: 24.18, lng: 120.64, geo_source: "address", location_class: "address",
    match_post_id: 0, match_level: 0, match_verdict: "", match_rejected: 0,
    offline: 0, offline_confirmed: 0, hidden: 0, hidden_at: null, last_event: "",
    first_seen_at: "2026-09-01T00:00:00.000Z", last_seen_at: "2026-09-01T00:00:00.000Z",
    refresh_time: "2026-09-01T00:00:00.000Z", listed_by_user_id: 0, self_status: "",
    // 頁面 hydration 才有的欄位（SELECT *）
    self_body: "", cover: "", photos: "[]", community_id: 0, model_score: 0,
    ...overrides,
  };
}

const FULL_ROWS = [
  fullFixtureRow(),
  fullFixtureRow({ post_id: 2, price: "30000元", price_num: 30000, area_name: "40坪", floor_name: "8/12" }),
  fullFixtureRow({ post_id: 3, source: "self", source_id: "", source_key: "", listed_by_user_id: 7, kind_name: "獨立套房" }),
  fullFixtureRow({ post_id: 4, offline: 1, offline_confirmed: 0 }),
  fullFixtureRow({ post_id: 5, hidden: 1 }),
  fullFixtureRow({ post_id: 6, match_post_id: 2, match_level: 2, match_verdict: "maybe", kind_name: "整層住家" }),
];

function candidateRowFrom(fullRow, columns) {
  const out = {};
  for (const col of columns) out[col] = fullRow[col];
  return out;
}
const FULL_KEYS = LIST_CANDIDATE_KEYS;
const SLIM_KEYS = PUBLIC_LISTING_CANDIDATE_COLUMNS.split(",").map((s) => s.trim()).filter(Boolean);

function runPipeline(columns) {
  const raw = FULL_ROWS.map((r) => candidateRowFrom(r, columns));
  const provider = spyProvider();
  const settings = publicSearchSettings({});
  const rows = buildPublicListingsRows(raw, { settings, kind: "", sources: "", sort: "newest",
    districtSet: new Set(), provider, now: Date.parse("2026-10-01T00:00:00.000Z") });
  const fullRows = FULL_ROWS.map((r) => ({ ...r }));
  const page = rows.slice(0, 10);
  const listings = decoratePublicListingsPage(page, fullRows, { settings, provider, now: Date.parse("2026-10-01T00:00:00.000Z") });
  return { totalMatched: rows.length, ids: rows.map((r) => Number(r.post_id)), listings };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

test("審計：公開候選階段讀到的 DB 欄位 ⊆ 36 欄，且不碰那 6 欄", () => {
  const reads = new Set();
  const raw = FULL_ROWS.map((r) => candidateRowFrom(r, FULL_KEYS)).map((row) => new Proxy(row, {
    get(target, prop, receiver) { if (typeof prop === "string") reads.add(prop); return Reflect.get(target, prop, receiver); },
    has(target, prop) { if (typeof prop === "string") reads.add(prop); return Reflect.has(target, prop); },
    set(target, prop, value, receiver) { if (typeof prop === "string") reads.add(prop); return Reflect.set(target, prop, value, receiver); },
  }));
  const provider = spyProvider();
  const settings = publicSearchSettings({});
  // 走多個 sort／kind 分支，才會覆蓋所有讀取點（single mode 會低估）。
  for (const mode of [{ kind: "", sort: "newest" }, { kind: "", sort: "price_asc" }, { kind: "whole", sort: "fit_desc" }]) {
    buildPublicListingsRows(raw, { settings, kind: mode.kind, sources: "", sort: mode.sort,
      districtSet: new Set(["西屯區"]), provider, now: Date.parse("2026-10-01T00:00:00.000Z") });
  }
  const slim = new Set(SLIM_KEYS);
  const droppedRead = DROPPED_COLUMNS.filter((c) => reads.has(c));
  assert.deepEqual(droppedRead, [], `公開候選階段不應讀到未用欄位：${droppedRead.join(", ")}`);
  // 讀到的「DB 欄位」只能是 36 欄子集（管線自建欄位與 provider 別名除外）。
  const known = new Set([
    "commute_km", "route_km", "source_updated_at", "source_published_at",
    "buildingType", "building_type", "caseTypeName", "listing_kind",
    "region_id", "regionid", "section_id", "sectionid", "shape", "shape_name",
    "district", "fit_score", "same_house_role", "same_house_split", "same_house_primary_id",
    "same_house_primary_offline", "same_house_personal", "guest_commute_km",
    "fixture_namespace", "mine", "watched", "viewed",
  ]);
  const unregistered = [...reads].filter((k) => !slim.has(k) && !known.has(k));
  assert.deepEqual(unregistered, [], `公開候選階段讀到未登錄欄位：${unregistered.join(", ")}`);
});

test("離線 parity：42 欄 vs 36 欄候選，結果（totalMatched／順序／裝飾值）完全一致", () => {
  const full = runPipeline(FULL_KEYS);
  const slim = runPipeline(SLIM_KEYS);
  assert.equal(full.totalMatched, slim.totalMatched, "totalMatched 一致");
  assert.deepEqual(full.ids, slim.ids, "post_id 順序一致");
  assert.equal(JSON.stringify(full.listings.map(stableStringify)), JSON.stringify(slim.listings.map(stableStringify)),
    "裝飾後回應欄位值一致");
});
