import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HP_POST_ID_BASE,
  HP_SOURCE,
  fetchHpCoveringListings,
  hpDetailUrl,
  hpListUrl,
  hpPostIdFromCase,
  hpSidForDistrict,
  isHpListingId,
  normalizeHpItem,
  parseHpListHtml,
} from "../src/houseprice.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(path.join(dir, "fixtures/houseprice-list.html"), "utf8");

test("5168 maps 591 districts onto list path and reserved ids", () => {
  assert.equal(hpSidForDistrict(1, 8), 8);
  assert.equal(hpSidForDistrict(3, 37), 26);
  assert.match(hpListUrl({ sid: 8, page: 2 }), /8_zip\/\?p=2/);
  const id = hpPostIdFromCase("1447592_285879");
  assert.equal(isHpListingId(id), true);
  assert.ok(id >= HP_POST_ID_BASE);
  assert.equal(hpDetailUrl("1447592_285879"), "https://rent.houseprice.tw/house/1447592_285879");
});

test("parseHpListHtml reads 5168 SSR cards", () => {
  const parsed = parseHpListHtml(fixture);
  assert.equal(parsed.total, 1187);
  assert.equal(parsed.items.length, 2);
  const whole = normalizeHpItem(parsed.items[0], { regionId: 1, sectionId: 8 });
  assert.equal(whole.source, HP_SOURCE);
  assert.equal(whole.source_id, "1447592_285879");
  assert.equal(whole.kind_name, "整層住家");
  assert.equal(whole.price_num, 200000);
  assert.equal(whole.floor_name, "4/4");
  assert.match(whole.address, /士林區格致路/);
  assert.match(whole.url, /house\/1447592_285879/);
  const suite = normalizeHpItem(parsed.items[1], { regionId: 1, sectionId: 8 });
  assert.equal(suite.kind_name, "獨立套房");
  assert.equal(suite.price_num, 24999);
});

test("fetchHpCoveringListings uses injected HTML", async () => {
  const jobs = [{
    regionId: 1,
    sectionIds: [8],
    priceMin: 0,
    priceMax: 0,
    searchUrl: "https://rent.591.com.tw/list?region=1&section=8&notice=not_cover",
  }];
  const batches = await fetchHpCoveringListings(jobs, {
    pages: 1,
    minBuildingFloors: 4,
    getHtml: async () => fixture,
  });
  assert.equal(batches.length, 1);
  assert.match(batches[0].parsed.label, /5168/);
  assert.ok(batches[0].listings.some((row) => row.source_id === "1447592_285879"));
  assert.ok(batches[0].listings.some((row) => row.source_id === "16512158_1170048"));
  assert.ok(batches[0].listings.every((row) => row.source === "houseprice"));
});

