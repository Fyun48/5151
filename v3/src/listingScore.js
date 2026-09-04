import {
  buildingTotalFloors,
  isAtOrBelowFirstFloor,
  isWholeFloorHome,
  listingHasElevator,
} from "./floors.js";
import { hasWorkPoint } from "./geo.js";

/** 依會員條件打的規則分，不是成交預測、也不是仲介評等。 */
export function listingFitScore(listing, settings = {}) {
  let score = 58;
  const price = Number(listing?.price_num) || 0;
  const min = Number(settings.priceMin) || 0;
  const max = Number(settings.priceMax) || 0;
  if (price > 0 && (min > 0 || max > 0)) {
    if (max > 0 && price > max * 1.15) score -= 24;
    else if (max > 0 && price > max) score -= 10;
    else if (min > 0 && price < min) score -= 6;
    else score += 16;
  }

  if (settings.wholeFloorOnly === true) {
    if (isWholeFloorHome(listing?.kind_name)) score += 12;
    else score -= 18;
  } else if (isWholeFloorHome(listing?.kind_name)) {
    score += 4;
  }

  if (settings.excludeLowFloors !== false && isAtOrBelowFirstFloor(listing?.floor_name)) {
    score -= 16;
  }

  const minFloors = Number(settings.minBuildingFloors);
  if (Number.isFinite(minFloors) && minFloors > 0) {
    const total = buildingTotalFloors(listing?.floor_name);
    if (total > 0) {
      if (total >= minFloors) score += 8;
      else score -= 14;
    }
  }

  const budget = Number(settings.commuteKm);
  if (hasWorkPoint(settings) && budget > 0) {
    const km = Number(listing?.commute_km);
    if (Number.isFinite(km) && km > 0) {
      if (km <= budget) score += 14;
      else score -= 20;
    } else {
      score -= 3;
    }
  }

  if (listingHasElevator(listing)) score += 4;
  const extra = Number(listing?.extra_fee) || 0;
  if (extra > 0) score -= 4;

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function listingFitLabel(score) {
  const n = Number(score) || 0;
  if (n >= 75) return "較適合";
  if (n >= 50) return "尚可";
  return "較不合";
}

export function listingFitFields(listing, settings = {}) {
  const fit_score = listingFitScore(listing, settings);
  return {
    fit_score,
    fit_label: listingFitLabel(fit_score),
  };
}
