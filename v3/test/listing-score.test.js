import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { listingFitFields, listingFitLabel, listingFitScore } from "../src/listingScore.js";
import { getCrawlSources, sortListingsRows } from "../src/db.js";

const settings = {
  priceMin: 15000,
  priceMax: 30000,
  wholeFloorOnly: true,
  excludeLowFloors: true,
  minBuildingFloors: 4,
  commuteKm: 8,
  workLat: 25.09,
  workLng: 121.52,
};

test("fit score rewards in-budget whole-floor homes and penalizes suites over rent", () => {
  const good = listingFitScore({
    price_num: 25000,
    kind_name: "整層住家",
    floor_name: "5/10",
    commute_km: 3,
    tags: '["有電梯"]',
  }, settings);
  const poor = listingFitScore({
    price_num: 45000,
    kind_name: "獨立套房",
    floor_name: "1/3",
    commute_km: 20,
  }, settings);
  assert.ok(good >= 75, `expected high fit, got ${good}`);
  assert.ok(poor <= 40, `expected low fit, got ${poor}`);
  assert.equal(listingFitLabel(82), "較適合");
  assert.equal(listingFitLabel(60), "尚可");
  assert.equal(listingFitLabel(20), "較不合");
  const fields = listingFitFields({
    price_num: 25000,
    kind_name: "整層住家",
    floor_name: "5/10",
    commute_km: 3,
  }, settings);
  assert.equal(fields.fit_label, listingFitLabel(fields.fit_score));
});

test("guest fit score uses stored commute only and does not penalize missing km", () => {
  const member = listingFitScore({
    price_num: 25000,
    kind_name: "整層住家",
    floor_name: "5/10",
    tags: '["有電梯"]',
  }, settings);
  const guest = listingFitScore({
    price_num: 25000,
    kind_name: "整層住家",
    floor_name: "5/10",
    tags: '["有電梯"]',
  }, settings, { guest: true });
  assert.ok(guest > member, `guest ${guest} should not take the missing-commute penalty ${member}`);
  const guestWithKm = listingFitScore({
    price_num: 25000,
    kind_name: "整層住家",
    floor_name: "5/10",
    commute_km: 3,
    tags: '["有電梯"]',
  }, settings, { guest: true });
  assert.ok(guestWithKm >= guest);
});

test("fit_desc sorts higher scores first", () => {
  const rows = sortListingsRows(
    [
      { post_id: 1, fit_score: 40, price_num: 10000 },
      { post_id: 2, fit_score: 90, price_num: 28000 },
      { post_id: 3, fit_score: 70, price_num: 22000 },
    ],
    "fit_desc",
  );
  assert.deepEqual(rows.map((row) => row.post_id), [2, 3, 1]);
});

test("decorateListing strips model_score and attaches fit fields", () => {
  const dbSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/db.js"), "utf8");
  assert.match(dbSrc, /listingFitFields/);
  assert.match(dbSrc, /model_score: _modelScore/);
  assert.match(dbSrc, /\.\.\.fit/);
  assert.doesNotMatch(dbSrc, /fit_score:\s*row\.model_score/);
});

// astra 2026-09-25 §3.6：原本這裡是**原始碼文字斷言**（切片 `listListings` 後檢查 `rows.slice` 出現在
// `decorateListingLite` 之前…）✗ —— 一旦共用管線把角色判定抽到 `buildListListingsRows` 就會誤報 ✗。
// 改成**行為驗證**：用共用的三個階段函式驅動，斷言
//   (1) 便宜的屬性／顯示篩選套用在**全部候選**上；
//   (2) 分頁只回傳頁面切片；
//   (3) 裝飾（provider 的逐列查詢）**只發生在頁面列**（＝同戶／裝飾不碰候選全集）。
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
      // 其餘（routeCache／mrtCache／routeJobs…）一律當成「查不到」的查詢函式，避免測試綁死內部形狀。
      return () => null;
    },
  });
}

test("listListings 便宜篩選套用在全部候選，且同戶／裝飾只碰頁面切片（行為驗證）", async () => {
  const mod = await import("../src/db.js");
  const { buildListListingsRows, paginateListListingsRows, decorateListListingsPage } = mod;
  assert.equal(typeof buildListListingsRows, "function");
  assert.equal(typeof paginateListListingsRows, "function");
  assert.equal(typeof decorateListListingsPage, "function");

  const record = { calls: [] };
  const provider = spyProvider(record);
  const rows = [
    { post_id: 1, source: "houseprice", price_num: 20000, kind_name: "整層住家", area_name: "10坪", floor_name: "5/10", match_verdict: "", offline: 0, hidden: 0 },
    { post_id: 2, source: "591", price_num: 20000, kind_name: "整層住家", area_name: "40坪", floor_name: "5/10", match_verdict: "", offline: 0, hidden: 0 },
    { post_id: 3, source: "591", price_num: 20000, kind_name: "整層住家", area_name: "10坪", floor_name: "5/10", match_verdict: "", offline: 0, hidden: 0 },
  ];

  // (1) areaMax=30 屬**顯示篩選** ⇒ 套用在全部候選（post 2 的 40 坪必須被排除）
  const filtered = buildListListingsRows(rows.map((r) => ({ ...r })), {
    filter: "all", kind: "", sources: "", sort: "price_asc",
    uid: 0, voteUid: 0, settings: { areaMax: 30 }, districtSet: new Set(), provider, flagMap: new Map(),
  });
  assert.deepEqual(filtered.map((r) => r.post_id), [1, 3], "顯示篩選必須在全部候選上生效");

  // (2) 分頁只回傳頁面切片
  const paged = paginateListListingsRows(filtered, { sort: "price_asc", filter: "all", settings: {}, limit: 1, offset: 0 });
  assert.deepEqual(paged.page.map((r) => r.post_id), [1], "必須依 limit 切片");

  // (3) 裝飾只碰頁面列（provider 的逐列查詢不得出現非頁面 id）
  const pageIds = new Set(paged.page.map((r) => Number(r.post_id)));
  const fullRows = filtered.map((r) => ({ ...r }));
  const decorated = decorateListListingsPage(paged.page, fullRows, { settings: {}, uid: 0, voteUid: 0, sameHouse: true, provider });
  assert.ok(decorated.length <= paged.page.length);
  assert.ok(record.calls.length > 0, "裝飾階段應向 provider 取用逐列資料");
  for (const call of record.calls) {
    assert.ok(pageIds.has(call.id), `裝飾不得碰非頁面列（${call.label} 取了 post_id=${call.id}）`);
  }
});

test("getCrawlSources is wired so listing lists can load", () => {
  const { items } = getCrawlSources();
  assert.ok(items.some((row) => row.id === "591" && row.enabled));
});
