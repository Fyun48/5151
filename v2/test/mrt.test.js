import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateMrtAccess, estimateMrtAccessForPoint, formatMrtAccess, makeMrtKey, nearestMrtStation } from "../src/mrt.js";
import { MRT_STATIONS } from "../src/mrtStations.js";

test("MRT station list has unique names and valid coordinates", () => {
  const names = new Set();
  assert.ok(MRT_STATIONS.length > 80);
  for (const [name, lat, lng] of MRT_STATIONS) {
    assert.equal(names.has(name), false, name);
    names.add(name);
    assert.ok(lat > 24.8 && lat < 25.3, name);
    assert.ok(lng > 121.3 && lng < 121.7, name);
  }
});

test("nearest station for Nangang exhibition area is 南港展覽館", () => {
  const row = nearestMrtStation(25.05781, 121.6184);
  assert.equal(row.name, "南港展覽館");
  assert.ok(row.straightKm < 0.5);
});

test("nearest station for Shilin Dexing is 芝山 or 士林", () => {
  const row = nearestMrtStation(25.10628, 121.52419);
  assert.ok(["芝山", "士林", "明德"].includes(row.name), row.name);
});

test("estimated walk is a bit longer than the straight line", () => {
  const est = estimateMrtAccess(0.5);
  assert.equal(est.walk_km, 0.6);
  assert.equal(est.ride_km, 0.6);
  assert.ok(est.walk_min >= 7);
  assert.ok(est.ride_min >= 2);
});

test("estimateMrtAccessForPoint returns the nearest station and route-like distances", () => {
  const row = estimateMrtAccessForPoint(25.05781, 121.6184);
  assert.equal(row.station, "南港展覽館");
  assert.ok(row.walk_km > 0);
  assert.ok(row.ride_km > 0);
  assert.ok(row.walk_min >= 1);
  assert.ok(row.ride_min >= 1);
  assert.match(formatMrtAccess(row), /捷運南港展覽館站/);
});

test("formatMrtAccess shows walk and ride", () => {
  const text = formatMrtAccess({
    station: "南港展覽館",
    walk_km: 0.5,
    walk_min: 7,
    ride_km: 0.6,
    ride_min: 2,
  });
  assert.match(text, /捷運南港展覽館站/);
  assert.match(text, /走路 0.5 公里（7 分）/);
  assert.match(text, /騎車 0.6 公里（2 分）/);
  assert.equal(makeMrtKey(25.05781, 121.6184), "25.05781,121.6184");
});
