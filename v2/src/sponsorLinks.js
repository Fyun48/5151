/** 全站贊助連結：管理員後台填收款網址，未贊助一般會員才看得到。 */

const MAX_INTRO = 400;
const MAX_LABEL = 40;
const MAX_EXTRAS = 8;
const MAX_URL = 500;

export const DEFAULT_SPONSOR_INTRO =
  "贊助是自願的，沒贊助也能繼續用。有贊助的會員，自動搜尋間隔會從 8 分鐘改成 5 分鐘。可選下面任一方式刷卡或線上贊助；完成後請跟站長說一聲，才會改成已贊助。";

export const DEFAULT_SPONSOR_THANKS = "感謝贊助。你的檢查間隔已是較短的方案。";

/** 免月費／免年費、會員能刷卡的方案（實際開通後把收款網址填進後台）。 */
export const SPONSOR_PROVIDERS = [
  {
    id: "opay",
    name: "歐付寶收款連結",
    label: "歐付寶刷卡",
    signupUrl: "https://www.opay.tw/",
    memberBlurb: "台灣信用卡",
    feeNote: "個人免年費；刷卡約 2.75%，每筆最低 5 元。",
    hint: "台灣個人會員可申請「快速收款連結」或「一址付」，適合收台灣信用卡。付的人有時要先有歐付寶帳號。",
  },
  {
    id: "ezpay",
    name: "ezPay 簡單付",
    label: "ezPay 刷卡",
    signupUrl: "https://www.ezpay.com.tw/",
    memberBlurb: "台灣信用卡",
    feeNote: "個人免年費；刷卡約 2.8%。",
    hint: "藍新集團的電子支付。實名驗證後可做收款連結，台灣卡較順。",
  },
  {
    id: "oen",
    name: "OEN 幫收 Link",
    label: "OEN 刷卡贊助",
    signupUrl: "https://oen.tw/pricing",
    memberBlurb: "台灣信用卡",
    feeNote: "幫收 Link：開通與月租 0 元，金流約 3% 起。創作者方案月租也可 0 元（手續費較高）。",
    hint: "台灣個人免統編可申請。線上給會員的是「幫收 Link」收款網址；「應碰收」是手機現場感應，不適合當網頁按鈕。",
  },
  {
    id: "kofi",
    name: "Ko-fi",
    label: "Ko-fi",
    signupUrl: "https://ko-fi.com/",
    memberBlurb: "海外卡／PayPal",
    feeNote: "斗內平台抽 0%；金流另計（PayPal 或 Stripe）。",
    hint: "免月費。台灣個人通常沒有 Stripe，多半接 PayPal。台灣卡走 PayPal 常失敗，比較適合海外贊助者。",
  },
  {
    id: "paypal",
    name: "PayPal.Me",
    label: "PayPal",
    signupUrl: "https://www.paypal.com/paypalme/",
    memberBlurb: "海外卡",
    feeNote: "免月費；商業收款約 4.4% + 固定費用。",
    hint: "台灣 PayPal 不易收台灣信用卡，也無法台灣帳戶互轉。適合海外用 PayPal 或海外卡的人。",
  },
  {
    id: "bmc",
    name: "Buy Me a Coffee",
    label: "Buy Me a Coffee",
    signupUrl: "https://buymeacoffee.com/",
    memberBlurb: "海外信用卡",
    feeNote: "免月費；平台約抽 5%，另加 Stripe 手續費。",
    hint: "頁面簡單、能刷卡。金流走 Stripe，台灣個人較難開通，多半給海外卡用。",
  },
  {
    id: "github",
    name: "GitHub Sponsors",
    label: "GitHub Sponsors",
    signupUrl: "https://github.com/sponsors",
    memberBlurb: "GitHub 刷卡",
    feeNote: "個人帳號平台抽 0%；金流由 GitHub 處理。",
    hint: "若你有 GitHub 且所在地區可收款，這是少數平台抽 0% 的刷卡贊助。要先通過 GitHub 審核。",
  },
];

const PROVIDER_IDS = new Set(SPONSOR_PROVIDERS.map((row) => row.id));

export function sponsorCatalog() {
  return SPONSOR_PROVIDERS.map((row) => ({ ...row }));
}

export function sanitizeHttpUrl(value) {
  const text = String(value || "").trim().slice(0, MAX_URL);
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  if (!parsed.hostname) return "";
  return parsed.toString();
}

function cleanLabel(value, fallback = "") {
  const text = String(value || "").trim().slice(0, MAX_LABEL);
  return text || String(fallback || "").trim().slice(0, MAX_LABEL);
}

function emptyProviderState() {
  const out = {};
  for (const row of SPONSOR_PROVIDERS) {
    out[row.id] = { url: "", enabled: false, label: "" };
  }
  return out;
}

export function normalizeSponsorConfig(input = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const intro = String(src.intro || DEFAULT_SPONSOR_INTRO).trim().slice(0, MAX_INTRO) || DEFAULT_SPONSOR_INTRO;
  const thanks = String(src.thanks || DEFAULT_SPONSOR_THANKS).trim().slice(0, MAX_INTRO) || DEFAULT_SPONSOR_THANKS;
  const providers = emptyProviderState();
  const incoming = src.providers && typeof src.providers === "object" ? src.providers : {};
  for (const row of SPONSOR_PROVIDERS) {
    const cell = incoming[row.id] && typeof incoming[row.id] === "object" ? incoming[row.id] : {};
    const url = sanitizeHttpUrl(cell.url);
    providers[row.id] = {
      url,
      enabled: cell.enabled === true && Boolean(url),
      label: cleanLabel(cell.label),
    };
  }
  const extras = [];
  const extraSrc = Array.isArray(src.extras) ? src.extras : [];
  const seen = new Set();
  for (const raw of extraSrc) {
    if (!raw || typeof raw !== "object") continue;
    const url = sanitizeHttpUrl(raw.url);
    const label = cleanLabel(raw.label, "其他贊助");
    if (!url || !label) continue;
    let id = String(raw.id || "").trim().slice(0, 40);
    if (!id || PROVIDER_IDS.has(id) || seen.has(id) || !/^custom[-_a-zA-Z0-9]+$/.test(id)) {
      id = `custom-${extras.length + 1}`;
    }
    seen.add(id);
    extras.push({
      id,
      label,
      url,
      enabled: raw.enabled !== false,
    });
    if (extras.length >= MAX_EXTRAS) break;
  }
  return { intro, thanks, providers, extras };
}

function providerById(id) {
  return SPONSOR_PROVIDERS.find((row) => row.id === id) || null;
}

export function publicSponsorLinks(config) {
  const cfg = normalizeSponsorConfig(config);
  const links = [];
  for (const row of SPONSOR_PROVIDERS) {
    const cell = cfg.providers[row.id];
    if (!cell?.enabled || !cell.url) continue;
    links.push({
      id: row.id,
      label: cell.label || row.label,
      url: cell.url,
      blurb: row.memberBlurb,
    });
  }
  for (const extra of cfg.extras) {
    if (!extra.enabled || !extra.url) continue;
    links.push({
      id: extra.id,
      label: extra.label,
      url: extra.url,
      blurb: "",
    });
  }
  return links;
}

export function publicSponsorOffer(config, { role, plan } = {}) {
  const cfg = normalizeSponsorConfig(config);
  const links = publicSponsorLinks(cfg);
  const admin = role === "admin";
  const sponsored = plan === "sponsor";
  return {
    intro: cfg.intro,
    thanks: cfg.thanks,
    links: admin || sponsored ? [] : links,
    sponsored,
    show: !admin && !sponsored && links.length > 0,
  };
}
