import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HP_POST_ID_BASE,
  HP_SOURCE,
  enrichHpListingFromDetail,
  fetchHpCoveringListings,
  hpDetailUrl,
  hpListUrl,
  hpPostIdFromCase,
  hpSidForDistrict,
  isHpListingId,
  normalizeHpItem,
  parseHpDetailHtml,
  parseHpListHtml,
} from "../src/houseprice.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(path.join(dir, "fixtures/houseprice-list.html"), "utf8");
const detailFixture = readFileSync(path.join(dir, "fixtures/houseprice-detail.html"), "utf8");

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
  assert.match(whole.title, /🔥\s*御陽明美景豪邸拎包入住/);
  assert.match(whole.title, /御陽明美景豪邸拎包入住/);
  assert.equal(whole.title.includes("<"), false);
  assert.match(whole.cover, /0b4edd2ae1664881/);
  assert.doesNotMatch(whole.cover, /default_cover/);
  assert.equal(whole.price_num, 200000);
  assert.equal(whole.floor_name, "4/4");
  assert.match(whole.address, /士林區格致路/);
  assert.match(whole.url, /house\/1447592_285879/);
  const suite = normalizeHpItem(parsed.items[1], { regionId: 1, sectionId: 8 });
  assert.equal(suite.kind_name, "獨立套房");
  assert.equal(suite.price_num, 24999);
  assert.match(suite.cover, /realphoto_800x600/);
  assert.doesNotMatch(suite.cover, /default_cover/);
});

test("parseHpDetailHtml reads total/rental floor and community from the detail page", () => {
  const detail = parseHpDetailHtml(detailFixture);
  assert.equal(detail.floorName, "4/4");
  assert.equal(detail.community, "御陽明");
  assert.equal(detail.areaName, "64.73坪");
  assert.equal(detail.layout, "4房2廳4衛2陽台");
  assert.equal(detail.kind, "整層住家");
  assert.equal(detail.buildingType, "大樓");
  assert.match(detail.address, /士林區格致路/);
});

test("parseHpDetailHtml falls back to meta description when label spans are absent", () => {
  const lite = readFileSync(path.join(dir, "fixtures/houseprice-detail-lite.html"), "utf8");
  const detail = parseHpDetailHtml(lite);
  assert.equal(detail.floorName, "");
  assert.equal(detail.community, "");
  assert.equal(detail.areaName, "53坪");
  assert.equal(detail.layout, "2房2廳2衛");
  assert.equal(detail.kind, "整層住家");
  assert.match(detail.address, /士林區士商路/);
});

test("enrichHpListingFromDetail fills missing floor and community and rebuilds the fingerprint", () => {
  const bare = normalizeHpItem({
    id: "9999_1", kind: "獨立套房", title: "測試套房", price: 20000,
    areaName: "7坪", layout: "1房1衛", floorName: "", address: "台北市士林區格致路", community: "",
  }, { regionId: 1, sectionId: 8 });
  assert.equal(bare.floor_name, "");
  assert.equal(bare.community_name, "");
  const beforeKey = bare.source_key;
  const enriched = enrichHpListingFromDetail(bare, parseHpDetailHtml(detailFixture), { regionId: 1, sectionId: 8 });
  assert.equal(enriched.floor_name, "4/4");
  assert.equal(enriched.community_name, "御陽明");
  assert.notEqual(enriched.source_key, beforeKey);
  assert.match(enriched.tags, /御陽明/);
});

test("fetchHpCoveringListings enriches suite listings from the detail page", async () => {
  const jobs = [{ regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 0, searchUrl: "x" }];
  const batches = await fetchHpCoveringListings(jobs, {
    pages: 1,
    detailGapMs: 0,
    getHtml: async (url) => (String(url).includes("/house/") ? detailFixture : fixture),
  });
  const suite = batches[0].listings.find((row) => row.source_id === "16512158_1170048");
  assert.ok(suite);
  assert.equal(suite.floor_name, "4/4");
  assert.equal(suite.community_name, "御陽明");
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

