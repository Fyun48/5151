// `safeStats()`（server.js）的短期回應快取（2026-10-17）。
//
// 為什麼需要（Owner 回報「開發站按隱藏縣市沒反應」的根因）：
//   POST /api/settings 的最後一步是 `stats: await safeStats(uid)`，PG 路徑的
//   `listingStatsAsync()` 開發站實測 38.9–44.8 秒；前端 `saveSettings()` 是
//   `AbortSignal.timeout(20000)`（public/index.html）⇒ 20 秒被中止、`persistCityPrefs()` 拋錯、
//   沒有任何 UI 回饋（設定其實已寫入）。
//
// 這裡**只在呼叫端**加一層行程內快取，`listingStatsAsync()` 本身（被多條路由共用）一個字都不改。
//
// 設計：
//   * key = `userId` ＋ 設定指紋。指紋**只納入真的會改變統計結果的欄位**（見
//     `statsSettingsFingerprint()` 的逐欄出處），不把整個 settings 序列化 —— 否則改頭像、
//     通知、webhook 這些與統計無關的欄位也會讓快取失效。
//   * TTL 45 秒：取複審建議的 30–60 秒中間值，理由有兩個：
//       ① 大於前端 20 秒逾時 ⇒ 使用者第一次按到逾時後立刻再按一次仍能命中（第二次就看得到反應）；
//       ② 小於排程抓取 60 秒一輪 ⇒ 畫面上的統計最多落後一個排程週期，不會愈看愈舊。
//   * single-flight：同一個 key 併發時只算一次，其他人等同一份（連點兩次不會變成兩趟 40 秒）。
//   * 上限 200 個 key（LRU）⇒ 多會員、多設定檔切換也不會讓 Map 無界成長。
//   * 計算失敗不快取：錯誤照原樣往外丟，交給 `safeStats()` 原本的 fail-soft 契約（回 `{total:0,error}`）。
import { createHash } from "node:crypto";
import { normalizeBoxes, normalizeCommuteMode } from "./geo.js";

export const STATS_CACHE_TTL_MS = 45_000;
export const STATS_CACHE_MAX_ENTRIES = 200;

/** 字串清單去重、去空白、排序（順序不影響統計結果，排序讓同一組設定只有一個指紋）。 */
function canonicalTextList(value, { lower = false } = {}) {
  const list = (Array.isArray(value) ? value : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .map((item) => (lower ? item.toLowerCase() : item));
  return [...new Set(list)].sort();
}

/** 數字清單去重、去非有限值、排序。`excludeAgentIds` 只比對正整數（見 geo.js:isExcludedByAgent）。 */
function canonicalNumberList(value) {
  const list = (Array.isArray(value) ? value : [])
    .map(Number)
    .filter((item) => Number.isFinite(item) && item > 0);
  return [...new Set(list)].sort((a, b) => a - b);
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 會影響 `listingStatsAsync({ userId, settings })` 結果的設定欄位（逐欄出處）：
 *
 *   * `watchDistricts` / `searchUrls` → `db.js:memberRegionDistrictNames()`（行政區範圍）、
 *     `covering.js:listingInMemberScope()`（站內自刊是否可見）、`searchWhere()` 的 search keys。
 *   * `priceMin` / `priceMax` / `priceMaxIncludesExtras` → `listingCost.js:passesPriceFilter()`、
 *     `listPriceSql.js:appendPriceCeilingCandidates()`、`covering.js:listingInMemberScope()`。
 *   * `areaMax` / `minBuildingFloors` / `excludeKeywords` / `excludeAgents` / `excludeAgentIds`
 *     → `floors.js:passesAttributeFilters()`。
 *   * `wholeFloorOnly` / `excludeLowFloors` / `excludeRooftop` / `hasParking`
 *     → `floors.js:passesDisplayFilters()`。
 *   * `commuteKm` / `workLat` / `workLng` / `commuteMode` → `db.js:applyListingFilter()`／
 *     `applyCachedCoords()`、`listingStatsAsync.js:statsProvider()`、`summarizeListingStats()`。
 *   * `excludeBoxes` → `floors.js:passesGeoFilters()`／`geo.js:isExcludedByBox()`（只比對座標與
 *     enabled，名稱／id／描述不影響結果，指紋只取會影響結果的欄位）。
 *
 * 刻意**不納入**（實測沒有進入統計路徑）：`hiddenCityIds`（只給縣市選單顯示用，實際範圍由
 * `watchDistricts` 決定）、`housing_kinds` / `listing_sources`（列表頁晶片，不是設定檔統計範圍）、
 * 通知／webhook／SMTP／設定檔名稱…等。
 *
 * ⚠️ 站台層級設定（`crawlSources`、全域 `searchUrls`、`dataEpoch`…）與資料本身（`listings`、
 * `user_listing_flags`、`route_cache`）不在 key 裡 —— 那些變化由 TTL（45 秒）界定最多落後多久。
 */
export function statsSettingsFingerprint(settings = {}) {
  const conf = settings && typeof settings === "object" ? settings : {};
  const fingerprint = {
    watchDistricts: canonicalTextList(conf.watchDistricts),
    searchUrls: canonicalTextList(conf.searchUrls),
    priceMin: numberOrZero(conf.priceMin),
    priceMax: numberOrZero(conf.priceMax),
    priceMaxIncludesExtras: conf.priceMaxIncludesExtras === true,
    areaMax: numberOrZero(conf.areaMax),
    minBuildingFloors: numberOrZero(conf.minBuildingFloors),
    wholeFloorOnly: conf.wholeFloorOnly === true,
    excludeLowFloors: conf.excludeLowFloors !== false,
    excludeRooftop: conf.excludeRooftop !== false,
    hasParking: conf.hasParking === true,
    excludeKeywords: canonicalTextList(conf.excludeKeywords, { lower: true }),
    excludeAgents: canonicalTextList(conf.excludeAgents, { lower: true }),
    excludeAgentIds: canonicalNumberList(conf.excludeAgentIds),
    excludeBoxes: normalizeBoxes(conf.excludeBoxes)
      .map((box) => [box.south, box.west, box.north, box.east, box.enabled !== false ? 1 : 0])
      .sort((a, b) => String(a).localeCompare(String(b))),
    commuteKm: numberOrZero(conf.commuteKm),
    workLat: numberOrZero(conf.workLat),
    workLng: numberOrZero(conf.workLng),
    commuteMode: normalizeCommuteMode(conf.commuteMode),
  };
  return JSON.stringify(fingerprint);
}

/** 快取 key：`userId:指紋前 24 碼 sha256`（指紋可能包含搜尋網址，日誌只印雜湊）。 */
export function statsCacheKey(userId, settings = {}) {
  const uid = Number(userId) || 0;
  const digest = createHash("sha256").update(statsSettingsFingerprint(settings)).digest("hex").slice(0, 24);
  return `${uid}:${digest}`;
}

/**
 * 小型 LRU ＋ TTL ＋ single-flight 快取。
 *
 * `getOrCompute(key, compute)` 回傳 `{ value, cached, shared }`：
 *   * `cached`：這次沒有真的重算（TTL 內命中，或搭上同一 key 正在算的那一趟）。
 *   * `shared`：搭上別人的 single-flight（不是自己算的）。
 *
 * 測試可注入 `now`（毫秒時鐘）；正式路徑用 `Date.now`。
 */
export function createStatsCache({
  ttlMs = STATS_CACHE_TTL_MS,
  maxEntries = STATS_CACHE_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  if (!(Number(ttlMs) > 0)) throw new Error("createStatsCache: ttlMs 必須 > 0");
  if (!(Number(maxEntries) >= 1)) throw new Error("createStatsCache: maxEntries 必須 >= 1");
  const ttl = Number(ttlMs);
  const limit = Math.floor(Number(maxEntries));
  const entries = new Map(); // key -> { value, expiresAt }；Map 的插入順序＝LRU 順序（最舊在最前）
  const inflight = new Map(); // key -> Promise（single-flight）
  const counters = { hits: 0, misses: 0, shared: 0, evictions: 0 };

  async function getOrCompute(key, compute) {
    if (typeof compute !== "function") throw new TypeError("getOrCompute: compute 必須是函式");
    const at = now();
    const hit = entries.get(key);
    if (hit) {
      if (hit.expiresAt > at) {
        // 命中即移到最新（LRU）：Map 沒有「移到尾端」，先刪再插。
        entries.delete(key);
        entries.set(key, hit);
        counters.hits += 1;
        return { value: hit.value, cached: true, shared: false };
      }
      entries.delete(key);
    }
    const pending = inflight.get(key);
    if (pending) {
      counters.shared += 1;
      return { value: await pending, cached: true, shared: true };
    }
    // 先登記 in-flight 再開始算：並發的第二個請求才看得到這一趟。
    const task = Promise.resolve().then(compute);
    inflight.set(key, task);
    try {
      const value = await task;
      // 到期時間從「算完」開始算：冷算本身可能 40 秒，從請求開始算會讓快取立刻過期。
      entries.set(key, { value, expiresAt: now() + ttl });
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
        counters.evictions += 1;
      }
      counters.misses += 1;
      return { value, cached: false, shared: false };
    } finally {
      inflight.delete(key);
    }
  }

  return {
    getOrCompute,
    size: () => entries.size,
    inflightSize: () => inflight.size,
    counters: () => ({ ...counters }),
    clear() {
      entries.clear();
      inflight.clear();
    },
  };
}
