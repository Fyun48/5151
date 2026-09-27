// 站台內容類設定的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼需要：`getHousingData`／`saveHousingData`／`getSpirit`／`saveSpirit` 原本只在 `db.js`
// （同步 SQLite），所以後台改「居住數據」「站台精神」只寫進**回答你那台節點的本機檔案**。
// 實測（2026-09-27）：`settings.housingData` 在 PG／CasaOS／Synology **三個來源各一版**。
//
// 這裡刻意**逐一照抄同步版的語意，不做抽象化**——兩者表面很像，實際上不同：
//   housingData 儲存：normalizeHousingData(src)                     ← 不與現值合併
//   spirit      儲存：normalizeSpirit({ ...getSpirit(), ...src })   ← 與**公開形狀**合併
// 這種差異用共用樣板很容易寫錯，而錯了就是資料語意改變。parity 優先於 DRY。
import { resolveDbDriver } from "./dbDriver.js";
import { defaultHousingData, normalizeHousingData, publicHousingData } from "./housingData.js";
import { defaultSpirit, normalizeSpirit, publicSpirit } from "./spirit.js";
import { defaultHelpQaItems, mergeMissingDefaultHelpQa, normalizeHelpQaItems, publicHelpQa } from "./helpQa.js";
import { defaultCrawlSources, normalizeCrawlSources, publicCrawlSources } from "./crawlSources.js";
import { getSiteSettingAsync, setSiteSettingAsync } from "./settingsKvAsync.js";
import {
  getCrawlSources as getCrawlSourcesSync,
  getHelpQa as getHelpQaSync,
  getHousingData as getHousingDataSync,
  getSpirit as getSpiritSync,
  saveCrawlSources as saveCrawlSourcesSync,
  saveHelpQa as saveHelpQaSync,
  saveHousingData as saveHousingDataSync,
  saveSpirit as saveSpiritSync,
} from "./db.js";

const HOUSING_KEY = "housingData";
const SPIRIT_KEY = "spirit";
const HELP_QA_KEY = "helpQa";
const CRAWL_SOURCES_KEY = "crawlSources";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// ---- 居住數據 ----

export async function getHousingDataAsync(options = {}) {
  if (!isPg(options)) return getHousingDataSync();
  const stored = await getSiteSettingAsync(HOUSING_KEY, options);
  return publicHousingData(stored ?? defaultHousingData());
}

export async function saveHousingDataAsync(partial = {}, options = {}) {
  if (!isPg(options)) return saveHousingDataSync(partial);
  const src = partial && typeof partial === "object" ? partial : {};
  if (src.reset === true) {
    await setSiteSettingAsync(HOUSING_KEY, defaultHousingData(), options);
  } else {
    await setSiteSettingAsync(HOUSING_KEY, normalizeHousingData(src), options);
  }
  return getHousingDataAsync(options);
}

// ---- 站台精神 ----

export async function getSpiritAsync(options = {}) {
  if (!isPg(options)) return getSpiritSync();
  const stored = await getSiteSettingAsync(SPIRIT_KEY, options);
  return publicSpirit(stored ?? defaultSpirit());
}

export async function saveSpiritAsync(partial = {}, options = {}) {
  if (!isPg(options)) return saveSpiritSync(partial);
  const src = partial && typeof partial === "object" ? partial : {};
  if (src.reset === true) {
    await setSiteSettingAsync(SPIRIT_KEY, defaultSpirit(), options);
  } else {
    // 與同步版相同：以**公開形狀**為底再套用變更。
    await setSiteSettingAsync(SPIRIT_KEY, normalizeSpirit({ ...(await getSpiritAsync(options)), ...src }), options);
  }
  return getSpiritAsync(options);
}

// ---- 說明問答（helpQa）----
//
// 同步版：get 讀 key → 沒有就用預設 → mergeMissingDefaultHelpQa（補上新增的預設題）→ public。
// 這裡逐條照抄，包含 stored 可能是 { items: [...] } 或直接是陣列兩種歷史格式。

export async function getHelpQaAsync(options = {}) {
  if (!isPg(options)) return getHelpQaSync();
  const stored = await getSiteSettingAsync(HELP_QA_KEY, options);
  const items = stored == null ? defaultHelpQaItems() : mergeMissingDefaultHelpQa(stored.items ?? stored);
  return publicHelpQa(items);
}

export async function saveHelpQaAsync(partial = {}, options = {}) {
  if (!isPg(options)) return saveHelpQaSync(partial);
  const src = partial && typeof partial === "object" ? partial : {};
  const next = src.reset === true
    ? { items: defaultHelpQaItems() }
    : { items: normalizeHelpQaItems(src.items) };
  await setSiteSettingAsync(HELP_QA_KEY, next, options);
  return getHelpQaAsync(options);
}

// ---- 爬取來源開關（crawlSources）----
//
// 同步版的 save 是「以現有清單為底，只套用 incoming 的 enabled」——不是整包覆蓋。
// 這一點必須照抄，否則後台只切一個開關會把其他來源的設定洗掉。

export async function getCrawlSourcesAsync(options = {}) {
  if (!isPg(options)) return getCrawlSourcesSync();
  const stored = await getSiteSettingAsync(CRAWL_SOURCES_KEY, options);
  return publicCrawlSources(stored ?? defaultCrawlSources());
}

export async function saveCrawlSourcesAsync(partial = {}, options = {}) {
  if (!isPg(options)) return saveCrawlSourcesSync(partial);
  const src = partial && typeof partial === "object" ? partial : {};
  const incoming = src.items ?? src;
  const incomingMap = Array.isArray(incoming)
    ? Object.fromEntries(incoming.map((row) => [String(row?.id || ""), row]))
    : incoming && typeof incoming === "object"
      ? incoming
      : {};
  const current = (await getCrawlSourcesAsync(options)).items || [];
  const merged = current.map((row) => {
    if (!Object.prototype.hasOwnProperty.call(incomingMap, row.id)) return row;
    const cell = incomingMap[row.id];
    const enabledRaw = cell && typeof cell === "object" ? cell.enabled : cell;
    if (enabledRaw === undefined || enabledRaw === null) return row;
    return { ...row, enabled: Boolean(enabledRaw) };
  });
  await setSiteSettingAsync(CRAWL_SOURCES_KEY, normalizeCrawlSources(merged), options);
  return getCrawlSourcesAsync(options);
}
