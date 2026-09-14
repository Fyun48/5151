/** 5168 資料準備與逐欄合併。其他來源不走這套展示門檻。 */

import { addressPrecision, isTaiwanMapPin } from "./location.js";
import { shouldAcceptGeoUpdate, resolveLocationClass } from "./geoPrecision.js";
import { floorNameLooksComplete, normalizeHpFloorName } from "./houseprice.js";
import { listingKitFrom } from "./listingKit.js";

export const HP_PREP_SOURCE = "houseprice";

export const PREP_PENDING = "pending";
export const PREP_READY = "ready";
export const PREP_SOURCE_LIMITED = "source_limited";
export const PREP_PARSE_FAILED = "parse_failed";

export const FIELD_PROVIDED = "provided";
export const FIELD_ABSENT = "absent";
export const FIELD_NOT_PROVIDED = "not_provided";
export const FIELD_NOT_FETCHED = "not_fetched";
export const FIELD_PARSE_FAILED = "parse_failed";

export const GEO_EXACT = "exact";
export const GEO_APPROX = "approx";
export const GEO_UNKNOWN = "unknown";

const WHOLE_BUILDING_RE = /整棟|整幢|整棟出租/;
const NO_FACILITY_RE = /無設備|沒有設備|不含設備|不附設備|無家俱|沒有家俱|未提供設備/;
export function isHousepriceListing(listing) {
  return String(listing?.source || "") === HP_PREP_SOURCE;
}

export function hasValidRent(listing) {
  return Number(listing?.price_num) > 0;
}

export function hasListingIdentity(listing) {
  const title = String(listing?.title || "").trim();
  const url = String(listing?.url || "").trim();
  const sourceId = String(listing?.source_id || "").trim();
  return Boolean(title && title !== "(無標題)" && url && sourceId && hasValidRent(listing));
}

/** 出租樓層：整棟、範圍、出租/總樓高，或來源只寫單層出租。不能只用總樓高。 */
export function classifyRentalFloor(floorName, { fetched = false, parseFailed = false, buildingOnly = false } = {}) {
  if (parseFailed) return { status: FIELD_PARSE_FAILED, kind: "", reason: "floor_parse_failed" };
  if (!fetched) return { status: FIELD_NOT_FETCHED, kind: "", reason: "floor_not_fetched" };
  const raw = String(floorName || "").trim();
  if (buildingOnly && !raw) {
    return { status: FIELD_NOT_PROVIDED, kind: "", reason: "building_height_only" };
  }
  if (!raw) return { status: FIELD_NOT_PROVIDED, kind: "", reason: "floor_not_provided" };
  if (WHOLE_BUILDING_RE.test(raw)) return { status: FIELD_PROVIDED, kind: "whole", reason: "" };
  const normalized = normalizeHpFloorName(raw) || raw;
  if (/\d+\s*-\s*\d+/.test(normalized)) return { status: FIELD_PROVIDED, kind: "range", reason: "" };
  if (floorNameLooksComplete(normalized)) return { status: FIELD_PROVIDED, kind: "rental_over_total", reason: "" };
  if (/^(?:B\d+|地下\d*|\d+)(?:F|樓)?$/i.test(normalized.replace(/\s+/g, ""))) {
    return { status: FIELD_PROVIDED, kind: "single", reason: "" };
  }
  return { status: FIELD_PARSE_FAILED, kind: "", reason: "floor_unrecognized" };
}

export function classifyFacilities(listing, {
  fetched = false,
  parseFailed = false,
  sourceBlock = false,
  sourceAbsent = false,
} = {}) {
  if (parseFailed) return { status: FIELD_PARSE_FAILED, basis: "none", reason: "facility_parse_failed" };
  if (!fetched) return { status: FIELD_NOT_FETCHED, basis: "none", reason: "facility_not_fetched" };
  if (sourceAbsent) return { status: FIELD_ABSENT, basis: "source_block", reason: "" };
  const kit = listingKitFrom(listing || {});
  const tags = parseTags(listing?.tags);
  const hay = `${tags.join(" ")} ${listing?.title || ""}`;
  if (NO_FACILITY_RE.test(hay)) return { status: FIELD_ABSENT, basis: "source_block", reason: "" };
  if (sourceBlock) {
    const hasAny = tags.some((tag) => /車位|家俱|家具|冷氣|冰箱|洗衣機|陽台|瓦斯/.test(tag))
      || Number(listing?.has_natural_gas) === 1
      || Number(listing?.has_balcony) === 1
      || (Array.isArray(kit.furnish_items) && kit.furnish_items.length > 0);
    if (hasAny) return { status: FIELD_PROVIDED, basis: "source_block", reason: "" };
    return { status: FIELD_NOT_PROVIDED, basis: "source_block", reason: "facility_source_empty" };
  }
  if (tags.some((tag) => /車位|家俱|家具/.test(tag))) {
    return { status: FIELD_PROVIDED, basis: "inferred", reason: "facility_partial_inferred" };
  }
  return { status: FIELD_NOT_PROVIDED, basis: "source_empty", reason: "facility_not_provided" };
}

export function classifyAddress(listing) {
  const address = String(listing?.address || "").trim();
  const community = String(listing?.community_name || "").trim();
  const precision = addressPrecision(address);
  const hasCoords = isTaiwanMapPin(listing?.lat, listing?.lng);
  const hasDoor = /\d+(?:之\d+)?號/.test(address.replace(/\s+/g, ""));
  const streetOrAlley = precision >= 10;
  const communityOnly = !streetOrAlley && Boolean(community);
  const usable = (streetOrAlley || communityOnly || precision >= 5) && hasCoords;
  let mark = GEO_UNKNOWN;
  if (hasCoords && hasDoor && precision >= 35) mark = GEO_EXACT;
  else if (hasCoords && (streetOrAlley || communityOnly)) mark = GEO_APPROX;
  const sourceLimited = usable && !hasDoor;
  return {
    usable,
    precision,
    mark,
    sourceLimited,
    reason: !address && !community
      ? "address_missing"
      : !hasCoords
        ? "coords_missing"
        : sourceLimited
          ? "door_not_published"
          : "",
    label: sourceLimited ? "概略位置／來源未公開門牌" : (mark === GEO_EXACT ? "精準位置" : ""),
  };
}

export function evaluateHpPrep(listing, meta = {}) {
  const fetched = meta.fetched === true;
  const parseFailed = meta.parseFailed === true;
  const detailRecognized = meta.detailRecognized === true || (fetched && !parseFailed && hasListingIdentity(listing));
  const identity = hasListingIdentity(listing);
  const address = classifyAddress(listing);
  const floor = classifyRentalFloor(listing?.floor_name, {
    fetched,
    parseFailed: parseFailed && !listing?.floor_name,
    buildingOnly: meta.buildingOnly === true,
  });
  const facility = classifyFacilities(listing, {
    fetched,
    parseFailed: parseFailed && !meta.facilityBlock,
    sourceBlock: meta.facilityBlock === true,
    sourceAbsent: meta.facilityAbsent === true,
  });
  const missing = [];
  if (!identity) missing.push("identity");
  if (!detailRecognized) missing.push("detail");
  if (!address.usable) missing.push("address");
  if (floor.status !== FIELD_PROVIDED) missing.push("floor");
  if (![FIELD_PROVIDED, FIELD_ABSENT, FIELD_NOT_PROVIDED].includes(facility.status) || facility.basis === "inferred") {
    missing.push("facility");
  }
  let status = PREP_PENDING;
  let withholdReason = "";
  const facilityOk = [FIELD_PROVIDED, FIELD_ABSENT, FIELD_NOT_PROVIDED].includes(facility.status)
    && facility.basis !== "inferred";
  if (parseFailed && missing.includes("detail")) {
    status = PREP_PARSE_FAILED;
    withholdReason = "detail_parse_failed";
  } else if (identity && detailRecognized && address.usable && floor.status === FIELD_PROVIDED && facilityOk) {
    status = PREP_READY;
    missing.length = 0;
    withholdReason = "";
  } else if (fetched && !parseFailed && identity) {
    if (floor.status === FIELD_NOT_PROVIDED) {
      status = PREP_SOURCE_LIMITED;
      withholdReason = floor.reason || "floor_not_provided";
    } else if (!address.usable && (address.sourceLimited || address.reason === "address_missing" || address.reason === "coords_missing")) {
      status = PREP_SOURCE_LIMITED;
      withholdReason = address.reason || "source_limited";
    }
  }
  if (status === PREP_PENDING && missing.length) withholdReason = withholdReason || missing.join(",");
  return {
    status,
    displayReady: status === PREP_READY,
    identity,
    detailRecognized,
    address,
    floor,
    facility,
    missing,
    withholdReason,
    sourceLimitedReason: address.sourceLimited ? address.reason : (meta.limitedReason || ""),
    geoPrecision: address.mark,
    locationLabel: address.label,
  };
}

export function filledText(value) {
  const text = String(value || "").trim();
  if (!text || text === "--" || text === "-" || text === "—") return "";
  return text;
}

function parseTags(raw) {
  if (Array.isArray(raw)) return raw.map((item) => String(item || "").trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map((item) => String(item || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function mergeTagList(current, extra) {
  const out = [...parseTags(current)];
  for (const item of extra || []) {
    const label = String(item || "").trim();
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/** 逐欄合併：暫缺／解析失敗不覆蓋完整值；來源明確更正則採用有效新值。 */
export function mergeHpListingFields(current, incoming = {}, { allowCorrection = true } = {}) {
  const next = { ...current };
  const changes = [];
  const takeText = (key, incomingKey = key) => {
    const prev = filledText(current?.[key]);
    const value = filledText(incoming?.[incomingKey]);
    if (!value) return;
    if (!prev) {
      next[key] = value;
      changes.push(key);
      return;
    }
    if (allowCorrection && value !== prev) {
      if (key === "address") {
        if (addressPrecision(value) >= addressPrecision(prev)) {
          next[key] = value;
          changes.push(key);
        }
        return;
      }
      if (key === "floor_name") {
        const prevFloor = classifyRentalFloor(prev, { fetched: true });
        const nextFloor = classifyRentalFloor(value, { fetched: true });
        if (nextFloor.status === FIELD_PROVIDED && (prevFloor.status !== FIELD_PROVIDED || value !== prev)) {
          next[key] = value;
          changes.push(key);
        }
        return;
      }
      next[key] = value;
      changes.push(key);
    }
  };

  takeText("title");
  if (Number(incoming.price_num) > 0 && Number(incoming.price_num) !== Number(current.price_num)) {
    next.price_num = Number(incoming.price_num);
    next.price = incoming.price || String(incoming.price_num);
    changes.push("price");
  }
  takeText("url");
  takeText("address");
  takeText("area_name");
  takeText("layout");
  takeText("floor_name");
  takeText("kind_name");
  takeText("community_name");
  if (Number(incoming.community_id) > 0 && Number(incoming.community_id) !== Number(current.community_id)) {
    next.community_id = Number(incoming.community_id);
    changes.push("community_id");
  }
  if (incoming.community_linked) next.community_linked = 1;

  const incomingCoords = isTaiwanMapPin(incoming.lat, incoming.lng);
  if (incomingCoords) {
    const incomingGeo = {
      lat: incoming.lat,
      lng: incoming.lng,
      geo_source: incoming.geo_source || "houseprice",
      address: incoming.address || next.address,
    };
    const accept = !isTaiwanMapPin(current.lat, current.lng)
      || shouldAcceptGeoUpdate(current, incomingGeo)
      || resolveLocationClass(incomingGeo) !== resolveLocationClass(current);
    if (accept) {
      const moved = Number(current.lat) !== Number(incoming.lat) || Number(current.lng) !== Number(incoming.lng);
      next.lat = incoming.lat;
      next.lng = incoming.lng;
      next.geo_source = incomingGeo.geo_source;
      if (moved) changes.push("coords");
    }
  }

  const extraTags = parseTags(incoming.tags);
  if (extraTags.length) {
    const merged = mergeTagList(current.tags, extraTags);
    if (JSON.stringify(merged) !== JSON.stringify(parseTags(current.tags))) {
      next.tags = JSON.stringify(merged);
      changes.push("tags");
    }
  } else if (typeof incoming.tags === "string" && incoming.tags && incoming.tags !== current.tags) {
    next.tags = incoming.tags;
    changes.push("tags");
  }

  for (const key of ["has_natural_gas", "has_balcony", "furnish_items"]) {
    if (incoming[key] != null && incoming[key] !== current[key]) {
      next[key] = incoming[key];
      changes.push(key);
    }
  }

  const addressChanged = changes.includes("address");
  const coordsChanged = changes.includes("coords");
  return {
    listing: next,
    changes,
    addressChanged,
    coordsChanged,
    locationChanged: addressChanged || coordsChanged,
  };
}

export function hpDisplayReadySql(alias = "listings") {
  return `(COALESCE(${alias}.source, '591') != 'houseprice' OR EXISTS (
    SELECT 1 FROM listing_prep p
    WHERE p.post_id = ${alias}.post_id AND p.display_ready = 1
  ))`;
}

export function commuteIncompleteShouldExclude(settings, listingMeters) {
  const km = Number(settings?.commuteKm);
  const commuteOn = Number.isFinite(km) && km > 0 && Number(settings?.workLat) && Number(settings?.workLng);
  if (!commuteOn) return false;
  return listingMeters == null;
}
