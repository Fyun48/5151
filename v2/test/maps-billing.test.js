import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAPS_SKU,
  bindGoogleDirectionsEnabled,
  googleDirectionsAllowed,
  isBillableDirectionsStatus,
  isGoogleDirectionsEnabled,
  mapsAdminWarning,
  nextWeekdayTaipeiUnix,
  pacificYmd,
  rushStale,
  secondsToMinutes,
  skuCostBreakdown,
  skuUsd,
  summarizeMapsUsage,
  taipeiYmd,
} from "../src/mapsBilling.js";

test("free monthly caps keep estimated cost at zero", () => {
  assert.equal(skuUsd(4999, MAPS_SKU.advanced), 0);
  assert.equal(skuUsd(5000, MAPS_SKU.advanced), 0);
  assert.equal(skuUsd(5500, MAPS_SKU.advanced), 5);
  assert.equal(skuUsd(10000, MAPS_SKU.essentials), 0);
  assert.equal(skuUsd(12000, MAPS_SKU.essentials), 10);
});

test("official volume tiers match Google's Directions price list", () => {
  assert.equal(skuUsd(100000, MAPS_SKU.essentials), 450);
  assert.equal(skuUsd(100001, MAPS_SKU.essentials), 450);
  assert.equal(skuUsd(101000, MAPS_SKU.essentials), 454);
  assert.equal(skuUsd(12135, MAPS_SKU.advanced), 71.35);
  const sheet = skuCostBreakdown(12135, MAPS_SKU.advanced);
  assert.equal(sheet.billable, 7135);
  assert.equal(sheet.lines[0].usd, 0);
  assert.equal(sheet.lines[1].usd, 71.35);
});

test("summarize uses Pacific billing month, not Taipei calendar day", () => {
  const now = Date.parse("2026-09-02T04:00:00Z");
  assert.equal(pacificYmd(now), "2026-09-01");
  const usage = summarizeMapsUsage([
    { day: "2026-08-31", essentials: 12000, advanced: 6000 },
    { day: "2026-09-01", essentials: 10, advanced: 20 },
    { day: "2026-09-02", essentials: 3, advanced: 4 },
  ], { now });
  assert.equal(usage.today, "2026-09-01");
  assert.equal(usage.month, "2026-09");
  assert.equal(usage.billingTz, "America/Los_Angeles");
  assert.equal(usage.todayEssentials, 10);
  assert.equal(usage.todayAdvanced, 20);
  assert.equal(usage.monthEssentials, 10);
  assert.equal(usage.monthAdvanced, 20);
  assert.equal(usage.monthUsd, 0);
  assert.equal(usage.lifetimeUsd, 20);
});

test("billable Directions events are only successful responses", () => {
  assert.equal(isBillableDirectionsStatus("OK"), true);
  assert.equal(isBillableDirectionsStatus("ZERO_RESULTS"), true);
  assert.equal(isBillableDirectionsStatus("REQUEST_DENIED"), false);
  assert.equal(isBillableDirectionsStatus("OVER_QUERY_LIMIT"), false);
});

test("next Tuesday rush time is in the future and in Taipei morning/evening", () => {
  const now = Date.parse("2026-09-01T00:00:00Z");
  const am = nextWeekdayTaipeiUnix(8, 15, { now, weekday: 2 });
  const pm = nextWeekdayTaipeiUnix(18, 15, { now, weekday: 2 });
  assert.ok(am * 1000 > now);
  assert.ok(pm > am);
  const amTaipei = new Date(am * 1000 + 8 * 3600 * 1000);
  assert.equal(amTaipei.getUTCDay(), 2);
  assert.equal(amTaipei.getUTCHours(), 8);
  assert.equal(amTaipei.getUTCMinutes(), 15);
});

test("rush cache is stale after 14 days", () => {
  const now = Date.parse("2026-09-16T00:00:00Z");
  assert.equal(rushStale("2026-09-01T00:00:00.000Z", now), true);
  assert.equal(rushStale("2026-09-10T00:00:00.000Z", now), false);
  assert.equal(secondsToMinutes(1679), 28);
  assert.equal(taipeiYmd(Date.parse("2026-09-01T16:30:00Z")), "2026-09-02");
});

test("Google Directions stays off unless the admin switch is explicitly true", () => {
  const prev = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "fake-key";
  try {
    assert.equal(isGoogleDirectionsEnabled(undefined), false);
    assert.equal(isGoogleDirectionsEnabled(false), false);
    assert.equal(isGoogleDirectionsEnabled(true), true);
    bindGoogleDirectionsEnabled(() => false);
    assert.equal(googleDirectionsAllowed(), false);
    bindGoogleDirectionsEnabled(() => true);
    assert.equal(googleDirectionsAllowed(), true);
  } finally {
    bindGoogleDirectionsEnabled(() => false);
    if (prev == null) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = prev;
  }
});

test("admin warning explains OSRM fallback when Google is off", () => {
  assert.match(mapsAdminWarning({ googleEnabled: false, hasKey: true, rushEnabled: true }), /金鑰仍保留/);
  assert.match(mapsAdminWarning({ googleEnabled: false, hasKey: false }), /OSRM/);
  assert.match(mapsAdminWarning({ googleEnabled: true, hasKey: false }), /還沒有金鑰/);
  assert.match(mapsAdminWarning({ googleEnabled: true, hasKey: true, rushEnabled: true }), /含路況/);
});
