import { test } from "node:test";
import assert from "node:assert/strict";
import {
  communityRefFromDetail,
  extractTaiwanStreetAddress,
  formatListingAddress,
  listingAddressFromDetail,
  parseCommunityIdFromSourceKey,
  parseCommunityPayload,
  preferCommunityLocation,
} from "../src/location.js";
import { decideNotifyDelivery, hasTrustedCoords, isGeoReady, listingIsApartment, listingIsSuite, listingIsShop, listingIsWarehouse, listingHasElevator, matchesHousingKind, matchesListingSources, authorizedListingSources, canUseListingSourceFilter, normalizeListQuery, toggleHousingKind, passesGeoFilters, housingTypeLabel } from "../src/floors.js";
import { hasWorkPoint, needsListingGeo, commuteWorkJobs } from "../src/geo.js";

test("extracts the house-number address from a community page line", () => {
  const fromShot = "淡海新市鎮-行政中心 | 新北市淡水區淡金路二段173號";
  assert.equal(extractTaiwanStreetAddress(fromShot), "新北市淡水區淡金路二段173號");
  assert.equal(
    extractTaiwanStreetAddress("地址 : 淡海新市鎮-行政中心新北市淡水區淡金路二段173號"),
    "新北市淡水區淡金路二段173號",
  );
});

test("parses community API payload into a precise location", () => {
  const loc = parseCommunityPayload({
    status: 1,
    data: {
      community: {
        id: 101675,
        name: "將捷之森",
        address: "新北市淡水區淡金路二段173號",
        lat: "25.1825200",
        lng: "121.4492100",
      },
    },
  });
  assert.equal(loc.id, 101675);
  assert.equal(loc.name, "將捷之森");
  assert.equal(loc.address, "新北市淡水區淡金路二段173號");
  assert.equal(loc.lat, 25.18252);
  assert.equal(loc.lng, 121.44921);
});

test("prefers community building coordinates over listing street pin", () => {
  const chosen = preferCommunityLocation(
    {
      address: "淡水區淡金路二段",
      lat: 25.1839163,
      lng: 121.4467172,
    },
    {
      id: 101675,
      name: "將捷之森",
      address: "新北市淡水區淡金路二段173號",
      lat: 25.18252,
      lng: 121.44921,
    },
  );
  assert.equal(chosen.geo_source, "community");
  assert.equal(chosen.lat, 25.18252);
  assert.equal(chosen.lng, 121.44921);
  assert.equal(chosen.address, "將捷之森 新北市淡水區淡金路二段173號");
  assert.equal(chosen.community_id, 101675);
});

test("falls back to listing pin when community has no coordinates", () => {
  const chosen = preferCommunityLocation(
    { address: "淡水區淡金路二段", lat: 25.18, lng: 121.44, community_id: 9, community_name: "將捷之森" },
    { id: 9, name: "將捷之森", address: "", lat: null, lng: null },
  );
  assert.equal(chosen.geo_source, "591");
  assert.equal(chosen.lat, 25.18);
  assert.match(chosen.address, /將捷之森/);
});

test("reads community id from listing detail and source key", () => {
  const ref = communityRefFromDetail({
    positionRound: { communityId: 101675, communityName: "將捷之森", address: "淡水區淡金路二段" },
    address: { data: "淡水區淡金路二段", value: "將捷之森 淡水區淡金路二段" },
  });
  assert.equal(ref.id, 101675);
  assert.equal(ref.name, "將捷之森");
  assert.equal(listingAddressFromDetail({ address: { data: "淡水區淡金路二段" } }), "淡水區淡金路二段");
  assert.equal(parseCommunityIdFromSourceKey("3|50|c101675|淡水區淡金路二段|11|15.5|2房"), 101675);
  assert.equal(formatListingAddress("新北市淡水區淡金路二段173號", "將捷之森"), "將捷之森 新北市淡水區淡金路二段173號");
});

const commuteSettings = {
  commuteKm: 12,
  workLat: 25.05,
  workLng: 121.52,
};

const listingBase = {
  title: "將捷之森二房",
  kind_name: "整層住家",
  floor_name: "11F/14F",
  address: "將捷之森 新北市淡水區淡金路二段173號",
  lat: 25.18252,
  lng: 121.44921,
  geo_source: "community",
};

test("community coordinates count as trusted for commute filters", () => {
  assert.equal(hasTrustedCoords(listingBase), true);
  assert.equal(isGeoReady({ ...listingBase, route_kms: [16] }, commuteSettings), true);
  assert.equal(passesGeoFilters({ ...listingBase, route_kms: [16] }, commuteSettings), false);
  assert.equal(passesGeoFilters({ ...listingBase, route_kms: [9, 11] }, commuteSettings), true);
});

test("commute work jobs come from member settings, not empty global defaults", () => {
  const jobs = commuteWorkJobs([
    { commuteKm: 0, workLat: 25.1, workLng: 121.5 },
    { commuteKm: 13, workLat: 25.1062827, workLng: 121.524189 },
    { commuteKm: 13, workLat: 25.1062827, workLng: 121.524189 },
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workLat, 25.1062827);
  assert.equal(jobs[0].commuteMode, "scooter");
  const both = commuteWorkJobs([
    { commuteKm: 13, workLat: 25.1, workLng: 121.5, commuteMode: "scooter" },
    { commuteKm: 25, workLat: 25.1, workLng: 121.5, commuteMode: "car" },
  ]);
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((job) => job.commuteMode).sort(), ["car", "scooter"]);
  assert.equal(commuteWorkJobs([{ commuteKm: 12, workLat: 0, workLng: 0 }]).length, 0);
});

test("zero work coords do not enable commute filtering", () => {
  const broken = { commuteKm: 12, workLat: 0, workLng: 0, workAddress: "台北市士林區德行西路7號" };
  assert.equal(hasWorkPoint(broken), false);
  assert.equal(needsListingGeo(broken), false);
  assert.equal(passesGeoFilters({ ...listingBase, route_kms: [99] }, broken, { strict: true }), true);
});

test("notifications wait for commute distance then skip listings over the limit", () => {
  assert.equal(decideNotifyDelivery(listingBase, commuteSettings), "pending");
  assert.equal(decideNotifyDelivery({ ...listingBase, route_kms: [16] }, commuteSettings), "skip");
  assert.equal(decideNotifyDelivery({ ...listingBase, route_kms: [8, 10] }, commuteSettings), "send");
});

test("notifications wait for rush minutes when that flag is on", () => {
  const withKm = { ...listingBase, route_kms: [8, 10] };
  assert.equal(decideNotifyDelivery(withKm, { ...commuteSettings, waitRushMinutes: true }), "pending");
  assert.equal(
    decideNotifyDelivery(
      { ...withKm, rush_am_min: 28, rush_pm_min: 35 },
      { ...commuteSettings, waitRushMinutes: true },
    ),
    "send",
  );
});

test("webhook-bound filter also skips listings without trusted coordinates once commute is on", () => {
  assert.equal(
    decideNotifyDelivery({ ...listingBase, geo_source: "", route_kms: [8] }, commuteSettings),
    "pending",
  );
});

test("apartment and suite view filters do not treat elevator buildings as 公寓", () => {
  assert.equal(listingIsApartment({ title: "公寓三樓", kind_name: "整層住家", tags: ["公寓"] }), true);
  assert.equal(listingIsApartment({ title: "電梯大樓", kind_name: "整層住家", tags: ["電梯大樓"] }), false);
  assert.equal(listingIsSuite({ kind_name: "獨立套房" }), true);
  assert.equal(listingIsSuite({ kind_name: "整層住家" }), false);
  assert.equal(listingHasElevator({ title: "電梯大樓", kind_name: "整層住家", tags: ["電梯大樓"] }), true);
  assert.equal(housingTypeLabel({ kind_name: "獨立套房" }), "套房");
  assert.equal(housingTypeLabel({ kind_name: "分租套房" }), "套房");
  assert.equal(housingTypeLabel({ kind_name: "整層住家", tags: ["公寓"] }), "公寓");
  assert.equal(housingTypeLabel({ title: "電梯大樓", kind_name: "整層住家", tags: ["電梯大樓"] }), "電梯公寓/大樓");
  assert.equal(housingTypeLabel({ kind_name: "整層住家", tags: ["有電梯"] }), "電梯公寓/大樓");
  assert.equal(housingTypeLabel({ kind_name: "整層住家", tags: '["有電梯"]' }), "電梯公寓/大樓");
  assert.equal(housingTypeLabel({ kind_name: "整層住家", tags: ["無電梯", "公寓"] }), "公寓");
  assert.equal(housingTypeLabel({ kind_name: "整層住家" }), "公寓");
});

test("housing kind filters can combine with 特別關注", () => {
  const apt = { title: "公寓", kind_name: "整層住家", tags: ["公寓"] };
  const tower = { title: "電梯大樓", kind_name: "整層住家", tags: ["電梯大樓"] };
  const suite = { kind_name: "獨立套房" };
  assert.equal(matchesHousingKind(apt, "apartment"), true);
  assert.equal(matchesHousingKind(tower, "apartment"), false);
  assert.equal(matchesHousingKind(suite, "suite"), true);
  assert.equal(matchesHousingKind(tower, "elevator"), true);
  assert.deepEqual(normalizeListQuery("watched", "suite"), { filter: "watched", kind: "suite", kinds: ["suite"], sources: [] });
  assert.deepEqual(normalizeListQuery("elevator", ""), { filter: "all", kind: "elevator", kinds: ["elevator"], sources: [] });
  assert.deepEqual(normalizeListQuery("all", "building"), { filter: "all", kind: "", kinds: [], sources: [] });
  assert.deepEqual(normalizeListQuery("all", "elevator,whole", "591,sinyi"), {
    filter: "all",
    kind: "elevator,whole",
    kinds: ["elevator", "whole"],
    sources: ["591", "sinyi"],
  });
  assert.deepEqual(normalizeListQuery("all", "suite,whole"), { filter: "all", kind: "whole", kinds: ["whole"], sources: [] });
  assert.equal(listingIsShop({ kind_name: "店面" }), true);
  assert.equal(listingIsWarehouse({ kind_name: "倉庫" }), true);
  assert.equal(housingTypeLabel({ kind_name: "店面" }), "店面");
  assert.equal(matchesHousingKind({ kind_name: "店面" }, "shop"), true);
  assert.equal(matchesHousingKind({ kind_name: "獨立套房" }, "suite,whole"), false);
  assert.deepEqual(toggleHousingKind(["suite"], "whole"), ["whole"]);
  assert.deepEqual(toggleHousingKind(["whole"], "shop"), ["shop"]);
  assert.deepEqual(toggleHousingKind(["elevator"], "apartment"), ["elevator", "apartment"]);
  assert.deepEqual(toggleHousingKind(["shop"], "warehouse"), ["shop", "warehouse"]);
  assert.equal(matchesHousingKind({ title: "電梯大樓", kind_name: "整層住家", tags: ["電梯大樓"] }, "elevator,apartment"), true);
  assert.equal(matchesListingSources({ source: "sinyi" }, "591,sinyi"), true);
  assert.equal(matchesListingSources({ source: "housefun" }, "591"), false);
  assert.equal(canUseListingSourceFilter({ role: "admin", plan: "free" }), true);
  assert.equal(canUseListingSourceFilter({ role: "member", plan: "sponsor" }), true);
  assert.equal(canUseListingSourceFilter({ role: "member", plan: "free" }), false);
  assert.deepEqual(authorizedListingSources("591,sinyi", { role: "member", plan: "free" }), []);
  assert.deepEqual(authorizedListingSources("591,sinyi", { role: "admin" }), ["591", "sinyi"]);
  assert.deepEqual(authorizedListingSources("591,sinyi", { plan: "sponsor" }), ["591", "sinyi"]);
});
