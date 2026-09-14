/** 5168（rent.houseprice.tw）公開物件頁 adapter：公開 HTML 與公開明細 JSON。 */

import { decodeEntities } from "./htmlEntities.js";
import {
  looksLikeCaptchaOrLogin,
  looksLikeUnavailable,
  sanitizeImportedText,
  sanitizeImportedTitle,
  uniqueUrls,
} from "./importSanitize.js";
import {
  hpDetailApiUrl,
  hpDetailIdentityValue,
  hpDetailMatchesExpectedId,
  hpIdFromUrl,
  parseHpDetailHtml,
  parseHpDetailJson,
} from "./houseprice.js";
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

function verifiedHpDetail(detail, expectedId) {
  if (!detail) return null;
  const expected = String(expectedId || "").trim();
  if (!expected) return null;
  return hpDetailMatchesExpectedId(detail, expected) ? detail : null;
}

function emptyParsedListing(reason = "id_missing") {
  return {
    title: "",
    description: "",
    text: "",
    photos: [],
    address: "",
    floor_name: "",
    community: "",
    layout: "",
    area_name: "",
    kind: "",
    htmlVerified: false,
    identityReason: reason,
  };
}

function identityReasonFor(detail, expectedId) {
  const expected = String(expectedId || "").trim();
  if (!expected) return "id_missing";
  return hpDetailIdentityValue(detail) ? "id_mismatch" : "id_missing";
}

function structureSummaryLines(detail) {
  return [
    detail.community ? `社區 ${detail.community}` : "",
    detail.floorName ? `樓層 ${detail.floorName}` : "",
    detail.address ? `地址 ${detail.address}` : "",
    detail.layout || "",
    detail.areaName || "",
  ].filter(Boolean);
}

function formatListingText(description, detail) {
  const descLines = String(description || "").split(/\n+/).map((row) => row.trim()).filter(Boolean);
  const seen = new Set(descLines);
  const lines = [...descLines];
  for (const row of structureSummaryLines(detail)) {
    if (seen.has(row)) continue;
    seen.add(row);
    lines.push(row);
  }
  return lines.join("\n");
}

function listingFieldsFromVerifiedDetail(detail, extras = {}) {
  const description = extras.description || "";
  return {
    title: extras.title || sanitizeImportedTitle(detail.title || ""),
    description,
    text: formatListingText(description, detail),
    photos: extras.photos || [],
    address: detail.address || "",
    floor_name: detail.floorName || "",
    community: detail.community || "",
    layout: detail.layout || "",
    area_name: detail.areaName || "",
    kind: detail.kind || "",
    htmlVerified: extras.htmlVerified === true,
    identityReason: "",
  };
}

function chooseVerified5168Listing(parsed, jsonDetail) {
  if (jsonDetail && parsed?.htmlVerified) {
    const jsonTitle = sanitizeImportedTitle(jsonDetail.title || "");
    return listingFieldsFromVerifiedDetail(jsonDetail, {
      title: jsonTitle || parsed.title,
      description: parsed.description,
      photos: parsed.photos,
      htmlVerified: true,
    });
  }
  if (jsonDetail) return listingFieldsFromVerifiedDetail(jsonDetail);
  if (parsed?.htmlVerified) return parsed;
  return null;
}

function identityError(reason) {
  const err = new Error(
    reason === "id_mismatch"
      ? "公開頁物件身分與請求不符，無法匯入"
      : "無法確認公開頁物件身分，無法匯入",
  );
  err.status = 400;
  err.code = reason === "id_mismatch" ? "IDENTITY_MISMATCH" : "IDENTITY_MISSING";
  return err;
}

export function parse5168Listing(html, pageUrl = "") {
  const document = String(html || "");
  const expectedId = hpIdFromUrl(pageUrl);
  const parsedDetail = parseHpDetailHtml(document);
  const detail = verifiedHpDetail(parsedDetail, expectedId);
  if (!detail) return emptyParsedListing(identityReasonFor(parsedDetail, expectedId));
  return listingFieldsFromVerifiedDetail(detail, {
    title: extractTitle(document),
    description: extractText(document),
    photos: collectImgUrls(document, pageUrl),
    htmlVerified: true,
  });
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
  const id = hpIdFromUrl(got.url || url);
  let jsonDetail = null;
  if (id) {
    try {
      const api = await fetchText(hpDetailApiUrl(id));
      jsonDetail = verifiedHpDetail(parseHpDetailJson(api.text || api), id);
    } catch {
      jsonDetail = null;
    }
  }
  // HTML、JSON 各自核對請求物件。兩者都相符時保留 JSON 未提供的可信 HTML 描述與照片；
  // 錯誤或未驗證 HTML 不得參與補充，此時只採用已驗證 JSON。
  const chosen = chooseVerified5168Listing(parsed, jsonDetail);
  if (!chosen) throw identityError(parsed.identityReason);
  if (!chosen.title && !chosen.text) {
    const err = new Error("無法從 5168 公開頁解析物件內容");
    err.status = 400;
    err.code = "PARSE_FAILED";
    throw err;
  }
  return {
    provider: "5168",
    title: chosen.title,
    text: chosen.text,
    photos: (chosen.photos || []).slice(0, FETCH_LIMITS.maxPhotos),
    address: chosen.address || "",
    floor_name: chosen.floor_name || "",
    community: chosen.community || "",
    layout: chosen.layout || "",
    area_name: chosen.area_name || "",
    kind: chosen.kind || "",
    fetched_url: got.url || url,
  };
}
