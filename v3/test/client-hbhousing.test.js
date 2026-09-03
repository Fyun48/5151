import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HB_POST_ID_BASE,
  HB_POST_ID_END,
  HB_SOURCE,
  districtKeyForZip,
  fetchHbCoveringListings,
  hbDetailUrl,
  hbPostIdFromSn,
  isHbListingId,
  kindFromHbItem,
  normalizeHbItem,
  parseHbApiBody,
  parseHbNuxtHtml,
  priceTwdFromWan,
  zipForDistrict,
} from "../src/hbhousing.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(dir, "fixtures/hbhousing-page.json"), "utf8"));

test("住商 zip maps onto 591 districts and reserved post ids", () => {
  assert.equal(zipForDistrict(1, 5), "106");
  assert.equal(zipForDistrict(3, 37), "234");
  assert.equal(districtKeyForZip("104"), "1-3");
  assert.equal(isHbListingId(15801234), false);
  assert.equal(isHbListingId(2_100_000_001), false);
  const id = hbPostIdFromSn("ZR204342");
  assert.equal(isHbListingId(id), true);
  assert.ok(id >= HB_POST_ID_BASE && id < HB_POST_ID_END);
  assert.equal(hbPostIdFromSn("ZR204342"), id);
  assert.equal(hbDetailUrl("ZR204342"), "https://www.hbhousing.com.tw/detail?sn=ZR204342");
});

test("normalize 住商 items converts 萬元、跳過店面、套房不標整層", () => {
  const parsed = parseHbApiBody({ data: fixture });
  assert.ok(parsed.items.length >= 3);
  const whole = normalizeHbItem(parsed.items.find((row) => row.sn === "ZR204342"), { regionId: 1, sectionId: 5 });
  assert.equal(whole.source, HB_SOURCE);
  assert.equal(whole.source_id, "ZR204342");
  assert.equal(whole.kind_name, "整層住家");
  assert.equal(whole.price_num, 79000);
  assert.equal(whole.price, "79000");
  assert.equal(whole.floor_name, "4/8");
  assert.match(whole.address, /台北市大安區浦城街/);
  assert.equal(whole.geo_source, "hbhousing");
  assert.ok(whole.lat > 25);
  assert.match(whole.url, /detail\?sn=ZR204342/);
  assert.match(whole.source_key, /^1\|5\|/);

  const suite = normalizeHbItem(parsed.items.find((row) => row.sn === "OR225594"), { regionId: 3, sectionId: 37 });
  assert.equal(suite.kind_name, "獨立套房");
  assert.equal(suite.price_num, 8500);

  const shop = parsed.items.find((row) => row.type === "店面" || row.type === "辦公");
  assert.equal(kindFromHbItem(shop), "");
  assert.equal(normalizeHbItem(shop, { regionId: 1, sectionId: 5 }), null);
  assert.equal(priceTwdFromWan(0.85), 8500);
});

test("fetchHbCoveringListings uses injected POST and covering jobs", async () => {
  const jobs = [{
    regionId: 1,
    sectionIds: [5],
    priceMin: 0,
    priceMax: 0,
    searchUrl: "https://rent.591.com.tw/list?region=1&section=5&notice=not_cover",
  }];
  const batches = await fetchHbCoveringListings(jobs, {
    pages: 1,
    minBuildingFloors: 4,
    postJson: async () => ({ code: 1, data: fixture }),
  });
  assert.equal(batches.length, 1);
  assert.match(batches[0].parsed.label, /住商/);
  assert.equal(batches[0].searchUrl, jobs[0].searchUrl);
  const sns = batches[0].listings.map((row) => row.source_id);
  assert.ok(sns.includes("ZR204342"));
  assert.ok(!sns.includes("OR225594"));
  assert.ok(batches[0].listings.every((row) => row.source === "hbhousing"));
});

test("parseHbNuxtHtml reads rentHouseData pointers", () => {
  const payload = [
    ["ShallowReactive", 1],
    { data: 2 },
    0,
    { rentHouseData: 4, cnts: 5 },
    [6],
    1,
    {
      sn: 7, objName: 8, type: 9, price: 10, rentPrice: 10, zipCode: 11,
      doorplate: 12, floor: 13, floorTotal: 14, area: 15, special: 16,
      lat: 17, lon: 18, photo1: 19, storeID: 20,
    },
    "AB1",
    "測試住宅",
    "住宅",
    1.2,
    "106",
    "大安區測試路",
    "5",
    "10",
    22,
    "2房1廳1衛",
    25.04,
    121.54,
    "https://img.example/a.jpg",
    "A1",
  ];
  const html = `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  const parsed = parseHbNuxtHtml(html);
  assert.equal(parsed.total, 1);
  assert.equal(parsed.items[0].sn, "AB1");
  assert.equal(parsed.items[0].objName, "測試住宅");
  const row = normalizeHbItem(parsed.items[0], { regionId: 1, sectionId: 5 });
  assert.equal(row.kind_name, "整層住家");
  assert.equal(row.price_num, 12000);
});

test("watcher still crawls 住商 when 591 is closed", () => {
  const src = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(src, /fetchHbCoveringListings/);
  assert.match(src, /wantHb/);
  assert.match(src, /isCrawlSourceEnabled\("hbhousing"\)/);
  assert.match(src, /skipped: "hbhousing"/);
});
