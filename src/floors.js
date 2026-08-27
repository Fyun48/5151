import { isExcludedByBox, isExcludedByKeyword } from "./geo.js";

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

export function shouldKeepListing(listing, settings = {}) {
  if (settings.wholeFloorOnly !== false && !isWholeFloorHome(listing.kind_name)) {
    return false;
  }
  if (settings.excludeLowFloors !== false && isAtOrBelowFirstFloor(listing.floor_name)) {
    return false;
  }
  const minFloors = Number(settings.minBuildingFloors);
  const min = Number.isFinite(minFloors) && minFloors > 0 ? minFloors : 4;
  const totalFloors = buildingTotalFloors(listing.floor_name);
  if (totalFloors > 0 && totalFloors < min) {
    return false;
  }
  if (isExcludedByKeyword(listing, settings.excludeKeywords)) {
    return false;
  }
  if (isExcludedByBox(listing.lat, listing.lng, settings.excludeBoxes)) {
    return false;
  }
  return true;
}
