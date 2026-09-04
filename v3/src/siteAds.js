/** 站內自助小廣告：後台填一則安靜卡片，不是 Google Ads／AdSense。 */

import { sanitizeHttpUrl } from "./sponsorLinks.js";

const MAX_TITLE = 40;
const MAX_TEXT = 160;

export const SITE_AD_SLOTS = [
  { id: "listings", label: "找房列表上方", hint: "清單上方安靜一則" },
  { id: "between", label: "物件與物件之間", hint: "細字＋小連結，插在卡片中間" },
  { id: "native", label: "找房列表卡片型", hint: "看起來像一則物件，標贊助訊息" },
  { id: "login", label: "登入頁", hint: "登入表單下方" },
  { id: "me", label: "我的頁", hint: "個人資料下方" },
];

function emptySlot() {
  return { enabled: false, title: "", text: "", url: "", image_url: "" };
}

export function emptySiteAds() {
  const slots = {};
  for (const row of SITE_AD_SLOTS) slots[row.id] = emptySlot();
  return { slots };
}

function cleanText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeSlot(input = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const title = cleanText(src.title, MAX_TITLE);
  const text = cleanText(src.text, MAX_TEXT);
  const url = sanitizeHttpUrl(src.url);
  const image_url = sanitizeHttpUrl(src.image_url);
  return {
    enabled: src.enabled === true && Boolean(title),
    title,
    text,
    url,
    image_url,
  };
}

export function normalizeSiteAds(input = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const incoming = src.slots && typeof src.slots === "object" ? src.slots : src;
  const slots = {};
  for (const row of SITE_AD_SLOTS) {
    slots[row.id] = normalizeSlot(incoming[row.id]);
  }
  return { slots };
}

export function publicSiteAds(input = {}) {
  const cfg = normalizeSiteAds(input);
  const out = {};
  for (const row of SITE_AD_SLOTS) {
    const slot = cfg.slots[row.id];
    out[row.id] = slot.enabled && slot.title
      ? {
        title: slot.title,
        text: slot.text,
        url: slot.url,
        image_url: slot.image_url,
      }
      : null;
  }
  return out;
}

export function adminSiteAdsView(input = {}) {
  return {
    slots: SITE_AD_SLOTS.map((row) => ({ ...row })),
    config: normalizeSiteAds(input),
  };
}
