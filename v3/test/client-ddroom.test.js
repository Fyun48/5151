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
