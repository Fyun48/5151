/** 樂屋網公開頁 adapter：只解析公開 HTML／JSON-LD，不繞過 Cloudflare、登入或驗證碼。 */

import { createHash } from "node:crypto";
import { sanitizeFloorName } from "./floors.js";
import { decodeEntities } from "./htmlEntities.js";
import { hasListingMainContent, looksLikeCaptchaOrLogin, looksLikeChallengePage, looksLikeUnavailable } from "./importSanitize.js";
import { listingKitFields, listingKitFrom } from "./listingKit.js";
import { hasHouseNumber, extractMapFromHtml, sourceMapPin } from "./location.js";
import { feeFieldsFromBlob } from "./listingCost.js";
import { CITIES } from "./regions.js";
import { coverToListUrl } from "./covering.js";

export const RAKUYA_SOURCE = "rakuya";
export const RAKUYA_POST_ID_BASE = 2_700_000_000;
export const RAKUYA_POST_ID_END = 2_800_000_000;
export const RAKUYA_SITE = "https://www.rakuya.com.tw";
export const RAKUYA_RENT_SITE = "https://rent.rakuya.com.tw";
export const RAKUYA_LIST_PATH = "/result";
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
  if (!id) return `${RAKUYA_RENT_SITE}${RAKUYA_LIST_PATH}`;
  return `${RAKUYA_RENT_SITE}/item/${encodeURIComponent(id)}`;
}

// Verified against the portal's city pages; these are NOT 591 region IDs.
const RAKUYA_CITY_CODES = { 1: 0, 2: 1, 3: 2 };
export function rakuyaListUrl({ regionId = "", page = 1 } = {}) {
  const city = RAKUYA_CITY_CODES[Number(regionId)];
  if (city == null) return "";
  const params = new URLSearchParams({ city: String(city) });
  if (Number(page) > 1) params.set("page", String(Number(page) || 1));
  return `${RAKUYA_RENT_SITE}${RAKUYA_LIST_PATH}?${params}`;
}

export function ehidFromRakuyaUrl(pageUrl = "") {
  try {
    const url = new URL(String(pageUrl || ""), RAKUYA_SITE);
    return String(url.searchParams.get("ehid") || (url.pathname.match(/\/(?:rent|item)\/([a-z0-9]+)/i) || [])[1] || "").trim();
  } catch {
    return "";
  }
}

export function districtNameFromRakuyaAddress(address = "") {
  const hay = String(address || "");
  return CITIES.flatMap(city => city.districts).find(district => hay.includes(district.name))?.name || "";
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

export function rakuyaSourceKey({ regionId, sectionId, address, floor, area, layout, ehid }) {
  const addr = String(address || "").replace(/\s+/g, "").toLowerCase();
  // District/road-only data cannot identify a house or inherit another house's flags.
  const identity = !hasHouseNumber(address) && ehid ? `rakuya:${ehid}` : "";
  return [regionId || "", sectionId || "", identity, addr, floor || "", area || "", layout || ""].join("|");
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
  // Current public result pages link the whole card to /item/:id or a
  // community /rent/:id page. Keep this fallback scoped to that one link.
  const linkRe = /<a\b([^>]*\bhref=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi;
  while ((m = linkRe.exec(String(html || "")))) {
    let url;
    try { url = new URL(decodeEntities(m[2]), RAKUYA_RENT_SITE); } catch { continue; }
    if (url.protocol !== "https:" || !["rent.rakuya.com.tw", "community.rakuya.com.tw"].includes(url.hostname)) continue;
    const ehid = ehidFromRakuyaUrl(url.href);
    if (!ehid || seen.has(ehid)) continue;
    const block = m[3];
    const heading = textOf((block.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i) || [])[1]
      || (m[1].match(/\btitle=["']([^"']+)["']/i) || [])[1] || "");
    if (!heading) continue;
    const locationText = textOf(block.replace(/<h[1-4]\b[^>]*>[\s\S]*?<\/h[1-4]>/gi, "")
      .replace(/<(?:del|s)\b[^>]*>[\s\S]*?<\/(?:del|s)>/gi, "")).replace(heading, "");
    const prices = [...new Set([...locationText.matchAll(/([\d,]+)\s*元(?:\s*\/\s*月)?/g)].map(hit => hit[1]))];
    const areas = [...new Set([...locationText.matchAll(/(?:主建|建物|使用)?\s*([\d.]+)\s*坪/g)].map(hit => hit[1]))];
    if (prices.length !== 1 || areas.length !== 1) continue;
    const [price] = prices;
    const [areaName] = areas;
    const names = [...new Set(CITIES.flatMap(city => city.districts).filter(row => locationText.includes(row.name)).map(row => row.name))];
    const district = names.length === 1 ? names[0] : "";
    const kind = (locationText.slice(locationText.indexOf(district) + district.length).match(
      /(整層住家|分租套房|獨立套房|雅房|店面|倉庫|廠房|住辦|商用)(?:\s*[／/]?\s*(電梯大廈|電梯大樓|華廈|公寓|透天厝|別墅|辦公))?/,
    ) || [])[0] || "";
    if (!price || !areaName || !district || !kind) continue;
    const title = heading;
    if (!title) continue;
    seen.add(ehid);
    items.push({
      ehid, url: url.href, title, price, areaName: `${areaName}坪`, kind,
      // A community name or road-only label does not establish a street address.
      address: district,
      layout: (locationText.match(/\d+房(?:\d+廳)?(?:[\d.]+衛)?|開放式格局/) || [])[0] || "",
      floorName: (locationText.match(/(?:B?\d+(?:[~～-]\d+)?\/\d+樓|頂樓加蓋)/i) || [])[0] || "",
      refresh: (locationText.match(/(?:\d+\s*(?:分鐘|小時|天|個月|年)前)更新/) || [])[0]?.replace(/更新$/, "") || "",
      cover: decodeEntities((block.match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i) || [])[1] || ""),
      field_status: { title: "parsed", price: "parsed", address: "district_only" },
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
      ehid,
    }),
    title: String(item.title || "").trim() || "(無標題)",
    url: item.url || rakuyaDetailUrl(ehid, item.communityId),
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
  return /找不到物件|沒有符合|搜尋結果[：:]\s*0(?:\D|$)|(?:^|[^\d])0\s*筆/.test(String(html || ""));
}

/** Repair only orphaned Rakuya associations with an explicit, unambiguous address. */
export function repairRakuyaScopes(conn, jobs) {
  const rows = conn.prepare("SELECT post_id, source_key, address FROM listings WHERE source = 'rakuya' AND search_key = ''").all();
  const update = conn.prepare("UPDATE listings SET search_key = ?, source_key = ? WHERE post_id = ? AND source = 'rakuya' AND search_key = ''");
  let repaired = 0;
  for (const row of rows) {
    const address = String(row.address || "").replaceAll("臺", "台");
    const city = CITIES.find(item => address.includes(item.name.replaceAll("臺", "台")));
    const district = city?.districts.find(item => address.includes(item.name));
    if (!city || !district) continue;
    const job = (jobs || []).find(item => Number(item.regionId) === Number(city.id)
      && (!item.sectionIds?.length || item.sectionIds.map(Number).includes(Number(district.id))));
    if (!job) continue;
    const key = job.searchUrl || coverToListUrl(job);
    if (!key) continue;
    const bits = String(row.source_key || "").split("|");
    bits[0] = String(city.id);
    bits[1] = String(district.id);
    repaired += Number(update.run(key, bits.join("|"), row.post_id).changes);
  }
  return repaired;
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
  const maxPages = Math.max(1, Math.min(12, Number(options.maxPages ?? options.pages) || RAKUYA_MAX_PAGES));
  const batches = [];
  let sourcePaused = false;
  for (const job of jobs || []) {
    if (sourcePaused) break;
    const regionId = Number(job.regionId) || 0;
    const seen = new Set();
    const listings = [];
    const errors = [];
    const searchUrl = job.searchUrl || coverToListUrl(job);
    const city = CITIES.find(row => Number(row.id) === regionId);
    let stopReason = "page_limit";
    // Refresh page one every run; spend the remaining budget continuing coverage.
    const resumePage = Math.max(2, Math.floor(Number(options.startPages?.[regionId]) || 2));
    const pageNumbers = [1, ...Array.from({ length: maxPages - 1 }, (_, i) => resumePage + i)];
    let nextPage = resumePage;
    let headValid = false;
    let resetReason = "";
    for (const page of pageNumbers) {
      const url = rakuyaListUrl({ regionId, page });
      let got;
      try {
        got = url ? await fetchRakuyaListPage({ fetchText, url })
          : { ok: false, code: "UNSUPPORTED_REGION", message: "樂屋網縣市代碼尚未驗證" };
      } catch (error) {
        got = { ok: false, code: error.code || "FETCH_FAILED", message: error.message };
      }
      if (!got.ok) {
        errors.push({ code: got.code, message: got.message || "樂屋網無法抓取", page });
        sourcePaused = ["FETCH_BLOCKED", "RATE_LIMITED"].includes(got.code);
        if (headValid && page > 1 && got.httpStatus === 404) {
          nextPage = 2;
          resetReason = "PAGE_OUT_OF_RANGE";
        }
        stopReason = got.code || "partial";
        break;
      }
      const pageItems = got.items || [];
      if (page === 1) headValid = true;
      let added = 0;
      for (const item of pageItems) {
        const ehid = String(item.ehid || "").trim();
        if (!ehid || seen.has(ehid)) continue;
        seen.add(ehid);
        added += 1;
        const districtName = districtNameFromRakuyaAddress(item.address);
        const district = city?.districts.find(row => row.name === districtName);
        // Do not stamp another district/city onto a result from a broad city page.
        if (!district || (job.sectionIds?.length && !job.sectionIds.map(Number).includes(Number(district.id)))) continue;
        const row = normalizeRakuyaItem(item, {
          regionId,
          sectionId: district.id,
        });
        if (row) {
          listings.push(row);
        }
      }
      if (got.code === "SUCCESS_EMPTY" || !pageItems.length) {
        stopReason = got.code === "SUCCESS_EMPTY" ? "empty" : "end";
        nextPage = 2;
        break;
      }
      if (!added) {
        stopReason = "duplicate";
        nextPage = 2;
        break;
      }
      if (page > 1) nextPage = page + 1;
      if (page !== pageNumbers.at(-1)) await sleep(options.pageGapMs ?? RAKUYA_PAGE_GAP_MS);
    }
    batches.push({
      searchUrl,
      listings,
      total: listings.length,
      errors,
      progress: { regionId, nextPage, resetReason },
      parsed: { label: "樂屋網", source: RAKUYA_SOURCE, href: rakuyaListUrl({ regionId }), stopReason },
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
  if (!judged.ok) return { ...judged, httpStatus: Number(got.status), items: [] };
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
