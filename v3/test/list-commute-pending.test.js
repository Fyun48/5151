// 通勤這一層的「可觀測性」契約（Owner 裁決 2026-10-12：「**最後資料精準**」）：
//   ① 路線還沒算好（pending）的列**不算符合**——不得先顯示、再由背景 route job 撤掉（假陽性）。
//   ② 使用者點了一個行政區看到 0 筆時，必須看得到**原因**：
//        `stats.excludedByCommute`＝已知距離超過 `commuteKm` 被排除的列數；
//        `stats.commutePending`  ＝座標可信、路段類別可用，但 `route_cache` 還沒有值的列數。
//   ③ 兩個計數與 list 同一個請求快照、**零額外查詢**（`applyListingFilter()` 當場累加）。
// 這支測試走產品碼自己的 `loadListingPage()`（sqlite driver、離線可重跑），不另外重寫一份過濾邏輯。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "list-commute-explain-"));
process.env.DATA_DIR = dataDir;

const app = await import("../src/db.js");
const { loadListingPage } = await import("../src/listingSearchPage.js");
const { commuteIncompleteShouldExclude } = await import("../src/listingPrep.js");
const { passesGeoFilters } = await import("../src/floors.js");
const { districtNameFromListing } = await import("../src/regions.js");

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const uid = app.defaultUserId();
const WORK = { workLat: 25.1062827, workLng: 121.524189, workLocationClass: "address" };
const SETTINGS = {
  ...app.getSettings(uid),
  searchUrls: [],
  watchDistricts: ["8-107"],
  priceMin: 0,
  priceMax: 0,
  priceMaxIncludesExtras: true,
  commuteKm: 5,
  commuteMode: "scooter",
  wholeFloorOnly: false,
  excludeLowFloors: false,
  excludeRooftop: false,
  excludeKeywords: [],
  excludeAgents: [],
  excludeAgentIds: [],
  excludeBoxes: [],
  ...WORK,
};

/** 大里區（source_key 8|107）的合成物件；座標可信、路段類別可用。 */
function seed(postId, overrides = {}) {
  app.upsertListing({
    post_id: postId,
    source: "591",
    source_id: String(postId),
    source_key: "8|107|" + postId,
    search_key: "https://example.test/search",
    title: "合成住宅 " + postId,
    url: "https://example.test/listing/" + postId,
    price: "20000元",
    price_num: 20000,
    extra_fee: 0,
    extra_fees: [],
    address: "台中市大里區測試路" + postId + "號",
    area_name: "20坪",
    layout: "2房1廳1衛",
    floor_name: "5/12",
    kind_name: "整層住家/電梯大樓",
    role_name: "",
    cover: "https://example.test/cover.png",
    tags: "[]",
    refresh_time: "2026-09-01T00:00:00.000Z",
    first_seen_at: "2026-09-01T00:00:00.000Z",
    last_seen_at: "2026-09-01T00:00:00.000Z",
    last_event: "new",
    lat: 24.2,
    lng: 120.7,
    geo_source: "591",
    ...overrides,
  });
}

function routeRow(extra = {}) {
  return { lat: 24.24, lng: 120.74, geo_source: "591", location_class: "source", ...extra };
}

/** 三筆大里區物件（每個 test 各呼叫一次；upsertListing／setCachedRoute 都是冪等）。 */
function seedFixtures() {
  // 730001：路線 pending（有可信座標、route_cache 沒有這一筆）
  seed(730001, { lat: 24.21, lng: 120.71 });
  // 730002：已知 50 公里（超過 commuteKm=5）
  seed(730002, { lat: 24.22, lng: 120.72 });
  app.setCachedRoute(24.22, 120.72, WORK.workLat, WORK.workLng, [50]);
  // 730003：已知 2 公里（在範圍內）
  seed(730003, { lat: 24.23, lng: 120.73 });
  app.setCachedRoute(24.23, 120.73, WORK.workLat, WORK.workLng, [2]);
}

test("大里區回 0 筆時，stats 要看得出是通勤擋掉的（不是沒有資料）", async () => {
  assert.equal(districtNameFromListing({ source_key: "8|107|1" }), "大里區");
  seedFixtures();

  const page = await loadListingPage(
    { filter: "all", sort: "newest", limit: 20, offset: 0, userId: uid, matchVoteUserId: uid, districts: ["大里區"], settings: SETTINGS },
    { driver: "sqlite" },
  );
  const ids = page.listings.map((row) => Number(row.post_id));

  // ① 原因看得到（現況沒有這兩個欄位 ⇒ 這幾行會紅）
  assert.ok(page.stats.excludedByCommute > 0, "stats.excludedByCommute 必須 > 0（已知超出通勤範圍的列數）");
  assert.ok(Number.isInteger(page.stats.commutePending), "stats.commutePending 必須是整數");
  assert.equal(page.stats.excludedByCommute, 1, "大里區恰好一筆已知超出 5 公里");
  assert.equal(page.stats.commutePending, 1, "大里區恰好一筆路線還沒算好");
  // ② 反向紅線：pending 的列**不得**出現在回傳的 listings
  assert.deepEqual(ids, [730003], "只有已知在範圍內的列可以出現");
  assert.ok(!ids.includes(730001), "路線 pending 的列不得先顯示（最後資料精準）");
  assert.ok(!ids.includes(730002), "已知超限的列不得出現");
});

test("計數口徑：沒有開通勤時兩個計數都是 0（也不會擋住任何列）", async () => {
  seedFixtures();
  const page = await loadListingPage(
    { filter: "all", sort: "newest", limit: 20, offset: 0, userId: uid, matchVoteUserId: uid, districts: ["大里區"], settings: { ...SETTINGS, commuteKm: 0 } },
    { driver: "sqlite" },
  );
  assert.equal(page.stats.excludedByCommute, 0);
  assert.equal(page.stats.commutePending, 0);
  assert.deepEqual(
    page.listings.map((row) => Number(row.post_id)).sort((a, b) => a - b),
    [730001, 730002, 730003],
    "沒開通勤時三筆都要出現",
  );
});

test("pending 的判定只有一份來源：helper 與 passesGeoFilters 必須一致", () => {
  const pendingRow = { lat: 24.2, lng: 120.7, geo_source: "591", location_class: "source" };
  assert.equal(commuteIncompleteShouldExclude(SETTINGS, null), true, "路線還沒有值 ⇒ 應該排除");
  assert.equal(passesGeoFilters(pendingRow, SETTINGS, { strict: true }), false, "管線的判定必須與 helper 相同");
  assert.equal(commuteIncompleteShouldExclude(SETTINGS, 2000), false, "已知距離交給距離閘門");
  assert.equal(commuteIncompleteShouldExclude({ ...SETTINGS, commuteKm: 0 }, null), false, "沒開通勤就不因路線排除");
});

test("排除原因回報：pending 與 over_limit 分得開，而且不改變回傳值", () => {
  const far = routeRow({ route_kms: [50], route_km: 50, route_min_m: 50000 });
  const reasons = [];
  assert.equal(passesGeoFilters(far, SETTINGS, { strict: true, onExclude: (reason) => reasons.push(reason) }), false);
  assert.deepEqual(reasons, ["commute_over_limit"]);
  const pendingReasons = [];
  assert.equal(
    passesGeoFilters(routeRow(), SETTINGS, { strict: true, onExclude: (reason) => pendingReasons.push(reason) }),
    false,
  );
  assert.deepEqual(pendingReasons, ["commute_pending"]);
  // 沒有可信座標 ⇒ 另一種原因（永遠算不出），不要混進 pending 的計數
  const noCoordsReasons = [];
  assert.equal(
    passesGeoFilters({ lat: null, lng: null, geo_source: "" }, SETTINGS, { strict: true, onExclude: (reason) => noCoordsReasons.push(reason) }),
    false,
  );
  assert.deepEqual(noCoordsReasons, ["commute_no_usable_coords"]);
});
