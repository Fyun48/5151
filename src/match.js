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

export function scoreMatch(incoming, previous) {
  if (!incoming || !previous) return null;
  if (Number(incoming.post_id) === Number(previous.post_id)) return null;
  if (incoming.source_key && incoming.source_key === previous.source_key) {
    return { level: "high", detail: `指紋相同，先前 #${previous.post_id}` };
  }

  const floorA = floorMain(incoming.floor_name);
  const floorB = floorMain(previous.floor_name);
  const areaA = areaNum(incoming.area_name);
  const areaB = areaNum(previous.area_name);
  const commA = communityId(incoming);
  const commB = communityId(previous);
  const streetA = streetKey(incoming.address);
  const streetB = streetKey(previous.address);
  const coverA = coverKey(incoming.cover);
  const coverB = coverKey(previous.cover);
  const roomsA = layoutRooms(incoming.layout);
  const roomsB = layoutRooms(previous.layout);
  const sameFloor = Boolean(floorA && floorA === floorB);
  const areaClose = areaA != null && areaB != null && Math.abs(areaA - areaB) <= 1;
  const areaTight = areaA != null && areaB != null && Math.abs(areaA - areaB) <= 0.5;
  const sameCover = Boolean(coverA && coverA === coverB);
  const sameRooms = roomsA != null && roomsA === roomsB;
  const sameRole = Boolean(incoming.role_name && incoming.role_name === previous.role_name);
  const priorGone = Boolean(previous.offline || previous.hidden || previous.viewed);

  if (commA && commA === commB && sameFloor && areaTight) {
    return { level: "high", detail: `同社區＋樓層＋坪數，先前 #${previous.post_id}` };
  }

  // 房仲常刪掉重刊：舊刊登已下架／隱藏／已瀏覽時，同路段＋樓層＋坪數即可判同屋源
  if (streetA && streetA === streetB && sameFloor && areaClose && (sameCover || sameRooms || sameRole || priorGone)) {
    const why = sameCover
      ? "封面接近"
      : sameRooms
        ? "格局相同"
        : sameRole
          ? "同一聯絡人"
          : previous.offline
            ? "舊刊登已下架後重刊"
            : previous.hidden
              ? "對應已隱藏物件"
              : "對應已瀏覽物件";
    const level = previous.offline || sameCover ? "high" : "medium";
    return { level, detail: `${streetA} · ${why}，先前 #${previous.post_id}` };
  }

  if (sameCover && sameFloor && areaClose && streetA && streetB && streetA.slice(0, 3) === streetB.slice(0, 3)) {
    return { level: "medium", detail: `封面圖相同，先前 #${previous.post_id}` };
  }

  // 無完整門牌、但同社區＋同聯絡人＋樓層坪數接近 → 重刊嫌疑
  if (commA && commA === commB && sameFloor && areaClose && (sameRole || sameCover || priorGone)) {
    return {
      level: previous.offline ? "high" : "medium",
      detail: `同社區重刊嫌疑，先前 #${previous.post_id}`,
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

function rentNum(listing) {
  const n = Number(listing?.price_num);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Number(String(listing?.price || "").replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.MAX_SAFE_INTEGER;
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

/**
 * 確認同一間時要保留的主刊登：較低價優先；同價取更新較近。
 */
export function preferPrimaryListing(a, b, now = Date.now()) {
  if (!a) return b;
  if (!b) return a;
  const priceDiff = rentNum(a) - rentNum(b);
  if (priceDiff !== 0) return priceDiff < 0 ? a : b;
  const refreshDiff = listingRefreshAt(a, now) - listingRefreshAt(b, now);
  if (refreshDiff !== 0) return refreshDiff > 0 ? a : b;
  const seenDiff = String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || ""));
  if (seenDiff !== 0) return seenDiff < 0 ? a : b;
  return Number(a.post_id) <= Number(b.post_id) ? a : b;
}
