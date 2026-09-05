import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HF_POST_ID_BASE,
  HF_SOURCE,
  fetchHfCoveringListings,
  hfB64Encode,
  hfCityCode,
  hfDetailUrl,
  hfPostIdFromRentId,
  hfRequestPackage,
  hfUnwrapGateway,
  isHfListingId,
  kindFromHfText,
  normalizeHfItem,
  parseHfApiBody,
} from "../src/housefun.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(dir, "fixtures/housefun-page.json"), "utf8"));

test("好房網 city codes, gateway encode, reserved ids", () => {
  assert.equal(hfCityCode(1), "0000");
  assert.equal(hfCityCode(3), "0001");
  assert.equal(hfB64Encode("INQUIRE"), Buffer.from("INQUIRE").toString("base64"));
  assert.match(hfRequestPackage({ PMPage: "1" }), /RequestPackage=/);
  const id = hfPostIdFromRentId("1956467");
  assert.equal(isHfListingId(id), true);
  assert.ok(id >= HF_POST_ID_BASE);
  assert.equal(hfDetailUrl("1956467"), "https://rent.housefun.com.tw/rent/house/1956467/");
  assert.equal(hfUnwrapGateway(fixture).Status, "1");
});

test("parse 好房網 SearchContent keeps 店面 and 整層", () => {
  const parsed = parseHfApiBody(fixture);
  assert.equal(parsed.total, 188);
  assert.equal(parsed.pageCount, 19);
  assert.equal(parsed.items.length, 2);
  const shop = parsed.items.find((row) => row.id === "1992374");
  assert.equal(kindFromHfText(`${shop.title} ${shop.layout}`), "店面");
  const shopRow = normalizeHfItem(shop, { regionId: 1, sectionId: 8 });
  assert.equal(shopRow.kind_name, "店面");
  const home = normalizeHfItem(parsed.items.find((row) => row.id === "1956467"), {
    regionId: 1,
    sectionId: 8,
  });
  assert.equal(home.source, HF_SOURCE);
  assert.equal(home.kind_name, "整層住家");
  assert.equal(home.price_num, 235000);
  assert.equal(home.floor_name, "18/21");
  assert.match(home.address, /士林/);
  assert.equal(home.geo_source, "housefun");
  assert.ok(home.lat > 25);
  assert.match(home.url, /\/rent\/house\/1956467\//);
});

test("fetchHfCoveringListings uses injected POST", async () => {
  const jobs = [{
    regionId: 1,
    sectionIds: [8],
    priceMin: 0,
    priceMax: 0,
    searchUrl: "https://rent.591.com.tw/list?region=1&section=8&notice=not_cover",
  }];
  const batches = await fetchHfCoveringListings(jobs, {
    pages: 1,
    minBuildingFloors: 4,
    postForm: async () => fixture,
  });
  assert.equal(batches.length, 1);
  assert.match(batches[0].parsed.label, /好房/);
  assert.ok(batches[0].listings.some((row) => row.source_id === "1956467"));
  assert.ok(!batches[0].listings.some((row) => row.source_id === "1992374"));
  assert.ok(batches[0].listings.every((row) => row.source === "housefun"));
});
