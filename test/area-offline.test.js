import { test } from "node:test";
import assert from "node:assert/strict";
import { passesAttributeFilters } from "../src/floors.js";
import {
  daysSince,
  shouldConfirmOffline,
  shouldRecheckOffline,
  normalizeOfflineConfirmDays,
} from "../src/offline.js";
import { applySettingPatch } from "../src/settingsState.js";

const attrs = {
  wholeFloorOnly: false,
  excludeLowFloors: false,
  minBuildingFloors: 0,
};

test("hides listings larger than areaMax ping", () => {
  const listing = { kind_name: "整層住家", floor_name: "5F/12F", area_name: "40坪" };
  assert.equal(passesAttributeFilters(listing, { ...attrs, areaMax: 30 }), false);
  assert.equal(passesAttributeFilters(listing, { ...attrs, areaMax: 40 }), true);
  assert.equal(passesAttributeFilters(listing, { ...attrs, areaMax: 0 }), true);
});

test("keeps listings with unknown ping when areaMax is set", () => {
  const listing = { kind_name: "整層住家", floor_name: "5F/12F", area_name: "" };
  assert.equal(passesAttributeFilters(listing, { ...attrs, areaMax: 30 }), true);
});

test("confirms offline after 7 days from first not-found", () => {
  const now = new Date("2026-08-31T00:00:00.000Z");
  const listing = {
    offline: 1,
    offline_confirmed: 0,
    offline_at: "2026-08-24T00:00:00.000Z",
    last_checked_at: "2026-08-30T00:00:00.000Z",
  };
  assert.equal(shouldConfirmOffline(listing, { days: 7, now }), true);
  assert.equal(shouldRecheckOffline(listing, { days: 7, now }), false);
});

test("rechecks unconfirmed offline after 12 hours, not before", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");
  const listing = {
    offline: 1,
    offline_confirmed: 0,
    offline_at: "2026-08-24T00:00:00.000Z",
    last_checked_at: "2026-08-25T00:00:00.000Z",
  };
  assert.equal(shouldConfirmOffline(listing, { days: 7, now }), false);
  assert.equal(shouldRecheckOffline(listing, { hours: 12, days: 7, now }), true);
  assert.equal(
    shouldRecheckOffline(
      { ...listing, last_checked_at: "2026-08-25T06:00:00.000Z" },
      { hours: 12, days: 7, now },
    ),
    false,
  );
});

test("does not recheck once confirmed", () => {
  const now = new Date("2026-08-31T00:00:00.000Z");
  const listing = {
    offline: 1,
    offline_confirmed: 1,
    offline_at: "2026-08-20T00:00:00.000Z",
    last_checked_at: "2026-08-20T00:00:00.000Z",
  };
  assert.equal(shouldConfirmOffline(listing, { days: 7, now }), false);
  assert.equal(shouldRecheckOffline(listing, { days: 7, now }), false);
});

test("offlineConfirmDays defaults to 7", () => {
  assert.equal(normalizeOfflineConfirmDays(0), 7);
  assert.equal(normalizeOfflineConfirmDays(""), 7);
  assert.equal(normalizeOfflineConfirmDays(7), 7);
  assert.equal(normalizeOfflineConfirmDays(40), 30);
  assert.equal(daysSince("2026-08-24T00:00:00.000Z", new Date("2026-08-31T00:00:00.000Z")), 7);
});

test("saving areaMax and offlineConfirmDays keeps valid ranges", () => {
  const next = applySettingPatch(
    { watchDistricts: [], searchUrls: [], settingProfiles: [], activeProfileId: "" },
    { areaMax: 30.4, offlineConfirmDays: 7 },
  );
  assert.equal(next.areaMax, 30.4);
  assert.equal(next.offlineConfirmDays, 7);
  const clamped = applySettingPatch(next, { areaMax: -1, offlineConfirmDays: 0 });
  assert.equal(clamped.areaMax, 0);
  assert.equal(clamped.offlineConfirmDays, 7);
});
