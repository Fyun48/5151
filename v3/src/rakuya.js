/** 樂屋網公開頁 adapter：只解析公開 HTML／JSON-LD，不繞過 Cloudflare、登入或驗證碼。 */

import { createHash } from "node:crypto";
import { sanitizeFloorName } from "./floors.js";
import { decodeEntities } from "./htmlEntities.js";
import { hasListingMainContent, looksLikeCaptchaOrLogin, looksLikeChallengePage, looksLikeUnavailable } from "./importSanitize.js";
import { listingKitFields, listingKitFrom } from "./listingKit.js";
import { extractMapFromHtml, sourceMapPin } from "./location.js";
import { feeFieldsFromBlob } from "./listingCost.js";

export const RAKUYA_SOURCE = "rakuya";
export const RAKUYA_POST_ID_BASE = 2_700_000_000;
export const RAKUYA_POST_ID_END = 2_800_000_000;
export const RAKUYA_SITE = "https://www.rakuya.com.tw";
export const RAKUYA_LIST_PATH = "/rent_search/index";
export const RAKUYA_PAGE_GAP_MS = 800;
export const RAKUYA_MAX_PAGES = 4;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function isRakuyaListingId(postId) {
  const n = Number(postId);
  return Number.isFinite(n) && n >= RAKUYA_POST_ID_BASE && n < RAKUYA_POST_ID_END;
}

export function rakuyaDetailUrl(ehid, communityId = "") {
  const id = String(ehid || "").trim();
  const community = String(communityId || "").trim();
  if (community && id) return `https://community.rakuya.com.tw/${encodeURIComponent(community)}/rent/${encodeURIComponent(id)}`;
  if (!id) return `${RAKUYA_SITE}${RAKUYA_LIST_PATH}`;
  return `${RAKUYA_SITE}/rent_item/info?ehid=${encodeURIComponent(id)}`;
}

export function rakuyaListUrl({ regionId = "", sectionId = "", page = 1 } = {}) {
  const params = new URLSearchParams({ search: "city", city: String(regionId || "") });
  if (sectionId) params.set("section", String(sectionId));
  if (Number(page) > 1) params.set("page", String(Number(page) || 1));
  return `${RAKUYA_SITE}${RAKUYA_LIST_PATH}?${params}`;
}

export function ehidFromRakuyaUrl(pageUrl = "") {
  try {
    const url = new URL(String(pageUrl || ""), RAKUYA_SITE);
    return String(url.searchParams.get("ehid") || (url.pathname.match(/\/rent\/([a-z0-9]+)/i) || [])[1] || "").trim();
  } catch {
    return "";
  }
}

export function districtNameFromRakuyaAddress(address = "") {
  return String((String(address || "").match(/([\u4e00-\u9fff]{1,3}區)/) || [])[1] || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
}

export function rakuyaPostIdFromEhid(ehid) {
  const key = String(ehid || "").trim();
  if (!key) return 0;
  const digest = createHash("sha256").update(`rakuya:${key}`).digest();
  const span = RAKUYA_POST_ID_END - RAKUYA_POST_ID_BASE;
  return RAKUYA_POST_ID_BASE + (digest.readUInt32BE(0) % span);
}

export function rakuyaSourceKey({ regionId, sectionId, address, floor, area, layout }) {
  const addr = String(address || "").replace(/\s+/g, "").toLowerCase();
  return [regionId || "", sectionId || "", "", addr, floor || "", area || "", layout || ""].join("|");
}

export function interpretRakuyaResponse({ status, text } = {}) {
  const body = String(text || "");
  if (Number(status) === 429) {
    return { ok: false, code: "RATE_LIMITED", retryable: true, message: "樂屋網要求降低抓取頻率" };
  }
  const hasTarget = hasListingMainContent(body);
  if ((looksLikeChallengePage(body) || looksLikeCaptchaOrLogin(body)) && !hasTarget) {
    return { ok: false, code: "FETCH_BLOCKED", retryable: false, message: "樂屋網被 Cloudflare 或驗證擋住，不繞過" };
  }
  if (looksLikeUnavailable(body, status) || Number(status) === 404) {
    return { ok: false, code: "SOURCE_UNAVAILABLE", retryable: false, message: "樂屋網物件不存在或已下架" };
  }
  if (Number(status) >= 400) {
    return { ok: false, code: "SOURCE_UNAVAILABLE", retryable: Number(status) >= 500, message: `樂屋網回傳 ${status}` };
  }
  return { ok: true, pageKind: hasTarget ? "listing" : "unknown" };
}

function textOf(html) {
  return decodeEntities(String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    try {
      const parsed = JSON.parse(m[1]);
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed) out.push(parsed);
    } catch {
      // ignore broken JSON-LD
    }
  }
  return out;
}

export function parseRakuyaListHtml(html) {
  const items = [];
  const seen = new Set();
  const cardRe = /<article[^>]*data-ehid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = cardRe.exec(String(html || "")))) {
    const ehid = m[1];
    if (seen.has(ehid)) continue;
    seen.add(ehid);
    const block = m[2];
    const title = textOf((block.match(/<(?:h2|h3|a)[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\//i) || [])[1] || "")
      || textOf((block.match(/<a[^>]+href=["'][^"']*ehid=[^"']+["'][^>]*>([\s\S]*?)<\/a>/i) || [])[1] || "");
    const address = textOf((block.match(/class=["'][^"']*addr[^"']*["'][^>]*>([\s\S]*?)</i) || [])[1] || "");
    const price = textOf((block.match(/class=["'][^"']*price[^"']*["'][^>]*>([\s\S]*?)</i) || [])[1] || "");
    const area = textOf((block.match(/([\d.]+)\s*坪/) || [])[0] || "");
    const layout = textOf((block.match(/\d+\s*房(?:\d+\s*廳)?/) || [])[0] || "");
    const floor = textOf((block.match(/\d+\s*[FfＦ層](?:\s*\/\s*\d+)?/) || [])[0] || "");
    const cover = decodeEntities((block.match(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/i) || [])[1] || "");
    const communityEl = block.match(/<([a-z0-9]+)[^>]*class=["'][^"']*community[^"']*["'][^>]*>([\s\S]*?)</i);
    const community = textOf(communityEl?.[2] || "");
    const communityLinked = String(communityEl?.[1] || "").toLowerCase() === "a"
      || /<a[^>]*class=["'][^"']*community/i.test(block);
    const refresh = textOf((block.match(/更新[：:]\s*([^<]+)/) || [])[1] || "");
    const kind = textOf((block.match(/類型[：:]\s*([^<]+)/) || [])[1] || (block.match(/(整層住家|獨立套房|分租套房|雅房|店面|倉庫)(?:\s*[／/]\s*[^<]*)?/) || [])[0] || "");
    items.push({
      ehid,
      title,
      address,
      price,
      areaName: area,
      layout,
      floorName: floor,
      cover,
      community,
      communityLinked,
      kind,
      refresh,
      field_status: {
        title: title ? "parsed" : "missing",
        address: address ? "parsed" : "missing",
        price: price ? "parsed" : "missing",
      },
    });
  }
  return items;
}

export function parseRakuyaDetailHtml(html, pageUrl = "") {
  const ld = jsonLdBlocks(html).find((row) => /Apartment|Residence|Offer|Product/i.test(String(row["@type"] || ""))) || {};
  const title = sanitize(ld.name || (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "");
  const address = sanitize(
    (typeof ld.address === "string" ? ld.address : ld.address?.streetAddress)
    || (html.match(/地址[：:]\s*([^<]+)/) || [])[1]
    || "",
  );
  const price = sanitize(ld.offers?.price || (html.match(/租金[：:]\s*([^<]+)/) || [])[1] || "");
  const floorName = sanitize(
    (html.match(/樓層[／\/]樓高[：:\s]*([^<]+)/) || [])[1]
    || (html.match(/樓層[：:]\s*([^<]+)/) || [])[1]
    || "",
  );
  const areaName = sanitize(
    (html.match(/坪數[：:]\s*([^<]+)/) || [])[1]
    || (html.match(/建物面積[：:]\s*([^<]+)/) || [])[1]
    || "",
  );
  const layout = sanitize((html.match(/格局[：:]\s*([^<]+)/) || [])[1] || "");
  const kind = sanitize((html.match(/類型[：:]\s*([^<]+)/) || [])[1] || "");
  const communityHtml = (html.match(/社區[：:]\s*(<a[\s\S]*?<\/a>|[^<]+)/i) || [])[1] || "";
  const community = sanitize(communityHtml);
  const age = sanitize((html.match(/屋齡[：:]\s*([^<]+)/) || [])[1] || "");
  const parking = sanitize((html.match(/車位[：:]\s*([^<]+)/) || [])[1] || "");
  const elevator = sanitize((html.match(/電梯[：:]\s*([^<]+)/) || [])[1] || "");
  const facility = sanitize((html.match(/設備[：:]\s*([^<]+)/) || [])[1] || "");
  const gas = sanitize((html.match(/瓦斯[：:]\s*([^<]+)/) || [])[1] || "");
  const balcony = sanitize((html.match(/陽台[：:]\s*([^<]+)/) || [])[1] || "");
  const kit = listingKitFrom({
    title,
    tags: [facility, gas, balcony],
    text: `${facility} ${gas} ${balcony} ${textOf(html)}`,
    facility,
  });
  const ehid = ehidFromRakuyaUrl(pageUrl);
  const geo = ld.geo && typeof ld.geo === "object" ? ld.geo : {};
  const map = extractMapFromHtml(html);
  const pin = sourceMapPin(RAKUYA_SOURCE, geo.latitude ?? geo.lat ?? map?.lat, geo.longitude ?? geo.lng ?? geo.lon ?? map?.lng);
  const photos = [];
  const imgRe = /<(?:img|meta)[^>]+(?:src|content)=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/gi;
  let m;
  while ((m = imgRe.exec(String(html || "")))) {
    try { photos.push(new URL(m[1], pageUrl || RAKUYA_SITE).toString()); } catch { /* skip */ }
  }
  const photoCountMatch = String(html || "").match(/照片\s*(\d+)\s*\/\s*(\d+)/);
  const sourcePhotoCount = photoCountMatch ? Number(photoCountMatch[2]) : photos.length;
  return {
    ehid,
    title,
    address,
    price,
    floorName,
    areaName,
    layout,
    kind,
    community,
    communityLinked: /<a\b/i.test(communityHtml),
    age,
    parking,
    elevator,
    facility,
    has_natural_gas: kit.has_natural_gas,
    has_balcony: kit.has_balcony,
    furnish_items: kit.furnish_items,
    photos: [...new Set(photos)],
    sourcePhotoCount,
    parsedPhotoCount: [...new Set(photos)].length,
    lat: pin.lat,
    lng: pin.lng,
    field_status: {
      title: title ? "parsed" : "missing",
      address: address ? "parsed" : "missing",
      price: price ? "parsed" : "missing",
      floor: floorName ? "parsed" : "missing",
      area: areaName ? "parsed" : "missing",
      latlng: pin.lat != null ? "parsed" : "not_provided",
    },
  };
}

function sanitize(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function normalizeRakuyaItem(item, { regionId = "", sectionId = "" } = {}) {
  const ehid = String(item.ehid || "").trim();
  const postId = rakuyaPostIdFromEhid(ehid);
  if (!postId) return null;
  const priceNum = Number(String(item.price || "").replace(/[^\d.]/g, ""));
  const floor = sanitizeFloorName(item.floorName || item.floor_name);
  const area = String(item.areaName || item.area_name || "");
  const layout = String(item.layout || "");
  const address = String(item.address || "");
  const pin = sourceMapPin(RAKUYA_SOURCE, item.lat, item.lng);
  return {
    post_id: postId,
    source: RAKUYA_SOURCE,
    source_id: ehid,
    source_key: rakuyaSourceKey({
      regionId,
      sectionId,
      address,
      floor,
      area,
      layout,
    }),
    title: String(item.title || "").trim() || "(無標題)",
    url: rakuyaDetailUrl(ehid, item.communityId),
    price: Number.isFinite(priceNum) && priceNum > 0 ? String(Math.round(priceNum)) : "",
    price_num: Number.isFinite(priceNum) && priceNum > 0 ? Math.round(priceNum) : 0,
    ...feeFieldsFromBlob({ blob: String(item.price || "") }),
    address,
    address_raw: address,
    area_name: area,
    layout,
    floor_name: floor,
    ...listingKitFields({
      title: item.title,
      tags: item.tags,
      text: `${item.address || ""} ${item.community || ""} ${item.facility || ""}`,
      facility: item.facility,
      has_natural_gas: item.has_natural_gas,
      has_balcony: item.has_balcony,
      furnish_items: item.furnish_items,
    }),
    kind_name: String(item.kind || item.kind_name || "").trim(),
    role_name: "樂屋網",
    cover: String(item.cover || item.photos?.[0] || "").trim(),
    community_id: 0,
    community_name: String(item.community || ""),
    community_linked: item.communityLinked ? 1 : 0,
    tags: JSON.stringify([]),
    refresh_time: String(item.refresh || ""),
    lat: pin.lat,
    lng: pin.lng,
    geo_source: pin.geo_source,
    field_status: item.field_status || {},
    contact_fetched: 0,
  };
}

function looksLikeRakuyaEmptyResult(html) {
  return /找不到物件|沒有符合|搜尋結果[：:]\s*0|0\s*筆/.test(String(html || ""));
}

export async function fetchRakuyaCoveringListings(jobs, options = {}) {
  const fetchText = options.fetchText || (async (url) => {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return { status: res.status, text };
  });
  const maxPages = Math.max(1, Number(options.maxPages || RAKUYA_MAX_PAGES) || RAKUYA_MAX_PAGES);
  const batches = [];
  for (const job of jobs || []) {
    const regionId = Number(job.regionId) || 0;
    const seen = new Set();
    const listings = [];
    let stopReason = "complete";
    for (let page = 1; page <= maxPages; page += 1) {
      const url = rakuyaListUrl({ regionId, page });
      const got = await fetchRakuyaListPage({ fetchText, url });
      if (!got.ok) {
        if (!listings.length) {
          throw Object.assign(new Error(got.message || "樂屋網無法抓取"), { code: got.code, retryable: got.retryable });
        }
        stopReason = got.code || "partial";
        break;
      }
      const pageItems = got.items || [];
      let added = 0;
      for (const item of pageItems) {
        const ehid = String(item.ehid || "").trim();
        if (!ehid || seen.has(ehid)) continue;
        seen.add(ehid);
        const row = normalizeRakuyaItem(item, {
          regionId,
          sectionId: districtNameFromRakuyaAddress(item.address),
        });
        if (row) {
          listings.push(row);
          added += 1;
        }
      }
      if (got.code === "SUCCESS_EMPTY" || !pageItems.length) {
        stopReason = got.code === "SUCCESS_EMPTY" ? "empty" : "end";
        break;
      }
      if (!added) {
        stopReason = "duplicate";
        break;
      }
      if (page < maxPages) await sleep(options.pageGapMs ?? RAKUYA_PAGE_GAP_MS);
    }
    if (listings.length === 0 && stopReason === "complete") stopReason = "end";
    batches.push({
      listings,
      total: listings.length,
      parsed: { label: "樂屋網", source: RAKUYA_SOURCE, stopReason },
    });
  }
  return batches;
}

export async function fetchRakuyaListPage({ fetchText, url } = {}) {
  if (typeof fetchText !== "function") {
    return { ok: false, code: "FETCH_BLOCKED", items: [], message: "抓取器未提供" };
  }
  const got = await fetchText(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
  const html = got.text || got.body || "";
  const judged = interpretRakuyaResponse({ status: got.status, text: html });
  if (!judged.ok) return { ...judged, items: [] };
  const items = parseRakuyaListHtml(html);
  if (!items.length) {
    if (looksLikeRakuyaEmptyResult(html)) {
      return { ok: true, code: "SUCCESS_EMPTY", items: [] };
    }
    return { ok: false, code: "PARSE_FAILED", items: [], message: "樂屋網列表模板不符或解析失敗" };
  }
  return { ok: true, items };
}

export async function fetchRakuyaDetail(listing, options = {}) {
  const { fetchSourceKitPage } = await import("./sourceKit.js");
  const page = await fetchSourceKitPage(listing, {
    ...options,
    fallbackUrl: rakuyaDetailUrl(listing?.source_id),
  });
  const judged = interpretRakuyaResponse({ status: page.status, text: page.text });
  if (!judged.ok) {
    throw Object.assign(new Error(judged.message || "樂屋網詳情無法抓取"), {
      code: judged.code,
      retryable: judged.retryable,
    });
  }
  const detail = parseRakuyaDetailHtml(page.text, page.url);
  if (!detail.title && !detail.address) {
    throw Object.assign(new Error("樂屋網詳情無法解析房屋資訊"), { code: "KIT_PARSE_EMPTY" });
  }
  return detail;
}

export async function fetchRakuyaDetailKit(listing, options = {}) {
  const detail = await fetchRakuyaDetail(listing, options);
  return listingKitFrom({
    has_natural_gas: detail.has_natural_gas,
    has_balcony: detail.has_balcony,
    furnish_items: detail.furnish_items,
    facility: detail.facility,
    text: `${detail.facility || ""} ${detail.title || ""}`,
    kit_complete: true,
  });
}
