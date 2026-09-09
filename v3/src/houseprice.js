import { createHash } from "node:crypto";
import { passesAttributeFilters } from "./floors.js";
import { decodeEntities } from "./htmlEntities.js";
import { isExcludedByKeyword } from "./geo.js";
import { isTaiwanMapPin } from "./location.js";
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

/** 5168 明細現在是 SPA，內頁 HTML 只剩殼；完整欄位（含門牌地址與經緯度）走這支 JSON API。 */
export function hpDetailApiUrl(id) {
  const key = String(id || "").trim();
  if (!key) return `${HP_SITE}/ws/detail/`;
  return `${HP_SITE}/ws/detail/${encodeURIComponent(key)}`;
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

function stripTags(html) {
  return decodeEntities(String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

const HP_FIELD_LABELS = "地址|社區|樓層|坪數|型態|格局|用途|車位|現況|管理費|押金";

/** 5168「樓層 / 22 / 24樓」＝出租 22、總樓高 24。 */
export function normalizeHpFloorName(value) {
  const raw = String(value || "").replace(/樓\s*$/, "").replace(/[／]/g, "/").replace(/\s+/g, "").trim();
  if (!raw || raw === "--" || raw === "-") return "";
  const range = raw.match(/^(\d+)(?:-(\d+))?\/(\d+)$/);
  if (range) {
    const low = range[2] && range[2] !== range[1] ? `${range[1]}-${range[2]}` : range[1];
    return `${low}/${range[3]}`;
  }
  const pair = String(value || "").match(/(\d+)\s*[\/／]\s*(\d+)\s*樓?/);
  if (pair) return `${pair[1]}/${pair[2]}`;
  const only = raw.match(/^(\d+)$/);
  return only ? only[1] : raw;
}

export function floorNameLooksComplete(value) {
  return /\d+\s*[\/／]\s*\d+/.test(String(value || ""));
}

function cleanCommunityName(value) {
  const v = String(value || "").trim().replace(/^社區\s*[\/：:]\s*/, "");
  if (!v || /^[-–—]$/.test(v) || v === "無" || v === "無社區" || v === "--") return "";
  return v;
}

/** 內頁常見「標籤 / 值」或「標籤：值」，含「樓層 / 22 / 24樓」。 */
export function parseHpLabeledPlain(text) {
  const source = String(text || "");
  const fields = {};
  const re = new RegExp(`(?:^|[\\s>])(${HP_FIELD_LABELS})\\s*[\\/：:]\\s*([^\\n<]+?)(?=\\s+(?:${HP_FIELD_LABELS})\\s*[\\/：:]|$)`, "g");
  let m;
  while ((m = re.exec(source))) {
    const label = m[1];
    let value = stripTags(m[2]).trim();
    if (label === "樓層") {
      const extra = String(value).match(/(\d+)\s*[\/／]\s*(\d+)\s*樓?/)
        || source.slice(m.index, m.index + 48).match(/樓層\s*[\/：:]\s*(\d+)\s*[\/／]\s*(\d+)\s*樓?/);
      if (extra) value = `${extra[1]} / ${extra[2]}樓`;
    }
    if (label && value && !(label in fields)) fields[label] = value;
  }
  return fields;
}

/** 有門牌號的地址才能精準地理編碼；用它決定要不要用明細頁地址覆蓋列表頁的粗略地址。 */
export function addressHasHouseNumber(address) {
  return /\d+(?:之\d+)?號/.test(String(address || "").replace(/\s+/g, ""));
}

/** 從多個候選地址挑最精準：優先有門牌號者，否則第一個非空字串。 */
function pickBestAddress(candidates) {
  const list = (candidates || []).map((value) => String(value || "").trim()).filter(Boolean);
  return list.find((value) => addressHasHouseNumber(value)) || list[0] || "";
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
    const labeled = parseHpLabeledPlain(stripTags(card));
    const addressMatch = card.match(/location-filled[\s\S]{0,180}?<span>\s*([^<]+)\s*<\/span>/i)
      || card.match(/台北市[^<]{2,80}區[^<]{0,60}\d[^<]{0,20}號/)
      || card.match(/新北市[^<]{2,80}區[^<]{0,60}\d[^<]{0,20}號/)
      || card.match(/台北市[^<]{2,40}區[^<]{0,40}/)
      || card.match(/新北市[^<]{2,40}區[^<]{0,40}/);
    const communityMatch = card.match(/building-fill[\s\S]{0,180}?<span>\s*([^<]+)\s*<\/span>/i)
      || card.match(/【([^【】]{1,20})】/);
    const priceMatch = card.match(/>(\d{3,})\s*<\/span>\s*<span[^>]*>元\/月/);
    const kind = kindFromHpText(card);
    const areaMatch = stripTags(card).match(/([\d.]+)\s*坪/);
    const layoutMatch = stripTags(card).match(/(\d+\s*房[\d廳衛陽台\s]*)/);
    const floorMatch = stripTags(card).match(/(\d+\s*[\/／]\s*\d+)\s*樓/)
      || String(labeled["樓層"] || "").match(/(\d+\s*[\/／]\s*\d+)/);
    items.push({
      id: idMatch[1],
      title,
      address: pickBestAddress([
        labeled["地址"],
        decodeEntities(String(addressMatch?.[1] || addressMatch?.[0] || "").trim()),
      ]),
      community: cleanCommunityName(communityMatch?.[1] || labeled["社區"]),
      cover,
      price: Number(priceMatch?.[1]) || 0,
      kind,
      areaName: areaMatch ? `${areaMatch[1].replace(/\.0$/, "")}坪` : String(labeled["坪數"] || "").replace(/\s+/g, ""),
      layout: layoutMatch ? layoutMatch[1].replace(/\s+/g, "") : String(labeled["格局"] || "").replace(/\s+/g, ""),
      floorName: normalizeHpFloorName(floorMatch?.[1] || labeled["樓層"] || ""),
      text: stripTags(card),
    });
  }
  return { total: total || items.length, items };
}

/** 5168 物件明細頁：`現況/型態/坪數/樓層/格局/車位/社區` 是一組 label→value span。
    列表頁常缺總樓層與社區，明細頁才完整，故用它補齊同屋源指紋需要的欄位。 */
export function parseHpDetailHtml(html) {
  const source = String(html || "");
  const fields = {};
  // 「基本資料」的 label/value 相鄰；「其他資料」的 value span 帶 data-test 且中間有換行，故容忍空白與額外屬性。
  const re = /<span class="mr-3 text-c-dark-300">([^<]+)<\/span\s*>\s*<span class="text-c-dark-900"[^>]*>([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(source))) {
    const label = stripTags(m[1]).trim();
    const value = stripTags(m[2]).trim();
    if (label && !(label in fields)) fields[label] = value;
  }
  const labeled = parseHpLabeledPlain(stripTags(source));
  for (const [key, value] of Object.entries(labeled)) {
    if (!(key in fields)) fields[key] = value;
  }
  const floorName = normalizeHpFloorName(fields["樓層"]);
  // 部分（多為 591 轉入的純數字 id）明細頁沒有 label span，只有 meta description，用它補地址／坪數／格局／現況。
  const descMatch = source.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i);
  const desc = descMatch ? decodeEntities(descMatch[1]) : "";
  const addrMeta = source.match(/位於([^租,，]+?)(?:租金|[,，]|坪數|$)/) || desc.match(/位於([^租,，]+?)(?:租金|[,，]|坪數|$)/);
  const descArea = desc.match(/坪數\s*([\d.]+)/) || desc.match(/([\d.]+)\s*坪/);
  const descLayout = [...desc.matchAll(/(\d+\s*房[\d廳衛陽台\s]*)/g)]
    .map((m) => m[1].replace(/\s+/g, ""))
    .sort((a, b) => b.length - a.length)[0] || "";
  const areaName = String(fields["坪數"] || "").replace(/\s+/g, "").trim()
    || (descArea ? `${descArea[1].replace(/\.0$/, "")}坪` : "");
  const layout = String(fields["格局"] || "").replace(/\s+/g, "").trim() || descLayout;
  // 明細頁的地圖連結內含精準經緯度（query=lat,lng）與地址文字，直接拿來定位，免再打地理編碼服務。
  const mapAnchor = source.match(/data-test="map-link"[^>]*>([\s\S]*?)<\/a>/i);
  const mapAddress = mapAnchor ? stripTags(mapAnchor[1]) : "";
  const coordMatch = source.match(/query=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
  let lat = null;
  let lng = null;
  if (coordMatch && isTaiwanMapPin(coordMatch[1], coordMatch[2])) {
    lat = Number(coordMatch[1]);
    lng = Number(coordMatch[2]);
  }
  const address = pickBestAddress([fields["地址"], mapAddress, addrMeta ? addrMeta[1] : ""]);
  return {
    floorName,
    community: cleanCommunityName(fields["社區"]),
    areaName,
    layout,
    kind: kindFromHpText(fields["現況"] || "") || kindFromHpText(fields["型態"] || "") || kindFromHpText(desc),
    buildingType: String(fields["型態"] || "").trim(),
    parking: String(fields["車位"] || "").trim(),
    usage: String(fields["用途"] || "").trim(),
    address,
    lat,
    lng,
    fields,
  };
}

/** 解析 5168 明細 JSON API（/ws/detail/{id}）。回傳與 parseHpDetailHtml 相同的形狀；無法解析時回 null 讓外層退回 HTML。 */
export function parseHpDetailJson(payload) {
  let root = payload;
  if (typeof payload === "string") {
    try { root = JSON.parse(payload); } catch { return null; }
  }
  if (!root || typeof root !== "object") return null;
  const det = root.webRentCaseGroupingDetail || root.webRentCaseGroupingDet || root.caseDetail || root;
  if (!det || typeof det !== "object") return null;
  const str = (value) => String(value ?? "").trim();
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const toFloor = str(det.toFloor ?? det.to_floor ?? det.rentFloor ?? det.floor);
  const upFloor = str(det.upFloor ?? det.up_floor ?? det.totalFloor ?? det.total_floor);
  const fromFloor = str(det.fromFloor ?? det.from_floor);
  let floorName = "";
  if (upFloor) {
    const low = fromFloor && fromFloor !== toFloor ? `${fromFloor}-${toFloor}` : toFloor;
    floorName = normalizeHpFloorName(low ? `${low}/${upFloor}` : upFloor);
  } else if (toFloor) {
    floorName = normalizeHpFloorName(toFloor);
  }
  const rm = str(det.rm);
  const livingRm = str(det.livingRm);
  const bathRm = str(det.bathRm);
  const spaceRm = num(det.spaceRm);
  let layout = "";
  if (rm || livingRm || bathRm) {
    layout = `${rm || 0}房${livingRm || 0}廳${bathRm || 0}衛`;
    if (spaceRm && spaceRm > 0) layout += `${spaceRm}陽台`;
  }
  const buildPin = num(det.buildPin);
  const areaName = buildPin && buildPin > 0 ? `${String(buildPin).replace(/\.0$/, "")}坪` : "";
  const usage = str(det.rentPurPoseName);
  const buildingType = str(det.caseTypeName);
  const lat = num(det.lat);
  const lng = num(det.lng);
  const cityRoad = [str(det.city), str(det.district), str(det.road)].filter(Boolean).join("");
  const address = pickBestAddress([
    str(det.simpAddress),
    str(det.address),
    str(det.fullAddress),
    str(det.doorplate),
    cityRoad,
  ]);
  const conditionTags = Array.isArray(det.conditionTags) ? det.conditionTags.map(str).filter(Boolean) : [];
  const tagCommunity = (Array.isArray(det.tags) ? det.tags : [])
    .filter((row) => row && (Number(row.type) === 2 || row.communityId || row.id))
    .map((row) => str(row.name))
    .find(Boolean);
  const titleCommunity = str(det.caseName).match(/【([^】]{1,20})】/)?.[1] || "";
  const community = cleanCommunityName(
    det.communityName || det.community || det.communityTag || det.buildName || tagCommunity || titleCommunity || conditionTags[0],
  );
  return {
    floorName,
    community,
    areaName,
    layout,
    kind: kindFromHpText(usage) || kindFromHpText(buildingType) || kindFromHpText(str(det.caseName)),
    buildingType,
    parking: str(det.parkingYN) === "Y" ? "有車位" : "",
    usage,
    address,
    lat: lat != null && lng != null && isTaiwanMapPin(lat, lng) ? lat : null,
    lng: lat != null && lng != null && isTaiwanMapPin(lat, lng) ? lng : null,
    conditionTags,
    fields: {
      現況: usage,
      型態: buildingType,
      坪數: areaName,
      樓層: floorName ? `${floorName}樓` : "",
      格局: layout,
      社區: community,
      用途: usage,
      地址: address,
    },
  };
}

/** 先試 JSON API 取完整明細（含經緯度），失敗才退回舊 SSR HTML 解析。 */
export async function fetchHpDetail(id, getHtml) {
  try {
    const detail = parseHpDetailJson(await getHtml(hpDetailApiUrl(id)));
    if (detail && (detail.lat != null || detail.floorName || detail.community || detail.address || detail.layout)) {
      return detail;
    }
  } catch { /* JSON API 不可用就退回 HTML */ }
  try {
    return parseHpDetailHtml(await getHtml(hpDetailUrl(id)));
  } catch {
    return null;
  }
}

/** 用明細頁補齊列表頁缺的樓層／社區／坪數／格局／現況，並重算同屋源指紋 source_key。 */
export function enrichHpListingFromDetail(row, detail, { regionId, sectionId } = {}) {
  if (!row || !detail) return row;
  const next = { ...row };
  let changed = false;
  if (detail.floorName && (!next.floor_name || (!floorNameLooksComplete(next.floor_name) && floorNameLooksComplete(detail.floorName)))) {
    next.floor_name = detail.floorName;
    changed = true;
  }
  if (!next.area_name && detail.areaName) { next.area_name = detail.areaName; }
  if (!next.layout && detail.layout) { next.layout = detail.layout; }
  if ((!next.kind_name || next.kind_name === "") && detail.kind) { next.kind_name = detail.kind; }
  // 明細頁地址通常比列表頁完整（含門牌號），有門牌才有機會精準定位，故用它覆蓋粗略地址。
  if (detail.address && (!next.address || (addressHasHouseNumber(detail.address) && !addressHasHouseNumber(next.address)))) {
    next.address = detail.address;
    changed = true;
  }
  // 明細頁地圖連結帶精準座標：直接寫入 lat/lng 並標記 geo_source，之後才會被通勤／捷運距離回填採用。
  if (detail.lat != null && detail.lng != null && (next.lat == null || next.lng == null)) {
    next.lat = detail.lat;
    next.lng = detail.lng;
    next.geo_source = "houseprice";
  }
  let tags = null;
  const ensureTags = () => {
    if (tags) return tags;
    try { tags = JSON.parse(next.tags || "[]"); } catch { tags = []; }
    if (!Array.isArray(tags)) tags = [];
    return tags;
  };
  if (!next.community_name && detail.community) {
    next.community_name = detail.community;
    const t = ensureTags();
    if (!t.includes(detail.community)) t.push(detail.community);
    changed = true;
  }
  if (detail.parking && /車位/.test(detail.parking) && !/^無/.test(detail.parking)) {
    const t = ensureTags();
    if (!t.includes(detail.parking)) t.push(detail.parking);
  }
  if (detail.usage && !/^[-–—]$/.test(detail.usage) && detail.usage !== next.kind_name) {
    const t = ensureTags();
    if (!t.includes(detail.usage)) t.push(detail.usage);
  }
  if (Array.isArray(detail.conditionTags)) {
    for (const tag of detail.conditionTags) {
      const label = String(tag || "").trim();
      if (!label) continue;
      const t = ensureTags();
      if (!t.includes(label)) t.push(label);
    }
  }
  if (tags) next.tags = JSON.stringify(tags);
  if (changed) {
    next.source_key = listingSourceKey({
      regionId: Number(regionId) || 0,
      sectionId: Number(sectionId) || 0,
      address: next.address,
      floorName: next.floor_name,
      areaName: next.area_name,
      layout: next.layout,
    });
  }
  return next;
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

/** 從物件網址（或直接是 case id）取出 5168 case id。 */
export function hpIdFromUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const m = raw.match(/\/house\/([^/?#]+)/) || raw.match(/\/ws\/detail\/([^/?#]+)/);
  if (m) return decodeURIComponent(m[1]);
  return /^https?:/i.test(raw) ? "" : raw;
}

/** 點擊時即時確認 5168 物件是否還在。
 *  內頁已改為 SPA（HTML 殼恆回 200），故改打明細 JSON API /ws/detail/{id} 判斷：
 *  400/404/410 或回應內沒有物件明細（webRentCaseGroupingDetail 空）＝已下架；
 *  其它錯誤（403/429/5xx／逾時／非 JSON）保守不當作下架。 */
export async function probeHpListingAlive(url) {
  const id = hpIdFromUrl(url);
  if (!id) return true;
  let res;
  try {
    res = await fetch(hpDetailApiUrl(id), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Referer: hpDetailUrl(id),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return true;
  }
  if (res.status === 400 || res.status === 404 || res.status === 410) return false;
  if (!res.ok) return true;
  let body;
  try {
    body = await res.json();
  } catch {
    return true;
  }
  const det = body?.webRentCaseGroupingDetail || body?.webRentCaseGroupingDet || body?.caseDetail;
  const hasDetail = det && typeof det === "object" && Object.keys(det).length > 0;
  return hasDetail ? true : false;
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
  let detailBudget = Math.max(0, Number(options.detailLimit ?? 30));

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
          let row = normalizeHpItem(item, { regionId, sectionId });
          if (!row) continue;
          if (!keepHpListing(row, {
            ...options,
            priceMin: job.priceMin,
            priceMax: job.priceMax,
          })) continue;
          seen.add(id);
          // 缺樓層／社區要補明細；缺座標也要補（明細頁地圖連結才有精準經緯度，通勤與捷運距離都靠它）。
          const needDetail = !row.floor_name || !floorNameLooksComplete(row.floor_name) || !row.community_name || !addressHasHouseNumber(row.address) || row.lat == null;
          const alreadyGeo = typeof options.hasGeo === "function" && options.hasGeo(row.post_id);
          if (detailBudget > 0 && needDetail && !alreadyGeo) {
            const detail = await fetchHpDetail(id, getHtml);
            if (detail) row = enrichHpListingFromDetail(row, detail, { regionId, sectionId });
            detailBudget -= 1;
            const gap = options.detailGapMs ?? options.gapMs ?? 300;
            if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
          }
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
