/** 5168（rent.houseprice.tw）公開物件頁 adapter：只解析公開 HTML，不走未授權的內部 API。 */

import { decodeEntities } from "./htmlEntities.js";
import {
  looksLikeCaptchaOrLogin,
  looksLikeUnavailable,
  sanitizeImportedText,
  sanitizeImportedTitle,
  uniqueUrls,
} from "./importSanitize.js";
import { FETCH_LIMITS } from "./safeFetch.js";

const PLACEHOLDER_RE = /default_cover|no[_-]?photo|placeholder|noimage|nopic|logo_default|rent_1200x628_5168/i;

export function canHandle5168(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase() === "rent.houseprice.tw";
  } catch {
    return false;
  }
}

function attr(html, name) {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  return decodeEntities((html.match(re) || [])[1] || "");
}

function metaContent(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key}["'][^>]*>`, "ig");
  const found = [];
  let m;
  while ((m = re.exec(html))) found.push(attr(m[0], "content"));
  return found.filter(Boolean);
}

function collectImgUrls(html, pageUrl) {
  const found = [];
  const attrRe = /(?:src|data-src|data-original|data-lazy)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attrRe.exec(html))) found.push(m[1]);
  for (const raw of metaContent(html, "og:image")) found.push(raw);
  const out = [];
  for (const raw of found) {
    const text = decodeEntities(raw).trim();
    if (!text || /^data:/i.test(text) || /\.svg(\?|$)/i.test(text) || PLACEHOLDER_RE.test(text)) continue;
    try {
      out.push(new URL(text, pageUrl).toString());
    } catch {
      // skip
    }
  }
  return uniqueUrls(out);
}

function extractTitle(html) {
  const h1 = decodeEntities((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "");
  const og = metaContent(html, "og:title")[0] || "";
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  return sanitizeImportedTitle(h1 || og.replace(/\s*[-|].*(5168|租屋比價).*$/i, "") || title.replace(/\s*[-|].*(5168|租屋比價).*$/i, ""));
}

function extractText(html) {
  const og = metaContent(html, "og:description")[0] || "";
  const desc = metaContent(html, "description")[0] || "";
  const blocks = [];
  const re = /<(?:div|section|article|p)[^>]*(?:class|id)=["'][^"']*(?:house-desc|detail|intro|content)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section|article|p)>/ig;
  let m;
  while ((m = re.exec(html))) blocks.push(m[1]);
  const fromBlocks = blocks.map((b) => sanitizeImportedText(b)).filter((t) => t.length >= 8);
  return fromBlocks[0] || sanitizeImportedText(og || desc);
}

export function parse5168Listing(html, pageUrl = "") {
  const document = String(html || "");
  return {
    title: extractTitle(document),
    text: extractText(document),
    photos: collectImgUrls(document, pageUrl),
  };
}

export function interpret5168Response({ status, text }) {
  if (looksLikeCaptchaOrLogin(text)) {
    return { ok: false, code: "FETCH_BLOCKED", message: "來源要求登入或驗證，無法以公開方式匯入" };
  }
  if (looksLikeUnavailable(text, status) || Number(status) === 404) {
    return { ok: false, code: "SOURCE_UNAVAILABLE", message: "來源物件不存在或已下架" };
  }
  if (Number(status) >= 400) {
    return { ok: false, code: "SOURCE_UNAVAILABLE", message: `來源回傳 ${status}，無法匯入` };
  }
  return { ok: true };
}

export async function fetchPublic5168Listing(url, { fetchText } = {}) {
  if (typeof fetchText !== "function") {
    const err = new Error("抓取器未提供");
    err.status = 500;
    err.code = "FETCH_BLOCKED";
    throw err;
  }
  const got = await fetchText(url);
  const gate = interpret5168Response(got);
  if (!gate.ok) {
    const err = new Error(gate.message);
    err.status = 400;
    err.code = gate.code;
    throw err;
  }
  const parsed = parse5168Listing(got.text, got.url || url);
  if (!parsed.title && !parsed.text) {
    const err = new Error("無法從 5168 公開頁解析物件內容");
    err.status = 400;
    err.code = "PARSE_FAILED";
    throw err;
  }
  return {
    provider: "5168",
    title: parsed.title,
    text: parsed.text,
    photos: parsed.photos.slice(0, FETCH_LIMITS.maxPhotos),
    fetched_url: got.url || url,
  };
}
