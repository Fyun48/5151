import { hasWorkPoint } from "./geo.js";
import { CITIES, lookupDistrict } from "./regions.js";

/** 訪客示範用的固定公司地址（台北台積電南港），與任何會員帳號的個人設定無關。 */
export const DEMO_WORK_ADDRESS = "臺北市南港區經貿一路170號";
export const DEMO_COMMUTE_KM = 25;
export const DEMO_WORK_LAT = 25.05781;
export const DEMO_WORK_LNG = 121.6184;
export const DEMO_COMMUTE_MODE = "scooter";

export function demoCommutePatch() {
  return {
    workAddress: DEMO_WORK_ADDRESS,
    commuteKm: DEMO_COMMUTE_KM,
    workLat: DEMO_WORK_LAT,
    workLng: DEMO_WORK_LNG,
    commuteMode: DEMO_COMMUTE_MODE,
  };
}

export function applyDemoCommute(settings = {}) {
  return { ...settings, ...demoCommutePatch() };
}

export function demoDistrictNames(settings = {}) {
  return (settings.watchDistricts || [])
    .map((key) => lookupDistrict(key)?.name)
    .filter(Boolean);
}

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
    minBuildingFloors: Number(settings.minBuildingFloors) || 0,
    wholeFloorOnly: settings.wholeFloorOnly === true,
    excludeLowFloors: settings.excludeLowFloors !== false,
    excludeKeywords: [],
    excludeAgents: [],
    excludeAgentIds: [],
    excludeBoxes: [],
    discordWebhook: "",
    notifyMatrix: settings.notifyMatrix || {},
    ...demoCommutePatch(),
    showMrt: true,
    settingProfiles: [],
    activeProfileId: "",
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
  const source = uid ? getSettings(uid) : getSettings();
  const settings = applyDemoCommute(source);
  const listed = listListings({
    filter: "guest",
    sort: "newest",
    limit: GUEST_LIST_LIMIT,
    userId: uid,
    matchVoteUserId: 0,
    searchKeys: [],
    districts: demoDistrictNames(source),
    settings,
  });
  const listingStats = typeof stats === "function" ? stats(undefined, uid, settings) : {};
  return {
    guest: true,
    settings: publicDemoSettings(settings),
    listings: listed.listings || [],
    stats: { ...listingStats, matched: listed.totalMatched, shown: (listed.listings || []).length },
    cities: CITIES,
  };
}
