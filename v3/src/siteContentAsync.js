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
import { getSiteSettingAsync, setSiteSettingAsync } from "./settingsKvAsync.js";
import {
  getHousingData as getHousingDataSync,
  getSpirit as getSpiritSync,
  saveHousingData as saveHousingDataSync,
  saveSpirit as saveSpiritSync,
} from "./db.js";

const HOUSING_KEY = "housingData";
const SPIRIT_KEY = "spirit";

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
