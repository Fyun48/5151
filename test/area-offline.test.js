import { test } from "node:test";
import assert from "node:assert/strict";
import { passesAttributeFilters } from "../src/floors.js";
import {
  countsTowardAllTotal,
  daysSince,
  isConfirmedOffline,
  isPendingOffline,
  shouldConfirmOffline,
  shouldRecheckOffline,
  normalizeOfflineConfirmDays,
} from "../src/offline.js";
import { applySettingPatch } from "../src/settingsState.js";

const attrs = {
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

test("wholeFloorOnly and excludeLowFloors are view-only, not attribute filters", () => {
  const suite = { kind_name: "套房", floor_name: "2F/5F" };
  const low = { kind_name: "整層住家", floor_name: "1F/4F" };
  assert.equal(passesAttributeFilters(suite, attrs), true);
  assert.equal(passesAttributeFilters(low, attrs), true);
});

test("display filters hide suites and 1F for notify/list preferences", async () => {
  const { passesDisplayFilters } = await import("../src/floors.js");
  const suite = { kind_name: "套房", floor_name: "2F/5F" };
  const low = { kind_name: "整層住家", floor_name: "1F/4F" };
  const ok = { kind_name: "整層住家", floor_name: "3F/5F" };
  const prefs = { wholeFloorOnly: true, excludeLowFloors: true };
  assert.equal(passesDisplayFilters(suite, prefs), false);
  assert.equal(passesDisplayFilters(low, prefs), false);
  assert.equal(passesDisplayFilters(ok, prefs), true);
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

test("pending offline count excludes confirmed listings and live ones", () => {
  const live = { hidden: 0, watched: 0, offline: 0, offline_confirmed: 0, match_verdict: "" };
  const pending = { ...live, offline: 1, offline_confirmed: 0 };
  const confirmed = { ...live, offline: 1, offline_confirmed: 1 };
  const rows = [live, pending, pending, confirmed];
  assert.equal(rows.filter(isPendingOffline).length, 2);
  assert.equal(rows.filter(isConfirmedOffline).length, 1);
  assert.equal(isPendingOffline(confirmed), false);
});

test("confirmed offline is deducted from the All total", () => {
  const live = { hidden: 0, watched: 0, offline: 0, offline_confirmed: 0, match_verdict: "" };
  assert.equal(countsTowardAllTotal(live), true);
  assert.equal(countsTowardAllTotal({ ...live, offline: 1, offline_confirmed: 0 }), false);
  assert.equal(countsTowardAllTotal({ ...live, offline: 1, offline_confirmed: 1 }), false);
  assert.equal(countsTowardAllTotal({ ...live, watched: 1 }), false);
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
