import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commuteMetersWithinLimit,
  commutePrecisionText,
  decideNotifyGeo,
  eventFullyHandled,
  geoInflightKey,
  houseCacheKey,
  listingNeedsExternalGeocode,
  mergeChannelJob,
  notifyIncludeStreetEstimate,
  parseTaiwanAddressParts,
  providerCityMatches,
  shouldAcceptGeoUpdate,
  streetCacheKey,
} from "../src/geoPrecision.js";
import { geocodeAddress, parseTaiwanAddress, resetGeoMetrics, snapshotGeoMetrics } from "../src/geo.js";
import { decideNotifyDelivery, decideNotifyDecision, isStalePendingNotify, listingCanResolveNotifyGeo, passesGeoFilters, PENDING_NOTIFY_MAX_MS } from "../src/floors.js";
import { applySettingPatch, hydrateSettings, resolveWorkPointForSave } from "../src/settingsState.js";

const commute = { commuteKm: 10, workLat: 25.05, workLng: 121.52 };

test("G5 全台縣市與 12-1 號不會被刪成 121 號", () => {
  const kaohsiung = parseTaiwanAddressParts("高雄市鳳山區中山路12-1號");
  assert.equal(kaohsiung.city, "高雄市");
  assert.equal(kaohsiung.district, "鳳山區");
  assert.equal(kaohsiung.number, "12-1號");
  const hyphen = parseTaiwanAddress("臺南市東區崇明路12之1號");
  assert.equal(hyphen.number, "12-1號");
  assert.doesNotMatch(hyphen.number, /121/);
  const alley = parseTaiwanAddressParts("臺中市西屯區河南路二段12巷3弄");
  assert.equal(alley.city, "臺中市");
  assert.equal(alley.lane, "12");
  assert.equal(alley.alley, "3");
  assert.ok(streetCacheKey(kaohsiung).includes("高雄市|鳳山區"));
  assert.ok(houseCacheKey(kaohsiung).includes("12-1號"));
});

test("G1 來源座標不必再查外部地址", () => {
  assert.equal(listingNeedsExternalGeocode({
    lat: 25.18, lng: 121.44, geo_source: "591", location_class: "source",
  }), false);
  assert.equal(listingNeedsExternalGeocode({
    address: "新北市淡水區淡金路二段", lat: null, lng: null,
  }), true);
});

test("G2 快取命中不發外部查詢", async () => {
  resetGeoMetrics();
  let calls = 0;
  const hit = await geocodeAddress("新北市淡水區淡金路二段173號", () => ({
    lat: 25.18252,
    lng: 121.44921,
    location_class: "address",
    city: "新北市",
    district: "淡水區",
    quality: "house",
  }), {
    fetch: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
    fast: true,
  });
  assert.equal(calls, 0);
  assert.equal(hit.from_cache, true);
  assert.equal(hit.location_class, "address");
  assert.equal(snapshotGeoMetrics().external_requests, 0);
});

test("G3 路段地址可先當概略位置", async () => {
  const hit = await geocodeAddress("新北市淡水區淡金路二段", () => null, {
    fast: true,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        features: [{
          geometry: { coordinates: [121.4467, 25.1839] },
          properties: { type: "street", city: "Tamsui", county: "New Taipei", country: "Taiwan" },
        }],
      }),
    }),
  });
  assert.equal(hit.location_class, "street");
  assert.equal(hit.lat, 25.1839);
});

test("G4 行政區或他縣同名路不能當可通知位置", async () => {
  const admin = await geocodeAddress("新北市淡水區", () => null, {
    fast: true,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        features: [{
          geometry: { coordinates: [121.44, 25.16] },
          properties: { type: "district", city: "Tamsui", county: "New Taipei", country: "Taiwan" },
        }],
      }),
    }),
  });
  assert.equal(admin == null || admin.busy || admin.location_class === "unknown", true);
  assert.equal(providerCityMatches({ city: "高雄市", district: "鳳山區" }, "臺北市", "中山區"), false);
  const listing = { address: "高雄市鳳山區中山路", lat: 25.05, lng: 121.52, geo_source: "geocode", location_class: "admin", route_kms: [8] };
  assert.equal(decideNotifyDelivery(listing, commute), "pending");
  assert.equal(decideNotifyDecision(listing, commute).reason, "admin_only");
});

test("G6 同一地址共用一次在途工作", async () => {
  resetGeoMetrics();
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        features: [{
          geometry: { coordinates: [121.44921, 25.18252] },
          properties: { type: "house", housenumber: "173", city: "New Taipei", country: "Taiwan" },
        }],
      }),
    };
  };
  const a = "新北市淡水區淡金路二段173號";
  const [left, right] = await Promise.all([
    geocodeAddress(a, () => null, { fetch, fast: true }),
    geocodeAddress(a, () => null, { fetch, fast: true }),
  ]);
  assert.equal(geoInflightKey(a), geoInflightKey(a));
  assert.equal(left.lat, right.lat);
  assert.ok(calls <= 1 || snapshotGeoMetrics().inflight_merged >= 1);
});

test("G7 第一筆 429 後面仍可用快取且不繞過限流", async () => {
  resetGeoMetrics();
  const cache = new Map();
  const fetch = async () => ({ status: 429, ok: false, json: async () => ([]) });
  const first = await geocodeAddress("臺北市士林區中山北路六段", () => null, { fetch, fast: true });
  assert.equal(first?.busy || first == null, true);
  cache.set("hit", { lat: 25.1, lng: 121.52, location_class: "street", city: "臺北市", district: "士林區" });
  const second = await geocodeAddress("臺北市士林區中山北路六段", () => cache.get("hit"), {
    fetch: async () => { throw new Error("no fetch"); },
    fast: true,
    ignoreFailCache: true,
  });
  assert.equal(second.from_cache, true);
  assert.ok(snapshotGeoMetrics().busy >= 1 || snapshotGeoMetrics().external_requests >= 1);
});

test("G8 較好結果後到，舊結果不能覆蓋", () => {
  const street = { location_class: "street", coord_version: 1, lat: 25.1, lng: 121.5 };
  const address = { location_class: "address", coord_version: 2, lat: 25.11, lng: 121.51 };
  const stale = { location_class: "street", coord_version: 1, lat: 25.09, lng: 121.49 };
  assert.equal(shouldAcceptGeoUpdate(street, address), true);
  assert.equal(shouldAcceptGeoUpdate(address, stale), false);
});

test("R3 公尺原值比較，10.001 公里不會因顯示 10.0 通過", () => {
  assert.equal(commuteMetersWithinLimit(9999, 10), true);
  assert.equal(commuteMetersWithinLimit(10000, 10), true);
  assert.equal(commuteMetersWithinLimit(10001, 10), false);
  assert.equal(passesGeoFilters({
    lat: 25.18, lng: 121.44, geo_source: "community", location_class: "community",
    route_kms: [10.001], route_min_m: 10001,
  }, commute, { strict: true }), false);
  assert.equal(passesGeoFilters({
    lat: 25.18, lng: 121.44, geo_source: "community", location_class: "community",
    route_kms: [9.999], route_min_m: 9999,
  }, commute, { strict: true }), true);
});

test("N3 路段估算開關預設關；開啟才發帶標記的通知", () => {
  const street = {
    title: "路段物件",
    kind_name: "整層住家",
    floor_name: "3F/10F",
    address: "新北市淡水區淡金路二段",
    lat: 25.18,
    lng: 121.44,
    geo_source: "geocode",
    location_class: "street",
    route_kms: [8],
    route_min_m: 8000,
  };
  const defaults = hydrateSettings({}, { notifyIncludeStreetEstimate: false, commuteKm: 10 });
  assert.equal(defaults.notifyIncludeStreetEstimate, false);
  assert.equal(notifyIncludeStreetEstimate({}), false);
  assert.equal(decideNotifyDelivery(street, commute), "pending");
  assert.equal(decideNotifyDecision(street, commute).decide, "wait_precision");
  const on = decideNotifyDecision(street, { ...commute, notifyIncludeStreetEstimate: true });
  assert.equal(on.verdict, "send");
  assert.match(on.notify_note, /依路段位置估算/);
  assert.equal(decideNotifyDelivery(street, { ...commute, notifyIncludeStreetEstimate: true }), "send");
});

test("N4 路段超距不得永久排除，精度改善後可重判", () => {
  const farStreet = {
    title: "路段物件",
    kind_name: "整層住家",
    floor_name: "3F/10F",
    address: "新北市淡水區淡金路二段",
    lat: 25.18,
    lng: 121.44,
    geo_source: "geocode",
    location_class: "street",
    route_kms: [12],
    route_min_m: 12000,
  };
  assert.equal(decideNotifyDelivery(farStreet, commute), "pending");
  assert.equal(passesGeoFilters(farStreet, commute, { strict: false }), true);
  const better = { ...farStreet, location_class: "address", route_kms: [8], route_min_m: 8000 };
  assert.equal(decideNotifyDelivery(better, commute), "send");
});

test("N2 超過六小時仍不是已送出", () => {
  const old = { created_at: new Date(Date.now() - PENDING_NOTIFY_MAX_MS - 1000).toISOString() };
  assert.equal(isStalePendingNotify(old), true);
  const streetWait = {
    title: "待定位",
    kind_name: "整層住家",
    floor_name: "3F/10F",
    address: "新北市淡水區淡金路二段173號",
    lat: null,
    lng: null,
    geo_source: "",
    route_kms: [],
  };
  assert.equal(decideNotifyDelivery(streetWait, commute), "pending");
  assert.equal(listingCanResolveNotifyGeo(streetWait), true);
});

test("N6 只有公里門檻時不等尖峰分鐘", () => {
  const ready = {
    title: "社區",
    kind_name: "整層住家",
    floor_name: "11F/14F",
    address: "新北市淡水區淡金路二段173號",
    lat: 25.18252,
    lng: 121.44921,
    geo_source: "community",
    location_class: "community",
    route_kms: [8],
    route_min_m: 8000,
  };
  assert.equal(decideNotifyDelivery(ready, { ...commute, waitRushMinutes: true }), "send");
});

test("N8 N9 通道狀態可分開且逾時記 unknown", () => {
  const accepted = mergeChannelJob({ channel: "line", job_state: "accepted" }, { job_state: "retry" });
  assert.equal(accepted.job_state, "accepted");
  const unknown = mergeChannelJob({ channel: "line" }, { job_state: "unknown" });
  assert.equal(unknown.job_state, "unknown");
  assert.match(unknown.fail_reason, /timeout/);
  assert.equal(eventFullyHandled([
    { job_state: "accepted" },
    { job_state: "retry" },
  ]), false);
  assert.equal(eventFullyHandled([
    { job_state: "accepted" },
    { job_state: "skipped" },
  ]), true);
  assert.equal(eventFullyHandled([{ job_state: "legacy_handled_unknown" }]), true);
});

test("公司座標只沿用台灣範圍，客戶端精度不能升級", () => {
  const current = {
    workAddress: "新北市淡水區淡金路二段173號",
    workLat: 25.18252,
    workLng: 121.44921,
    workLocationClass: "street",
    commuteKm: 10,
  };
  const reuse = resolveWorkPointForSave(current, {
    workAddress: current.workAddress,
    commuteKm: 10,
  });
  assert.equal(reuse.reuse, true);
  assert.equal(reuse.workLocationClass, "street");

  const forged = resolveWorkPointForSave({
    ...current,
    workLat: 40.7,
    workLng: -74.0,
    workLocationClass: "source",
  }, { workAddress: current.workAddress, commuteKm: 10 });
  assert.equal(forged.needsGeocode, true);

  const switched = resolveWorkPointForSave(current, {
    workAddress: "高雄市鳳山區中山路12-1號",
    commuteKm: 0,
  });
  assert.equal(switched.dropClientCoords, true);
  assert.equal(switched.workLat, null);

  const patched = applySettingPatch(current, { workLocationClass: "not-a-class" });
  assert.equal(patched.workLocationClass, "");
  const kept = applySettingPatch(current, { notifyNew: false });
  assert.equal(kept.workLocationClass, "street");
});

test("U 文案區分等待、概略與行政區，不靠 hover", () => {
  assert.equal(commutePrecisionText({ location_class: "unknown", commute_state: "wait_geo" }), "等待定位");
  assert.equal(commutePrecisionText({ geo_job_state: "querying" }), "正在查詢位置");
  assert.match(commutePrecisionText({ location_class: "street" }, null), /概略位置/);
  assert.match(commutePrecisionText({ location_class: "street" }, 8.2), /到公司約 8.2 公里/);
  assert.equal(commutePrecisionText({ location_class: "source" }, 7.4), "到公司約 7.4 公里");
  assert.equal(commutePrecisionText({ location_class: "community" }, 8), "到公司約 8 公里");
  assert.doesNotMatch(commutePrecisionText({ location_class: "source" }, 7.4), /依來源地圖/);
  assert.doesNotMatch(commutePrecisionText({ location_class: "community" }, 8), /依社區位置/);
  assert.match(commutePrecisionText({ location_class: "admin" }), /行政區/);
  assert.match(commutePrecisionText({ geo_error: "busy", commute_state: "retry" }), /暫時忙碌/);
});
