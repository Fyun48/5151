import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DD_POST_ID_BASE,
  DD_SOURCE,
  ddCityName,
  ddDetailUrl,
  ddPostIdFromObject,
  ddSearchParams,
  enrichDdListingFromObject,
  fetchDdCoveringListings,
  isDdListingId,
  kindFromDdItem,
  normalizeDdItem,
  parseDdApiBody,
} from "../src/ddroom.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(dir, "fixtures/ddroom-page.json"), "utf8"));

test("租租通 city names and reserved post ids", () => {
  assert.equal(ddCityName(1), "臺北市");
  assert.equal(ddCityName(3), "新北市");
  assert.match(ddSearchParams({ city: "臺北市", area: "士林區" }).toString(), /area=%E5%A3%AB%E6%9E%97%E5%8D%80/);
  const id = ddPostIdFromObject("rvjwjje2subwa0gk");
  assert.equal(isDdListingId(id), true);
  assert.ok(id >= DD_POST_ID_BASE);
  assert.equal(ddDetailUrl("rvjwjje2subwa0gk"), "https://www.dd-room.com/object/rvjwjje2subwa0gk");
});

test("normalize 租租通 studio vs whole, keep shop", () => {
  const parsed = parseDdApiBody(fixture);
  assert.equal(parsed.total, 71);
  const studio = normalizeDdItem(parsed.items.find((row) => row.object_id === "rvjwjje2subwa0gk"), {
    regionId: 1,
    sectionId: 8,
  });
  assert.equal(studio.source, DD_SOURCE);
  assert.equal(studio.kind_name, "獨立套房");
  assert.equal(studio.price_num, 24999);
  assert.match(studio.address, /士林區重慶北路/);
  assert.match(studio.url, /\/object\/rvjwjje2subwa0gk/);
  const whole = normalizeDdItem(parsed.items.find((row) => row.type_space === "whole"), {
    regionId: 1,
    sectionId: 8,
  });
  assert.equal(whole.kind_name, "整層住家");
  assert.equal(kindFromDdItem({ type_space: "shop", type_space_name: "店面" }), "店面");
  assert.equal(kindFromDdItem({ type_space: "office", type_space_name: "辦公" }), "");
  const pinned = normalizeDdItem({
    object_id: "pin-dd-1",
    type_space: "whole",
    type_space_name: "整層住家",
    title: "淡水二房",
    rent: 18000,
    floor: 11,
    ping: 15.5,
    address: { complete: "新北市淡水區淡金路二段173號" },
    lat: 25.18252,
    lng: 121.44921,
  }, { regionId: 3, sectionId: 50 });
  assert.equal(pinned.geo_source, DD_SOURCE);
  assert.equal(pinned.lat, 25.18252);
  const enriched = enrichDdListingFromObject({ ...pinned, lat: null, lng: null, geo_source: null }, {
    title: "淡水二房",
    location: { lat: 25.18252, lng: 121.44921 },
  });
  assert.equal(enriched.geo_source, DD_SOURCE);
  assert.equal(enriched.lat, 25.18252);
});

test("租租通 floor -1 is unknown, object furnish is kept", () => {
  const object = JSON.parse(readFileSync(path.join(dir, "fixtures/ddroom-object-7eomdjwxiceohvsd.json"), "utf8")).data.object;
  const row = normalizeDdItem({
    object_id: object.object_id,
    type_space: object.type_space,
    type_space_name: "整層住家",
    title: object.title,
    rent: object.rent,
    floor: object.floor,
    ping: object.ping,
    address: object.address,
    themes: object.themes,
  }, { regionId: 1, sectionId: 8 });
  assert.equal(row.floor_name, "");
  assert.match(row.address, /德行東路/);
  const enriched = enrichDdListingFromObject(row, object);
  assert.equal(enriched.floor_name, "");
  assert.match(enriched.furnish_items, /冰箱/);
  assert.match(enriched.furnish_items, /冷氣/);
  assert.match(enriched.furnish_items, /熱水器/);
});

test("fetchDdCoveringListings uses injected GET JSON", async () => {
  const jobs = [{
    regionId: 1,
    sectionIds: [8],
    priceMin: 0,
    priceMax: 0,
    searchUrl: "https://rent.591.com.tw/list?region=1&section=8&notice=not_cover",
  }];
  const batches = await fetchDdCoveringListings(jobs, {
    pages: 1,
    minBuildingFloors: 4,
    getJson: async () => fixture,
  });
  assert.equal(batches.length, 1);
  assert.match(batches[0].parsed.label, /租租通/);
  assert.ok(batches[0].listings.some((row) => row.source_id === "dgdgvumpmdmjxe3x"));
  assert.ok(batches[0].listings.every((row) => row.source === "ddroom"));
});
