import { extraMonthlyAmount, listingCompareCost, rentAmount } from "./listingCost.js";

export const MATCH_GEO_MAX_METERS = 120;
export const MATCH_AREA_TIGHT = 0.5;
export const MATCH_AREA_CLOSE = 1;

export function streetKey(address) {
  const text = String(address || "")
    .replace(/\s+/g, "")
    .replace(/-/g, "");
  if (!text) return "";
  const street = text
    .replace(/\d+巷.*$/, "")
    .replace(/\d+弄.*$/, "")
    .replace(/\d+之\d+號.*$/, "")
    .replace(/\d+號.*$/, "")
    .replace(/\d+$/, "");
  if (street.length < 5 || !/[路街道大道]/.test(street)) return "";
  return street;
}

export function houseNumber(address) {
  const text = String(address || "").replace(/\s+/g, "").replace(/-/g, "");
  const alley = text.match(/(\d+)巷/);
  const lane = text.match(/(\d+)弄/);
  const num = text.match(/(\d+)(?:之(\d+))?號/);
  if (!num && !alley && !lane) return "";
  return [alley?.[1] ? `巷${alley[1]}` : "", lane?.[1] ? `弄${lane[1]}` : "", num ? `號${num[1]}${num[2] ? `之${num[2]}` : ""}` : ""]
    .filter(Boolean)
    .join("");
}

export function coverKey(url) {
  return String(url || "")
    .replace(/!.*$/, "")
    .replace(/\?.*$/, "")
    .replace(/#.*$/, "");
}

export function areaNum(value) {
  const n = Number(String(value || "").replace(/坪/g, "").replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function floorMain(floorName) {
  const main = String(floorName || "").replace(/\s+/g, "").split("/")[0];
  const numbered = main.match(/(\d+)/);
  if (numbered) return numbered[1];
  return main.toLowerCase();
}

export function layoutRooms(layout) {
  const match = String(layout || "").match(/(\d+)\s*房/);
  return match ? Number(match[1]) : null;
}

export function communityId(listing) {
  if (listing.community_id && Number(listing.community_id) !== 0) {
    return `c${listing.community_id}`;
  }
  const bit = String(listing.source_key || "").split("|")[2] || "";
  return bit.startsWith("c") ? bit : "";
}

export function communityNameKey(listing) {
  return String(listing.community_name || "").replace(/\s+/g, "").toLowerCase();
}

export function contactKey(listing) {
  const mobile = String(listing.mobile || "").replace(/\D/g, "");
  const phone = String(listing.phone || "").replace(/\D/g, "");
  const uid = String(listing.contact_uid || "").trim();
  if (mobile.length >= 8) return `m:${mobile}`;
  if (phone.length >= 8) return `p:${phone}`;
  if (uid) return `u:${uid}`;
  return "";
}

export function geoDistanceM(a, b) {
  const lat1 = Number(a?.lat);
  const lng1 = Number(a?.lng);
  const lat2 = Number(b?.lat);
  const lng2 = Number(b?.lng);
  if (![lat1, lng1, lat2, lng2].every((n) => Number.isFinite(n) && n !== 0)) return null;
  const r = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function comparableRent(listing) {
  const n = listingCompareCost(listing, { includeExtras: true });
  return Number.isFinite(n) && n > 0 ? n : null;
}

function evidence(signals, extra = {}) {
  return { signals, ...extra };
}

export function matchVeto(incoming, previous) {
  const reasons = [];
  const houseA = houseNumber(incoming.address);
  const houseB = houseNumber(previous.address);
  if (houseA && houseB && houseA !== houseB) reasons.push("house_number_mismatch");
  const floorA = floorMain(incoming.floor_name);
  const floorB = floorMain(previous.floor_name);
  if (floorA && floorB && floorA !== floorB && /^\d+$/.test(floorA) && /^\d+$/.test(floorB)) {
    reasons.push("floor_mismatch");
  }
  const commA = communityId(incoming);
  const commB = communityId(previous);
  if (commA && commB && commA !== commB) reasons.push("community_id_mismatch");
  const roomsA = layoutRooms(incoming.layout);
  const roomsB = layoutRooms(previous.layout);
  if (roomsA != null && roomsB != null && roomsA !== roomsB) reasons.push("layout_mismatch");
  const areaA = areaNum(incoming.area_name);
  const areaB = areaNum(previous.area_name);
  if (areaA != null && areaB != null && Math.abs(areaA - areaB) > 3) reasons.push("area_mismatch");
  const meters = geoDistanceM(incoming, previous);
  if (meters != null && meters > MATCH_GEO_MAX_METERS) reasons.push("geo_too_far");
  return reasons;
}

export function scoreMatch(incoming, previous) {
  if (!incoming || !previous) return null;
  if (Number(incoming.post_id) === Number(previous.post_id)) return null;

  const veto = matchVeto(incoming, previous);
  if (veto.length) {
    return null;
  }

  if (incoming.source_key && incoming.source_key === previous.source_key) {
    return {
      level: "high",
      confidence: 0.99,
      detail: `指紋相同，先前 #${previous.post_id}`,
      evidence: evidence(["source_key"], { source_key: incoming.source_key }),
    };
  }

  const floorA = floorMain(incoming.floor_name);
  const floorB = floorMain(previous.floor_name);
  const areaA = areaNum(incoming.area_name);
  const areaB = areaNum(previous.area_name);
  const commA = communityId(incoming);
  const commB = communityId(previous);
  const nameA = communityNameKey(incoming);
  const nameB = communityNameKey(previous);
  const streetA = streetKey(incoming.address);
  const streetB = streetKey(previous.address);
  const houseA = houseNumber(incoming.address);
  const houseB = houseNumber(previous.address);
  const coverA = coverKey(incoming.cover);
  const coverB = coverKey(previous.cover);
  const roomsA = layoutRooms(incoming.layout);
  const roomsB = layoutRooms(previous.layout);
  const contactA = contactKey(incoming);
  const contactB = contactKey(previous);
  const sameFloor = Boolean(floorA && floorA === floorB);
  const areaClose = areaA != null && areaB != null && Math.abs(areaA - areaB) <= MATCH_AREA_CLOSE;
  const areaTight = areaA != null && areaB != null && Math.abs(areaA - areaB) <= MATCH_AREA_TIGHT;
  const sameCover = Boolean(coverA && coverA === coverB);
  const sameRooms = roomsA != null && roomsA === roomsB;
  const sameRole = Boolean(incoming.role_name && incoming.role_name === previous.role_name);
  const sameContact = Boolean(contactA && contactA === contactB);
  const sameHouse = Boolean(houseA && houseA === houseB);
  const sameStreet = Boolean(streetA && streetA === streetB);
  const sameComm = Boolean(commA && commA === commB);
  const sameName = Boolean(nameA && nameA === nameB);
  const priorGone = Boolean(previous.offline || previous.hidden || previous.viewed);
  const meters = geoDistanceM(incoming, previous);
  const geoClose = meters != null && meters <= MATCH_GEO_MAX_METERS;

  if (sameComm && sameFloor && areaTight) {
    return {
      level: "high",
      confidence: 0.94,
      detail: `同社區＋樓層＋坪數，先前 #${previous.post_id}`,
      evidence: evidence(["community_id", "floor", "area"], { community_id: commA, floor: floorA, area: areaA }),
    };
  }

  if (sameStreet && sameHouse && sameFloor && areaClose) {
    return {
      level: "high",
      confidence: 0.93,
      detail: `${streetA}${houseA} · 同門牌樓層，先前 #${previous.post_id}`,
      evidence: evidence(["address", "house_number", "floor", "area"], { street: streetA, house: houseA, floor: floorA }),
    };
  }

  if (sameContact && sameFloor && areaTight && (sameStreet || sameComm || geoClose)) {
    return {
      level: "high",
      confidence: 0.91,
      detail: `同一聯絡資訊＋樓層坪數，先前 #${previous.post_id}`,
      evidence: evidence(["contact", "floor", "area"]),
    };
  }

  if (sameStreet && sameFloor && areaClose && (sameCover || sameRooms || sameRole || sameContact || priorGone)) {
    const why = sameCover
      ? "封面接近"
      : sameRooms
        ? "格局相同"
        : sameContact
          ? "同一聯絡資訊"
          : sameRole
            ? "同一聯絡人"
            : previous.offline
              ? "舊刊登已下架後重刊"
              : previous.hidden
                ? "對應已隱藏物件"
                : "對應已瀏覽物件";
    const level = previous.offline || sameCover || sameHouse ? "high" : "medium";
    return {
      level,
      confidence: level === "high" ? 0.88 : 0.72,
      detail: `${streetA} · ${why}，先前 #${previous.post_id}`,
      evidence: evidence(["street", "floor", "area", why]),
    };
  }

  if (sameCover && sameFloor && areaClose && streetA && streetB && streetA.slice(0, 3) === streetB.slice(0, 3)) {
    return {
      level: "medium",
      confidence: 0.7,
      detail: `封面圖相同，先前 #${previous.post_id}`,
      evidence: evidence(["cover", "floor", "area", "street_prefix"]),
    };
  }

  if ((sameComm || sameName) && sameFloor && areaClose && (sameRole || sameCover || sameContact || priorGone)) {
    return {
      level: previous.offline ? "high" : "medium",
      confidence: previous.offline ? 0.86 : 0.68,
      detail: `同社區重刊嫌疑，先前 #${previous.post_id}`,
      evidence: evidence(["community", "floor", "area"]),
    };
  }

  if (geoClose && sameFloor && areaTight && (sameRooms || sameCover || sameContact)) {
    return {
      level: "medium",
      confidence: 0.66,
      detail: `座標接近＋樓層坪數，先前 #${previous.post_id}`,
      evidence: evidence(["geo", "floor", "area"], { meters }),
    };
  }

  return null;
}

export function bestMatch(incoming, candidates) {
  let medium = null;
  for (const previous of candidates || []) {
    const hit = scoreMatch(incoming, previous);
    if (!hit) continue;
    if (hit.level === "high") return { ...hit, listing: previous };
    if (!medium) medium = { ...hit, listing: previous };
  }
  return medium;
}

export function extraFeeAmount(listing) {
  return extraMonthlyAmount(listing);
}

/** 列表要比的月費：租金＋額外費用。缺租金時盡量從 price 字串解析。 */
export function listingTotalCost(listing) {
  const n = listingCompareCost(listing, { includeExtras: true });
  return n > 0 ? n : Number.MAX_SAFE_INTEGER;
}

export { rentAmount };

function rentNum(listing) {
  return listingTotalCost(listing);
}

/** 把 591「3小時前／昨日」轉成時間戳，越新越大。解析不到就用 last_seen_at。 */
export function listingRefreshAt(listing, now = Date.now()) {
  const raw = String(listing?.refresh_time || "").trim();
  if (raw) {
    if (/剛剛/.test(raw)) return now;
    let m = raw.match(/(\d+)\s*秒前/);
    if (m) return now - Number(m[1]) * 1000;
    m = raw.match(/(\d+)\s*分鐘前/);
    if (m) return now - Number(m[1]) * 60 * 1000;
    m = raw.match(/(\d+)\s*小時(?:前|內)/);
    if (m) return now - Number(m[1]) * 3600 * 1000;
    if (/今日|今天/.test(raw)) return now;
    if (/昨日|昨天/.test(raw)) return now - 24 * 3600 * 1000;
    m = raw.match(/(\d+)\s*天前/);
    if (m) return now - Number(m[1]) * 24 * 3600 * 1000;
    const abs = Date.parse(raw);
    if (Number.isFinite(abs)) return abs;
  }
  const seen = Date.parse(listing?.last_seen_at || "");
  return Number.isFinite(seen) ? seen : 0;
}

export function listingTieBreakKey(listing) {
  const source = String(listing?.source || "591");
  const origin = String(listing?.source_id || listing?.url || listing?.post_id || "");
  return `${source}:${origin}:${Number(listing?.post_id) || 0}`;
}

/**
 * 主物件：可比較租金最低者優先；無／錯租金不得贏過正常租金。
 * 同價取來源更新較近；再以穩定 key 決勝負，避免重排跳動。
 */
export function preferPrimaryListing(a, b, now = Date.now()) {
  if (!a) return b;
  if (!b) return a;
  const rentA = comparableRent(a);
  const rentB = comparableRent(b);
  if (rentA != null && rentB == null) return a;
  if (rentB != null && rentA == null) return b;
  if (rentA != null && rentB != null && rentA !== rentB) return rentA < rentB ? a : b;
  const refreshDiff = listingRefreshAt(a, now) - listingRefreshAt(b, now);
  if (refreshDiff !== 0) return refreshDiff > 0 ? a : b;
  const seenDiff = String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || ""));
  if (seenDiff !== 0) return seenDiff < 0 ? a : b;
  const keyDiff = listingTieBreakKey(a).localeCompare(listingTieBreakKey(b));
  if (keyDiff !== 0) return keyDiff < 0 ? a : b;
  return Number(a.post_id) <= Number(b.post_id) ? a : b;
}

export function sortGroupListings(rows, now = Date.now()) {
  return [...(rows || [])].filter(Boolean).sort((a, b) => {
    const winner = preferPrimaryListing(a, b, now);
    if (winner === a) return -1;
    if (winner === b) return 1;
    return 0;
  });
}
