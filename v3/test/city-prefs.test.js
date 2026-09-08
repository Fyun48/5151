import { test } from "node:test";
import assert from "node:assert/strict";
import { applySettingPatch, hydrateSettings } from "../src/settingsState.js";
import {
  hideCitySelection,
  hiddenCities,
  restoreCitySelection,
  visibleCities,
} from "../src/cityPrefs.js";

const defaults = {
  searchUrls: [],
  settingProfiles: [],
  activeProfileId: "",
  watchDistricts: ["1-8", "3-50"],
  hiddenCityIds: [],
  priceMin: 0,
  priceMax: 36000,
};

test("hiding a city unchecks its districts but does not delete city master data", () => {
  const next = hideCitySelection(defaults, 1);
  assert.ok(next.hiddenCityIds.includes(1));
  assert.equal(next.watchDistricts.includes("1-8"), false);
  assert.equal(next.watchDistricts.includes("3-50"), true);
  assert.ok(next.removedDistricts.includes("1-8"));
  assert.equal(visibleCities(next.hiddenCityIds).some((city) => city.id === 1), false);
  assert.equal(hiddenCities(next.hiddenCityIds).some((city) => city.id === 1), true);
  assert.ok(visibleCities([]).some((city) => city.id === 1));
});

test("restoring a city only unhides it and keeps remaining districts", () => {
  const hidden = hideCitySelection(defaults, 1);
  const restored = restoreCitySelection(hidden, 1);
  assert.equal(restored.hiddenCityIds.includes(1), false);
  assert.deepEqual(restored.watchDistricts, hidden.watchDistricts);
});

test("hydrate and patch keep hiddenCityIds on the active profile snapshot", () => {
  const stored = hydrateSettings({
    ...defaults,
    hiddenCityIds: [3],
    settingProfiles: [{ id: "p-1", name: "淡水", data: { watchDistricts: ["3-50"] } }],
    activeProfileId: "p-1",
  }, defaults);
  assert.deepEqual(stored.hiddenCityIds, [3]);
  const patched = applySettingPatch(stored, { hiddenCityIds: [1, 1, 99], watchDistricts: ["1-8"] });
  assert.deepEqual(patched.hiddenCityIds, [1]);
  const snap = patched.settingProfiles.find((item) => item.id === "p-1")?.data;
  assert.deepEqual(snap.hiddenCityIds, [1]);
});
