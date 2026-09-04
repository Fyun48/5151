import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySettingPatch,
  hydrateSettings,
  normalizeProfiles,
  parseSettingRows,
  snapshotSettings,
  canAddProfile,
  limitWatchDistricts,
  resolveSaveAsProfileAction,
  MEMBER_MAX_PROFILE_DISTRICTS,
  MEMBER_MAX_PROFILES,
} from "../src/settingsState.js";
import { coveringJobsFromSettings } from "../src/covering.js";

const defaults = {
  searchUrls: ["https://rent.591.com.tw/list?region=1&section=5"],
  settingProfiles: [],
  activeProfileId: "",
  watchDistricts: [],
  priceMin: 0,
  priceMax: 36000,
  commuteKm: 12,
  workAddress: "新北市淡水區淡金路二段173號",
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

test("notify and floor prefs write into the active profile snapshot", () => {
  const current = hydrateSettings(
    {
      settingProfiles: [{ id: "p-1", name: "士林北投", data: { wholeFloorOnly: true, commuteKm: 12 } }],
      activeProfileId: "p-1",
      watchDistricts: ["1-8"],
      wholeFloorOnly: true,
    },
    defaults,
  );
  const next = applySettingPatch(current, {
    wholeFloorOnly: false,
    excludeLowFloors: false,
    notifyMatrix: { new: { dock: true, push: false, webhook: false, mail: false } },
  });
  assert.equal(next.wholeFloorOnly, false);
  assert.equal(next.excludeLowFloors, false);
  assert.equal(next.settingProfiles[0].data.wholeFloorOnly, false);
  assert.equal(next.settingProfiles[0].data.excludeLowFloors, false);
  assert.equal(next.settingProfiles[0].data.notifyMatrix.new.push, false);
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
    commuteMode: "car",
    workAddress: "台北市士林區德行西路7號",
    notifyNew: true,
  });
  assert.deepEqual(snap.watchDistricts, ["1-8", "3-50"]);
  assert.equal(snap.commuteKm, 12);
  assert.equal(snap.commuteMode, "car");
  assert.equal(snap.workAddress, "台北市士林區德行西路7號");
});

test("commuteMode is scooter or car only", () => {
  const next = applySettingPatch(
    { ...defaults, watchDistricts: ["1-8"] },
    { commuteMode: "bike", commuteKm: 25 },
  );
  assert.equal(next.commuteMode, "scooter");
  const car = applySettingPatch(next, { commuteMode: "car" });
  assert.equal(car.commuteMode, "car");
});

test("member work address is not rewritten to the guest demo template", () => {
  const stored = {
    watchDistricts: ["1-8"],
    workAddress: "台北市士林區德行西路7號",
    commuteKm: 13,
    workLat: 25.106,
    workLng: 121.524,
  };
  const next = hydrateSettings(stored, defaults);
  assert.equal(next.workAddress, "台北市士林區德行西路7號");
  assert.equal(next.commuteKm, 13);
  assert.equal(next.workLat, 25.106);
  assert.equal(next.workLng, 121.524);
  const patched = applySettingPatch(next, { notifyNew: false });
  assert.equal(patched.workAddress, "台北市士林區德行西路7號");
  assert.equal(patched.commuteKm, 13);
});

test("null or zero work coords stay missing", () => {
  const cleared = applySettingPatch(
    { ...defaults, watchDistricts: ["1-8"], workLat: 25.1, workLng: 121.5 },
    { workLat: null, workLng: null, commuteKm: 12 },
  );
  assert.equal(cleared.workLat, null);
  assert.equal(cleared.workLng, null);
  const zero = applySettingPatch(
    { ...defaults, watchDistricts: ["1-8"] },
    { workLat: 0, workLng: 0, commuteKm: 8 },
  );
  assert.equal(zero.workLat, null);
  assert.equal(zero.workLng, null);
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
  assert.equal(next.notifyMatrix.new.mail, false);
  assert.equal(next.notifyMatrix.new.push, true);
  assert.equal(next.webhookNotifyNew, false);
});

test("members are capped at 10 districts and 3 profiles; admins are not", () => {
  const many = ["1-8", "1-9", "1-2", "1-3", "1-4", "1-5", "1-7", "1-10", "1-11", "1-1", "1-6", "1-12"];
  assert.equal(many.length, 12);
  assert.equal(limitWatchDistricts(many).length, MEMBER_MAX_PROFILE_DISTRICTS);
  assert.equal(limitWatchDistricts(many, { admin: true }).length, 12);
  const hydrated = hydrateSettings({ watchDistricts: many }, defaults);
  assert.equal(hydrated.watchDistricts.length, MEMBER_MAX_PROFILE_DISTRICTS);
  const asAdmin = hydrateSettings({ watchDistricts: many }, defaults, { admin: true });
  assert.equal(asAdmin.watchDistricts.length, 12);
  const patched = applySettingPatch(
    { ...defaults, watchDistricts: ["1-8"] },
    { watchDistricts: many },
  );
  assert.equal(patched.watchDistricts.length, MEMBER_MAX_PROFILE_DISTRICTS);
  const adminPatched = applySettingPatch(
    { ...defaults, watchDistricts: ["1-8"] },
    { watchDistricts: many },
    { admin: true },
  );
  assert.equal(adminPatched.watchDistricts.length, 12);
  assert.equal(canAddProfile(new Array(MEMBER_MAX_PROFILES).fill({ id: "x" })), false);
  assert.equal(canAddProfile(new Array(MEMBER_MAX_PROFILES).fill({ id: "x" }), { admin: true }), true);
  assert.equal(hydrated.watchDistricts.includes("1-12"), false);
  const section = new URL(hydrated.searchUrls[0]).searchParams.get("section") || "";
  assert.equal(section.split(",").includes("12"), false);
  assert.equal(section.split(",").length, MEMBER_MAX_PROFILE_DISTRICTS);
  const jobs = coveringJobsFromSettings(hydrated);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sectionIds.includes(12), false);
  assert.equal(jobs[0].sectionIds.length, MEMBER_MAX_PROFILE_DISTRICTS);
});

test("save-as resolves overwrite, create, and full without adding a fourth slot", () => {
  const full = [
    { id: "p-1", name: "蘆洲" },
    { id: "p-2", name: "五股" },
    { id: "p-3", name: "三重" },
  ];
  assert.equal(resolveSaveAsProfileAction([], "").action, "empty");
  assert.equal(resolveSaveAsProfileAction(full.slice(0, 1), "士林").action, "create");
  assert.equal(resolveSaveAsProfileAction(full, "士林").action, "full");
  assert.equal(resolveSaveAsProfileAction(full, "士林", { admin: true }).action, "create");
  assert.equal(resolveSaveAsProfileAction(full, "蘆洲").action, "confirm_overwrite");
  const overwrite = resolveSaveAsProfileAction(full, " 蘆洲 ", { overwrite: true });
  assert.equal(overwrite.action, "overwrite");
  assert.equal(overwrite.existing.id, "p-1");
  assert.equal(resolveSaveAsProfileAction(full, "蘆洲", { overwrite: true }).action, "overwrite");
});

test("members cannot change interval, pages, or offline days; admins can", () => {
  const stored = {
    watchDistricts: ["1-8"],
    intervalMinutes: 2,
    pagesPerWatch: 10,
    offlineConfirmDays: 14,
  };
  const memberHydrated = hydrateSettings(stored, defaults);
  assert.equal(memberHydrated.intervalMinutes, 8);
  assert.equal(memberHydrated.pagesPerWatch, 40);
  assert.equal(memberHydrated.offlineConfirmDays, 7);

  const sponsorHydrated = hydrateSettings(stored, defaults, { plan: "sponsor" });
  assert.equal(sponsorHydrated.intervalMinutes, 5);

  const overridden = hydrateSettings(
    { ...stored, intervalMinutes: 3, intervalAdminSet: true },
    defaults,
  );
  assert.equal(overridden.intervalMinutes, 3);

  const adminHydrated = hydrateSettings(stored, defaults, { admin: true });
  assert.equal(adminHydrated.intervalMinutes, 2);
  assert.equal(adminHydrated.pagesPerWatch, 10);
  assert.equal(adminHydrated.offlineConfirmDays, 14);

  const memberPatched = applySettingPatch(
    { ...defaults, watchDistricts: ["1-8"], intervalMinutes: 8, pagesPerWatch: 40, offlineConfirmDays: 7 },
    { intervalMinutes: 30, pagesPerWatch: 8, offlineConfirmDays: 21 },
  );
  assert.equal(memberPatched.intervalMinutes, 8);
  assert.equal(memberPatched.pagesPerWatch, 40);
  assert.equal(memberPatched.offlineConfirmDays, 7);

  const adminPatched = applySettingPatch(
    { ...defaults, watchDistricts: ["1-8"], intervalMinutes: 5, pagesPerWatch: 40, offlineConfirmDays: 7 },
    { intervalMinutes: 1, pagesPerWatch: 8, offlineConfirmDays: 21 },
    { admin: true },
  );
  assert.equal(adminPatched.intervalMinutes, 1);
  assert.equal(adminPatched.pagesPerWatch, 8);
  assert.equal(adminPatched.offlineConfirmDays, 21);
});
