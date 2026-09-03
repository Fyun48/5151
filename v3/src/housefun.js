import { createHash } from "node:crypto";
import { passesAttributeFilters } from "./floors.js";
import { isExcludedByKeyword } from "./geo.js";
import { hpSidForDistrict } from "./houseprice.js";
import { lookupDistrict } from "./regions.js";

export const HF_SOURCE = "housefun";
export const HF_POST_ID_BASE = 2_600_000_000;
export const HF_POST_ID_END = 2_700_000_000;
export const HF_PAGE_ROWS = 10;
export const HF_LIST_URL = "https://rent.housefun.com.tw/ashx/search/search.ashx";
export const HF_SITE = "https://rent.housefun.com.tw";
export const HF_PURPOSE_RESIDENTIAL = "1,2,3,4";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function isHfListingId(postId) {
  const n = Number(postId);
  return Number.isFinite(n) && n >= HF_POST_ID_BASE && n < HF_POST_ID_END;
}

export function hfCityCode(regionId) {
  if (Number(regionId) === 1) return "0000";
  if (Number(regionId) === 3) return "0001";
  return "";
}

export function hfCityName(regionId) {
  if (Number(regionId) === 1) return "台北市";
  if (Number(regionId) === 3) return "新北市";
  return "";
}

export function hfDetailUrl(id) {
  const key = String(id || "").trim();
  if (!key) return `${HF_SITE}/`;
  return `${HF_SITE}/rent/house/${encodeURIComponent(key)}/`;
}

export function hfPostIdFromRentId(id) {
  const key = String(id || "").trim();
  if (!key) return 0;
  const digest = createHash("sha256").update(`housefun:${key}`).digest();
  const span = HF_POST_ID_END - HF_POST_ID_BASE;
  return HF_POST_ID_BASE + (digest.readUInt32BE(0) % span);
}

export function hfB64Encode(value) {
  return Buffer.from(String(value ?? ""), "utf8").toString("base64");
}

export function hfB64Decode(value) {
  return Buffer.from(String(value ?? ""), "base64").toString("utf8");
}

export function hfEncodeData(data) {
  if (!data || typeof data !== "object") return data;
  const out = Array.isArray(data) ? [] : {};
  for (const [key, val] of Object.entries(data)) {
    if (val && typeof val === "object") out[key] = hfEncodeData(val);
    else out[key] = encodeURIComponent(hfB64Encode(val ?? ""));
  }
  return out;
}

export function hfDecodeData(data) {
  if (!data || typeof data !== "object") return data;
  const out = Array.isArray(data) ? [] : {};
  for (const [key, val] of Object.entries(data)) {
    if (val && typeof val === "object") out[key] = hfDecodeData(val);
    else {
      try {
        out[key] = hfB64Decode(decodeURIComponent(String(val)));
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export function hfUnwrapGateway(body) {
  if (!body || typeof body !== "object") return body;
  const status = String(body.Status ?? "");
  if (status === "1" || status === "-1" || status === "OK") return body;
  return hfDecodeData(body);
}

export function hfSearchInput({ cityId, cityName, areaId, areaName, page = 1 } = {}) {
  return {
    DataUnit: "1",
    DataType: "",
    DataTab: "",
    OrderBy: "",
    OrderType: "",
    CityId: String(cityId || ""),
    CityId2: "",
    CityId3: "",
    CityName: String(cityName || ""),
    CityName2: "",
    CityName3: "",
    AreaId: String(areaId || ""),
    AreaId2: "",
    AreaId3: "",
    AreaName: String(areaName || ""),
    AreaName2: "",
    AreaName3: "",
    PurposeID: HF_PURPOSE_RESIDENTIAL,
    PriceRental: "",
    PriceL: "",
    PriceH: "",
    MRTLine: "",
    MRTLine2: "",
    MRTLine3: "",
    MRTLineName: "",
    MRTLineName2: "",
    MRTLineName3: "",
    MRTStation: "",
    MRTStation2: "",
    MRTStation3: "",
    MRTStationName: "",
    MRTStationName2: "",
    MRTStationName3: "",
    SchoolType: "",
    SchoolTypeName: "",
    SchoolId: "",
    SchoolName: "",
    BuildingID: "",
    BuildingName: "",
    KeyWord: "",
    KWkind: "",
    KWID: "",
    KWCounty: "",
    KWDistrict: "",
    NotRequiredOtherFeeID: "",
    NotRequiredEquipmentID: "",
    NotRequiredBaseMent: "",
    Room: "",
    LevelGroundID: "",
    CaseTypeID: "",
    AgentPositionID: "",
    CaseFromFloor: "",
    CaseToFloor: "",
    BuildYear: "",
    BuildYearL: "",
    BuildYearH: "",
    chkOTLimSex: "",
    OTLimSex: "",
    OTParkingSpace: "",
    OTLimWithLandlord: "",
    OTLimPet: "",
    TGType: "",
    EquipmentID: "",
    PMPage: String(Math.max(1, Number(page) || 1)),
    BrowseMode: "",
    CenterLat: "",
    CenterLng: "",
    SID: "",
    Distance: "",
    SearchList: "",
    MemberID: "",
    MainShopID: "",
    AgentName: "",
    LandlordNo: "",
  };
}

export function hfRequestPackage(input) {
  return `RequestPackage=${JSON.stringify({
    Method: hfB64Encode("INQUIRE"),
    Data: hfEncodeData(input),
  })}`;
}

export function parseHfApiBody(body) {
  const unwrapped = hfUnwrapGateway(body);
  const data = unwrapped?.Data && typeof unwrapped.Data === "object" ? unwrapped.Data : {};
  const html = String(data.SearchContent || "");
  const items = parseHfSearchHtml(html);
  const total = Number(String(data.HouseCount || "").replace(/,/g, ""));
  const pageBits = String(data.PageCount || "").split("/");
  const pageCount = Number(pageBits[1] || pageBits[0]) || 0;
  return {
    ok: String(unwrapped?.Status) === "1",
    total: Number.isFinite(total) ? total : items.length,
    pageCount,
    items,
  };
}

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function kindFromHfText(text) {
  const hay = String(text || "");
  if (/店面|辦公|廠房|車位|土地|倉庫/.test(hay)) return "";
  if (/雅房/.test(hay)) return "雅房";
  if (/分租/.test(hay)) return "分租套房";
  if (/套房/.test(hay)) return "獨立套房";
  const rooms = hay.match(/(\d+)\s*房/);
  if (rooms && Number(rooms[1]) >= 1) return "整層住家";
  return "獨立套房";
}

export function parseHfSearchHtml(html) {
  const source = String(html || "");
  const articles = source.split(/<article\b/i).slice(1);
  const items = [];
  for (const raw of articles) {
    const card = `<article${raw}`;
    const idMatch = card.match(/\/rent\/house\/(\d+)\//);
    if (!idMatch) continue;
    const titleMatch = card.match(/title="([^"]+)"/);
    const addrMatch = card.match(/<address[^>]*>([^<]+)<\/address>/i);
    const levelMatch = card.match(/class="level">([^<]+)/);
    const floorMatch = card.match(/樓層：\s*([^<]+)/);
    const priceMatch = card.match(/([\d,]+)\s*元\/月/);
    const pingMatch = card.match(/([\d.]+)\s*坪/);
    const imgMatch = card.match(/<img[^>]+src="([^"]+)"/i);
    const geoMatch = card.match(/LatLng=([0-9.]+)\s*,\s*([0-9.]+)/);
    const agencyMatch = card.match(/仲介[^<]{0,40}/);
    const refreshMatch = card.match(/更新：[\s\S]{0,40}?class="infos">([^<]+)/);
    items.push({
      id: idMatch[1],
      title: String(titleMatch?.[1] || "").trim(),
      address: String(addrMatch?.[1] || "").trim(),
      layout: String(levelMatch?.[1] || "").replace(/\(室\)/g, "").trim(),
      floorName: String(floorMatch?.[1] || "").replace(/\s+/g, "").replace("／", "/"),
      price: Number(String(priceMatch?.[1] || "").replace(/,/g, "")) || 0,
      areaName: pingMatch ? `${pingMatch[1].replace(/\.0$/, "")}坪` : "",
      cover: String(imgMatch?.[1] || "").trim(),
      lat: geoMatch ? Number(geoMatch[1]) : null,
      lng: geoMatch ? Number(geoMatch[2]) : null,
      agency: String(agencyMatch?.[0] || "").trim(),
      refresh: String(refreshMatch?.[1] || "").trim(),
      text: stripTags(card),
    });
  }
  return items;
}

function listingSourceKey({ regionId, sectionId, address, floorName, areaName, layout }) {
  const addr = String(address || "").replace(/\s+/g, "").toLowerCase();
  const floor = String(floorName || "").split("/")[0].trim();
  const area = String(areaName || "").replace(/坪/g, "");
  return [regionId || "", sectionId || "", "", addr, floor, area, layout].join("|");
}

export function normalizeHfItem(item, { regionId, sectionId } = {}) {
  const id = String(item?.id || "").trim();
  const kindName = kindFromHfText(`${item?.title || ""} ${item?.layout || ""} ${item?.text || ""}`);
  if (!id || !kindName) return null;
  const region = Number(regionId) || 0;
  const section = Number(sectionId) || 0;
  const address = String(item.address || "").trim();
  const areaName = String(item.areaName || "").trim();
  const layout = String(item.layout || "").trim();
  const floorName = String(item.floorName || "").trim();
  const priceNum = Number(item.price) || 0;
  const lat = Number(item.lat);
  const lng = Number(item.lng);
  const tags = ["好房", item.agency].filter((row) => String(row || "").trim());
  return {
    post_id: hfPostIdFromRentId(id),
    source: HF_SOURCE,
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
    url: hfDetailUrl(id),
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
    role_name: item.agency || "好房網",
    cover: String(item.cover || "").trim(),
    community_id: 0,
    community_name: "",
    tags: JSON.stringify(tags),
    refresh_time: String(item.refresh || "").trim(),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    geo_source: Number.isFinite(lat) && Number.isFinite(lng) ? HF_SOURCE : null,
    contact_fetched: 1,
  };
}

function inPriceRange(listing, priceMin, priceMax) {
  const n = Number(listing?.price_num) || 0;
  if (Number(priceMin) > 0 && n < Number(priceMin)) return false;
  if (Number(priceMax) > 0 && n > Number(priceMax)) return false;
  return true;
}

export function keepHfListing(listing, options = {}) {
  if (!listing?.post_id) return false;
  if (!inPriceRange(listing, options.priceMin, options.priceMax)) return false;
  if (isExcludedByKeyword(listing, options.excludeKeywords)) return false;
  if (!passesAttributeFilters(listing, options)) return false;
  return true;
}

async function defaultPostForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: HF_SITE,
      Referer: `${HF_SITE}/`,
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    throw new Error(`好房網暫時無法抓取（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(`好房網搜尋 ${res.status}`);
  return res.json();
}

export async function fetchHfPage({
  cityId,
  cityName,
  areaId,
  areaName,
  page = 1,
  postForm = defaultPostForm,
} = {}) {
  const input = hfSearchInput({ cityId, cityName, areaId, areaName, page });
  const body = await postForm(HF_LIST_URL, hfRequestPackage(input));
  return parseHfApiBody(body);
}

export async function fetchHfCoveringListings(jobs, options = {}) {
  const pages = Math.max(1, Math.min(Number(options.pages) || 8, 12));
  const postForm = options.postForm || defaultPostForm;
  const batches = [];
  const seen = new Set();

  for (const job of jobs || []) {
    const regionId = Number(job.regionId) || 0;
    const cityId = hfCityCode(regionId);
    const cityName = hfCityName(regionId);
    const sectionIds = [...new Set((job.sectionIds || []).map(Number).filter((id) => id > 0))];
    if (!cityId || !sectionIds.length) continue;

    const listings = [];
    let total = 0;
    const names = [];
    for (const sectionId of sectionIds) {
      const sid = hpSidForDistrict(regionId, sectionId);
      const district = lookupDistrict(`${regionId}-${sectionId}`);
      const areaName = district?.name || "";
      if (!sid || !areaName) continue;
      names.push(areaName.replace(/區$/, ""));
      let areaTotal = 0;
      for (let page = 1; page <= pages; page += 1) {
        const result = await fetchHfPage({
          cityId,
          cityName,
          areaId: String(sid),
          areaName,
          page,
          postForm,
        });
        if (page === 1) {
          areaTotal = Number(result.total) || 0;
          total += areaTotal;
        }
        for (const item of result.items) {
          const id = String(item.id || "");
          if (!id || seen.has(id)) continue;
          const row = normalizeHfItem(item, { regionId, sectionId });
          if (!row) continue;
          if (!keepHfListing(row, {
            ...options,
            priceMin: job.priceMin,
            priceMax: job.priceMax,
          })) continue;
          seen.add(id);
          listings.push(row);
        }
        if (result.items.length < HF_PAGE_ROWS || page * HF_PAGE_ROWS >= areaTotal) break;
        if (page < pages) await new Promise((resolve) => setTimeout(resolve, options.gapMs ?? 400));
      }
    }

    batches.push({
      searchUrl: job.searchUrl,
      parsed: {
        label: `好房 · ${names.join("、") || `地區 ${regionId}`}`,
        href: `${HF_SITE}/`,
      },
      total,
      listings,
    });
  }

  return batches;
}
