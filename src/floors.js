import { hasActiveBoxes, isExcludedByAgent, isExcludedByBox, isExcludedByKeyword, needsListingGeo, hasWorkPoint } from "./geo.js";
import { isTrustedGeoSource } from "./location.js";
import { areaNum } from "./match.js";

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

export function isAtOrBelowFirstFloor(floorName) {
  const text = String(floorName || "").replace(/\s+/g, "");
  if (!text) return false;
  const main = text.split("/")[0];
  if (/整棟|地下|騎樓|半地下|地面|頂樓加蓋/i.test(main) || /^B\d/i.test(main) || /^B$/i.test(main)) {
    return true;
  }
  if (/一樓|1樓/.test(main)) return true;
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

/** 列表顯示／通知用：整層、排除 1F。不影響 591 搜尋與左側統計。 */
export function passesDisplayFilters(listing, settings = {}) {
  if (settings.wholeFloorOnly !== false && !isWholeFloorHome(listing.kind_name)) {
    return false;
  }
  if (settings.excludeLowFloors !== false && isAtOrBelowFirstFloor(listing.floor_name)) {
    return false;
  }
  return true;
}

export function passesAttributeFilters(listing, settings = {}) {
  const minFloors = Number(settings.minBuildingFloors);
  const min = Number.isFinite(minFloors) && minFloors > 0 ? minFloors : 4;
  const totalFloors = buildingTotalFloors(listing.floor_name);
  if (totalFloors > 0 && totalFloors < min) {
    return false;
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
  return routes.length > 0;
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
