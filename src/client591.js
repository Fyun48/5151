import { passesAttributeFilters, passesGeoFilters } from "./floors.js";
import { allDistricts } from "./regions.js";
import { coordsFrom591Detail, coordsFromListing, isExcludedByKeyword } from "./geo.js";
import {
  communityRefFromDetail,
  listingAddressFromDetail,
  parseCommunityPayload,
  preferCommunityLocation,
} from "./location.js";

const LIST_URL = "https://bff-house.591.com.tw/v3/web/rent/list";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DROP_PARAMS = new Set([
  "firstRow",
  "totalRows",
  "region",
  "regionid",
  "is_format_data",
  "is_new_list",
  "type",
  "sort",
]);

const MAX_LIST_PAGES = 40;

export class ListingGoneError extends Error {
  constructor(message = "物件不存在") {
    super(message);
    this.name = "ListingGoneError";
    this.code = "gone";
  }
}

export function isListingGoneError(error) {
  return Boolean(error) && (error instanceof ListingGoneError || error.code === "gone" || error.name === "ListingGoneError");
}

export function isListingGoneResponse(body, httpStatus) {
  if (Number(httpStatus) === 404) return true;
  const msg = String(body?.msg || body?.message || "");
  if (/不存在|已關閉|已刪除|已下架|找不到此/.test(msg)) return true;
  const houseStatus = String(body?.data?.status || "").toLowerCase();
  if (["close", "closed", "off", "offline", "delete", "deleted"].includes(houseStatus)) return true;
  return false;
}

export function mapWebsiteSort(sort) {
  const text = String(sort || "").trim().toLowerCase();
  const matched = text.match(/^(money|posttime|area|id)_(asc|desc)$/);
  if (!matched) return null;
  return {
    order: matched[1] === "id" ? "posttime" : matched[1],
    orderType: matched[2],
  };
}

export function searchParts(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    const price = url.searchParams.get("price") || url.searchParams.get("rentprice") || "";
    return {
      region: url.searchParams.get("regionid") || url.searchParams.get("region") || "",
      section: url.searchParams.get("section") || "",
      price: price.replaceAll("$", ""),
      notice: url.searchParams.get("notice") || "",
    };
  } catch {
    return null;
  }
}

export function sameSearch(a, b) {
  if (String(a || "").trim() === String(b || "").trim()) return true;
  const pa = searchParts(a);
  const pb = searchParts(b);
  if (!pa || !pb) return false;
  return pa.region === pb.region && pa.section === pb.section && pa.price === pb.price && pa.notice === pb.notice;
}

export function parseSearchUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("請貼上 591 搜尋網址");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`網址格式不正確：${text}`);
  }
  if (!/591\.com\.tw$/i.test(url.hostname) && !url.hostname.endsWith(".591.com.tw")) {
    throw new Error("只接受 591.com.tw 的搜尋網址");
  }
  if (url.hostname.startsWith("sale.") || url.pathname.includes("/sale")) {
    throw new Error("目前先支援租屋頻道。請從 rent.591.com.tw 複製搜尋結果網址。");
  }

  const params = new URLSearchParams();
  const region = url.searchParams.get("regionid") || url.searchParams.get("region") || "1";
  params.set("regionid", region);

  for (const [key, value] of url.searchParams.entries()) {
    if (DROP_PARAMS.has(key) || !value) continue;
    if (key === "price" || key === "rentprice") {
      params.set(key, value.replaceAll("$", ""));
      continue;
    }
    params.append(key, value);
  }

  const fromSort = mapWebsiteSort(url.searchParams.get("sort"));
  if (fromSort) {
    params.set("order", fromSort.order);
    params.set("orderType", fromSort.orderType);
  } else if (!params.get("order")) {
    params.set("order", "posttime");
    params.set("orderType", "desc");
  }
  if (params.get("order") && !params.get("orderType")) {
    params.set("orderType", "desc");
  }

  return {
    label: summarize(url, region),
    href: url.toString(),
    query: params,
  };
}

function summarize(url, region) {
  const parts = ["租屋"];
  // 591 租屋網址：1 台北、3 新北（舊文件曾把新北寫成 2）
  const names = {
    1: "台北市",
    2: "新北市",
    3: "新北市",
    4: "台中市",
    5: "台南市",
    6: "高雄市",
    7: "基隆市",
    8: "新竹市",
    9: "嘉義市",
    10: "新竹縣",
    11: "苗栗縣",
    12: "彰化縣",
    13: "南投縣",
    14: "雲林縣",
    15: "嘉義縣",
    16: "屏東縣",
    17: "宜蘭縣",
    18: "花蓮縣",
    19: "台東縣",
    20: "澎湖縣",
    21: "金門縣",
    22: "連江縣",
  };
  // 591 website region ids differ from some older docs; keep the numeric id in the label.
  parts.push(names[region] || `地區 ${region}`);
  const kind = url.searchParams.get("kind");
  const kinds = { 1: "整層住家", 2: "獨立套房", 3: "分租套房", 4: "雅房", 8: "車位" };
  if (kind && kinds[kind]) parts.push(kinds[kind]);
  const section = url.searchParams.get("section");
  if (section) {
    const sectionNames = Object.fromEntries(allDistricts().map((item) => [item.id, item.name]));
    const labels = section.split(",").map((id) => sectionNames[id] || `行政區 ${id}`);
    parts.push(labels.join("、"));
  }
  const price = url.searchParams.get("price") || url.searchParams.get("rentprice");
  if (price) parts.push(`${price.replaceAll("$", "").replace("_", "–")} 元`);
  return parts.join(" · ");
}

function sourceKey(item) {
  const address = String(item.address || "")
    .replace(/\s+/g, "")
    .toLowerCase();
  const floor = String(item.floor_name || "").split("/")[0].trim();
  const area = String(item.area ?? item.area_name ?? "").replace(/坪/g, "");
  const layout = String(item.layoutStr || item.layout || "");
  const community = item.community_id && Number(item.community_id) !== 0 ? `c${item.community_id}` : "";
  return [item.regionid || "", item.sectionid || "", community, address, floor, area, layout].join("|");
}

function priceNum(price) {
  const n = Number(String(price || "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function stripParen(text) {
  return String(text || "").replace(/[()（）]/g, "").trim();
}

export function feesFromListItem(item) {
  const rows = [];
  const contain = stripParen(item.price_contain_text);
  if (contain) rows.push({ name: "租金含", value: contain, key: "contain" });
  const extraAmt = Number(item.extra_fee) || 0;
  const extraText = stripParen(item.extra_fee_text);
  if (extraText || extraAmt > 0) {
    rows.push({
      name: "額外費用",
      value: extraText || `${extraAmt.toLocaleString("zh-TW")}元/月`,
      key: "extra",
      amount: extraAmt,
    });
  }
  return rows;
}

export function feesFromDetail(costRows, listFees = []) {
  const skip = new Set(["rentPrice"]);
  const rows = [];
  for (const row of costRows || []) {
    if (!row?.name || skip.has(row.key)) continue;
    const value = String(row.value || "").trim();
    if (!value || value === "--") continue;
    rows.push({ name: row.name, value, key: row.key || "" });
  }
  const contain = (listFees || []).find((row) => row.key === "contain");
  if (contain && !rows.some((row) => row.key === "contain" || /含水|含網路|含瓦斯/.test(row.value))) {
    rows.unshift(contain);
  }
  return rows;
}

export function mergeFeeRows(listFees, detailFees) {
  return feesFromDetail(detailFees || [], listFees);
}

export function normalizeListing(item) {
  const coords = coordsFromListing(item);
  const extraFee = Number(item.extra_fee) || 0;
  return {
    post_id: Number(item.id),
    source_key: sourceKey(item),
    title: item.title || "(無標題)",
    url: item.url || `https://rent.591.com.tw/${item.id}`,
    price: item.price || "",
    price_num: priceNum(item.price),
    extra_fee: extraFee,
    extra_fee_text: item.extra_fee_text || "",
    price_contain_text: item.price_contain_text || "",
    extra_fees: JSON.stringify(feesFromListItem(item)),
    extra_fees_fetched: 0,
    address: item.address || "",
    area_name: item.area_name || "",
    layout: item.layoutStr || "",
    floor_name: item.floor_name || "",
    kind_name: item.kind_name || "",
    role_name: item.role_name || item.linkman || "",
    cover: item.cover || (item.photoList && item.photoList[0]) || "",
    community_id: item.community_id && Number(item.community_id) !== 0 ? Number(item.community_id) : 0,
    community_name: String(item.community_name || item.community || "").trim(),
    tags: JSON.stringify(item.tags || []),
    refresh_time: item.refresh_time || "",
    lat: coords.lat,
    lng: coords.lng,
  };
}

export async function fetchCostDetails(postId) {
  const detail = await fetchListingDetail(postId);
  return detail.fees;
}

export function contactFromLink(link = {}) {
  const line = String(link.line || "").trim();
  return {
    contact_name: String(link.name || link.imName || "").trim(),
    contact_role: String(link.roleName || "").trim(),
    agency: String(link.roleTxt || "").replace(/\s+/g, " ").trim(),
    mobile: String(link.mobile || "").trim(),
    phone: String(link.phone || "").trim(),
    line_url: /^https?:\/\//i.test(line) ? line : "",
    avatar: String(link.avatar || "").trim(),
    contact_uid: Number(link.uid || link.imUid) || null,
  };
}

const communityMemo = new Map();

export async function fetchCommunityLocation(communityId) {
  const id = Number(communityId);
  if (!id) return null;
  if (communityMemo.has(id)) return communityMemo.get(id);
  try {
    const res = await fetch(`https://bff.591.com.tw/v1/community/detail?id=${id}`, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        Referer: "https://market.591.com.tw/",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      communityMemo.set(id, null);
      return null;
    }
    const body = await res.json();
    if (body.status !== 1 && body.status !== true && !body.data?.community) {
      communityMemo.set(id, null);
      return null;
    }
    const loc = parseCommunityPayload(body);
    if (!loc.address && loc.lat == null) {
      communityMemo.set(id, null);
      return null;
    }
    loc.id = loc.id || id;
    communityMemo.set(id, loc);
    return loc;
  } catch {
    communityMemo.set(id, null);
    return null;
  }
}

async function fetchRentDetailBody(postId) {
  const res = await fetch(`https://bff-house.591.com.tw/v2/web/rent/detail?id=${postId}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      Referer: "https://rent.591.com.tw/",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) throw new ListingGoneError("物件不存在");
  if (!res.ok) throw new Error(`591 詳情 ${res.status}`);
  const body = await res.json();
  if (isListingGoneResponse(body, res.status)) {
    throw new ListingGoneError(body.msg || "物件不存在");
  }
  if (body.status !== 1 && body.status !== true && !body.data) {
    throw new Error(body.msg || "591 詳情失敗");
  }
  return body;
}

export async function probeListingAlive(postId) {
  await fetchRentDetailBody(postId);
  return true;
}

export async function fetchListingDetail(postId, options = {}) {
  const body = await fetchRentDetailBody(postId);
  const ref = communityRefFromDetail(body.data);
  let community = ref.id ? options.getCommunity?.(ref.id) : null;
  const cachedCommunity = community && (community.lat != null || community.address) ? community : null;
  if (ref.id && !community) {
    community = await fetchCommunityLocation(ref.id);
    options.saveCommunity?.(
      community || { id: ref.id, name: ref.name, address: "", lat: null, lng: null },
    );
  }
  const communityLoc = cachedCommunity || (community && (community.lat != null || community.address) ? community : null);
  if (communityLoc && ref.name && !communityLoc.name) {
    communityLoc.name = ref.name;
  }
  const chosen = preferCommunityLocation(
    {
      address: listingAddressFromDetail(body.data),
      ...coordsFrom591Detail(body.data),
      community_id: ref.id,
      community_name: ref.name,
    },
    communityLoc ? { ...communityLoc, id: communityLoc.id || ref.id, name: communityLoc.name || ref.name } : null,
  );
  return {
    fees: feesFromDetail(body.data?.cost?.data || []),
    contact: contactFromLink(body.data?.linkInfo || {}),
    lat: chosen.lat,
    lng: chosen.lng,
    address: chosen.address,
    geo_source: chosen.geo_source,
    community_id: chosen.community_id || ref.id || 0,
    community_name: chosen.community_name || ref.name || "",
  };
}

async function fetchPage(query, firstRow) {
  const params = new URLSearchParams(query);
  params.set("firstRow", String(firstRow));
  const res = await fetch(`${LIST_URL}?${params}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      Referer: "https://rent.591.com.tw/",
    },
  });
  if (!res.ok) {
    throw new Error(`591 回應 ${res.status}`);
  }
  const body = await res.json();
  if (body.status !== 1) {
    throw new Error(body.msg || "591 搜尋失敗");
  }
  return {
    total: Number(body.data?.total || 0),
    items: body.data?.items || [],
  };
}

export async function fetchListings(searchUrl, pages = 40, options = {}) {
  const parsed = parseSearchUrl(searchUrl);
  parsed.query.delete("kind");
  const listings = [];
  let total = 0;
  const maxPages = Math.max(1, Math.min(Number(pages) || MAX_LIST_PAGES, MAX_LIST_PAGES));
  for (let page = 0; page < maxPages; page += 1) {
    const { total: t, items } = await fetchPage(parsed.query, page * 30);
    total = t;
    listings.push(
      ...(await mapKeptListings(items, options)),
    );
    const fetched = (page + 1) * 30;
    if (items.length < 30 || fetched >= total) break;
    if (page + 1 < maxPages) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  return { searchUrl, parsed, total, listings };
}

async function mapKeptListings(items, options) {
  const out = [];
  for (const item of items) {
    const row = normalizeListing(item);
    if (!row.post_id) continue;
    if (isExcludedByKeyword(row, options.excludeKeywords)) continue;
    if (!passesAttributeFilters(row, options)) continue;
    if (passesGeoFilters(row, options, { strict: false })) out.push(row);
  }
  return out;
}
