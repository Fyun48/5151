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
  probeHpListingAlive,
  hpDetailApiUrl,
  hpDetailUrl,
  hpListUrl,
  hpPostIdFromCase,
  hpSidForDistrict,
  isHpListingId,
  normalizeHpFloorName,
  normalizeHpItem,
  parseHpDetailHtml,
  parseHpDetailJson,
  parseHpLabeledPlain,
  parseHpListHtml,
} from "../src/houseprice.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(path.join(dir, "fixtures/houseprice-list.html"), "utf8");
const detailFixture = readFileSync(path.join(dir, "fixtures/houseprice-detail.html"), "utf8");
const detailApiFixture = readFileSync(path.join(dir, "fixtures/houseprice-detail-api.json"), "utf8");

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

test("5168 labeled 樓層 / 22 / 24樓 means rental 22 and building 24", () => {
  assert.equal(normalizeHpFloorName("22 / 24樓"), "22/24");
  assert.equal(normalizeHpFloorName("樓層 / 22 / 24樓"), "22/24");
  const fields = parseHpLabeledPlain("地址 / 新北市淡水區民權路19號 社區 / 南加州 樓層 / 22 / 24樓 坪數 / 30.8 坪");
  assert.equal(fields["地址"], "新北市淡水區民權路19號");
  assert.equal(fields["社區"], "南加州");
  assert.equal(normalizeHpFloorName(fields["樓層"]), "22/24");
  const html = parseHpDetailHtml(`<p>樓層 / 22 / 24樓</p><p>社區 / 南加州</p><p>地址 / 新北市淡水區民權路19號</p>`);
  assert.equal(html.floorName, "22/24");
  assert.equal(html.community, "南加州");
  assert.match(html.address, /民權路19號/);
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
  assert.equal(detail.usage, "住家用");
  assert.ok(Math.abs(detail.lat - 25.1419) < 0.01, `lat ${detail.lat}`);
  assert.ok(Math.abs(detail.lng - 121.5493) < 0.01, `lng ${detail.lng}`);
});

test("parseHpDetailJson reads full detail (address+coords) from the SPA JSON API", () => {
  assert.equal(hpDetailApiUrl("16705651"), "https://rent.houseprice.tw/ws/detail/16705651");
  const detail = parseHpDetailJson(detailApiFixture);
  assert.equal(detail.address, "新北市淡水區中山路93號");
  assert.equal(detail.floorName, "6/12");
  assert.equal(detail.layout, "1房0廳1衛");
  assert.equal(detail.areaName, "11坪");
  assert.equal(detail.usage, "獨立套房");
  assert.equal(detail.kind, "獨立套房");
  assert.equal(detail.buildingType, "大樓");
  assert.equal(detail.community, "城市山水/永樂大廈");
  assert.ok(Math.abs(detail.lat - 25.1696) < 0.001, `lat ${detail.lat}`);
  assert.ok(Math.abs(detail.lng - 121.442) < 0.001, `lng ${detail.lng}`);
  assert.equal(parseHpDetailJson("not json"), null);
  assert.equal(parseHpDetailJson("<html>shell</html>"), null);
});

test("fetchHpCoveringListings enriches from the JSON API (address + geo pin)", async () => {
  const jobs = [{ regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 0, searchUrl: "x" }];
  const batches = await fetchHpCoveringListings(jobs, {
    pages: 1,
    detailGapMs: 0,
    getHtml: async (url) => (String(url).includes("/ws/detail/") ? detailApiFixture : fixture),
  });
  const suite = batches[0].listings.find((row) => row.source_id === "16512158_1170048");
  assert.ok(suite);
  assert.equal(suite.geo_source, "houseprice");
  assert.ok(Math.abs(suite.lat - 25.1696) < 0.001);
  assert.match(suite.address, /淡水區中山路93號/);
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
  assert.equal(enriched.geo_source, "houseprice");
  assert.ok(Number.isFinite(enriched.lat) && Number.isFinite(enriched.lng));
  assert.match(enriched.tags, /住家用/);
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
  assert.equal(suite.geo_source, "houseprice");
  assert.ok(Number.isFinite(suite.lat) && Number.isFinite(suite.lng));
});

test("fetchHpCoveringListings skips the detail fetch when hasGeo already has the pin", async () => {
  const jobs = [{ regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 0, searchUrl: "x" }];
  let detailHits = 0;
  const batches = await fetchHpCoveringListings(jobs, {
    pages: 1,
    detailGapMs: 0,
    hasGeo: () => true,
    getHtml: async (url) => {
      if (String(url).includes("/house/")) { detailHits += 1; return detailFixture; }
      return fixture;
    },
  });
  assert.equal(detailHits, 0);
  const suite = batches[0].listings.find((row) => row.source_id === "16512158_1170048");
  assert.ok(suite);
  assert.equal(suite.lat, null);
});

test("probeHpListingAlive uses the JSON API: 400/404/empty gone, live detail alive", async () => {
  const orig = globalThis.fetch;
  const calls = [];
  try {
    // 400（不存在的 case id）＝已下架
    globalThis.fetch = async (u) => { calls.push(String(u)); return { ok: false, status: 400, json: async () => ({}) }; };
    assert.equal(await probeHpListingAlive("https://rent.houseprice.tw/house/9999999999"), false);
    assert.match(calls.at(-1), /\/ws\/detail\/9999999999$/);
    // 404 ＝已下架
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    assert.equal(await probeHpListingAlive("https://rent.houseprice.tw/house/a"), false);
    // 200 但沒有物件明細 ＝已下架
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 200, webRentCaseGroupingDetail: {} }) });
    assert.equal(await probeHpListingAlive("https://rent.houseprice.tw/house/b"), false);
    // 200 且有物件明細 ＝仍在
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 200, webRentCaseGroupingDetail: { simpAddress: "新北市淡水區中山路93號", lat: 25.1696, lng: 121.442 } }) });
    assert.equal(await probeHpListingAlive("https://rent.houseprice.tw/house/16705651"), true);
    // 200 但非 JSON（保守視為仍在）
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } });
    assert.equal(await probeHpListingAlive("https://rent.houseprice.tw/house/c"), true);
    // 503 暫時錯誤（保守視為仍在）
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    assert.equal(await probeHpListingAlive("https://rent.houseprice.tw/house/d"), true);
    // fetch 逾時／擲錯（保守視為仍在）
    globalThis.fetch = async () => { throw new Error("timeout"); };
    assert.equal(await probeHpListingAlive("https://rent.houseprice.tw/house/e"), true);
    // 空網址
    assert.equal(await probeHpListingAlive(""), true);
  } finally {
    globalThis.fetch = orig;
  }
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

