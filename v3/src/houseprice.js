import { createHash } from "node:crypto";
import { passesAttributeFilters, sanitizeFloorName } from "./floors.js";
import { listingKitFields } from "./listingKit.js";
import { decodeEntities } from "./htmlEntities.js";
import { isExcludedByKeyword } from "./geo.js";
import { addressHasPrecisePart, addressPrecision, extractTaiwanStreetAddress, isTaiwanMapPin, pickRicherAddress, sourceCommunityLinked } from "./location.js";
import { shouldAcceptGeoUpdate } from "./geoPrecision.js";
import { PROBE_ALIVE, PROBE_GONE, PROBE_INCONCLUSIVE } from "./probeOutcomes.js";
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
  if (!raw || raw === "--" || raw === "-" || Number(raw) <= 0) return "";
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

export function rentalFloorProvided(value) {
  const normalized = normalizeHpFloorName(value) || String(value || "").trim();
  if (!normalized) return false;
  if (floorNameLooksComplete(normalized)) return true;
  return /^(?:B\d+|地下\d*|\d+)(?:F|樓)?$/i.test(normalized.replace(/\s+/g, ""));
}

export function parseRetryAfterMs(value) {
  if (value == null || value === "") return 0;
  const raw = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Math.min(24 * 60 * 60 * 1000, Math.max(0, Math.round(Number(raw) * 1000)));
  }
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.min(24 * 60 * 60 * 1000, Math.max(0, at - Date.now()));
  return 0;
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

/** 有門牌號或巷／弄才算精準；用來決定要不要用明細頁地址覆蓋列表粗址。 */
export function addressHasHouseNumber(address) {
  return addressHasPrecisePart(address);
}

/** 從多個候選地址挑最精準：號／巷／弄優先，其次較長的完整字串。 */
function pickBestAddress(candidates) {
  return pickRicherAddress(candidates);
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
    const locationSpan = card.match(/location-filled[\s\S]{0,180}?<span>\s*([^<]+)\s*<\/span>/i);
    const communityBlock = card.match(/building-fill[\s\S]{0,240}?<span>([\s\S]*?)<\/span>/i);
    const communityHtml = communityBlock?.[1] || "";
    const communityMatch = communityHtml
      || (card.match(/【([^【】]{1,20})】/) || [])[1]
      || "";
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
        decodeEntities(String(locationSpan?.[1] || "").trim()),
        extractTaiwanStreetAddress(stripTags(card)),
      ]),
      community: cleanCommunityName(stripTags(communityMatch) || labeled["社區"]),
      communityLinked: sourceCommunityLinked({ hasAnchor: /<a\b/i.test(communityHtml) }),
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
  let communityLinked = false;
  const communityRe = /<span class="mr-3 text-c-dark-300">社區<\/span\s*>\s*<span class="text-c-dark-900"[^>]*>([\s\S]*?)<\/span>/i;
  const communityHtml = source.match(communityRe)?.[1] || "";
  if (/<a\b/i.test(communityHtml)) communityLinked = true;
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
  const address = pickBestAddress([
    fields["地址"],
    mapAddress,
    addrMeta ? addrMeta[1] : "",
    extractTaiwanStreetAddress(stripTags(source)),
  ]);
  return {
    floorName,
    community: cleanCommunityName(fields["社區"]),
    communityId: 0,
    communityLinked,
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
  const toFloor = sanitizeFloorName(str(det.toFloor ?? det.to_floor ?? det.rentFloor ?? det.floor));
  const upFloor = sanitizeFloorName(str(det.upFloor ?? det.up_floor ?? det.totalFloor ?? det.total_floor));
  const fromFloor = sanitizeFloorName(str(det.fromFloor ?? det.from_floor));
  let floorName = "";
  if (toFloor && upFloor) {
    const low = fromFloor && fromFloor !== toFloor ? `${fromFloor}-${toFloor}` : toFloor;
    floorName = normalizeHpFloorName(`${low}/${upFloor}`);
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
  const namesFrom = (list) => (Array.isArray(list) ? list : [])
    .map((item) => str(item?.name || item?.label || item))
    .filter(Boolean);
  const conditionTags = Array.isArray(det.conditionTags) ? det.conditionTags.map(str).filter(Boolean) : [];
  const facilities = namesFrom(det.facilities);
  const equipments = namesFrom(det.equipments);
  const devices = namesFrom(det.devices);
  const facilityRemark = str(det.facilityRemark || det.equipRemark || det.facility_text);
  const tagCommunity = (Array.isArray(det.tags) ? det.tags : [])
    .filter((row) => row && (Number(row.type) === 2 || row.communityId))
    .map((row) => str(row.name))
    .find(Boolean);
  const titleCommunity = str(det.caseName).match(/【([^】]{1,20})】/)?.[1] || "";
  const communityId = Number(det.communityId || det.community_id) || 0;
  const community = cleanCommunityName(
    det.communityName || det.community || det.communityTag || det.buildName || tagCommunity || titleCommunity,
  );
  const communityLinked = sourceCommunityLinked({
    communityId,
    href: det.communityUrl || det.community_url || "",
  });
  const priceNum = num(det.rentPrice ?? det.price ?? det.rent);
  const title = str(det.caseName || det.title);
  const sourceId = str(det.sid ?? det.caseId ?? det.id);
  return {
    title,
    price_num: priceNum && priceNum > 0 ? priceNum : 0,
    price: priceNum && priceNum > 0 ? String(priceNum) : "",
    source_id: sourceId,
    floorName,
    community,
    communityId,
    communityLinked,
    areaName,
    layout,
    kind: kindFromHpText(usage) || kindFromHpText(buildingType) || kindFromHpText(str(det.caseName)),
    buildingType,
    parking: str(det.parkingYN) === "Y" ? "有車位" : (str(det.parkingYN) === "N" ? "無車位" : ""),
    usage,
    address,
    lat: lat != null && lng != null && isTaiwanMapPin(lat, lng) ? lat : null,
    lng: lat != null && lng != null && isTaiwanMapPin(lat, lng) ? lng : null,
    conditionTags,
    facilities,
    equipments,
    devices,
    facilityRemark,
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
function detailMatchesExpectedId(detail, expectedId) {
  const expected = String(expectedId || "").trim();
  if (!expected || !detail) return !expected;
  const actual = String(detail.source_id || detail.sid || detail.caseId || detail.id || "").trim();
  if (!actual) return true;
  return identitiesMatch(expected, actual);
}

export async function fetchHpDetail(id, getHtml = defaultGetHtml) {
  const key = hpIdFromUrl(id) || String(id || "").trim();
  if (!key) return null;
  const load = typeof getHtml === "function" ? getHtml : defaultGetHtml;
  try {
    const detail = parseHpDetailJson(await load(hpDetailApiUrl(key)));
    if (detail && !detailMatchesExpectedId(detail, key)) return null;
    if (detail && (detail.lat != null || detail.floorName || detail.community || detail.address || detail.layout)) {
      return detail;
    }
  } catch { /* JSON API 不可用就退回 HTML */ }
  try {
    const htmlDetail = parseHpDetailHtml(await load(hpDetailUrl(key)));
    if (htmlDetail && !detailMatchesExpectedId(htmlDetail, key)) return null;
    return htmlDetail;
  } catch {
    return null;
  }
}

/** 用明細頁補齊列表頁缺的樓層／社區／坪數／格局／現況，並重算同屋源指紋 source_key。 */
export function enrichHpListingFromDetail(row, detail, { regionId, sectionId, replaceBetterGeo = true } = {}) {
  if (!row || !detail) return row;
  const expectedId = String(row.source_id || "").trim();
  if (expectedId && !detailMatchesExpectedId(detail, expectedId)) return row;
  const next = { ...row };
  let changed = false;
  const detailFloor = sanitizeFloorName(detail.floorName);
  if (detailFloor && rentalFloorProvided(detailFloor) && (
    !next.floor_name
    || !rentalFloorProvided(next.floor_name)
    || detailFloor !== next.floor_name
  )) {
    next.floor_name = detailFloor;
    changed = true;
  }
  if (detail.title && detail.title !== next.title) {
    next.title = detail.title;
    changed = true;
  }
  if (Number(detail.price_num) > 0 && Number(detail.price_num) !== Number(next.price_num)) {
    next.price_num = Number(detail.price_num);
    next.price = detail.price || String(detail.price_num);
    changed = true;
  }
  if (!next.area_name && detail.areaName) { next.area_name = detail.areaName; }
  if (!next.layout && detail.layout) { next.layout = detail.layout; }
  if ((!next.kind_name || next.kind_name === "") && detail.kind) { next.kind_name = detail.kind; }
  // 同精度門牌更正也要寫入；較粗的地址不能覆蓋較精的。
  if (detail.address && (!next.address || addressPrecision(detail.address) >= addressPrecision(next.address))) {
    if (detail.address !== next.address) {
      next.address = detail.address;
      changed = true;
    }
  }
  if (detail.lat != null && detail.lng != null && isTaiwanMapPin(detail.lat, detail.lng)) {
    const incomingGeo = { lat: detail.lat, lng: detail.lng, geo_source: "houseprice", address: detail.address || next.address };
    if (next.lat == null || next.lng == null || (replaceBetterGeo && shouldAcceptGeoUpdate(next, incomingGeo))) {
      next.lat = detail.lat;
      next.lng = detail.lng;
      next.geo_source = "houseprice";
      next.clear_coords = false;
    }
  } else if (changed && next.address !== row.address) {
    next.lat = null;
    next.lng = null;
    next.geo_source = "";
    next.clear_coords = true;
  }
  let tags = null;
  const ensureTags = () => {
    if (tags) return tags;
    try { tags = JSON.parse(next.tags || "[]"); } catch { tags = []; }
    if (!Array.isArray(tags)) tags = [];
    return tags;
  };
  if (Number(detail.communityId) > 0) {
    next.community_id = Number(detail.communityId);
    changed = true;
  }
  if (detail.communityLinked || Number(detail.communityId) > 0) {
    next.community_linked = 1;
  }
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
  const facilityPatch = applyHpFacilityEvidence(next, detail);
  if (Array.isArray(detail.conditionTags)) {
    for (const tag of detail.conditionTags) {
      const label = String(tag || "").trim();
      if (!label || /^無|^沒有/.test(label)) continue;
      const t = ensureTags();
      if (!t.includes(label)) t.push(label);
    }
  }
  if (tags) next.tags = JSON.stringify(tags);
  if (facilityPatch.replace) {
    next.tags = facilityPatch.tags;
    next.has_natural_gas = facilityPatch.has_natural_gas;
    next.has_balcony = facilityPatch.has_balcony;
    next.furnish_items = facilityPatch.furnish_items;
    next.facility_replace = true;
  } else {
    Object.assign(next, listingKitFields({
      title: next.title,
      tags: next.tags,
      text: `${next.address || ""} ${detail.usage || ""} ${detail.facilityRemark || ""}`,
      conditionTags: detail.conditionTags,
      furnish: [...(detail.facilities || []), ...(detail.equipments || []), ...(detail.devices || [])],
      has_natural_gas: next.has_natural_gas,
      furnish_items: next.furnish_items,
    }));
  }
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
  const floorName = sanitizeFloorName(item.floorName);
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
    ...listingKitFields({ title: item.title, tags, text: item.text, conditionTags: item.conditionTags }),
    kind_name: kindName,
    role_name: "5168租屋",
    cover: String(item.cover || "").trim(),
    community_id: Number(item.communityId) || 0,
    community_name: String(item.community || "").trim(),
    community_linked: item.communityLinked || Number(item.communityId) > 0 ? 1 : 0,
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

const HP_GONE_TEXT = /物件已(下架|成交|出租|刪除|結案)|查無(此|該)?(物件|案件)|案件不存在|物件不存在/;
const HP_STATUS_GONE = /已下架|已成交|已出租|已刪除|已結案|不存在|offshelf|offline/i;
const HP_FACILITY_TAG = /冷氣|冰箱|洗衣機|烘衣|電視|網路|家具|家俱|陽台|瓦斯|床|衣櫃|沙發/;

function hpDetailObject(body) {
  if (!body || typeof body !== "object") return null;
  const det = body.webRentCaseGroupingDetail || body.webRentCaseGroupingDet || body.caseDetail;
  return det && typeof det === "object" ? det : null;
}

function hpDetailIdentity(det) {
  if (!det || typeof det !== "object") return "";
  return String(det.sid ?? det.caseId ?? det.id ?? "").trim();
}

function hpApiGoneSignal(json) {
  if (!json || typeof json !== "object") return false;
  const msg = String(json.msg || json.message || json.error || json.errMsg || "");
  if (HP_GONE_TEXT.test(msg)) return true;
  const code = String(json.code ?? json.status ?? "");
  if (/^(404|410)$/.test(code)) return true;
  return false;
}

function hpCaseStatusGone(det) {
  if (!det || typeof det !== "object") return false;
  if (Number(det.isOff) === 1 || det.offShelf === true || det.isDelete === true) return true;
  const status = String(det.caseStatus || det.rentStatus || det.status || det.caseState || "");
  return Boolean(status) && HP_STATUS_GONE.test(status);
}

const FACILITY_ITEM_RE = /冷氣|冰箱|洗衣機|烘衣|電視|網路|家具|家俱|陽台|瓦斯|床|衣櫃|沙發/;
const FACILITY_CANCEL_RE = /^(?:無|沒有|不含|不附|未提供)/;

function facilityNameList(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => String(item?.name || item?.label || item || "").trim())
    .filter(Boolean);
}

function splitFacilityTokens(text) {
  return String(text || "")
    .split(/[,，、;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseHpFacilityTokens(det = {}) {
  const raw = [
    ...facilityNameList(det.conditionTags),
    ...facilityNameList(det.facilities),
    ...facilityNameList(det.equipments),
    ...facilityNameList(det.devices),
    ...splitFacilityTokens(det.facilityRemark || det.equipRemark || det.facility_text),
  ];
  const present = [];
  const cancelled = [];
  for (const label of raw) {
    if (!label || /無設備|沒有設備|不含設備|不附設備/.test(label)) continue;
    const cancelledItem = FACILITY_CANCEL_RE.test(label)
      ? label.replace(FACILITY_CANCEL_RE, "").replace(/^的/, "").trim()
      : "";
    if (cancelledItem) {
      if (!cancelled.includes(cancelledItem)) cancelled.push(cancelledItem);
      continue;
    }
    if (!present.includes(label)) present.push(label);
  }
  return { present, cancelled };
}

export function applyHpFacilityEvidence(listing = {}, detail = {}) {
  const det = {
    conditionTags: detail.conditionTags,
    facilities: detail.facilities,
    equipments: detail.equipments,
    devices: detail.devices,
    facilityRemark: detail.facilityRemark,
    noFacility: detail.noFacility,
    noEquip: detail.noEquip,
  };
  const evidence = hpFacilityEvidence({ ...detail, ...det });
  const tokens = parseHpFacilityTokens({ ...detail, ...det });
  const remark = String(detail.facilityRemark || detail.equipRemark || "");
  const hasSource = evidence.block || evidence.absent || tokens.present.length || tokens.cancelled.length || remark;
  if (!hasSource && !evidence.partial) {
    return { replace: false };
  }
  const kit = listingKitFields({
    title: listing.title,
    text: `${detail.usage || ""} ${remark}`,
    conditionTags: tokens.present,
    furnish: tokens.present,
    facility: tokens.present,
    tags: tokens.present,
    has_natural_gas: tokens.cancelled.some((item) => /瓦斯/.test(item)) ? 0 : undefined,
    gas_state: tokens.cancelled.some((item) => /瓦斯/.test(item)) || tokens.present.some((item) => /天然瓦斯/.test(item))
      ? "known"
      : undefined,
    kit_complete: evidence.block || evidence.absent,
  });
  let furnish = [];
  try { furnish = JSON.parse(kit.furnish_items || "[]"); } catch { furnish = []; }
  furnish = furnish.filter((item) => !tokens.cancelled.some((gone) => String(item).includes(gone) || gone.includes(item)));
  const tags = tokens.present.filter((item) => !tokens.cancelled.some((gone) => item.includes(gone) || gone.includes(item)));
  const gasCancelled = tokens.cancelled.some((item) => /瓦斯/.test(item));
  const gasPresent = tokens.present.some((item) => /天然瓦斯/.test(item));
  return {
    replace: evidence.block || evidence.absent || tokens.present.length > 0 || tokens.cancelled.length > 0,
    tags: JSON.stringify(tags),
    has_natural_gas: gasCancelled ? 0 : (gasPresent ? 1 : Number(kit.has_natural_gas) || 0),
    has_balcony: Number(kit.has_balcony) || 0,
    furnish_items: furnish,
  };
}

export function hpFacilityEvidence(det) {
  if (!det || typeof det !== "object") {
    return { block: false, absent: false, partial: false, parkingOnly: false };
  }
  const tags = Array.isArray(det.conditionTags) ? det.conditionTags.map((item) => String(item || "").trim()).filter(Boolean) : null;
  const extra = []
    .concat(Array.isArray(det.facilities) ? det.facilities : [])
    .concat(Array.isArray(det.equipments) ? det.equipments : [])
    .concat(Array.isArray(det.devices) ? det.devices : []);
  const remark = String(det.facilityRemark || det.equipRemark || det.facility_text || "");
  const tokens = parseHpFacilityTokens(det);
  const explicitNone = det.noFacility === true || det.noEquip === true || /無設備|沒有設備|不含設備|不附設備/.test(remark);
  const hasFacilityItems = (tags && tags.some((tag) => HP_FACILITY_TAG.test(tag)))
    || extra.some((item) => HP_FACILITY_TAG.test(String(item?.name || item || "")))
    || tokens.present.some((item) => FACILITY_ITEM_RE.test(item))
    || tokens.cancelled.length > 0
    || FACILITY_ITEM_RE.test(remark);
  if (explicitNone && !tokens.present.length) return { block: true, absent: true, partial: false, parkingOnly: false };
  if (hasFacilityItems) return { block: true, absent: false, partial: false, parkingOnly: false };
  const parking = String(det.parkingYN || "");
  if (tags && tags.length === 0 && parking === "N") return { block: false, absent: false, partial: true, parkingOnly: true };
  if (Array.isArray(det.conditionTags) || extra.length) return { block: false, absent: false, partial: true, parkingOnly: parking === "N" };
  return { block: false, absent: false, partial: false, parkingOnly: false };
}

function detailLooksRecognizable(det) {
  if (!det || typeof det !== "object") return false;
  const keys = Object.keys(det);
  if (!keys.length) return false;
  return Boolean(det.caseId || det.sid || det.caseName || det.simpAddress || det.address || det.lat || det.road);
}

function identitiesMatch(expected, actual) {
  const a = String(expected || "").trim();
  const b = String(actual || "").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const main = (value) => String(value).split("_")[0];
  return Boolean(main(a)) && main(a) === main(b);
}

export function inspectHpDetailResponse({
  status = 0,
  json = null,
  text = "",
  timeout = false,
  network = false,
  parse_ms = 0,
  fetch_ms = null,
  expectedId = "",
  retryAfter = "",
} = {}) {
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  const base = { parse_ms, fetch_ms, retryAfterMs };
  if (timeout || network) return { outcome: PROBE_INCONCLUSIVE, reason: timeout ? "timeout" : "network", errorClass: "transient", ...base };
  if (status === 404 || status === 410) return { outcome: PROBE_GONE, reason: `http_${status}`, errorClass: "", ...base };
  if (status === 403 || status === 429 || status >= 500) {
    return { outcome: PROBE_INCONCLUSIVE, reason: `http_${status}`, errorClass: "transient", ...base };
  }
  const challengeBlob = `${text || ""} ${String(json?.msg || "")}`;
  if (/驗證碼|captcha|cloudflare|just a moment/i.test(challengeBlob)) {
    return { outcome: PROBE_INCONCLUSIVE, reason: "challenge", errorClass: "transient", ...base };
  }
  const det = hpDetailObject(json);
  const expected = String(expectedId || "").trim();
  const actualId = hpDetailIdentity(det);
  if (expected && (detailLooksRecognizable(det) || actualId || hpCaseStatusGone(det))) {
    if (!actualId) {
      return { outcome: PROBE_INCONCLUSIVE, reason: "id_missing", errorClass: "parse_failed", ...base };
    }
    if (!identitiesMatch(expected, actualId)) {
      return { outcome: PROBE_INCONCLUSIVE, reason: "id_mismatch", errorClass: "parse_failed", ...base };
    }
  }
  if (status === 400) {
    if (!det && hpApiGoneSignal(json)) return { outcome: PROBE_GONE, reason: "gone_signal", errorClass: "", ...base };
    return { outcome: PROBE_INCONCLUSIVE, reason: "http_400", errorClass: "transient", ...base };
  }
  if (!det && hpApiGoneSignal(json)) return { outcome: PROBE_GONE, reason: "gone_signal", errorClass: "", ...base };
  if (hpCaseStatusGone(det)) return { outcome: PROBE_GONE, reason: "case_status_gone", errorClass: "", ...base };
  if (detailLooksRecognizable(det)) {
    const detail = parseHpDetailJson(json);
    const evidence = hpFacilityEvidence(det);
    return {
      outcome: PROBE_ALIVE,
      reason: "detail_ok",
      detail,
      facilityBlock: evidence.block,
      facilityAbsent: evidence.absent,
      facilityPartial: evidence.partial,
      facilityEvidence: applyHpFacilityEvidence({}, detail),
      buildingOnly: Boolean(det.upFloor) && !det.fromFloor && !det.toFloor && !det.floor,
      ...base,
    };
  }
  if (!json || typeof json !== "object" || !Object.keys(json).length) {
    return { outcome: PROBE_INCONCLUSIVE, reason: "empty_json", errorClass: "parse_failed", ...base };
  }
  return { outcome: PROBE_INCONCLUSIVE, reason: "unexpected_payload", errorClass: "parse_failed", ...base };
}

export async function fetchHpDetailInspected(id) {
  const key = hpIdFromUrl(id) || String(id || "").trim();
  if (!key) return { outcome: PROBE_INCONCLUSIVE, reason: "missing_id", errorClass: "parse_failed" };
  const started = Date.now();
  let res;
  try {
    res = await fetch(hpDetailApiUrl(key), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Referer: hpDetailUrl(key),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return inspectHpDetailResponse({ timeout: true, fetch_ms: Date.now() - started, parse_ms: 0, expectedId: key });
  }
  let text = "";
  let json = null;
  if (typeof res.text === "function") {
    try { text = await res.text(); } catch { text = ""; }
  }
  const fetchMs = Date.now() - started;
  const parseStarted = Date.now();
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  } else if (typeof res.json === "function") {
    try { json = await res.json(); } catch { json = null; }
  }
  let retryAfter = "";
  try {
    retryAfter = res.headers?.get?.("retry-after") || res.headers?.get?.("Retry-After") || "";
  } catch {
    retryAfter = "";
  }
  return inspectHpDetailResponse({
    status: res.status,
    json,
    text,
    expectedId: key,
    retryAfter,
    fetch_ms: fetchMs,
    parse_ms: Date.now() - parseStarted,
  });
}

export async function probeHpListingOutcome(url) {
  return fetchHpDetailInspected(url);
}

export async function probeHpListingAlive(url) {
  const { outcome } = await probeHpListingOutcome(url);
  return outcome === PROBE_ALIVE;
}

async function defaultGetHtml(url) {
  const isJson = /\/ws\//.test(String(url || ""));
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: isJson ? "application/json, text/plain, */*" : "text/html,application/xhtml+xml",
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
  let detailBudget = Math.max(0, Number(options.detailLimit ?? 80));
  let addressBudget = Math.max(0, Number(options.addressDetailLimit ?? 200));

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
          const missingFloor = !row.floor_name || !floorNameLooksComplete(row.floor_name);
          const missingAddr = !addressHasPrecisePart(row.address);
          const alreadyGeo = typeof options.hasGeo === "function" && options.hasGeo(row.post_id);
          const missingGeo = row.lat == null && !alreadyGeo;
          const needDetail = missingFloor || missingAddr || !row.community_name || missingGeo;
          const canFetchAddress = missingAddr && addressBudget > 0;
          const canFetchOther = needDetail && !canFetchAddress && detailBudget > 0;
          if (canFetchAddress || canFetchOther) {
            const detail = await fetchHpDetail(id, getHtml);
            if (detail) row = enrichHpListingFromDetail(row, detail, { regionId, sectionId });
            if (canFetchAddress) addressBudget -= 1;
            else detailBudget -= 1;
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
