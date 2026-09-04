import { createHash } from "node:crypto";
import { passesAttributeFilters } from "./floors.js";
import { isExcludedByKeyword } from "./geo.js";
import { feeFieldsFromBlob } from "./listingCost.js";
import { lookupDistrict } from "./regions.js";

export const DD_SOURCE = "ddroom";
export const DD_POST_ID_BASE = 2_500_000_000;
export const DD_POST_ID_END = 2_600_000_000;
export const DD_PAGE_ROWS = 20;
export const DD_LIST_URL = "https://api.dd-room.com/api/v1/search";
export const DD_SITE = "https://www.dd-room.com";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function isDdListingId(postId) {
  const n = Number(postId);
  return Number.isFinite(n) && n >= DD_POST_ID_BASE && n < DD_POST_ID_END;
}

export function ddCityName(regionId) {
  if (Number(regionId) === 1) return "臺北市";
  if (Number(regionId) === 3) return "新北市";
  return "";
}

export function ddDetailUrl(objectId) {
  const id = String(objectId || "").trim();
  if (!id) return `${DD_SITE}/search`;
  return `${DD_SITE}/object/${encodeURIComponent(id)}`;
}

export function ddPostIdFromObject(objectId) {
  const key = String(objectId || "").trim();
  if (!key) return 0;
  const digest = createHash("sha256").update(`ddroom:${key}`).digest();
  const span = DD_POST_ID_END - DD_POST_ID_BASE;
  return DD_POST_ID_BASE + (digest.readUInt32BE(0) % span);
}

export function ddSearchParams({ city, area, page = 1, perPage = DD_PAGE_ROWS } = {}) {
  const params = new URLSearchParams();
  params.set("theme", "");
  params.set("city", city || "");
  if (area) params.set("area", area);
  params.set("keywords", "");
  params.set("order", "recommend");
  params.set("sort", "desc");
  params.set("category", "house");
  params.set("page", String(Math.max(1, Number(page) || 1)));
  params.set("per_page", String(Math.max(1, Math.min(Number(perPage) || DD_PAGE_ROWS, 20))));
  return params;
}

export function parseDdApiBody(body) {
  const search = body?.data?.search && typeof body.data.search === "object" ? body.data.search : {};
  const items = Array.isArray(search.items) ? search.items : [];
  const total = Number(search.total);
  return {
    total: Number.isFinite(total) ? total : items.length,
    items: items.filter((row) => row && typeof row === "object" && row.object_id),
    lastPage: Number(search.last_page) || 0,
  };
}

export function kindFromDdItem(item) {
  const space = String(item?.type_space || "").toLowerCase();
  const name = String(item?.type_space_name || item?.title || "");
  if (/店面|辦公|廠房|車位|土地/.test(name) || space === "shop" || space === "office") return "";
  if (space === "room" || /雅房/.test(name)) return "雅房";
  if (space === "share" || /分租/.test(name)) return "分租套房";
  if (space === "studio" || /套房/.test(name)) return "獨立套房";
  if (space === "whole" || /整層/.test(name)) return "整層住家";
  return "";
}

function layoutFromItem(item) {
  const pattern = item?.pattern && typeof item.pattern === "object" ? item.pattern : {};
  const room = Number(pattern.bedroom) || 0;
  const hall = Number(pattern.living_room) || 0;
  const bath = Number(pattern.bathroom) || 0;
  if (room || hall || bath) return `${room}房${hall}廳${bath}衛`;
  return "";
}

function areaNameFromItem(item) {
  const ping = Number(item.ping);
  if (Number.isFinite(ping) && ping > 0) {
    return `${String(Math.round(ping * 10) / 10).replace(/\.0$/, "")}坪`;
  }
  return "";
}

function roleFromItem(item) {
  const role = String(item.role || "");
  if (role === "individual") return "屋主";
  if (role === "escrow") return "租租通代管";
  if (role === "broker" || role === "agent") return "仲介";
  return "租租通";
}

function listingSourceKey({ regionId, sectionId, address, floorName, areaName, layout }) {
  const addr = String(address || "").replace(/\s+/g, "").toLowerCase();
  const floor = String(floorName || "").split("/")[0].trim();
  const area = String(areaName || "").replace(/坪/g, "");
  return [regionId || "", sectionId || "", "", addr, floor, area, layout].join("|");
}

export function normalizeDdItem(item, { regionId, sectionId } = {}) {
  const objectId = String(item?.object_id || "").trim();
  const kindName = kindFromDdItem(item);
  if (!objectId || !kindName) return null;
  const region = Number(regionId) || 0;
  const section = Number(sectionId) || 0;
  const address = String(item.address?.complete || "").trim()
    || [item.address?.city, item.address?.area, item.address?.road].filter(Boolean).join("");
  const areaName = areaNameFromItem(item);
  const layout = layoutFromItem(item);
  const floorName = item.floor != null && item.floor !== "" ? String(item.floor) : "";
  const priceNum = Number(item.rent) || 0;
  const cover = item.covers?.[0]?.image?.sm || item.covers?.[0]?.image?.md || "";
  const tags = ["租租通", ...(Array.isArray(item.themes) ? item.themes.slice(0, 4) : [])].filter((row) => String(row || "").trim());
  return {
    post_id: ddPostIdFromObject(objectId),
    source: DD_SOURCE,
    source_id: objectId,
    source_key: listingSourceKey({
      regionId: region,
      sectionId: section,
      address,
      floorName,
      areaName,
      layout,
    }),
    title: String(item.title || "").trim() || "(無標題)",
    url: ddDetailUrl(objectId),
    price: priceNum ? String(priceNum) : "",
    price_num: priceNum,
    ...feeFieldsFromBlob({
      blob: `${item.title || ""} ${(Array.isArray(item.themes) ? item.themes : []).join(" ")}`,
    }),
    extra_fees_fetched: 0,
    address,
    area_name: areaName,
    layout,
    floor_name: floorName,
    kind_name: kindName,
    role_name: roleFromItem(item),
    cover: String(cover || "").trim(),
    community_id: 0,
    community_name: "",
    tags: JSON.stringify(tags),
    refresh_time: String(item.published_date || "").trim(),
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

export function keepDdListing(listing, options = {}) {
  if (!listing?.post_id) return false;
  if (!inPriceRange(listing, options.priceMin, options.priceMax)) return false;
  if (isExcludedByKeyword(listing, options.excludeKeywords)) return false;
  if (!passesAttributeFilters(listing, options)) return false;
  return true;
}

async function defaultGetJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Origin: DD_SITE,
      Referer: `${DD_SITE}/search`,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    throw new Error(`租租通暫時無法抓取（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(`租租通搜尋 ${res.status}`);
  return res.json();
}

export async function fetchDdPage({ city, area, page = 1, pageRows = DD_PAGE_ROWS, getJson = defaultGetJson } = {}) {
  const params = ddSearchParams({ city, area, page, perPage: pageRows });
  const body = await getJson(`${DD_LIST_URL}?${params.toString()}`);
  return parseDdApiBody(body);
}

export async function fetchDdCoveringListings(jobs, options = {}) {
  const pages = Math.max(1, Math.min(Number(options.pages) || 8, 12));
  const pageRows = Number(options.pageRows) || DD_PAGE_ROWS;
  const getJson = options.getJson || defaultGetJson;
  const batches = [];
  const seen = new Set();

  for (const job of jobs || []) {
    const regionId = Number(job.regionId) || 0;
    const city = ddCityName(regionId);
    const sectionIds = [...new Set((job.sectionIds || []).map(Number).filter((id) => id > 0))];
    if (!city || !sectionIds.length) continue;

    const listings = [];
    let total = 0;
    const names = [];
    for (const sectionId of sectionIds) {
      const district = lookupDistrict(`${regionId}-${sectionId}`);
      const area = district?.name || "";
      if (!area) continue;
      names.push(area.replace(/區$/, ""));
      let areaTotal = 0;
      for (let page = 1; page <= pages; page += 1) {
        const result = await fetchDdPage({ city, area, page, pageRows, getJson });
        if (page === 1) {
          areaTotal = Number(result.total) || 0;
          total += areaTotal;
        }
        for (const item of result.items) {
          const id = String(item.object_id || "");
          if (!id || seen.has(id)) continue;
          const row = normalizeDdItem(item, { regionId, sectionId });
          if (!row) continue;
          if (!keepDdListing(row, {
            ...options,
            priceMin: job.priceMin,
            priceMax: job.priceMax,
          })) continue;
          seen.add(id);
          listings.push(row);
        }
        if (result.items.length < pageRows || page * pageRows >= areaTotal) break;
        if (page < pages) await new Promise((resolve) => setTimeout(resolve, options.gapMs ?? 400));
      }
    }

    batches.push({
      searchUrl: job.searchUrl,
      parsed: {
        label: `租租通 · ${names.join("、") || `地區 ${regionId}`}`,
        href: `${DD_SITE}/search`,
      },
      total,
      listings,
    });
  }

  return batches;
}
