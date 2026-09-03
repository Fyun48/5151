import { createHash } from "node:crypto";
import { passesAttributeFilters } from "./floors.js";
import { isExcludedByKeyword } from "./geo.js";
import { zipForDistrict, districtKeyForZip } from "./hbhousing.js";
import { lookupDistrict } from "./regions.js";

export const SINYI_SOURCE = "sinyi";
export const SINYI_POST_ID_BASE = 2_300_000_000;
export const SINYI_POST_ID_END = 2_400_000_000;
export const SINYI_PAGE_ROWS = 20;
export const SINYI_LIST_URL = "https://www.sinyi.com.tw/rent/ajaxSearchHouse.php";
export const SINYI_SITE = "https://www.sinyi.com.tw/rent";
export const SINYI_RETURN_PARAMS = [
  "NO", "name", "address", "price", "type", "use", "room", "hall", "bathroom",
  "floor", "imgDefault", "lat", "lng", "zipcode", "url", "layout", "ping", "community", "img",
].join(",");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function isSinyiListingId(postId) {
  const n = Number(postId);
  return Number.isFinite(n) && n >= SINYI_POST_ID_BASE && n < SINYI_POST_ID_END;
}

export function sinyiDetailUrl(no) {
  const id = String(no || "").trim();
  if (!id) return `${SINYI_SITE}/`;
  if (/^https?:\/\//i.test(id)) return id;
  const path = id.startsWith("houseno/") ? id : `houseno/${id}`;
  return `${SINYI_SITE}/${path}`;
}

export function sinyiPostIdFromNo(no) {
  const key = String(no || "").trim();
  if (!key) return 0;
  const digest = createHash("sha256").update(`sinyi:${key}`).digest();
  const span = SINYI_POST_ID_END - SINYI_POST_ID_BASE;
  return SINYI_POST_ID_BASE + (digest.readUInt32BE(0) % span);
}

export function sinyiFormBody({ zip, page = 1, limit = SINYI_PAGE_ROWS } = {}) {
  const params = new URLSearchParams();
  params.set("params", `${String(zip)}-zip`);
  params.set("page", String(Math.max(1, Number(page) || 1)));
  params.set("limit", String(Math.max(1, Math.min(Number(limit) || SINYI_PAGE_ROWS, 40))));
  params.set("returnParams", SINYI_RETURN_PARAMS);
  return params.toString();
}

export function parseSinyiApiBody(body) {
  const opt = body?.OPT && typeof body.OPT === "object" ? body.OPT : body;
  const items = Array.isArray(opt?.List) ? opt.List : [];
  const total = Number(opt?.total);
  const ok = String(opt?.status || "").toUpperCase() === "OK" || items.length > 0;
  return {
    ok,
    total: Number.isFinite(total) ? total : items.length,
    items: items.filter((row) => row && typeof row === "object" && (row.NO || row.no)),
  };
}

export function kindFromSinyiItem(item) {
  const hay = `${item?.use || ""} ${item?.type || ""} ${item?.name || ""} ${item?.layout || ""}`;
  if (/店面|辦公|廠房|車位|土地|倉庫/.test(hay)) return "";
  if (/雅房/.test(hay)) return "雅房";
  if (/分租/.test(hay)) return "分租套房";
  if (/套房/.test(hay)) return "獨立套房";
  return "整層住家";
}

export function priceTwdFromSinyi(value) {
  const n = Number(String(value ?? "").replace(/,/g, "").replace(/元.*$/, "").trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function layoutFromItem(item) {
  const layout = String(item.layout || item.totalLayout || "").replace(/--/g, "").trim();
  if (layout) return layout;
  const room = Number(item.room) || 0;
  const hall = Number(item.hall) || 0;
  const bath = Number(item.bathroom) || 0;
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

function cityPrefix(regionId) {
  if (Number(regionId) === 1) return "台北市";
  if (Number(regionId) === 3) return "新北市";
  return "";
}

function listingSourceKey({ regionId, sectionId, address, floorName, areaName, layout }) {
  const addr = String(address || "").replace(/\s+/g, "").toLowerCase();
  const floor = String(floorName || "").split("/")[0].trim();
  const area = String(areaName || "").replace(/坪/g, "");
  return [regionId || "", sectionId || "", "", addr, floor, area, layout].join("|");
}

export function normalizeSinyiItem(item, { regionId, sectionId } = {}) {
  const no = String(item?.NO || item?.no || "").trim();
  const kindName = kindFromSinyiItem(item);
  if (!no || !kindName) return null;
  const zip = String(item.zipcode || "").trim();
  const fromZip = zip ? districtKeyForZip(zip) : "";
  const [zipRegion, zipSection] = fromZip ? fromZip.split("-").map(Number) : [0, 0];
  const region = Number(regionId) || zipRegion || 0;
  const section = Number(sectionId) || zipSection || 0;
  const district = lookupDistrict(`${region}-${section}`);
  const door = String(item.address || item.addressrwd || "").trim();
  const city = district?.city || cityPrefix(region);
  const address = door && city && !door.startsWith(city) && !door.startsWith("台北") && !door.startsWith("臺北") && !door.startsWith("新北")
    ? `${city}${door}`
    : door;
  const areaName = areaNameFromItem(item);
  const layout = layoutFromItem(item);
  const floorName = String(item.floor || "").trim();
  const priceNum = priceTwdFromSinyi(item.price);
  const lat = Number(item.lat);
  const lng = Number(item.lng);
  const tags = ["信義", item.community, item.use].filter((row) => String(row || "").trim());
  const path = String(item.url || "").trim();
  return {
    post_id: sinyiPostIdFromNo(no),
    source: SINYI_SOURCE,
    source_id: no,
    source_key: listingSourceKey({
      regionId: region,
      sectionId: section,
      address,
      floorName,
      areaName,
      layout,
    }),
    title: String(item.name || "").trim() || "(無標題)",
    url: path && /^https?:\/\//i.test(path) ? path : sinyiDetailUrl(path || no),
    price: priceNum ? String(priceNum) : "",
    price_num: priceNum,
    extra_fee: 0,
    extra_fee_text: "",
    price_contain_text: "",
    extra_fees: "[]",
    extra_fees_fetched: 0,
    address,
    area_name: areaName,
    layout,
    floor_name: floorName,
    kind_name: kindName,
    role_name: "信義房屋",
    cover: String(item.img || item.imgDefault || "").trim(),
    community_id: 0,
    community_name: String(item.community || "").trim(),
    tags: JSON.stringify(tags),
    refresh_time: String(item.updatedate || "").trim(),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    geo_source: Number.isFinite(lat) && Number.isFinite(lng) ? SINYI_SOURCE : null,
    contact_fetched: 1,
  };
}

function inPriceRange(listing, priceMin, priceMax) {
  const n = Number(listing?.price_num) || 0;
  if (Number(priceMin) > 0 && n < Number(priceMin)) return false;
  if (Number(priceMax) > 0 && n > Number(priceMax)) return false;
  return true;
}

export function keepSinyiListing(listing, options = {}) {
  if (!listing?.post_id) return false;
  if (!inPriceRange(listing, options.priceMin, options.priceMax)) return false;
  if (isExcludedByKeyword(listing, options.excludeKeywords)) return false;
  if (!passesAttributeFilters(listing, options)) return false;
  return true;
}

async function defaultPostForm(url, body) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Origin: "https://www.sinyi.com.tw",
        Referer: `${SINYI_SITE}/`,
      },
      body,
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 403 || res.status === 429) {
      throw new Error(`信義暫時無法抓取（HTTP ${res.status}）`);
    }
    if (res.status === 503) {
      lastError = new Error("信義暫時無法抓取（HTTP 503）");
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`信義搜尋 ${res.status}`);
    return res.json();
  }
  throw lastError || new Error("信義搜尋失敗");
}

export async function fetchSinyiPage({ zip, page = 1, pageRows = SINYI_PAGE_ROWS, postForm = defaultPostForm } = {}) {
  const body = await postForm(SINYI_LIST_URL, sinyiFormBody({ zip, page, limit: pageRows }));
  return parseSinyiApiBody(body);
}

export async function fetchSinyiCoveringListings(jobs, options = {}) {
  const pages = Math.max(1, Math.min(Number(options.pages) || 8, 12));
  const pageRows = Number(options.pageRows) || SINYI_PAGE_ROWS;
  const postForm = options.postForm || defaultPostForm;
  const batches = [];
  const seenNo = new Set();

  for (const job of jobs || []) {
    const regionId = Number(job.regionId) || 0;
    const sectionIds = [...new Set((job.sectionIds || []).map(Number).filter((id) => id > 0))];
    const zips = [];
    for (const sectionId of sectionIds) {
      const zip = zipForDistrict(regionId, sectionId);
      if (zip && !zips.some((row) => row.zip === zip)) zips.push({ zip, sectionId });
    }
    if (!zips.length) continue;

    const listings = [];
    let total = 0;
    const names = [];
    for (const { zip, sectionId } of zips) {
      const district = lookupDistrict(`${regionId}-${sectionId}`);
      if (district?.name) names.push(district.name.replace(/區$/, ""));
      let zipTotal = 0;
      for (let page = 1; page <= pages; page += 1) {
        const result = await fetchSinyiPage({ zip, page, pageRows, postForm });
        if (page === 1) {
          zipTotal = Number(result.total) || 0;
          total += zipTotal;
        }
        for (const item of result.items) {
          const no = String(item.NO || item.no || "");
          if (!no || seenNo.has(no)) continue;
          const row = normalizeSinyiItem(item, { regionId, sectionId });
          if (!row) continue;
          if (!keepSinyiListing(row, {
            ...options,
            priceMin: job.priceMin,
            priceMax: job.priceMax,
          })) continue;
          seenNo.add(no);
          listings.push(row);
        }
        if (result.items.length < pageRows || page * pageRows >= zipTotal) break;
        if (page < pages) await new Promise((resolve) => setTimeout(resolve, options.gapMs ?? 400));
      }
    }

    batches.push({
      searchUrl: job.searchUrl,
      parsed: {
        label: `信義 · ${names.join("、") || `地區 ${regionId}`}`,
        href: `${SINYI_SITE}/`,
      },
      total,
      listings,
    });
  }

  return batches;
}
