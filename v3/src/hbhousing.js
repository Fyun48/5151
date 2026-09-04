import { createHash } from "node:crypto";
import { passesAttributeFilters } from "./floors.js";
import { isExcludedByKeyword } from "./geo.js";
import { feeFieldsFromBlob } from "./listingCost.js";
import { lookupDistrict } from "./regions.js";

export const HB_SOURCE = "hbhousing";
export const HB_POST_ID_BASE = 2_200_000_000;
export const HB_POST_ID_END = 2_300_000_000;
export const HB_PAGE_ROWS = 30;
export const HB_LIST_URL = "https://www.hbhousing.com.tw/proxy/api/HB/RentHouseRelated/GetHouseDataCount";
export const HB_SITE = "https://www.hbhousing.com.tw";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 591 行政區 key（region-section）對應住商郵遞區號。 */
export const HB_ZIP_BY_DISTRICT = {
  "1-1": "100",
  "1-2": "103",
  "1-3": "104",
  "1-4": "105",
  "1-5": "106",
  "1-6": "108",
  "1-7": "110",
  "1-8": "111",
  "1-9": "112",
  "1-10": "114",
  "1-11": "115",
  "1-12": "116",
  "3-26": "220",
  "3-27": "221",
  "3-34": "231",
  "3-37": "234",
  "3-38": "235",
  "3-39": "236",
  "3-40": "237",
  "3-41": "238",
  "3-42": "239",
  "3-43": "241",
  "3-44": "242",
  "3-45": "243",
  "3-46": "244",
  "3-47": "247",
  "3-48": "248",
  "3-49": "249",
  "3-50": "251",
  "3-51": "252",
};

const DISTRICT_BY_ZIP = new Map(
  Object.entries(HB_ZIP_BY_DISTRICT).map(([key, zip]) => [zip, key]),
);

export function isHbListingId(postId) {
  const n = Number(postId);
  return Number.isFinite(n) && n >= HB_POST_ID_BASE && n < HB_POST_ID_END;
}

export function zipForDistrict(regionId, sectionId) {
  return HB_ZIP_BY_DISTRICT[`${Number(regionId)}-${Number(sectionId)}`] || "";
}

export function districtKeyForZip(zip) {
  return DISTRICT_BY_ZIP.get(String(zip || "").trim()) || "";
}

export function hbDetailUrl(sn) {
  const id = String(sn || "").trim();
  if (!id) return `${HB_SITE}/renthouse`;
  return `${HB_SITE}/detail?sn=${encodeURIComponent(id)}`;
}

export function hbPostIdFromSn(sn) {
  const key = String(sn || "").trim();
  if (!key) return 0;
  const digest = createHash("sha256").update(`hbhousing:${key}`).digest();
  const span = HB_POST_ID_END - HB_POST_ID_BASE;
  return HB_POST_ID_BASE + (digest.readUInt32BE(0) % span);
}

export function hbRequestBody({ zip, page = 1, pageRows = HB_PAGE_ROWS, priceMin = 0, priceMax = 0 } = {}) {
  const wanStart = Number(priceMin) > 0 ? Math.floor(Number(priceMin) / 10000) : null;
  const wanFinish = Number(priceMax) > 0 ? Math.ceil(Number(priceMax) / 10000) : null;
  return {
    vrType: 0,
    page: Math.max(1, Number(page) || 1),
    pageRows: Math.max(1, Math.min(Number(pageRows) || HB_PAGE_ROWS, 40)),
    sort: 0,
    cityNo: null,
    zipCode: [String(zip)],
    style: [],
    type: [],
    priceStart: wanStart && wanStart > 0 ? wanStart : null,
    priceFinish: wanFinish && wanFinish > 0 ? wanFinish : null,
    areaType: "P",
    areaStart: null,
    areaFinish: null,
    ageStart: null,
    ageFinish: null,
    roomStart: null,
    roomFinish: null,
    bathStart: null,
    bathFinish: null,
    hallStart: null,
    hallFinish: null,
    floorStart: null,
    floorFinish: null,
    location: null,
    keyWord: null,
    tag: [],
    searchTopics: null,
    theme: [],
    storeID: null,
    employeeID: null,
    equipment: [],
    identity: [],
    gender: [],
  };
}

export function parseHbApiBody(body) {
  const data = body?.data && typeof body.data === "object" ? body.data : body;
  const items = Array.isArray(data?.rentHouseData) ? data.rentHouseData : [];
  const total = Number(data?.cnts);
  return {
    total: Number.isFinite(total) ? total : items.length,
    items: items.filter((row) => row && typeof row === "object" && row.sn),
    searchFilter: data?.searchFilter || null,
  };
}

function resolveNuxt(data, idx, stack = new Set()) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= data.length) return idx;
  if (stack.has(idx)) return null;
  const value = data[idx];
  if (value == null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  stack.add(idx);
  let out = value;
  if (Array.isArray(value)) {
    out = value.map((item) => (Number.isInteger(item) ? resolveNuxt(data, item, stack) : item));
  } else if (typeof value === "object") {
    out = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, Number.isInteger(item) ? resolveNuxt(data, item, stack) : item]),
    );
  }
  stack.delete(idx);
  return out;
}

export function parseHbNuxtHtml(html) {
  const match = String(html || "").match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return { total: 0, items: [] };
  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return { total: 0, items: [] };
  }
  if (!Array.isArray(payload)) return { total: 0, items: [] };
  let items = [];
  let total = 0;
  for (const node of payload) {
    if (!node || typeof node !== "object" || Array.isArray(node) || !("rentHouseData" in node)) continue;
    const resolved = resolveNuxt(payload, node.rentHouseData);
    items = Array.isArray(resolved) ? resolved.filter((row) => row && row.sn) : [];
    total = Number(resolveNuxt(payload, node.cnts)) || items.length;
    break;
  }
  return { total, items };
}

export function priceTwdFromWan(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 10000);
}

function layoutFromItem(item) {
  const special = String(item.special || "").replace(/--/g, "").replace(/\(室\)/g, "").trim();
  if (/\d+\s*房/.test(special)) return special;
  const room = Number(item.room) || 0;
  const hall = Number(item.hall) || 0;
  const bath = Number(item.bath) || 0;
  if (room || hall || bath) return `${room}房${hall}廳${bath}衛`;
  return "";
}

export function kindFromHbItem(item) {
  const hay = `${item?.objName || ""} ${item?.special || ""} ${item?.type || ""}`;
  if (/雅房/.test(hay)) return "雅房";
  if (/分租/.test(hay)) return "分租套房";
  if (/套房/.test(hay)) return "獨立套房";
  if (item?.type === "住宅" || item?.type === "住商") return "整層住家";
  return "";
}

function floorNameFromItem(item) {
  const floor = String(item.floor || "").trim();
  const total = String(item.floorTotal || "").trim();
  if (floor && total) return `${floor}/${total}`;
  return floor;
}

function cityPrefix(regionId) {
  if (Number(regionId) === 1) return "台北市";
  if (Number(regionId) === 3) return "新北市";
  return "";
}

function hbSourceKey({ regionId, sectionId, address, floorName, areaName, layout }) {
  const addr = String(address || "").replace(/\s+/g, "").toLowerCase();
  const floor = String(floorName || "").split("/")[0].trim();
  const area = String(areaName || "").replace(/坪/g, "");
  return [regionId || "", sectionId || "", "", addr, floor, area, layout].join("|");
}

export function normalizeHbItem(item, { regionId, sectionId } = {}) {
  const sn = String(item?.sn || "").trim();
  const kindName = kindFromHbItem(item);
  if (!sn || !kindName) return null;
  const zip = String(item.zipCode || "").trim();
  const fromZip = districtKeyForZip(zip);
  const [zipRegion, zipSection] = fromZip ? fromZip.split("-").map(Number) : [0, 0];
  const region = Number(regionId) || zipRegion || 0;
  const section = Number(sectionId) || zipSection || 0;
  const district = lookupDistrict(`${region}-${section}`);
  const door = String(item.doorplate || "").trim();
  const city = district?.city || cityPrefix(region);
  const address = door && city && !door.startsWith(city) ? `${city}${door}` : door;
  const areaVal = Number(item.area);
  const areaName = Number.isFinite(areaVal) && areaVal > 0
    ? `${String(Math.round(areaVal * 10) / 10).replace(/\.0$/, "")}坪`
    : "";
  const layout = layoutFromItem(item);
  const floorName = floorNameFromItem(item);
  const priceNum = priceTwdFromWan(item.rentPrice ?? item.price);
  const lat = Number(item.lat);
  const lng = Number(item.lon ?? item.lng);
  const tags = ["住商", item.mrt, item.style].filter((row) => String(row || "").trim());
  return {
    post_id: hbPostIdFromSn(sn),
    source: HB_SOURCE,
    source_id: sn,
    source_key: hbSourceKey({
      regionId: region,
      sectionId: section,
      address,
      floorName,
      areaName,
      layout,
    }),
    title: String(item.objName || "").trim() || "(無標題)",
    url: hbDetailUrl(sn),
    price: priceNum ? String(priceNum) : "",
    price_num: priceNum,
    ...feeFieldsFromBlob({ blob: `${item.objName || ""} ${item.emphasis1 || ""} ${item.parking || ""} ${item.special || ""}` }),
    extra_fees_fetched: 0,
    address,
    area_name: areaName,
    layout,
    floor_name: floorName,
    kind_name: kindName,
    role_name: item.storeID ? `住商 ${item.storeID}` : "住商不動產",
    cover: String(item.photo1 || "").trim(),
    community_id: 0,
    community_name: "",
    tags: JSON.stringify(tags),
    refresh_time: "",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    geo_source: Number.isFinite(lat) && Number.isFinite(lng) ? HB_SOURCE : null,
    contact_fetched: 1,
  };
}

function inPriceRange(listing, priceMin, priceMax) {
  const n = Number(listing?.price_num) || 0;
  if (Number(priceMin) > 0 && n < Number(priceMin)) return false;
  if (Number(priceMax) > 0 && n > Number(priceMax)) return false;
  return true;
}

export function keepHbListing(listing, options = {}) {
  if (!listing?.post_id) return false;
  if (!inPriceRange(listing, options.priceMin, options.priceMax)) return false;
  if (isExcludedByKeyword(listing, options.excludeKeywords)) return false;
  if (!passesAttributeFilters(listing, options)) return false;
  return true;
}

async function defaultPostJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: HB_SITE,
      Referer: `${HB_SITE}/renthouse`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    throw new Error(`住商暫時無法抓取（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(`住商搜尋 ${res.status}`);
  return res.json();
}

export async function fetchHbPage({ zip, page = 1, pageRows = HB_PAGE_ROWS, priceMin = 0, priceMax = 0, postJson = defaultPostJson } = {}) {
  const body = await postJson(HB_LIST_URL, hbRequestBody({ zip, page, pageRows, priceMin, priceMax }));
  return parseHbApiBody(body);
}

export async function fetchHbCoveringListings(jobs, options = {}) {
  const pages = Math.max(1, Math.min(Number(options.pages) || 8, 12));
  const pageRows = Number(options.pageRows) || HB_PAGE_ROWS;
  const postJson = options.postJson || defaultPostJson;
  const batches = [];
  const seenSn = new Set();

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
        const result = await fetchHbPage({
          zip,
          page,
          pageRows,
          priceMin: job.priceMin,
          priceMax: job.priceMax,
          postJson,
        });
        if (page === 1) {
          zipTotal = Number(result.total) || 0;
          total += zipTotal;
        }
        for (const item of result.items) {
          const sn = String(item.sn || "");
          if (!sn || seenSn.has(sn)) continue;
          const row = normalizeHbItem(item, { regionId, sectionId });
          if (!row) continue;
          if (!keepHbListing(row, {
            ...options,
            priceMin: job.priceMin,
            priceMax: job.priceMax,
          })) continue;
          seenSn.add(sn);
          listings.push(row);
        }
        if (result.items.length < pageRows || page * pageRows >= zipTotal) break;
        if (page < pages) await new Promise((resolve) => setTimeout(resolve, options.gapMs ?? 400));
      }
    }

    batches.push({
      searchUrl: job.searchUrl,
      parsed: {
        label: `住商 · ${names.join("、") || `地區 ${regionId}`}`,
        href: `${HB_SITE}/renthouse`,
      },
      total,
      listings,
    });
  }

  return batches;
}
