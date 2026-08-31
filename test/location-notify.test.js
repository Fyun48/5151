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
import { decideNotifyDelivery, hasTrustedCoords, isGeoReady, listingIsApartment, listingIsSuite, passesGeoFilters } from "../src/floors.js";

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

test("notifications wait for commute distance then skip listings over the limit", () => {
  assert.equal(decideNotifyDelivery(listingBase, commuteSettings), "pending");
  assert.equal(decideNotifyDelivery({ ...listingBase, route_kms: [16] }, commuteSettings), "skip");
  assert.equal(decideNotifyDelivery({ ...listingBase, route_kms: [8, 10] }, commuteSettings), "send");
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
});
