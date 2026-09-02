import { test } from "node:test";
import assert from "node:assert/strict";
import { commuteModeLabel, normalizeCommuteMode } from "../src/geo.js";
import { fetchRoadRoutes, fetchRushRoadRoutes, makeRouteKey } from "../src/route.js";
import { bindGoogleDirectionsEnabled } from "../src/mapsBilling.js";

test("commute mode is scooter unless the user picks car", () => {
  assert.equal(normalizeCommuteMode(undefined), "scooter");
  assert.equal(normalizeCommuteMode(""), "scooter");
  assert.equal(normalizeCommuteMode("bike"), "scooter");
  assert.equal(normalizeCommuteMode("car"), "car");
  assert.equal(commuteModeLabel("scooter"), "機車");
  assert.equal(commuteModeLabel("car"), "汽車");
});

test("car and scooter routes keep separate cache keys", () => {
  const scooter = makeRouteKey(25.05, 121.52, 25.06, 121.61);
  const car = makeRouteKey(25.05, 121.52, 25.06, 121.61, "car");
  assert.equal(scooter, "25.05,121.52>25.06,121.61");
  assert.equal(car, "car:25.05,121.52>25.06,121.61");
  assert.notEqual(scooter, car);
  assert.equal(makeRouteKey(25.05, 121.52, 25.06, 121.61, "scooter"), scooter);
});

test("fetchRoadRoutes does not call Google when the admin switch is off", async () => {
  const prevKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "fake-key";
  bindGoogleDirectionsEnabled(() => false);
  const urls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: "Ok", routes: [{ distance: 4200 }] }),
    };
  };
  try {
    const distances = await fetchRoadRoutes(25.05, 121.52, 25.06, 121.61);
    assert.deepEqual(distances, [4.2]);
    assert.equal(urls.some((url) => url.includes("maps.googleapis.com")), false);
    assert.equal(urls.some((url) => url.includes("router.project-osrm.org")), true);
    assert.equal(await fetchRushRoadRoutes(25.05, 121.52, 25.06, 121.61), null);
    assert.equal(urls.some((url) => url.includes("maps.googleapis.com")), false);
  } finally {
    globalThis.fetch = orig;
    bindGoogleDirectionsEnabled(() => false);
    if (prevKey == null) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = prevKey;
  }
});

test("fetchRoadRoutes always uses OSRM, even if the Google switch is on", async () => {
  const prevKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "fake-key";
  bindGoogleDirectionsEnabled(() => true);
  const urls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("maps.googleapis.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "OK",
          routes: [{ legs: [{ distance: { value: 5100 }, duration: { value: 720 } }] }],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: "Ok", routes: [{ distance: 4200 }] }),
    };
  };
  try {
    const distances = await fetchRoadRoutes(25.05, 121.52, 25.06, 121.61);
    assert.deepEqual(distances, [4.2]);
    assert.equal(urls.some((url) => url.includes("maps.googleapis.com")), false);
    assert.equal(urls.some((url) => url.includes("router.project-osrm.org")), true);
    urls.length = 0;
    const rush = await fetchRushRoadRoutes(25.05, 121.52, 25.06, 121.61);
    assert.equal(rush?.distances?.[0], 5.1);
    assert.equal(urls.filter((url) => url.includes("maps.googleapis.com/maps/api/directions")).length, 2);
  } finally {
    globalThis.fetch = orig;
    bindGoogleDirectionsEnabled(() => false);
    if (prevKey == null) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = prevKey;
  }
});
