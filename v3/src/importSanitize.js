/** 匯入文字清洗：不信任來源 HTML；去掉腳本、聯絡資訊與不安全標記。 */

import { decodeEntities } from "./htmlEntities.js";
import { containsUnsafeMarkup } from "./safeContent.js";
import { SELF_BODY_MAX, SELF_TITLE_MAX } from "./selfListings.js";

const PHONE_RE = /(?:\+?886[-\s]?)?(?:0?9\d{2}[-\s]?\d{3}[-\s]?\d{3}|0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{3,4})/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LINE_RE = /(?:line\s*id|line\s*帳號|賴|LINE)[:：\s]+[A-Za-z0-9._-]{2,40}/gi;
const CONTACT_LABEL_RE = /(?:聯絡人|屋主|仲介|代理人|手機|電話|聯絡電話)[:：]\s*[^\n]{0,40}/g;

export function stripTagsPreserveBreaks(html) {
  let text = decodeEntities(String(html || ""));
  text = text
    .replace(/<\s*script[\s\S]*?>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*(iframe|object|embed|style)[\s\S]*?>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*p\s*>/gi, "\n\n")
    .replace(/<\s*\/\s*(div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ");
  return text;
}

export function stripContactNoise(text) {
  return String(text || "")
    .replace(PHONE_RE, " ")
    .replace(EMAIL_RE, " ")
    .replace(LINE_RE, " ")
    .replace(CONTACT_LABEL_RE, " ");
}

export function normalizeImportedPlain(text, max) {
  let out = String(text || "").replace(/\0/g, "").replace(/\r\n/g, "\n");
  out = stripContactNoise(out);
  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (containsUnsafeMarkup(out)) {
    out = out.replace(/javascript\s*:/gi, "").replace(/on[a-z]+\s*=/gi, "").replace(/<[^>]+>/g, "");
  }
  return out.slice(0, max);
}

export function sanitizeImportedTitle(value) {
  const raw = stripTagsPreserveBreaks(value).replace(/\n+/g, " ");
  return normalizeImportedPlain(raw, SELF_TITLE_MAX);
}

export function sanitizeImportedText(value) {
  const raw = stripTagsPreserveBreaks(value);
  return normalizeImportedPlain(raw, SELF_BODY_MAX);
}

export function hasListingMainContent(html) {
  const hay = String(html || "");
  if (/data-ehid\s*=/.test(hay)) return true;
  if (/rent_item\/info\?ehid=/.test(hay)) return true;
  if (/href=["'](?:https:\/\/rent\.rakuya\.com\.tw)?\/item\/[a-z0-9]+/i.test(hay) && /[\d,]+\s*元/.test(hay)) return true;
  if (/community\.rakuya\.com\.tw\/\d+\/rent\/[a-z0-9]+/i.test(hay)) return true;
  if (/物件詳情/.test(hay) && /租金/.test(hay)) return true;
  if (/<h1[\s\S]{0,240}<\/h1>/.test(hay) && /格局|樓層[／\/]樓高|樓層[：:]/.test(hay)) return true;
  return false;
}

export function looksLikeChallengePage(html) {
  const hay = String(html || "");
  return /just a moment/i.test(hay)
    || /cf-browser-verification|cf-challenge-running|cdn-cgi\/challenge-platform/i.test(hay);
}

export function looksLikeCaptchaOrLogin(html) {
  const hay = String(html || "");
  if (hasListingMainContent(hay)) return false;
  return /recaptcha|hcaptcha|cf-challenge|請先登入|會員登入|login-form|id=["']captcha|name=["']captcha|驗證碼/i.test(hay);
}

export function looksLikeUnavailable(html, status) {
  if (Number(status) === 404 || Number(status) === 410) return true;
  const hay = String(html || "");
  if (hasListingMainContent(hay)) return false;
  return /物件不存在|已關閉|已刪除|已下架|找不到此物件|此物件已不存在|page not found/i.test(hay);
}

export function uniqueUrls(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const url = String(raw || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
