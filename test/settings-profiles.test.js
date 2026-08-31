import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySettingPatch,
  hydrateSettings,
  normalizeProfiles,
  parseSettingRows,
  snapshotSettings,
} from "../src/settingsState.js";

const defaults = {
  searchUrls: ["https://rent.591.com.tw/list?region=1&section=5"],
  settingProfiles: [],
  activeProfileId: "",
  watchDistricts: [],
  priceMin: 0,
  priceMax: 36000,
  commuteKm: 12,
  workAddress: "台北市士林區德行西路7號",
  notifyNew: true,
};

test("corrupt settings rows do not wipe the rest", () => {
  const stored = parseSettingRows([
    { key: "workAddress", value: '"台北市士林區德行西路7號"' },
    { key: "commuteKm", value: "not-json" },
    { key: "settingProfiles", value: "[{]" },
  ]);
  assert.equal(stored.workAddress, "台北市士林區德行西路7號");
  assert.equal(stored.commuteKm, undefined);
  assert.equal(stored.settingProfiles, undefined);
});

test("saved profiles stay in the list after hydrate", () => {
  const stored = {
    settingProfiles: [{ id: "p-1", name: "士林北投", data: { commuteKm: 12 } }],
    activeProfileId: "p-1",
    watchDistricts: ["1-8"],
  };
  const next = hydrateSettings(stored, defaults);
  assert.equal(next.settingProfiles.length, 1);
  assert.equal(next.settingProfiles[0].name, "士林北投");
  assert.equal(next.activeProfileId, "p-1");
});

test("saving without settingProfiles keeps existing profiles", () => {
  const current = hydrateSettings(
    {
      settingProfiles: [{ id: "p-1", name: "士林北投", data: {} }],
      activeProfileId: "p-1",
      watchDistricts: ["1-8", "1-9"],
      workAddress: "台北市士林區德行西路7號",
      commuteKm: 12,
    },
    defaults,
  );
  const next = applySettingPatch(current, { commuteKm: 10, watchDistricts: ["1-8"] });
  assert.equal(next.settingProfiles.length, 1);
  assert.equal(next.settingProfiles[0].name, "士林北投");
  assert.equal(next.commuteKm, 10);
});

test("empty settingProfiles patch cannot sneak in via unrelated save", () => {
  const current = {
    ...defaults,
    settingProfiles: normalizeProfiles([{ id: "p-1", name: "士林北投", data: {} }]),
    activeProfileId: "p-1",
    watchDistricts: ["1-8"],
  };
  const next = applySettingPatch(current, { notifyNew: false });
  assert.equal(next.settingProfiles.length, 1);
  assert.equal(next.notifyNew, false);
});

test("full form save updates the active profile snapshot", () => {
  const current = hydrateSettings(
    {
      settingProfiles: [{ id: "p-1", name: "士林北投", data: { commuteKm: 12 } }],
      activeProfileId: "p-1",
      watchDistricts: ["1-8"],
      commuteKm: 12,
    },
    defaults,
  );
  const next = applySettingPatch(current, {
    watchDistricts: ["1-8", "1-9"],
    commuteKm: 10,
    notifyNew: true,
  });
  assert.equal(next.settingProfiles.length, 1);
  assert.deepEqual(next.settingProfiles[0].data.watchDistricts, ["1-8", "1-9"]);
  assert.equal(next.settingProfiles[0].data.commuteKm, 10);
});

test("snapshot keeps commute and districts for a profile", () => {
  const snap = snapshotSettings({
    watchDistricts: ["1-8", "3-50"],
    commuteKm: 12,
    workAddress: "台北市士林區德行西路7號",
    notifyNew: true,
  });
  assert.deepEqual(snap.watchDistricts, ["1-8", "3-50"]);
  assert.equal(snap.commuteKm, 12);
  assert.equal(snap.workAddress, "台北市士林區德行西路7號");
});

test("notifyMatrix hydrates defaults and preserves unchecks", () => {
  const hydrated = hydrateSettings({ webhookNotifyNew: false }, defaults);
  assert.equal(hydrated.notifyMatrix.new.webhook, false);
  assert.equal(hydrated.notifyMatrix.new.dock, true);
  const next = applySettingPatch(hydrated, {
    watchDistricts: ["1-8"],
    notifyMatrix: {
      new: { dock: true, webhook: false },
      update: { dock: false, webhook: true },
    },
  });
  assert.equal(next.notifyMatrix.new.webhook, false);
  assert.equal(next.notifyMatrix.update.dock, false);
  assert.equal(next.notifyMatrix.update.webhook, true);
  assert.equal(next.notifyMatrix.price.dock, true);
  assert.equal(next.webhookNotifyNew, false);
});
