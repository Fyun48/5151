import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateMrtAccess,
  estimateMrtAccessForPoint,
  fetchMrtAccess,
  formatMrtAccess,
  isWalkableMrtDistance,
  makeMrtKey,
  nearbyWalkMrtStations,
  nearestMrtStation,
} from "../src/mrt.js";
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
});

test("walkable MRT distance is under 1.5 km exclusive", () => {
  assert.equal(isWalkableMrtDistance(1.4), true);
  assert.equal(isWalkableMrtDistance(1.5), false);
  assert.equal(isWalkableMrtDistance(1.6), false);
  assert.equal(isWalkableMrtDistance(0), false);
});

test("nearby walk candidates skip stations at or beyond 1.5 km straight-line", () => {
  const near = nearbyWalkMrtStations(25.05781, 121.6184);
  assert.ok(near.some((row) => row.name === "南港展覽館"));
  assert.ok(near.every((row) => row.straightKm < 1.5));
});

test("formatMrtAccess shows only station and walking kilometers", () => {
  const text = formatMrtAccess({
    station: "南港展覽館",
    walk_km: 0.5,
    walk_min: 7,
    ride_km: 0.6,
    ride_min: 2,
  });
  assert.equal(text, "捷運南港展覽館站 · 步行約 0.5 公里");
  assert.doesNotMatch(text, /分/);
  assert.doesNotMatch(text, /騎車/);
  assert.equal(formatMrtAccess({ station: "南港展覽館", walk_km: 1.5 }), "");
  assert.equal(makeMrtKey(25.05781, 121.6184), "25.05781,121.6184");
});

test("fetchMrtAccess uses walking map routes and hides 1.5 km and farther", async () => {
  const calls = [];
  const access = await fetchMrtAccess(25.05781, 121.6184, {
    routeWalk: async (fromLat, fromLng, toLat, toLng) => {
      calls.push({ fromLat, fromLng, toLat, toLng });
      return { km: 0.8 };
    },
  });
  assert.ok(calls.length >= 1);
  assert.equal(access.station, "南港展覽館");
  assert.equal(access.walk_km, 0.8);
  assert.equal(access.ride_km, null);
  assert.equal(access.too_far, false);

  const far = await fetchMrtAccess(25.05781, 121.6184, {
    routeWalk: async () => ({ km: 1.5 }),
  });
  assert.equal(far.station, "");
  assert.equal(far.too_far, true);
  assert.equal(formatMrtAccess(far), "");

  const none = await fetchMrtAccess(24.9, 121.35, {
    routeWalk: async () => {
      throw new Error("should not route");
    },
  });
  assert.equal(none.too_far, true);
  assert.equal(none.station, "");
});

test("fetchMrtAccess picks the shortest walking route among nearby stations", async () => {
  const access = await fetchMrtAccess(25.05781, 121.6184, {
    routeWalk: async (_a, _b, toLat) => ({ km: Number(toLat) > 25.05 ? 1.2 : 0.4 }),
  });
  assert.ok(access.walk_km <= 1.2);
  assert.ok(isWalkableMrtDistance(access.walk_km));
  assert.ok(access.station);
});
