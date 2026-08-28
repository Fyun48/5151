import { shouldKeepListing } from "./floors.js";
import { coordsFromListing, geocodeAddress, isExcludedByKeyword } from "./geo.js";

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
]);

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
    params.append(key, value);
  }

  if (!params.get("order") && !params.get("sort")) {
    params.set("order", "posttime");
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
  const names = {
    1: "台北市",
    2: "新北市",
    3: "桃園市",
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
    const sectionNames = { 8: "士林區", 9: "北投區", 5: "大安區", 7: "信義區", 4: "松山區", 3: "中山區", 1: "中正區", 2: "大同區", 6: "萬華區", 10: "內湖區", 11: "南港區", 12: "文山區" };
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
    tags: JSON.stringify(item.tags || []),
    refresh_time: item.refresh_time || "",
    lat: coords.lat,
    lng: coords.lng,
  };
}

export async function fetchCostDetails(postId) {
  const res = await fetch(`https://bff-house.591.com.tw/v2/web/rent/detail?id=${postId}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      Referer: "https://rent.591.com.tw/",
    },
  });
  if (!res.ok) throw new Error(`591 詳情 ${res.status}`);
  const body = await res.json();
  if (body.status !== 1 && body.status !== true && !body.data) {
    throw new Error(body.msg || "591 詳情失敗");
  }
  return feesFromDetail(body.data?.cost?.data || []);
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

export async function fetchListings(searchUrl, pages = 2, options = {}) {
  const parsed = parseSearchUrl(searchUrl);
  if (options.wholeFloorOnly !== false) {
    parsed.query.set("kind", "1");
  }
  const listings = [];
  let total = 0;
  const maxPages = Math.max(1, Math.min(Number(pages) || 1, 5));
  for (let page = 0; page < maxPages; page += 1) {
    const { total: t, items } = await fetchPage(parsed.query, page * 30);
    total = t;
    listings.push(
      ...(await mapKeptListings(items, options)),
    );
    if (items.length < 30) break;
    if (page + 1 < maxPages) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  return { searchUrl, parsed, total, listings };
}

async function mapKeptListings(items, options) {
  const out = [];
  const boxes = Array.isArray(options.excludeBoxes) ? options.excludeBoxes : [];
  for (const item of items) {
    const row = normalizeListing(item);
    if (!row.post_id) continue;
    if (isExcludedByKeyword(row, options.excludeKeywords)) continue;
    if (boxes.length && (row.lat == null || row.lng == null) && /\d/.test(row.address || "")) {
      const cached = options.lookupGeo?.(row.address);
      if (cached) {
        row.lat = cached.lat;
        row.lng = cached.lng;
      } else {
        const geo = await geocodeAddress(row.address, options.lookupGeo);
        if (geo) {
          row.lat = geo.lat;
          row.lng = geo.lng;
          options.saveGeo?.(row.address, geo.lat, geo.lng);
          await new Promise((resolve) => setTimeout(resolve, 1100));
        }
      }
    }
    if (shouldKeepListing(row, options)) out.push(row);
  }
  return out;
}
