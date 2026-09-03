import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SINYI_POST_ID_BASE,
  SINYI_POST_ID_END,
  SINYI_SOURCE,
  fetchSinyiCoveringListings,
  isSinyiListingId,
  kindFromSinyiItem,
  normalizeSinyiItem,
  parseSinyiApiBody,
  priceTwdFromSinyi,
  sinyiDetailUrl,
  sinyiFormBody,
  sinyiPostIdFromNo,
} from "../src/sinyi.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(dir, "fixtures/sinyi-page.json"), "utf8"));

test("信義 zip form and reserved post ids", () => {
  assert.match(sinyiFormBody({ zip: "111", page: 2, limit: 20 }), /params=111-zip/);
  assert.match(sinyiFormBody({ zip: "111" }), /returnParams=/);
  const id = sinyiPostIdFromNo("C366801");
  assert.equal(isSinyiListingId(id), true);
  assert.ok(id >= SINYI_POST_ID_BASE && id < SINYI_POST_ID_END);
  assert.equal(sinyiPostIdFromNo("C366801"), id);
  assert.equal(sinyiDetailUrl("C366801"), "https://www.sinyi.com.tw/rent/houseno/C366801");
  assert.equal(sinyiDetailUrl("houseno/C366801"), "https://www.sinyi.com.tw/rent/houseno/C366801");
});

test("normalize 信義 items keeps 成屋住宅、跳過店面", () => {
  const parsed = parseSinyiApiBody(fixture);
  assert.equal(parsed.total, 133);
  assert.ok(parsed.items.length >= 2);
  const row = normalizeSinyiItem(parsed.items.find((item) => item.NO === "C366801"), {
    regionId: 1,
    sectionId: 8,
  });
  assert.equal(row.source, SINYI_SOURCE);
  assert.equal(row.source_id, "C366801");
  assert.equal(row.kind_name, "整層住家");
  assert.equal(row.price_num, 49800);
  assert.equal(row.floor_name, "4/5");
  assert.match(row.address, /士林區天母西路/);
  assert.equal(row.geo_source, "sinyi");
  assert.ok(row.lat > 25);
  assert.match(row.url, /houseno\/C366801/);
  assert.equal(priceTwdFromSinyi("49,800"), 49800);
  assert.equal(kindFromSinyiItem({ use: "店面", name: "金店面" }), "");
  assert.equal(normalizeSinyiItem({ NO: "X1", use: "店面", name: "金店面" }), null);
});

test("fetchSinyiCoveringListings uses injected POST and covering jobs", async () => {
  const jobs = [{
    regionId: 1,
    sectionIds: [8],
    priceMin: 0,
    priceMax: 0,
    searchUrl: "https://rent.591.com.tw/list?region=1&section=8&notice=not_cover",
  }];
  const batches = await fetchSinyiCoveringListings(jobs, {
    pages: 1,
    minBuildingFloors: 4,
    postForm: async () => fixture,
  });
  assert.equal(batches.length, 1);
  assert.match(batches[0].parsed.label, /信義/);
  assert.ok(batches[0].listings.some((row) => row.source_id === "C366801"));
  assert.ok(batches[0].listings.every((row) => row.source === "sinyi"));
});
