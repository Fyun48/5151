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
import { emptyCommsConfig, normalizeCommsConfig } from "./comms.js";
import { getSiteSettingAsync, setSiteSettingAsync } from "./settingsKvAsync.js";
import {
  getCommsConfig as getCommsConfigSync,
  getCrawlSources as getCrawlSourcesSync,
  getHelpQa as getHelpQaSync,
  getHousingData as getHousingDataSync,
  getSpirit as getSpiritSync,
  saveCommsConfig as saveCommsConfigSync,
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

// ---- 通訊設定（commsConfig）----
//
// 這個是乾淨的單鍵形狀：讀 = normalize(key || empty)，寫 = normalize({ ...現值, ...變更 })。
// 沒有記憶體快取、沒有額外表、不寫 auth.env——所以可以直接照抄。
// （其餘 settings 類多半不是這樣：有的要同步記憶體狀態，有的寫 auth.env，有的跑資料搬遷。）

const COMMS_KEY = "commsConfig";

export async function getCommsConfigAsync(options = {}) {
  if (!isPg(options)) return getCommsConfigSync();
  const stored = await getSiteSettingAsync(COMMS_KEY, options);
  return normalizeCommsConfig(stored || emptyCommsConfig());
}

export async function saveCommsConfigAsync(partial = {}, options = {}) {
  if (!isPg(options)) return saveCommsConfigSync(partial);
  const current = await getCommsConfigAsync(options);
  const src = partial && typeof partial === "object" ? partial : {};
  const next = normalizeCommsConfig({ ...current, ...src });
  await setSiteSettingAsync(COMMS_KEY, next, options);
  return next;
}
