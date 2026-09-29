// 後台設定（郵件／OAuth／贊助／品牌）的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼挑這一批：用修好的量尺排出「只有**一個**真卡點」的 101 條路由之後，
// 這幾個函式各卡住 1～2 條，而且形狀幾乎一樣——都是「讀一個 settings 鍵 + 一個純函式」。
// 純函式留在原模組（兩個 driver 共用），這裡只換「跑語句的人」，語句由
// `settingsKvAsync.js` 的通用存取器負責，所以每個 port 都只有幾行。
//
// ✅ 第五十五批（Owner 決定：**移植**）：`saveAdminMailSettings()`／`saveAdminOauthSettings()`
//   也搬上 PG，作法是「**設定進 PG、`auth.env` 仍留節點本機**」：
//     1. 讀目前值（PG）
//     2. 用同一組純函式正規化
//     3. 寫 PG（`settings.smtp`／`settings.mailTemplates`／`settings.oauth`）
//     4. 在**回答你的那一台**做本機落地（本機 settings 鏡射 ＋ 寫 `auth.env`）
//   第 4 步是必要的，不是遺漏：`auth.env` 是節點啟動時套用的檔案（`applyStoredSmtp()`／
//   `applyStoredOauth()` 在 import 時就跑），而本機的同步讀者（`getStoredSmtp()`…）也還在。
//   ⚠️ 也就是說 **SMTP 密碼與 OAuth client secret 會進 PG 的 settings**——與先前 SQLite 的
//   `settings` 同一類（本來就不是只放檔案），但 PG 是多節點共用的 store，維運時要記得。
import { resolveDbDriver } from "./dbDriver.js";
import {
  defaultBrandMascot,
  normalizeBrandMascot,
  publicBrandMascot,
} from "./brandMascot.js";
import { normalizeOauthConfig, publicOauthConfig } from "./oauth.js";
import {
  normalizeSponsorConfig,
  publicSponsorOffer,
  sponsorCatalog,
} from "./sponsorLinks.js";
import { normalizeMailTemplates, normalizeSmtp, publicSmtp, smtpFromEnv } from "./siteMail.js";
import {
  googleDirectionsBlockState,
  hasGoogleMapsKey,
  isCommuteRushEnabled,
  isGoogleDirectionsEnabled,
  mapsAdminWarning,
  mapsBudgetWarning,
  summarizeMapsUsage,
} from "./mapsBilling.js";
import { budgetStore } from "./budgetStore.js";
import {
  persistGoogleKeyToAuthEnv,
  saveAdminMapsSettings as saveAdminMapsSettingsSync,
  sqliteHandle,
} from "./db.js";
import { sharedPgDriver as sharedDriverForMaps } from "./pgSharedDriver.js";
import { toPostgresSql as toPgSqlForMaps } from "./sqlDialect.js";
import { BRAND_SLOTS } from "./brandMascot.js";
import { adminSiteAdsView, normalizeSiteAds } from "./siteAds.js";
import { adminBroadcastsView, normalizeBroadcasts } from "./broadcasts.js";
import { getSiteSettingAsync, setSiteSettingAsync } from "./settingsKvAsync.js";
import {
  getAdminAdsSettings as getAdminAdsSettingsSync,
  getAdminBroadcastsSettings as getAdminBroadcastsSettingsSync,
  getAdminMailSettings as getAdminMailSettingsSync,
  getAdminMapsSettings as getAdminMapsSettingsSync,
  getAdminOauthSettings as getAdminOauthSettingsSync,
  getAdminSponsorSettings as getAdminSponsorSettingsSync,
  getBrandMascot as getBrandMascotSync,
  getMailTemplates as getMailTemplatesSync,
  getSponsorConfig as getSponsorConfigSync,
  getStoredOauth as getStoredOauthSync,
  getStoredSmtp as getStoredSmtpSync,
  publicSponsorSettings as publicSponsorSettingsSync,
  saveAdminMailSettings as saveAdminMailSettingsSync,
  saveAdminOauthSettings as saveAdminOauthSettingsSync,
  saveAdminSponsorSettings as saveAdminSponsorSettingsSync,
  saveBrandMascot as saveBrandMascotSync,
  applyAdminMailSettingsLocally,
  applyAdminOauthSettingsLocally,
} from "./db.js";

const GOOGLE_DIRECTIONS_KEY = "googleDirectionsEnabled";
const COMMUTE_RUSH_KEY = "commuteRushEnabled";
const MAPS_USAGE_SQL = "SELECT day, essentials, advanced FROM maps_usage_daily ORDER BY day";

// `maps_usage_daily` 的讀取（PG 走共用 driver，SQLite 走本機）。
// ⚠️ 注入式 `exec` 的形狀要正規化成**裸陣列**（這個模組的 runner 約定），
// 而且只能呼叫它**一次**（第一版寫成呼叫兩次，第二次的值還會蓋掉第一次）。
async function withMapsExec(options, fn) {
  if (options.exec) {
    const injected = options.exec;
    return fn(async (sql, params = []) => {
      const raw = await injected(sql, params);
      return Array.isArray(raw) ? raw : (raw?.rows || []);
    });
  }
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return fn(async (sql, params = []) => sqliteHandle().prepare(sql).all(...params));
  }
  const pgDriver = options.pgDriver || (await sharedDriverForMaps());
  return fn(async (sql, params = []) => (await pgDriver.query(toPgSqlForMaps(sql), params)).rows);
}

const SMTP_KEY = "smtp";
const MAIL_TEMPLATES_KEY = "mailTemplates";
const OAUTH_KEY = "oauth";
const SPONSOR_KEY = "sponsorLinks";
const BRAND_MASCOT_KEY = "brandMascot";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// ---- 郵件（smtp ＋ mailTemplates）----

export async function getMailTemplatesAsync(options = {}) {
  if (!isPg(options)) return getMailTemplatesSync();
  return normalizeMailTemplates(await getSiteSettingAsync(MAIL_TEMPLATES_KEY, options));
}

// 逐字對應 db.js:1138——**只有在存的值有 host 時才用它**，否則回環境變數的設定。
// 這個 fallback 很容易在改寫時漏掉（漏了就會讓「尚未在後台設定 SMTP」的站台整個寄不出信）。
export async function getStoredSmtpAsync(options = {}) {
  if (!isPg(options)) return getStoredSmtpSync();
  const stored = await getSiteSettingAsync(SMTP_KEY, options);
  if (stored && typeof stored === "object" && String(stored.host || "").trim()) {
    return normalizeSmtp(stored);
  }
  return smtpFromEnv();
}

export async function getAdminMailSettingsAsync(options = {}) {
  if (!isPg(options)) return getAdminMailSettingsSync();
  const smtp = await getStoredSmtpAsync(options);
  return {
    smtp: publicSmtp(smtp),
    templates: await getMailTemplatesAsync(options),
    configured: Boolean(smtp.host && (smtp.from || smtp.user)),
  };
}

// ---- OAuth（唯讀；寫入因為會碰 auth.env，見檔頭說明）----

export async function getStoredOauthAsync(options = {}) {
  if (!isPg(options)) return getStoredOauthSync();
  const stored = await getSiteSettingAsync(OAUTH_KEY, options);
  return normalizeOauthConfig(stored && typeof stored === "object" ? stored : {}, {}, process.env);
}

// ---- 地圖與預算（`GET /api/admin/maps`）--------------------------------------
//
// 同步版 `db.js getAdminMapsSettings()` 讀三個地方：兩個 settings 鍵
// （`googleDirectionsEnabled`／`commuteRushEnabled`）、`maps_usage_daily` 的用量列，
// 以及 BudgetGuard 的 provider 設定（`distance_matrix` 的日預算）。
// PG 模式下這些都必須讀 PG，否則後台看到的會是**別的節點**的開關與用量。
// 純函式（`mapsAdminWarning`／`summarizeMapsUsage`／`mapsBudgetWarning`／
// `googleDirectionsBlockState`）全部沿用同一份，兩個 driver 的輸出才會逐字相同。
export async function getAdminMapsSettingsAsync(options = {}) {
  if (!isPg(options)) return getAdminMapsSettingsSync();
  const [googleEnabledRaw, rushEnabledRaw] = await Promise.all([
    getSiteSettingAsync(GOOGLE_DIRECTIONS_KEY, options),
    getSiteSettingAsync(COMMUTE_RUSH_KEY, options),
  ]);
  const googleEnabled = isGoogleDirectionsEnabled(googleEnabledRaw);
  const enabled = isCommuteRushEnabled(rushEnabledRaw);
  const hasKey = hasGoogleMapsKey();
  const block = googleDirectionsBlockState();
  const daily = await withMapsExec(options, (exec) => exec(MAPS_USAGE_SQL, []));
  const usage = summarizeMapsUsage(daily);
  // ⚠️ 同步版的 provider 判斷走 `googleDirectionsAllowed()`，而那一支用的是
  // `directionsEnabledReader()`（在 db.js 被綁到**同步**讀取器）⇒ PG 版自己算：
  // 熔斷中、沒有金鑰、或 PG 的開關是關的，就一律走免費的 OSRM。
  const provider = (!block.blocked && hasKey && googleEnabled) ? "google" : "osrm";
  const baseWarning = mapsAdminWarning({ googleEnabled, rushEnabled: enabled, hasKey, block });
  const cfg = await budgetStore({ sqliteDb: sqliteHandle(), options }).config("distance_matrix");
  return {
    enabled,
    googleEnabled,
    hasKey,
    googleBlocked: block.blocked,
    googleBlockReason: block.reason,
    googleBlockUntil: block.until,
    provider,
    warning: mapsBudgetWarning(baseWarning, { googleEnabled, dailyLimitMinor: cfg?.daily_limit_minor }),
    usage,
  };
}

// `db.js:saveAdminMapsSettings()` 的 PG 版（第七十八批）。
//
// ⚠️ 為什麼重要：後台這顆「開啟 Google 路線」的按鈕在 PG 模式下寫的是**節點本機**的
// `settings` 鍵 ⇒ 管理員以為開了，實際上只有他按下去的那一台生效（另一台照樣走 OSRM），
// 而且 `queueGeoBackfill()` 會拿本機的值去跑整條補路線流程。
//
// 兩個節點本機的副作用**刻意保留**（`persistGoogleKeyToAuthEnv` 寫的是這台節點的 `auth.env`、
// 金鑰屬於基礎設施），其餘（兩個開關）一律寫 PG，回傳值也走 PG 版的讀取。
export async function saveAdminMapsSettingsAsync(partial = {}, options = {}) {
  if (!isPg(options)) return saveAdminMapsSettingsSync(partial);
  const src = partial && typeof partial === "object" ? partial : {};
  if (src.clearKey === true) {
    persistGoogleKeyToAuthEnv("", { unset: true });
    await setSiteSettingAsync(GOOGLE_DIRECTIONS_KEY, false, options);
    await setSiteSettingAsync(COMMUTE_RUSH_KEY, false, options);
    return getAdminMapsSettingsAsync(options);
  }
  if (Object.prototype.hasOwnProperty.call(src, "googleEnabled")) {
    await setSiteSettingAsync(GOOGLE_DIRECTIONS_KEY, Boolean(src.googleEnabled), options);
  }
  if (Object.prototype.hasOwnProperty.call(src, "enabled")) {
    await setSiteSettingAsync(COMMUTE_RUSH_KEY, Boolean(src.enabled), options);
  }
  if (Object.prototype.hasOwnProperty.call(src, "apiKey")) {
    // 金鑰落在這台節點的 `auth.env`（基礎設施，與同步版同一個行為）。
    persistGoogleKeyToAuthEnv(src.apiKey);
  }
  return getAdminMapsSettingsAsync(options);
}

// `db.js saveAdminMailSettings()` 的 PG 版（第五十五批）。
// ⚠️ 順序：**先寫 PG，再本機落地**。反過來的話，PG 寫失敗時本機已經變了（而且 auth.env 也寫了），
// 會出現「這台看起來設定好了、其他節點還是舊的」——正是這一包要修掉的病。
export async function saveAdminMailSettingsAsync(partial = {}, options = {}) {
  if (!isPg(options)) return saveAdminMailSettingsSync(partial);
  const src = partial && typeof partial === "object" ? partial : {};
  const current = await getStoredSmtpAsync(options);
  const smtp = normalizeSmtp(src.smtp || {}, current);
  const templates = normalizeMailTemplates({
    ...(await getMailTemplatesAsync(options)),
    ...(src.templates && typeof src.templates === "object" ? src.templates : {}),
  });
  await setSiteSettingAsync(SMTP_KEY, smtp, options);
  await setSiteSettingAsync(MAIL_TEMPLATES_KEY, templates, options);
  // 本機落地（best effort）：auth.env 寫不進去不該讓「PG 已經寫成功」變成失敗。
  try {
    applyAdminMailSettingsLocally({ smtp, templates });
  } catch (error) {
    console.warn("本機 SMTP 落地失敗（PG 已寫入）：", error?.message || error);
  }
  return getAdminMailSettingsAsync(options);
}

// `db.js saveAdminOauthSettings()` 的 PG 版（第五十五批）。
export async function saveAdminOauthSettingsAsync(partial = {}, options = {}) {
  if (!isPg(options)) return saveAdminOauthSettingsSync(partial);
  const src = partial && typeof partial === "object" ? partial : {};
  const current = await getStoredOauthAsync(options);
  const oauth = normalizeOauthConfig(src.oauth || {}, current);
  await setSiteSettingAsync(OAUTH_KEY, oauth, options);
  try {
    applyAdminOauthSettingsLocally(oauth);
  } catch (error) {
    console.warn("本機 OAuth 落地失敗（PG 已寫入）：", error?.message || error);
  }
  return getAdminOauthSettingsAsync(options);
}

export async function getAdminOauthSettingsAsync(options = {}) {
  if (!isPg(options)) return getAdminOauthSettingsSync();
  return { oauth: publicOauthConfig(await getStoredOauthAsync(options)) };
}

// ---- 贊助連結（sponsorLinks）----

export async function getSponsorConfigAsync(options = {}) {
  if (!isPg(options)) return getSponsorConfigSync();
  return normalizeSponsorConfig(await getSiteSettingAsync(SPONSOR_KEY, options));
}

export async function getAdminSponsorSettingsAsync(options = {}) {
  if (!isPg(options)) return getAdminSponsorSettingsSync();
  return {
    catalog: sponsorCatalog(), // 純函式（常數目錄），不必碰 DB
    config: await getSponsorConfigAsync(options),
  };
}

export async function saveAdminSponsorSettingsAsync(partial = {}, options = {}) {
  if (!isPg(options)) return saveAdminSponsorSettingsSync(partial);
  const src = partial && typeof partial === "object" ? partial : {};
  const current = await getSponsorConfigAsync(options);
  const next = normalizeSponsorConfig({
    intro: Object.prototype.hasOwnProperty.call(src, "intro") ? src.intro : current.intro,
    thanks: Object.prototype.hasOwnProperty.call(src, "thanks") ? src.thanks : current.thanks,
    providers: src.providers && typeof src.providers === "object" ? { ...current.providers, ...src.providers } : current.providers,
    extras: Array.isArray(src.extras) ? src.extras : current.extras,
  });
  await setSiteSettingAsync(SPONSOR_KEY, next, options);
  return getAdminSponsorSettingsAsync(options);
}

// 公開的贊助資訊：未登入訪客也要拿得到（`/api/comms`、`/api/me` 都會用）。
// 純判斷（`publicSponsorOffer`）留在 sponsorLinks.js，這裡只把 config 的來源換成 PG。
export async function publicSponsorSettingsAsync(user = {}, options = {}) {
  if (!isPg(options)) return publicSponsorSettingsSync(user);
  return publicSponsorOffer(await getSponsorConfigAsync(options), { role: user.role, plan: user.plan });
}

// ---- 品牌吉祥物（brandMascot）----

// 注意：同步版存的是**公開形狀**（先 `publicBrandMascot` 再 `normalizeBrandMascot` 存回去），
// 這裡逐字照抄——不要「順手改成存原始形狀」，那會改變落地資料。
export async function getBrandMascotAsync(options = {}) {
  if (!isPg(options)) return getBrandMascotSync();
  const stored = await getSiteSettingAsync(BRAND_MASCOT_KEY, options);
  return publicBrandMascot(stored || defaultBrandMascot());
}

export async function saveBrandMascotAsync(partial = {}, options = {}) {
  if (!isPg(options)) return saveBrandMascotSync(partial);
  const current = await getBrandMascotAsync(options);
  const src = partial && typeof partial === "object" ? partial : {};
  const clipPatch = src.clips && typeof src.clips === "object" ? src.clips : {};
  const next = normalizeBrandMascot({
    ...current,
    ...src,
    clips: {
      welcome: { ...current.clips.welcome, ...clipPatch.welcome },
      register: { ...current.clips.register, ...clipPatch.register },
      sponsor: { ...current.clips.sponsor, ...clipPatch.sponsor },
      confused: { ...current.clips.confused, ...clipPatch.confused },
    },
  });
  await setSiteSettingAsync(BRAND_MASCOT_KEY, next, options);
  return getBrandMascotAsync(options);
}

// ---- 站台廣告／廣播（唯讀）----
//
// 這兩個是**純讀取**（各自的 `save*` 是 `rejectLegacy*Mutation()`，一律拒絕舊介面），
// 所以與郵件／OAuth 那兩個「會寫節點本機 auth.env」的情況不同，可以安全移植。
// 邏輯只有「讀 settings 的一個鍵 → normalize → 後台視圖」，純函式完全重用。
export async function getAdminAdsSettingsAsync(options = {}) {
  if (!isPg(options)) return getAdminAdsSettingsSync();
  return adminSiteAdsView(normalizeSiteAds(await getSiteSettingAsync("siteAds", options)));
}

export async function getAdminBroadcastsSettingsAsync(options = {}) {
  if (!isPg(options)) return getAdminBroadcastsSettingsSync();
  return adminBroadcastsView(normalizeBroadcasts(await getSiteSettingAsync("broadcasts", options)));
}

// 對應 `db.js:1364 applyBrandUpload()`：把上傳好的檔案套到指定的品牌位置。
// 它只用到 `getBrandMascot()`／`saveBrandMascot()`——兩個都已經有 async 版——
// 所以這裡沒有任何新邏輯，只是把同一段組合改成 await 版（原檔案的註解也照抄語意）。
export async function applyBrandUploadAsync(slot, upload, options = {}) {
  const key = String(slot || "").trim();
  if (!BRAND_SLOTS.includes(key)) {
    const err = new Error("請選擇要套用的位置");
    err.status = 400;
    throw err;
  }
  const current = await getBrandMascotAsync(options);
  if (key === "mark") {
    return saveBrandMascotAsync({ ...current, markUrl: upload.url }, options);
  }
  return saveBrandMascotAsync({
    ...current,
    clips: {
      ...current.clips,
      [key]: { ...current.clips[key], url: upload.url, kind: upload.kind },
    },
  }, options);
}
