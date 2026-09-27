// 後台設定（郵件／OAuth／贊助／品牌）的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼挑這一批：用修好的量尺排出「只有**一個**真卡點」的 101 條路由之後，
// 這幾個函式各卡住 1～2 條，而且形狀幾乎一樣——都是「讀一個 settings 鍵 + 一個純函式」。
// 純函式留在原模組（兩個 driver 共用），這裡只換「跑語句的人」，語句由
// `settingsKvAsync.js` 的通用存取器負責，所以每個 port 都只有幾行。
//
// ⚠️ **刻意沒有移植的兩個（不是漏掉）**：
//   - `saveAdminMailSettings()`  → 除了寫 `smtp`／`mailTemplates`，還會 `persistSmtpToAuthEnv()`
//   - `saveAdminOauthSettings()` → 除了寫 `oauth`，還會 `persistOauthToAuthEnv()`
//   兩者都**額外寫節點本機的 `auth.env`**（db.js:1164／1195），與 `saveAdminMapsSettings`
//   同一類陷阱：在 PG 模式下「資料進 PG、檔案設定只留在回答你那台」。
//   這需要一個刻意的決定（auth.env 在 PG 模式還要不要寫？由誰寫？），**留給下一批**。
//   對應的路由因此仍會留在缺口裡——這是誠實的取捨，不是忘記。
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
import { getSiteSettingAsync, setSiteSettingAsync } from "./settingsKvAsync.js";
import {
  getAdminMailSettings as getAdminMailSettingsSync,
  getAdminOauthSettings as getAdminOauthSettingsSync,
  getAdminSponsorSettings as getAdminSponsorSettingsSync,
  getBrandMascot as getBrandMascotSync,
  getMailTemplates as getMailTemplatesSync,
  getSponsorConfig as getSponsorConfigSync,
  getStoredOauth as getStoredOauthSync,
  getStoredSmtp as getStoredSmtpSync,
  publicSponsorSettings as publicSponsorSettingsSync,
  saveAdminSponsorSettings as saveAdminSponsorSettingsSync,
  saveBrandMascot as saveBrandMascotSync,
} from "./db.js";

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
