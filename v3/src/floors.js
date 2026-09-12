import { hasActiveBoxes, isExcludedByAgent, isExcludedByBox, isExcludedByKeyword, needsListingGeo, hasWorkPoint } from "./geo.js";
import { isTrustedGeoSource } from "./location.js";
import { areaNum } from "./match.js";
import { passesPriceFilter } from "./listingCost.js";
import {
  canUseForRoadDistance,
  commuteMetersWithinLimit,
  decideNotifyGeo,
  kmListToMinMeters,
  listingHasStreetAddress,
  resolveLocationClass,
} from "./geoPrecision.js";
import {
  HOUSING_KINDS,
  elevatorRequired,
  kindsToQuery,
  parseHousingKinds,
  resolveHousingKinds,
} from "./housingQuery.js";

export {
  HOUSING_CATEGORY_KINDS,
  HOUSING_KIND_CHIPS,
  HOUSING_KIND_GROUPS,
  HOUSING_KINDS,
  parseHousingKinds,
  resolveHousingKinds,
  toggleHousingKind,
} from "./housingQuery.js";

function tagText(listing) {
  let tags = listing.tags;
  if (typeof tags === "string") {
    try {
      tags = JSON.parse(tags);
    } catch {
      tags = [];
    }
  }
  return (Array.isArray(tags) ? tags : [])
    .map((item) => (typeof item === "string" ? item : item?.name || item?.value || ""))
    .join(" ");
}

/** 型態欄／標籤才算房屋型態；標題不看，避免「社區垃圾大樓」誤判。 */
const EXPLICIT_HOUSING_FORM_RE = /大樓|大廈|公寓|華廈|店面|店舖|店鋪|倉庫|廠房|套房|雅房|分租|共宅|共居|透天|別墅|農舍/;

function listingFormHay(listing) {
  return `${listing?.kind_name || ""} ${listing?.listing_kind || ""} ${tagText(listing)}`;
}

export function listingHasExplicitHousingForm(listing) {
  return EXPLICIT_HOUSING_FORM_RE.test(listingFormHay(listing));
}

export function listingIsUnspecifiedWholeFloor(listing) {
  const kind = String(listing?.kind_name || listing?.listing_kind || "");
  return isWholeFloorHome(kind) && !listingHasExplicitHousingForm(listing);
}

export function listingHasElevator(listing) {
  const kind = String(listing.kind_name || "");
  const hay = `${listing.title || ""} ${kind} ${listing.address || ""} ${tagText(listing)}`;
  if (/無電梯|沒有電梯|不含電梯|五樓以下無電梯/.test(hay)) return false;
  if (/有電梯|電梯大樓|電梯大廈|電梯公寓|電梯華廈|貨梯/.test(hay)) return true;
  if (listingIsBuilding(listing)) return true;
  return false;
}

export function listingHasParking(listing) {
  const hay = `${listing.title || ""} ${listing.kind_name || ""} ${listing.address || ""} ${tagText(listing)}`;
  if (/無車位|沒有車位|不含車位|不附車位|無停車/.test(hay)) return false;
  return /車位|停車位|平面車位|機械車位|坡道車位|含車位|附車位|可停車/.test(hay);
}

export function listingIsBuilding(listing) {
  if (listingIsUnspecifiedWholeFloor(listing)) return true;
  return /大[樓廈]/.test(listingFormHay(listing));
}

export function listingIsApartment(listing) {
  if (listingIsUnspecifiedWholeFloor(listing)) return true;
  const hay = `${listing.title || ""} ${listing.kind_name || ""} ${tagText(listing)}`;
  if (/大[樓廈]/.test(listingFormHay(listing)) || /電梯大[樓廈]/.test(hay)) return false;
  return /公寓|華廈/.test(hay);
}

export function listingIsSuite(listing) {
  return /套房|雅房/.test(String(listing.kind_name || ""));
}

export function listingIsYafang(listing) {
  return /雅房/.test(`${listing?.kind_name || ""} ${listing?.title || ""}`);
}

export function listingIsShareRental(listing) {
  return /分租/.test(`${listing?.kind_name || ""} ${listing?.title || ""}`);
}

export function listingIsColiving(listing) {
  return /共生宅|共居宅|共生住宅|共居|共宅/.test(`${listing?.kind_name || ""} ${listing?.title || ""} ${tagText(listing)}`);
}

export function listingIsShop(listing) {
  const hay = `${listing?.kind_name || ""} ${listing?.title || ""}`;
  return /店面|店鋪/.test(hay);
}

export function listingIsWarehouse(listing) {
  const hay = `${listing?.kind_name || ""} ${listing?.title || ""}`;
  return /倉庫|廠房|倉儲/.test(hay);
}

/** 通知結尾用的房屋類型，不寫「整層住家」。 */
export function housingTypeLabel(listing) {
  if (listingIsShop(listing)) return "店面";
  if (listingIsWarehouse(listing)) return "倉庫";
  if (listingIsSuite(listing)) return "套房";
  if (listingHasElevator(listing)) return "電梯公寓/大樓";
  return "公寓";
}

export const LISTING_SOURCE_KEYS = ["591", "self", "hbhousing", "sinyi", "houseprice", "ddroom", "housefun", "rakuya"];

export function parseListingSources(sources) {
  const raw = Array.isArray(sources) ? sources : String(sources || "").split(/[,|]/);
  const keys = [];
  for (const item of raw) {
    const key = String(item || "").trim();
    if (LISTING_SOURCE_KEYS.includes(key) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function canUseListingSourceFilter(actor = {}) {
  return actor?.role === "admin" || actor?.plan === "sponsor";
}

export function authorizedListingSources(sources, actor = {}) {
  if (!canUseListingSourceFilter(actor)) return [];
  return parseListingSources(sources);
}

export function listingSourceKey(listing) {
  return String(listing?.source || "591").trim() || "591";
}

export function matchesListingSources(listing, sources) {
  const keys = parseListingSources(sources);
  if (!keys.length) return true;
  return keys.includes(listingSourceKey(listing));
}

export function listingFilterHay(listing) {
  return `${listing?.floor_name || ""} ${listing?.title || ""} ${listing?.kind_name || ""} ${listing?.address || ""} ${tagText(listing)}`;
}

export function isRooftopAddition(listing) {
  const hay = listingFilterHay(listing);
  if (/無加蓋|非頂加|不是頂加|無違蓋/.test(hay)) return false;
  if (/頂樓加蓋|頂加|違蓋|違建住家|鐵皮加蓋/.test(hay)) return true;
  return /加蓋/.test(String(listing?.floor_name || ""));
}

function floorToken(token) {
  const raw = String(token || "").replace(/樓/g, "").trim();
  if (!raw) return "";
  if (/^B\d*$/i.test(raw) || /地下/.test(raw)) return raw.toUpperCase();
  if (/^\d+(?:-\d+)?$/.test(raw)) return `${raw}F`;
  if (/^\d+(?:-\d+)?F$/i.test(raw)) return raw.toUpperCase();
  return raw;
}

/** 來源常用 -1／--／0 當「樓層不明」，不是地下室或 1F。 */
export function isPlaceholderFloor(floorName) {
  const raw = String(floorName || "").trim().replace(/\s+/g, "").replace(/[／]/g, "/");
  if (!raw) return true;
  if (/^[-–—]+$/.test(raw) || raw === "--/--" || raw === "-/-") return true;
  if (/^-?\d+(?:F|樓)?$/i.test(raw) && Number(String(raw).replace(/[F樓]/i, "")) <= 0) return true;
  const pair = raw.match(/^(-?\d+)(?:F|樓)?\/(-?\d+)(?:F|樓)?$/i);
  if (pair && Number(pair[1]) <= 0) return true;
  return false;
}

export function sanitizeFloorName(floorName) {
  return isPlaceholderFloor(floorName) ? "" : String(floorName || "").trim();
}

/** 列表／詳情／比較統一顯示：( 3F / 8F ) */
export function formatFloorDisplay(floorName) {
  const original = sanitizeFloorName(floorName);
  if (!original) return "";
  if (/^\(\s*.+\s*\/\s*.+\s*\)$/.test(original)) return original.replace(/\s+/g, " ");
  const raw = original.replace(/\s+/g, "").replace(/[／]/g, "/");
  const pair = raw.match(/^(?:出租)?(\d+(?:-\d+)?|B\d+|地下\d*)(?:F|樓)?\/(?:共)?(\d+)(?:F|樓)?$/i);
  if (pair) {
    const left = floorToken(pair[1]);
    const right = floorToken(pair[2]);
    if (left && right) return `( ${left} / ${right} )`;
  }
  const single = raw.match(/^(?:出租)?(\d+(?:-\d+)?|B\d+)(?:F|樓)$/i);
  if (single) return `( ${floorToken(single[1])} )`;
  return original;
}

export function listingIsSuiteShared(listing) {
  if (listingIsWarehouse(listing)) return false;
  return listingIsSuite(listing) || listingIsYafang(listing) || listingIsShareRental(listing) || listingIsColiving(listing);
}

export function listingMatchesKindKey(listing, kind) {
  const key = String(kind || "").trim();
  if (key === "elevator") return listingHasElevator(listing);
  if (key === "apartment" || key === "apartment_huaxia") return listingIsApartment(listing);
  if (key === "building") return listingIsBuilding(listing);
  if (key === "suite") return listingIsSuite(listing);
  if (key === "yafang") return listingIsYafang(listing);
  if (key === "share") return listingIsShareRental(listing);
  if (key === "coliving") return listingIsColiving(listing);
  if (key === "suite_shared") return listingIsSuiteShared(listing);
  if (key === "whole") return isWholeFloorHome(listing.kind_name);
  if (key === "shop") return listingIsShop(listing) || listingIsUnspecifiedWholeFloor(listing);
  if (key === "warehouse") return listingIsWarehouse(listing) || listingIsUnspecifiedWholeFloor(listing);
  return true;
}

export function matchesHousingKind(listing, kind) {
  const query = kindsToQuery(kind);
  if (query.rentalMode === "any" && !query.categories.length && !query.elevatorManual && !query.legacyRental) {
    return true;
  }
  if (query.rentalMode === "whole" && !listingMatchesKindKey(listing, "whole")) return false;
  if (query.rentalMode === "suite_shared" && !listingMatchesKindKey(listing, "suite_shared")) return false;
  if (query.rentalMode === "legacy" && query.legacyRental && !listingMatchesKindKey(listing, query.legacyRental)) {
    return false;
  }
  if (query.categories.length && !query.categories.some((key) => listingMatchesKindKey(listing, key))) {
    return false;
  }
  if (elevatorRequired(query) && !listingHasElevator(listing)) return false;
  return true;
}

export function normalizeListQuery(filter, kind, sources) {
  let section = String(filter || "all");
  let kinds = parseHousingKinds(kind);
  if (HOUSING_KINDS.includes(section)) {
    if (!kinds.length) kinds = [section];
    section = "all";
  }
  const resolved = resolveHousingKinds(kinds);
  return { filter: section, kind: resolved.join(","), kinds: resolved, sources: parseListingSources(sources) };
}

function hayLooksLowFloor(hay) {
  const text = String(hay || "").replace(/\s+/g, "");
  if (!text) return false;
  if (/地下[室樓]|半地下|騎樓|(?:^|[^\d])B\d/i.test(text)) return true;
  if (/(?:10|11|12|13|14|15|16|17|18|19|21)樓|(?:10|11|12|13|14|15|16|17|18|19|21)F/i.test(text)) return false;
  return /(?:^|[^\d])1樓|(?:^|[^\d])一樓|(?:^|[^\d])1F(?:[^\d]|$)/i.test(text);
}

/** 1F、地面／騎樓、地下室。不含整棟、頂樓加蓋（頂加另用排除頂樓加蓋）。 */
export function isAtOrBelowFirstFloor(floorName, extraHay = "") {
  const text = String(floorName || "").replace(/\s+/g, "");
  if (!text) return hayLooksLowFloor(extraHay);
  const main = text.split("/")[0];
  if (/地下|半地下/i.test(main) || /^B\d/i.test(main) || /^B$/i.test(main)) {
    return true;
  }
  if (/一樓|1樓|騎樓|地面/.test(main)) return true;
  const range = main.match(/(\d+)\s*(?:F|樓)?\s*[~～\-至到]/i);
  if (range) return Number(range[1]) <= 1;
  const numbered = main.match(/(\d+)\s*(?:F|樓)/i);
  if (numbered) return Number(numbered[1]) <= 1;
  // 非 591 來源（住商/信義/5168/租租通）樓層常寫成「current/total」且不帶 F/樓，
  // 例如 "1/4"、"1/12" 或裸數字 "1"。當主段以純數字開頭時，也視為樓層數判斷。
  const bare = main.match(/^(\d+)/);
  if (bare) return Number(bare[1]) <= 1;
  return hayLooksLowFloor(extraHay);
}

export function buildingTotalFloors(floorName) {
  const text = String(floorName || "").replace(/\s+/g, "");
  const parts = text.split("/");
  if (parts.length < 2) return 0;
  const match = parts[1].match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

export function isWholeFloorHome(kindName) {
  const raw = String(kindName || "");
  if (/獨立套房|分租套房|雅房|共宅|共居/.test(raw)) return false;
  return /整層|整戶出租|整間出租/.test(raw);
}

/** 列表顯示／通知用：排除頂加、排除 1F 及地下室。不影響抓取。列表 kind 晶片優先於設定檔整層。 */
export function passesDisplayFilters(listing, settings = {}, { skipWholeFloor = false } = {}) {
  if (!skipWholeFloor && settings.wholeFloorOnly === true && !isWholeFloorHome(listing.kind_name)) {
    return false;
  }
  if (settings.excludeLowFloors !== false && isAtOrBelowFirstFloor(listing.floor_name, listingFilterHay(listing))) {
    return false;
  }
  if (settings.excludeRooftop !== false && isRooftopAddition(listing)) {
    return false;
  }
  if (settings.hasParking === true && !listingHasParking(listing)) {
    return false;
  }
  return true;
}

export function passesAttributeFilters(listing, settings = {}) {
  if (!passesPriceFilter(listing, settings)) return false;
  const minFloors = Number(settings.minBuildingFloors);
  if (Number.isFinite(minFloors) && minFloors > 0) {
    const totalFloors = buildingTotalFloors(listing.floor_name);
    if (totalFloors > 0 && totalFloors < minFloors) {
      return false;
    }
  }
  if (isExcludedByKeyword(listing, settings.excludeKeywords)) {
    return false;
  }
  if (isExcludedByAgent(listing, settings)) {
    return false;
  }
  const areaMax = Number(settings.areaMax);
  if (Number.isFinite(areaMax) && areaMax > 0) {
    const area = areaNum(listing.area_name);
    if (area != null && area > areaMax) return false;
  }
  return true;
}

export function hasTrustedCoords(listing) {
  const lat = Number(listing.lat);
  const lng = Number(listing.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) return false;
  return isTrustedGeoSource(listing.geo_source);
}

/** 有可信座標、可解析路段地址，或 591 仍可能補社區／詳情時才繼續等。沒有地址的外站不要永遠 pending。 */
export function listingCanResolveNotifyGeo(listing) {
  if (hasTrustedCoords(listing)) return true;
  if (listingHasStreetAddress(listing)) return true;
  return listingSourceKey(listing) === "591";
}

export const PENDING_NOTIFY_MAX_MS = 6 * 60 * 60 * 1000;

/** 只表示等待已久，不得再被當成「已送出」。 */
export function isStalePendingNotify(event, now = Date.now()) {
  const created = Date.parse(event?.created_at || "");
  return Number.isFinite(created) && now - created > PENDING_NOTIFY_MAX_MS;
}

export function listingNotifyMeters(listing = {}) {
  return kmListToMinMeters(listing.route_kms, listing.route_min_m ?? listing.min_m);
}

export function isGeoReady(listing, settings = {}) {
  if (!needsListingGeo(settings)) return true;
  const cls = resolveLocationClass(listing);
  if (!canUseForRoadDistance(cls) || !hasTrustedCoords(listing)) return false;
  const km = Number(settings.commuteKm);
  const commuteOn = Number.isFinite(km) && km > 0 && hasWorkPoint(settings);
  if (!commuteOn) return true;
  return listingNotifyMeters(listing) != null;
}

export function decideNotifyDelivery(listing, settings = {}) {
  if (!passesAttributeFilters(listing, settings)) return "skip";
  if (!passesDisplayFilters(listing, settings)) return "skip";
  const decision = decideNotifyGeo(listing, settings);
  if (decision.verdict === "pending") {
    return listingCanResolveNotifyGeo(listing) ? "pending" : "skip";
  }
  if (decision.verdict === "skip") return "skip";
  if (!passesGeoFilters(listing, settings, { strict: true })) return "skip";
  return "send";
}

export function decideNotifyDecision(listing, settings = {}) {
  if (!passesAttributeFilters(listing, settings)) return { verdict: "skip", decide: "cancelled", reason: "attribute" };
  if (!passesDisplayFilters(listing, settings)) return { verdict: "skip", decide: "cancelled", reason: "display" };
  const decision = decideNotifyGeo(listing, settings);
  if (decision.verdict === "pending" && !listingCanResolveNotifyGeo(listing)) {
    return { ...decision, verdict: "skip", decide: "wait_data", reason: "no-geo" };
  }
  return decision;
}

export function passesGeoFilters(listing, settings = {}, { strict = true } = {}) {
  const cls = resolveLocationClass(listing);
  const usableRoad = canUseForRoadDistance(cls) && hasTrustedCoords(listing);
  if (usableRoad && isExcludedByBox(listing.lat, listing.lng, settings.excludeBoxes)) {
    return false;
  }
  const km = Number(settings.commuteKm);
  const commuteOn = Number.isFinite(km) && km > 0 && hasWorkPoint(settings);
  const boxesOn = hasActiveBoxes(settings.excludeBoxes);
  if (strict && boxesOn && !usableRoad) return false;
  if (commuteOn) {
    if (strict && !usableRoad) return false;
    const meters = listingNotifyMeters(listing);
    if (strict && meters == null) return false;
    if (meters != null && !commuteMetersWithinLimit(meters, km)) {
      if (!strict && cls === "street") return true;
      return false;
    }
  }
  return true;
}

export function shouldKeepListing(listing, settings = {}, options = {}) {
  return passesAttributeFilters(listing, settings) && passesGeoFilters(listing, settings, options);
}
