import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAPS_SKU,
  nextWeekdayTaipeiUnix,
  rushStale,
  secondsToMinutes,
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

test("summarize splits today, this month, and lifetime with per-month free caps", () => {
  const now = Date.parse("2026-09-02T04:00:00Z");
  const usage = summarizeMapsUsage([
    { day: "2026-08-31", essentials: 12000, advanced: 6000 },
    { day: "2026-09-01", essentials: 10, advanced: 20 },
    { day: "2026-09-02", essentials: 3, advanced: 4 },
  ], { now });
  assert.equal(usage.today, "2026-09-02");
  assert.equal(usage.month, "2026-09");
  assert.equal(usage.todayEssentials, 3);
  assert.equal(usage.todayAdvanced, 4);
  assert.equal(usage.monthEssentials, 13);
  assert.equal(usage.monthAdvanced, 24);
  assert.equal(usage.monthUsd, 0);
  assert.equal(usage.lifetimeUsd, 20);
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
