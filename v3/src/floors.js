import { hasActiveBoxes, isExcludedByAgent, isExcludedByBox, isExcludedByKeyword, needsListingGeo, hasWorkPoint } from "./geo.js";
import { isTrustedGeoSource } from "./location.js";
import { areaNum } from "./match.js";
import { passesPriceFilter } from "./listingCost.js";

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

export function listingHasElevator(listing) {
  const hay = `${listing.title || ""} ${listing.kind_name || ""} ${listing.address || ""} ${tagText(listing)}`;
  if (/無電梯/.test(hay)) return false;
  return /有電梯|電梯大樓|電梯公寓/.test(hay);
}

export function listingIsApartment(listing) {
  const hay = `${listing.title || ""} ${listing.kind_name || ""} ${listing.address || ""} ${tagText(listing)}`;
  if (/電梯大樓/.test(hay)) return false;
  return /公寓/.test(hay);
}

export function listingIsSuite(listing) {
  return /套房|雅房/.test(String(listing.kind_name || ""));
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

export const HOUSING_KINDS = ["elevator", "apartment", "suite", "whole", "shop", "warehouse"];
export const HOUSING_KIND_GROUPS = {
  building: ["elevator", "apartment"],
  dwelling: ["suite", "whole", "shop", "warehouse"],
};
export const LISTING_SOURCE_KEYS = ["591", "self", "hbhousing", "sinyi", "houseprice", "ddroom", "housefun"];

export function housingKindConflicts(a, b) {
  if (!a || !b || a === b) return false;
  const home = (key) => key === "suite" || key === "whole";
  const commercial = (key) => key === "shop" || key === "warehouse";
  if (home(a) && home(b)) return true;
  if ((home(a) && commercial(b)) || (commercial(a) && home(b))) return true;
  return false;
}

export function toggleHousingKind(selected, next) {
  const key = String(next || "").trim();
  if (!HOUSING_KINDS.includes(key)) return parseHousingKinds(selected);
  const current = parseHousingKinds(selected);
  if (current.includes(key)) return current.filter((item) => item !== key);
  const nextSet = current.filter((item) => !housingKindConflicts(item, key));
  nextSet.push(key);
  return HOUSING_KINDS.filter((item) => nextSet.includes(item));
}

export function parseHousingKinds(kind) {
  const raw = Array.isArray(kind) ? kind : String(kind || "").split(/[,|]/);
  const keys = [];
  for (const item of raw) {
    const key = String(item || "").trim();
    if (HOUSING_KINDS.includes(key) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function resolveHousingKinds(kind) {
  const resolved = [];
  for (const key of parseHousingKinds(kind)) {
    for (let i = resolved.length - 1; i >= 0; i -= 1) {
      if (housingKindConflicts(resolved[i], key)) resolved.splice(i, 1);
    }
    if (!resolved.includes(key)) resolved.push(key);
  }
  return resolved;
}

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

export function isRooftopAddition(listing) {
  const hay = `${listing?.floor_name || ""} ${listing?.title || ""} ${listing?.kind_name || ""} ${tagText(listing)}`;
  return /頂樓加蓋|頂加/.test(hay);
}

export function listingMatchesKindKey(listing, kind) {
  const key = String(kind || "").trim();
  if (key === "elevator") return listingHasElevator(listing);
  if (key === "apartment") return listingIsApartment(listing);
  if (key === "suite") return listingIsSuite(listing);
  if (key === "whole") return isWholeFloorHome(listing.kind_name);
  if (key === "shop") return listingIsShop(listing);
  if (key === "warehouse") return listingIsWarehouse(listing);
  return true;
}

export function matchesHousingKind(listing, kind) {
  const kinds = resolveHousingKinds(kind);
  if (!kinds.length) return true;
  const building = kinds.filter((key) => HOUSING_KIND_GROUPS.building.includes(key));
  const dwelling = kinds.filter((key) => HOUSING_KIND_GROUPS.dwelling.includes(key));
  if (building.length && !building.some((key) => listingMatchesKindKey(listing, key))) return false;
  if (dwelling.length && !dwelling.some((key) => listingMatchesKindKey(listing, key))) return false;
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

/** 1F、地面／騎樓、地下室。不含整棟、頂樓加蓋（頂加另用排除頂樓加蓋）。 */
export function isAtOrBelowFirstFloor(floorName) {
  const text = String(floorName || "").replace(/\s+/g, "");
  if (!text) return false;
  const main = text.split("/")[0];
  if (/地下|半地下/i.test(main) || /^B\d/i.test(main) || /^B$/i.test(main)) {
    return true;
  }
  if (/一樓|1樓|騎樓|地面/.test(main)) return true;
  const range = main.match(/(\d+)\s*(?:F|樓)?\s*[~～\-至到]/i);
  if (range) return Number(range[1]) <= 1;
  const numbered = main.match(/(\d+)\s*(?:F|樓)/i);
  if (numbered) return Number(numbered[1]) <= 1;
  return false;
}

export function buildingTotalFloors(floorName) {
  const text = String(floorName || "").replace(/\s+/g, "");
  const parts = text.split("/");
  if (parts.length < 2) return 0;
  const match = parts[1].match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

export function isWholeFloorHome(kindName) {
  return String(kindName || "").includes("整層住家");
}

/** 列表顯示／通知用：排除頂加、排除 1F 及地下室。不影響抓取。列表 kind 晶片優先於設定檔整層。 */
export function passesDisplayFilters(listing, settings = {}, { skipWholeFloor = false } = {}) {
  if (!skipWholeFloor && settings.wholeFloorOnly === true && !isWholeFloorHome(listing.kind_name)) {
    return false;
  }
  if (settings.excludeLowFloors !== false && isAtOrBelowFirstFloor(listing.floor_name)) {
    return false;
  }
  if (settings.excludeRooftop !== false && isRooftopAddition(listing)) {
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

export function isGeoReady(listing, settings = {}) {
  if (!needsListingGeo(settings)) return true;
  if (!hasTrustedCoords(listing)) return false;
  const km = Number(settings.commuteKm);
  const commuteOn = Number.isFinite(km) && km > 0 && hasWorkPoint(settings);
  if (!commuteOn) return true;
  const routes = Array.isArray(listing.route_kms) ? listing.route_kms.map(Number).filter(Number.isFinite) : [];
  if (!routes.length) return false;
  if (settings.waitRushMinutes) {
    const am = Number(listing.commute_min_am ?? listing.rush_am_min);
    const pm = Number(listing.commute_min_pm ?? listing.rush_pm_min);
    return Number.isFinite(am) && Number.isFinite(pm);
  }
  return true;
}

export function decideNotifyDelivery(listing, settings = {}) {
  if (!passesAttributeFilters(listing, settings)) return "skip";
  if (!passesDisplayFilters(listing, settings)) return "skip";
  if (!isGeoReady(listing, settings)) return "pending";
  if (!passesGeoFilters(listing, settings, { strict: true })) return "skip";
  return "send";
}

export function passesGeoFilters(listing, settings = {}, { strict = true } = {}) {
  const hasCoords = hasTrustedCoords(listing);
  if (hasCoords && isExcludedByBox(listing.lat, listing.lng, settings.excludeBoxes)) {
    return false;
  }
  const km = Number(settings.commuteKm);
  const commuteOn = Number.isFinite(km) && km > 0 && hasWorkPoint(settings);
  const boxesOn = hasActiveBoxes(settings.excludeBoxes);
  if (strict && boxesOn && !hasCoords) return false;
  if (commuteOn) {
    if (strict && !hasCoords) return false;
    const routes = Array.isArray(listing.route_kms) ? listing.route_kms.map(Number).filter(Number.isFinite) : [];
    if (strict && !routes.length) return false;
    if (routes.length && routes.every((dist) => dist > km)) return false;
  }
  return true;
}

export function shouldKeepListing(listing, settings = {}, options = {}) {
  return passesAttributeFilters(listing, settings) && passesGeoFilters(listing, settings, options);
}
