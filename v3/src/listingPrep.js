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

/** 畫面／群組只用目前可展示的成員；須含來源 enabled。資料庫關係仍保留。 */
export function listingIsDisplayable(row, prep = null) {
  if (row?.source_enabled === false) return false;
  if (!isHousepriceListing(row)) return true;
  if (prep && Object.prototype.hasOwnProperty.call(prep, "display_ready")) {
    return Number(prep.display_ready) === 1;
  }
  if (row?.display_ready === true || Number(row?.display_ready) === 1) return true;
  if (row?.display_ready === false || Number(row?.display_ready) === 0) return false;
  return false;
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
  sourcePartial = false,
} = {}) {
  if (parseFailed) return { status: FIELD_PARSE_FAILED, basis: "none", reason: "facility_parse_failed" };
  if (!fetched) return { status: FIELD_NOT_FETCHED, basis: "none", reason: "facility_not_fetched" };
  if (sourceAbsent) return { status: FIELD_ABSENT, basis: "source_block", reason: "" };
  if (sourcePartial && !sourceBlock) {
    return { status: FIELD_NOT_PROVIDED, basis: "inferred", reason: "facility_partial" };
  }
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
  const alreadyReady = meta.alreadyReady === true
    || Number(listing?.display_ready) === 1
    || listing?.display_ready === true;
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
    sourcePartial: meta.facilityPartial === true,
  });
  const missing = [];
  if (!identity) missing.push("identity");
  if (!detailRecognized) missing.push("detail");
  if (!address.usable) missing.push("address");
  if (floor.status !== FIELD_PROVIDED) missing.push("floor");
  if (![FIELD_PROVIDED, FIELD_ABSENT, FIELD_NOT_PROVIDED].includes(facility.status)
    || facility.basis === "inferred") {
    missing.push("facility");
  }
  let status = PREP_PENDING;
  let withholdReason = "";
  // 「推估」在**完整性**這個定義上仍然不算完整（保持原樣）：缺欄位的記帳與 queue 重試
  // 分類是 386 次重試事故之後鎖住的規則（見 listing-enrich-pending-missing.test.js），不能動。
  // 它不再擋展示 ⇒ 見下方 `facilityOnlyGap`。
  const facilityComplete = [FIELD_PROVIDED, FIELD_ABSENT, FIELD_NOT_PROVIDED].includes(facility.status)
    && facility.basis !== "inferred";
  // 已就緒房源遇到部分設備回應：保留展示，記錄缺漏並重試；首次不完整仍不展示。
  const facilityOk = facilityComplete || (alreadyReady && meta.facilityPartial === true && meta.facilityAbsent !== true);
  const keepVisible = alreadyReady && identity && detailRecognized && address.usable
    && floor.status === FIELD_PROVIDED && facilityOk;
  if (parseFailed && missing.includes("detail")) {
    status = PREP_PARSE_FAILED;
    withholdReason = "detail_parse_failed";
  } else if (identity && detailRecognized && address.usable && floor.status === FIELD_PROVIDED && facilityOk && !missing.includes("facility")) {
    status = PREP_READY;
    missing.length = 0;
    withholdReason = "";

  } else if (keepVisible && meta.facilityPartial === true && missing.includes("facility")) {
    status = PREP_SOURCE_LIMITED;
    withholdReason = facility.reason || "facility_partial";
  } else if (fetched && !parseFailed && identity) {
    if (floor.status === FIELD_NOT_PROVIDED) {
      status = PREP_SOURCE_LIMITED;
      withholdReason = floor.reason || "floor_not_provided";
    } else if (!address.usable && (address.sourceLimited || address.reason === "address_missing" || address.reason === "coords_missing")) {
      status = PREP_SOURCE_LIMITED;
      withholdReason = address.reason || "source_limited";
    }
  }
  // 2026-10-08 決定：5168 不提供設施欄位，我們由內文**推估**（`basis === "inferred"`）。
  // 原本這樣一律不能展示 ⇒ `hpDisplayReadySql()`（只對 houseprice 生效）把這一家的物件整批擋在搜尋外；
  // 正式站現在有 5297 筆的 `missing_fields` 就只有 `facility`（`facility_status=not_provided`、
  // `facility_basis=inferred` 共 5569 筆），全部卡在這條政策上。
  // 所以：**其他必要條件都齊、唯一缺口是推估的設施 ⇒ 放行展示**。
  // 但「缺欄位」的記帳與 queue 重試分類維持原樣（仍記 `missing_fields=facility`、
  // 仍是 `pending_missing`／`source_limited` 車道，事故 L-02xx 鎖的規則不動）。
  // `facility_basis` 照樣存 "inferred" ⇒ 前端 `kitLine()` 據此標示「推估」，不假裝是來源實測。
  // 通知不會暴增：`watcher.js` 的 `onFirstReady` 只對 `first_seen_at` 兩小時內的物件發事件。
  const facilityOnlyGap = missing.length === 1 && missing[0] === "facility"
    && identity && detailRecognized && address.usable && floor.status === FIELD_PROVIDED;

  if (status === PREP_PENDING && missing.length) withholdReason = withholdReason || missing.join(",");
  return {
    status,
    // 2026-10-08 決定：設施是「推估」或「只拿到一部分」都不再擋展示。
    // 但部分回應要繼續讓 queue 補抓 ⇒ 狀態仍留 PREP_SOURCE_LIMITED（見上面那條分支），
    // 只有「來源根本沒有這個欄位」才會走到 PREP_READY 並結案。
    // 2026-10-08 決定（見上）：唯一缺口是推估設施時照樣展示。
    displayReady: status === PREP_READY || keepVisible || facilityOnlyGap,
    identity,
    detailRecognized,
    address,
    floor,
    facility,
    missing,
    withholdReason,
    sourceLimitedReason: address.sourceLimited ? address.reason : (meta.limitedReason || (keepVisible && meta.facilityPartial ? "facility_partial" : "")),
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
        if (addressPrecision(value) >= addressPrecision(prev) && value !== prev) {
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
  if (incoming.source_key && incoming.source_key !== current.source_key) {
    next.source_key = incoming.source_key;
    changes.push("source_key");
  }
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

  const incomingCoords = incoming.clear_coords === true ? false : isTaiwanMapPin(incoming.lat, incoming.lng);
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
      next.clear_coords = false;
      if (moved) changes.push("coords");
    }
  } else if (changes.includes("address") && isTaiwanMapPin(current.lat, current.lng)) {
    next.lat = null;
    next.lng = null;
    next.geo_source = "";
    next.clear_coords = true;
    changes.push("coords");
  }

  const extraTags = parseTags(incoming.tags);
  if (incoming.facility_replace === true) {
    const replaced = typeof incoming.tags === "string" ? incoming.tags : JSON.stringify(extraTags);
    if (replaced !== (typeof current.tags === "string" ? current.tags : JSON.stringify(parseTags(current.tags)))) {
      next.tags = replaced;
      changes.push("tags");
    }
    next.facility_replace = true;
    for (const key of ["has_natural_gas", "has_balcony", "furnish_items"]) {
      if (incoming[key] != null && incoming[key] !== current[key]) {
        next[key] = incoming[key];
        changes.push(key);
      }
    }
  } else {
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
