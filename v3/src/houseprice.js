import { createHash } from "node:crypto";
import { passesAttributeFilters } from "./floors.js";
import { isExcludedByKeyword } from "./geo.js";
import { feeFieldsFromBlob } from "./listingCost.js";
import { zipForDistrict } from "./hbhousing.js";
import { lookupDistrict } from "./regions.js";

export const HP_SOURCE = "houseprice";
export const HP_POST_ID_BASE = 2_400_000_000;
export const HP_POST_ID_END = 2_500_000_000;
export const HP_PAGE_ROWS = 20;
export const HP_SITE = "https://rent.houseprice.tw";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 5168 area.json 的 sid（台北與 591 section 相同；新北不同，用郵遞區號對）。 */
export const HP_SID_BY_ZIP = {
  100: 1,
  103: 2,
  104: 3,
  105: 4,
  106: 5,
  108: 6,
  110: 7,
  111: 8,
  112: 9,
  114: 10,
  115: 11,
  116: 12,
  220: 15,
  221: 16,
  231: 23,
  234: 26,
  235: 27,
  236: 28,
  237: 29,
  238: 30,
  239: 31,
  241: 32,
  242: 33,
  243: 34,
  244: 35,
  247: 36,
  248: 37,
  249: 38,
  251: 39,
  252: 40,
};

export function isHpListingId(postId) {
  const n = Number(postId);
  return Number.isFinite(n) && n >= HP_POST_ID_BASE && n < HP_POST_ID_END;
}

export function hpSidForDistrict(regionId, sectionId) {
  const zip = zipForDistrict(regionId, sectionId);
  const sid = HP_SID_BY_ZIP[Number(zip)];
  return Number.isFinite(sid) ? sid : 0;
}

export function hpListUrl({ sid, page = 1 } = {}) {
  const path = `住宅_usage/${Number(sid)}_zip/`;
  return `${HP_SITE}/list/${path}?p=${Math.max(1, Number(page) || 1)}`;
}

export function hpDetailUrl(id) {
  const key = String(id || "").trim();
  if (!key) return `${HP_SITE}/`;
  return `${HP_SITE}/house/${encodeURIComponent(key)}`;
}

export function hpPostIdFromCase(id) {
  const key = String(id || "").trim();
  if (!key) return 0;
  const digest = createHash("sha256").update(`houseprice:${key}`).digest();
  const span = HP_POST_ID_END - HP_POST_ID_BASE;
  return HP_POST_ID_BASE + (digest.readUInt32BE(0) % span);
}

export function kindFromHpText(text) {
  const hay = String(text || "");
  if (/整層住家/.test(hay)) return "整層住家";
  if (/雅房/.test(hay)) return "雅房";
  if (/分租套房/.test(hay)) return "分租套房";
  if (/獨立套房/.test(hay)) return "獨立套房";
  if (/套房/.test(hay)) return "獨立套房";
  if (/倉庫|廠房/.test(hay)) return "倉庫";
  if (/店面/.test(hay)) return "店面";
  if (/辦公|土地/.test(hay)) return "";
  return "";
}

function listingSourceKey({ regionId, sectionId, address, floorName, areaName, layout }) {
  const addr = String(address || "").replace(/\s+/g, "").toLowerCase();
  const floor = String(floorName || "").split("/")[0].trim();
  const area = String(areaName || "").replace(/坪/g, "");
  return [regionId || "", sectionId || "", "", addr, floor, area, layout].join("|");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function stripTags(html) {
  return decodeEntities(String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function isHpPlaceholderCover(url) {
  const text = String(url || "").toLowerCase();
  return /default_cover|no[_-]?photo|placeholder|noimage|nopic/.test(text);
}

function collectHpImageUrls(card) {
  const html = String(card || "");
  const found = [];
  const attrRe = /(?:src|data-src|data-original|data-lazy|data-bg)\s*=\s*"([^"]+)"/gi;
  let attr;
  while ((attr = attrRe.exec(html))) found.push(attr[1]);
  const srcsetRe = /srcset\s*=\s*"([^"]+)"/gi;
  let set;
  while ((set = srcsetRe.exec(html))) {
    for (const part of String(set[1] || "").split(",")) {
      const url = part.trim().split(/\s+/)[0];
      if (url) found.push(url);
    }
  }
  const out = [];
  const seen = new Set();
  for (const raw of found) {
    const url = decodeEntities(raw).trim();
    if (!url || seen.has(url)) continue;
    if (/^data:/i.test(url)) continue;
    if (/\.svg(\?|$)/i.test(url)) continue;
    if (isHpPlaceholderCover(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function pickHpCover(card) {
  const urls = collectHpImageUrls(card);
  const preferred = urls.find((url) => /image\.houseprice\.tw|hpimage|\/house\/.*\.(jpe?g|png|webp)/i.test(url));
  return preferred || urls[0] || "";
}

export function titleFromHpCard(card) {
  const block = String(card || "").match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  return stripTags(block?.[1] || "");
}

export function parseHpListHtml(html) {
  const source = String(html || "");
  const totalMatch = source.match(/共有[\s\S]{0,240}?<span[^>]*>\s*([\d,]+)\s*<\/span>[\s\S]{0,40}?筆/);
  const total = Number(totalMatch?.[1]) || 0;
  const marker = "<a href=https://rent.houseprice.tw/house/";
  const parts = source.split(marker);
  const items = [];
  for (const part of parts.slice(1)) {
    const end = part.indexOf("</section>");
    const card = marker + (end >= 0 ? part.slice(0, end + "</section>".length) : part);
    const idMatch = card.match(/house\/(\d+(?:_\d+)?)/);
    if (!idMatch) continue;
    const cover = pickHpCover(card);
    const title = titleFromHpCard(card);
    const addressMatch = card.match(/location-filled[\s\S]{0,180}?<span>\s*([^<]+)\s*<\/span>/i)
      || card.match(/台北市[^<]{2,40}區[^<]{0,40}/)
      || card.match(/新北市[^<]{2,40}區[^<]{0,40}/);
    const communityMatch = card.match(/building-fill[\s\S]{0,180}?<span>\s*([^<]+)\s*<\/span>/i);
    const priceMatch = card.match(/>(\d{3,})\s*<\/span>\s*<span[^>]*>元\/月/);
    const kind = kindFromHpText(card);
    const areaMatch = stripTags(card).match(/([\d.]+)\s*坪/);
    const layoutMatch = stripTags(card).match(/(\d+\s*房[\d廳衛陽台\s]*)/);
    const floorMatch = stripTags(card).match(/(\d+\s*\/\s*\d+)\s*樓/);
    items.push({
      id: idMatch[1],
      title,
      address: decodeEntities(String(addressMatch?.[1] || addressMatch?.[0] || "").trim()),
      community: decodeEntities(String(communityMatch?.[1] || "").trim()),
      cover,
      price: Number(priceMatch?.[1]) || 0,
      kind,
      areaName: areaMatch ? `${areaMatch[1].replace(/\.0$/, "")}坪` : "",
      layout: layoutMatch ? layoutMatch[1].replace(/\s+/g, "") : "",
      floorName: floorMatch ? floorMatch[1].replace(/\s+/g, "") : "",
      text: stripTags(card),
    });
  }
  return { total: total || items.length, items };
}

export function normalizeHpItem(item, { regionId, sectionId } = {}) {
  const id = String(item?.id || "").trim();
  const kindName = item?.kind || kindFromHpText(item?.text);
  if (!id || !kindName) return null;
  const region = Number(regionId) || 0;
  const section = Number(sectionId) || 0;
  const address = String(item.address || "").trim();
  const areaName = String(item.areaName || "").trim();
  const layout = String(item.layout || "").trim();
  const floorName = String(item.floorName || "").trim();
  const priceNum = Number(item.price) || 0;
  const tags = ["5168", item.community].filter((row) => String(row || "").trim());
  return {
    post_id: hpPostIdFromCase(id),
    source: HP_SOURCE,
    source_id: id,
    source_key: listingSourceKey({
      regionId: region,
      sectionId: section,
      address,
      floorName,
      areaName,
      layout,
    }),
    title: String(item.title || "").trim() || "(無標題)",
    url: hpDetailUrl(id),
    price: priceNum ? String(priceNum) : "",
    price_num: priceNum,
    ...feeFieldsFromBlob({ blob: `${item.title || ""} ${item.text || ""} ${item.community || ""}` }),
    extra_fees_fetched: 0,
    address,
    area_name: areaName,
    layout,
    floor_name: floorName,
    kind_name: kindName,
    role_name: "5168租屋",
    cover: String(item.cover || "").trim(),
    community_id: 0,
    community_name: String(item.community || "").trim(),
    tags: JSON.stringify(tags),
    refresh_time: "",
    lat: null,
    lng: null,
    geo_source: null,
    contact_fetched: 1,
  };
}

function inPriceRange(listing, priceMin, priceMax) {
  const n = Number(listing?.price_num) || 0;
  if (Number(priceMin) > 0 && n < Number(priceMin)) return false;
  if (Number(priceMax) > 0 && n > Number(priceMax)) return false;
  return true;
}

export function keepHpListing(listing, options = {}) {
  if (!listing?.post_id) return false;
  if (!inPriceRange(listing, options.priceMin, options.priceMax)) return false;
  if (isExcludedByKeyword(listing, options.excludeKeywords)) return false;
  if (!passesAttributeFilters(listing, options)) return false;
  return true;
}

async function defaultGetHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      Referer: `${HP_SITE}/`,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    throw new Error(`5168 暫時無法抓取（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(`5168 搜尋 ${res.status}`);
  return res.text();
}

export async function fetchHpPage({ sid, page = 1, getHtml = defaultGetHtml } = {}) {
  const html = await getHtml(hpListUrl({ sid, page }));
  return parseHpListHtml(html);
}

export async function fetchHpCoveringListings(jobs, options = {}) {
  const pages = Math.max(1, Math.min(Number(options.pages) || 8, 12));
  const getHtml = options.getHtml || defaultGetHtml;
  const batches = [];
  const seen = new Set();

  for (const job of jobs || []) {
    const regionId = Number(job.regionId) || 0;
    const sectionIds = [...new Set((job.sectionIds || []).map(Number).filter((id) => id > 0))];
    const targets = [];
    for (const sectionId of sectionIds) {
      const sid = hpSidForDistrict(regionId, sectionId);
      if (sid && !targets.some((row) => row.sid === sid)) targets.push({ sid, sectionId });
    }
    if (!targets.length) continue;

    const listings = [];
    let total = 0;
    const names = [];
    for (const { sid, sectionId } of targets) {
      const district = lookupDistrict(`${regionId}-${sectionId}`);
      if (district?.name) names.push(district.name.replace(/區$/, ""));
      let sidTotal = 0;
      for (let page = 1; page <= pages; page += 1) {
        const result = await fetchHpPage({ sid, page, getHtml });
        if (page === 1) {
          sidTotal = Number(result.total) || 0;
          total += sidTotal;
        }
        for (const item of result.items) {
          const id = String(item.id || "");
          if (!id || seen.has(id)) continue;
          const row = normalizeHpItem(item, { regionId, sectionId });
          if (!row) continue;
          if (!keepHpListing(row, {
            ...options,
            priceMin: job.priceMin,
            priceMax: job.priceMax,
          })) continue;
          seen.add(id);
          listings.push(row);
        }
        if (result.items.length < HP_PAGE_ROWS || page * HP_PAGE_ROWS >= sidTotal) break;
        if (page < pages) await new Promise((resolve) => setTimeout(resolve, options.gapMs ?? 400));
      }
    }

    batches.push({
      searchUrl: job.searchUrl,
      parsed: {
        label: `5168 · ${names.join("、") || `地區 ${regionId}`}`,
        href: `${HP_SITE}/`,
      },
      total,
      listings,
    });
  }

  return batches;
}
