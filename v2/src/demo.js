import { hasWorkPoint } from "./geo.js";
import { CITIES } from "./regions.js";

export const GUEST_LIST_LIMIT = 30;

export function demoSourceUserId({ listUserIds, getSettings, defaultUserId }) {
  const ids = typeof listUserIds === "function" ? listUserIds() : [];
  for (const id of ids) {
    const settings = getSettings(id);
    if (Number(settings?.commuteKm) > 0 && hasWorkPoint(settings) && (settings.watchDistricts || []).length) {
      return id;
    }
  }
  for (const id of ids) {
    const settings = getSettings(id);
    if ((settings.watchDistricts || []).length) return id;
  }
  return defaultUserId();
}

export function publicDemoSettings(settings = {}) {
  return {
    searchUrls: [],
    watchDistricts: Array.isArray(settings.watchDistricts) ? settings.watchDistricts : [],
    priceMin: Number(settings.priceMin) || 0,
    priceMax: Number(settings.priceMax) || 0,
    areaMax: Number(settings.areaMax) || 0,
    excludeRooftop: settings.excludeRooftop !== false,
    intervalMinutes: Number(settings.intervalMinutes) || 8,
    offlineConfirmDays: Number(settings.offlineConfirmDays) || 7,
    pagesPerWatch: Number(settings.pagesPerWatch) || 40,
    minBuildingFloors: Number(settings.minBuildingFloors) || 4,
    wholeFloorOnly: settings.wholeFloorOnly !== false,
    excludeLowFloors: settings.excludeLowFloors !== false,
    excludeKeywords: [],
    excludeAgents: [],
    excludeAgentIds: [],
    excludeBoxes: [],
    discordWebhook: "",
    notifyMatrix: settings.notifyMatrix || {},
    workAddress: String(settings.workAddress || "").trim(),
    commuteKm: Number(settings.commuteKm) || 0,
    workLat: Number(settings.workLat) || null,
    workLng: Number(settings.workLng) || null,
    settingProfiles: Array.isArray(settings.settingProfiles)
      ? settings.settingProfiles.map((item) => ({ id: item.id, name: item.name }))
      : [],
    activeProfileId: settings.activeProfileId || "",
  };
}

export function buildDemoState({
  listUserIds,
  getSettings,
  defaultUserId,
  listListings,
  stats,
} = {}) {
  const uid = demoSourceUserId({ listUserIds, getSettings, defaultUserId });
  const settings = uid ? getSettings(uid) : getSettings();
  const listed = listListings({
    filter: "guest",
    sort: "newest",
    limit: GUEST_LIST_LIMIT,
    userId: uid,
  });
  const listingStats = typeof stats === "function" ? stats(undefined, uid) : {};
  return {
    guest: true,
    settings: publicDemoSettings(settings),
    listings: listed.listings || [],
    stats: { ...listingStats, matched: listed.totalMatched, shown: (listed.listings || []).length },
    cities: CITIES,
  };
}
