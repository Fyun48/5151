import { test } from "node:test";
import assert from "node:assert/strict";
import { commuteModeLabel, normalizeCommuteMode } from "../src/geo.js";
import { makeRouteKey } from "../src/route.js";

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
