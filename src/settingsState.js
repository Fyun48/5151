import { buildSearchUrls, districtsFromSearchUrls, normalizeWatchDistricts, priceFromSearchUrls } from "./regions.js";
import { normalizeBoxes, normalizeKeywords } from "./geo.js";
import { normalizeNotifyMatrix } from "./notifyMatrix.js";

export const PROFILE_FIELDS = [
  "searchUrls",
  "intervalMinutes",
  "pagesPerWatch",
  "minBuildingFloors",
  "wholeFloorOnly",
  "excludeLowFloors",
  "excludeKeywords",
  "excludeAgents",
  "excludeAgentIds",
  "excludeBoxes",
  "discordWebhook",
  "notifyMatrix",
  "workAddress",
  "commuteKm",
  "workLat",
  "workLng",
  "watchDistricts",
  "priceMin",
  "priceMax",
  "areaMax",
  "excludeRooftop",
  "offlineConfirmDays",
];

export function parseSettingRows(rows) {
  const stored = {};
  for (const row of rows || []) {
    const key = String(row?.key || "");
    if (!key) continue;
    try {
      stored[key] = JSON.parse(row.value);
    } catch {
      // skip a corrupt key instead of failing the whole settings load
    }
  }
  return stored;
}

export function normalizeProfiles(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "").trim();
    const name = String(raw.name || "").trim().slice(0, 40);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      saved_at: String(raw.saved_at || new Date().toISOString()),
      data: raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : {},
    });
    if (out.length >= 12) break;
  }
  return out;
}

export function snapshotSettings(settings) {
  const out = {};
  for (const key of PROFILE_FIELDS) out[key] = settings?.[key];
  return out;
}

export function hydrateSettings(stored, defaults) {
  const source = stored && typeof stored === "object" ? stored : {};
  const next = { ...defaults, ...source };
  if (Number(next.pagesPerWatch) <= 5) next.pagesPerWatch = 40;
  if (!Array.isArray(source.watchDistricts) || !source.watchDistricts.length) {
    next.watchDistricts = districtsFromSearchUrls(next.searchUrls);
  } else {
    next.watchDistricts = normalizeWatchDistricts(next.watchDistricts);
  }
  if (source.priceMax == null && source.priceMin == null) {
    const parsed = priceFromSearchUrls(next.searchUrls);
    if (parsed.max || parsed.min) {
      next.priceMin = parsed.min;
      next.priceMax = parsed.max;
    }
  }
  next.settingProfiles = normalizeProfiles(next.settingProfiles);
  next.activeProfileId = String(next.activeProfileId || "");
  if (next.activeProfileId && !next.settingProfiles.some((item) => item.id === next.activeProfileId)) {
    next.activeProfileId = "";
  }
  next.notifyMatrix = normalizeNotifyMatrix(next);
  return next;
}

export function applySettingPatch(current, partial = {}) {
  const patch = partial && typeof partial === "object" ? partial : {};
  const next = { ...current, ...patch };
  if (!Object.prototype.hasOwnProperty.call(patch, "settingProfiles")) {
    next.settingProfiles = current.settingProfiles;
  }
  if (!Object.prototype.hasOwnProperty.call(patch, "activeProfileId")) {
    next.activeProfileId = current.activeProfileId;
  }
  next.excludeKeywords = normalizeKeywords(next.excludeKeywords);
  next.excludeAgents = normalizeKeywords(next.excludeAgents);
  next.excludeAgentIds = [...new Set((next.excludeAgentIds || []).map(Number).filter((id) => id > 0))].slice(0, 80);
  next.excludeBoxes = normalizeBoxes(next.excludeBoxes);
  next.pagesPerWatch = Math.max(1, Math.min(Number(next.pagesPerWatch) || 40, 40));
  next.commuteKm = Math.max(0, Math.min(Number(next.commuteKm) || 0, 80));
  next.workAddress = String(next.workAddress || "").trim().slice(0, 120);
  const workLat = Number(next.workLat);
  const workLng = Number(next.workLng);
  next.workLat = Number.isFinite(workLat) ? workLat : null;
  next.workLng = Number.isFinite(workLng) ? workLng : null;
  next.watchDistricts = normalizeWatchDistricts(next.watchDistricts);
  next.priceMin = Math.max(0, Number(next.priceMin) || 0);
  next.priceMax = Math.max(0, Number(next.priceMax) || 0);
  next.areaMax = Math.max(0, Math.min(Number(next.areaMax) || 0, 500));
  next.offlineConfirmDays = Math.max(1, Math.min(Math.round(Number(next.offlineConfirmDays) || 7), 30));
  next.excludeRooftop = next.excludeRooftop !== false;
  next.wholeFloorOnly = next.wholeFloorOnly !== false;
  next.excludeLowFloors = next.excludeLowFloors !== false;
  next.notifyMatrix = normalizeNotifyMatrix(next);
  if (!Object.prototype.hasOwnProperty.call(patch, "notifyMatrix")) {
    if (Object.prototype.hasOwnProperty.call(patch, "notifyNew")) {
      next.notifyMatrix.new.dock = patch.notifyNew !== false;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "notifySameSource")) {
      next.notifyMatrix.same_source.dock = patch.notifySameSource !== false;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "webhookNotifyNew")) {
      next.notifyMatrix.new.webhook = patch.webhookNotifyNew !== false;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "webhookNotifyPriceDrop")) {
      next.notifyMatrix.price.webhook = patch.webhookNotifyPriceDrop !== false;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "webhookNotifyTitleUpdate")) {
      next.notifyMatrix.title.webhook = patch.webhookNotifyTitleUpdate !== false;
    }
  }
  next.notifyNew = next.notifyMatrix.new.dock;
  next.notifySameSource = next.notifyMatrix.same_source.dock;
  next.webhookNotifyNew = next.notifyMatrix.new.webhook;
  next.webhookNotifyPriceDrop = next.notifyMatrix.price.webhook;
  next.webhookNotifyTitleUpdate = next.notifyMatrix.title.webhook;
  if (next.watchDistricts.length) {
    next.searchUrls = buildSearchUrls({
      districts: next.watchDistricts,
      priceMin: next.priceMin,
      priceMax: next.priceMax,
      excludeRooftop: next.excludeRooftop,
    });
  }
  next.settingProfiles = normalizeProfiles(next.settingProfiles);
  next.activeProfileId = String(next.activeProfileId || "");
  if (next.activeProfileId && !next.settingProfiles.some((item) => item.id === next.activeProfileId)) {
    next.activeProfileId = "";
  }
  const fullFormSave = Object.prototype.hasOwnProperty.call(patch, "watchDistricts");
  if (fullFormSave && next.activeProfileId) {
    next.settingProfiles = next.settingProfiles.map((profile) =>
      profile.id === next.activeProfileId
        ? { ...profile, saved_at: new Date().toISOString(), data: snapshotSettings(next) }
        : profile,
    );
  }
  return next;
}
