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

// 挑「示範用的來源會員」的**純決策**（同步與 PG 版共用）：先找有通勤設定又有追蹤行政區的，
// 再退而求其次找只有追蹤行政區的，都沒有就用預設帳號。
export function demoSourceUserIdFrom(ids = [], settingsFor = () => ({}), pickDefault = () => 0) {
  const list = Array.isArray(ids) ? ids : [];
  for (const id of list) {
    const settings = settingsFor(id) || {};
    if (Number(settings.commuteKm) > 0 && hasWorkPoint(settings) && (settings.watchDistricts || []).length) {
      return id;
    }
  }
  for (const id of list) {
    const settings = settingsFor(id) || {};
    if ((settings.watchDistricts || []).length) return id;
  }
  return pickDefault();
}

export function demoSourceUserId({ listUserIds, getSettings, defaultUserId }) {
  const ids = typeof listUserIds === "function" ? listUserIds() : [];
  return demoSourceUserIdFrom(
    ids,
    (id) => (typeof getSettings === "function" ? getSettings(id) : {}),
    () => (typeof defaultUserId === "function" ? defaultUserId() : 0),
  );
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

// 示範清單的查詢參數與最終狀態組裝（**同步與 PG 版共用**）：兩個 driver 的「訪客視角、
// 示範行政區、固定通勤設定、統計合併」不可以各寫一份。
export function demoListArgs({ uid, source, settings }) {
  return {
    filter: "guest",
    sort: "newest",
    limit: GUEST_LIST_LIMIT,
    userId: uid,
    matchVoteUserId: 0,
    searchKeys: [],
    districts: demoDistrictNames(source),
    settings,
  };
}

export function demoStateFrom({ settings, listed, listingStats = {} }) {
  return {
    guest: true,
    settings: publicDemoSettings(settings),
    listings: listed.listings || [],
    stats: { ...listingStats, matched: listed.totalMatched, shown: (listed.listings || []).length },
    cities: CITIES,
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
  const listed = listListings(demoListArgs({ uid, source, settings }));
  const listingStats = typeof stats === "function" ? stats(undefined, uid, settings) : {};
  return demoStateFrom({ settings, listed, listingStats });
}

// `buildDemoState()` 的 driver-aware 版（第七十八批）：訪客示範的會員掃描與清單、統計全部走島嶼。
//
// ⚠️ 為什麼重要：PG 模式下同步版是「本機的會員清單 ＋ 本機的設定 ＋ 本機的刊登」⇒
// 示範頁顯示的是**這台節點**的資料（別的節點爬到的刊登不會出現），而統計也只看得到本機。
// 這一支把四個依賴都改成注入的 async 島嶼；SQLite 模式下那些島嶼自己會回退同步路徑，
// 所以行為不變。
export async function buildDemoStateAsync({
  listUserIdsAsync,
  getSettingsAsync,
  defaultUserIdAsync,
  listListingsAsync,
  statsAsync,
  options = {},
} = {}) {
  const ids = typeof listUserIdsAsync === "function" ? await listUserIdsAsync(options) : [];
  const settingsCache = new Map();
  const settingsOf = async (id) => {
    if (!settingsCache.has(id)) settingsCache.set(id, await getSettingsAsync(id, options));
    return settingsCache.get(id);
  };
  let uid = 0;
  for (const id of ids) {
    const row = await settingsOf(id);
    if (Number(row?.commuteKm) > 0 && hasWorkPoint(row) && (row.watchDistricts || []).length) { uid = id; break; }
  }
  if (!uid) {
    for (const id of ids) {
      const row = await settingsOf(id);
      if ((row.watchDistricts || []).length) { uid = id; break; }
    }
  }
  if (!uid) uid = await defaultUserIdAsync(options);
  const source = await getSettingsAsync(uid, options);
  const settings = applyDemoCommute(source);
  const listed = await listListingsAsync(demoListArgs({ uid, source, settings }), options);
  const listingStats = typeof statsAsync === "function"
    ? await statsAsync({ userId: uid, settings }, options)
    : {};
  return demoStateFrom({ settings, listed, listingStats });
}
