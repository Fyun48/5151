import { extraMonthlyAmount, listingCompareCost, rentAmount } from "./listingCost.js";

export const MATCH_GEO_MAX_METERS = 120;
export const MATCH_AREA_TIGHT = 0.5;
export const MATCH_AREA_CLOSE = 1;
export const MATCHER_VERSION = "same-house-v2";

export function listingSourceName(listing) {
  return String(listing?.source || "591") || "591";
}

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
  const source = listingSourceName(listing);
  if (listing.community_id && Number(listing.community_id) !== 0) {
    return `${source}:${Number(listing.community_id)}`;
  }
  const bit = String(listing.source_key || "").split("|")[2] || "";
  if (bit.startsWith("c") && /^\d+$/.test(bit.slice(1))) {
    return `${source}:${bit.slice(1)}`;
  }
  return bit.startsWith("c") ? `${source}:${bit}` : "";
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

/**
 * 寫入端固化「同屋源折疊」所需的數值欄（供 SQL 折疊在讀取時算 role，不需重算解析）。
 * 值一律由既有解析函式（comparableRent／listingRefreshParts）算出，**不新增第二套解析**。
 *
 * 刻意用「最小欄位子集」建 row 再算：讀取端 comparableRent 只看到候選列的欄位
 * （listings 沒有 fee_blob 欄，listingBlob 的 fee_blob 永遠 undefined），寫入端若直接拿
 * 爬蟲物件算，fee_blob 若存在會改變 extraMonthlyAmount，造成與讀取端不一致。
 *
 *   fold_rent_num          = comparableRent(listing)；不可比較 → NULL。
 *   fold_refresh_kind      = 1 relative / 2 absolute / 0 missing。
 *   fold_refresh_rel_ms    = relative 的倒退毫秒數（「剛剛／今日」為 0）；非 relative → NULL。
 *   fold_refresh_abs_ms    = absolute 的絕對毫秒（或 last_seen_at fallback）；missing → 0；relative → NULL。
 *
 * 讀取端還原 listingRefreshAt(listing, now) =
 *   CASE WHEN fold_refresh_kind = 1 THEN now - fold_refresh_rel_ms ELSE fold_refresh_abs_ms END。
 */
export function computeFoldColumns(listing = {}) {
  const row = {
    price: listing.price,
    price_num: listing.price_num,
    extra_fee: listing.extra_fee,
    extra_fees: listing.extra_fees,
    extra_fee_text: listing.extra_fee_text,
    tags: listing.tags,
    refresh_time: listing.refresh_time,
    last_seen_at: listing.last_seen_at,
  };
  const rent = comparableRent(row);
  const refresh = listingRefreshParts(row);
  return {
    fold_rent_num: rent,
    fold_refresh_kind: refresh.kind === "relative" ? 1 : refresh.kind === "absolute" ? 2 : 0,
    fold_refresh_rel_ms: refresh.kind === "relative" ? refresh.relMs : null,
    fold_refresh_abs_ms: refresh.kind === "relative" ? null : refresh.absMs,
  };
}

// 同屋源折疊欄的寫入端 SQL 與參數綁定（唯一一份）：SQLite 與 PG 只差在執行器形狀
// （PG 的 exec 會把 `?` 轉成 $n）。fold_* 的值仍只由 computeFoldColumns 決定，這裡不含任何公式。
export function foldColumnsUpdateSql() {
  return "UPDATE listings SET fold_rent_num = ?, fold_refresh_kind = ?, fold_refresh_rel_ms = ?, fold_refresh_abs_ms = ? WHERE post_id = ?";
}

export function bindFoldColumnValues(fold, postId) {
  return [fold.fold_rent_num, fold.fold_refresh_kind, fold.fold_refresh_rel_ms, fold.fold_refresh_abs_ms, Number(postId) || 0];
}

// 單一漏斗（fold 刷新）：所有改到 fold 輸入欄（price／extra_fees／extra_fee_text／refresh_time／
// last_seen_at…）的寫入路徑，在主列改完後都該呼叫這裡，用「回讀後的最終列」重算 fold_*，
// 與投影的 refreshListingProjection(Sync) 同一原則。fold 值只由 computeFoldColumns 決定，本函式
// 不複製任何公式；SQLite 與 PG 只差在執行器形狀。
//
//   refreshFoldColumns      — async，exec(sql, params) => rows|{rows}（PG 側，`?` 佔位由呼叫端轉譯）。
//   refreshFoldColumnsSync  — sync，better-sqlite3 handle（SQLite 側）。
export function refreshFoldColumnsSync(sqliteDb, postId) {
  const id = Number(postId) || 0;
  if (!id) return false;
  const row = sqliteDb.prepare("SELECT * FROM listings WHERE post_id = ?").get(id);
  if (!row) return false;
  sqliteDb.prepare(foldColumnsUpdateSql()).run(...bindFoldColumnValues(computeFoldColumns(row), id));
  return true;
}

export async function refreshFoldColumns(exec, postId) {
  const id = Number(postId) || 0;
  if (!id) return false;
  const raw = await exec("SELECT * FROM listings WHERE post_id = ?", [id]);
  const rows = Array.isArray(raw) ? raw : raw?.rows;
  const row = rows?.[0];
  if (!row) return false;
  await exec(foldColumnsUpdateSql(), bindFoldColumnValues(computeFoldColumns(row), id));
  return true;
}

function evidence(signals, extra = {}) {
  return {
    signals,
    matcher_version: MATCHER_VERSION,
    evaluated_at: extra.evaluated_at || new Date().toISOString(),
    ...extra,
  };
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
  const sameSource = listingSourceName(incoming) === listingSourceName(previous);
  if (sameSource) {
    const commA = communityId(incoming);
    const commB = communityId(previous);
    if (commA && commB && commA !== commB) reasons.push("community_id_mismatch");
  }
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

export function evaluateMatch(incoming, previous, { now = new Date() } = {}) {
  const veto_reasons = incoming && previous ? matchVeto(incoming, previous) : ["missing_listing"];
  const hit = incoming && previous ? scoreMatch(incoming, previous) : null;
  const evaluated_at = now instanceof Date ? now.toISOString() : String(now);
  return {
    incoming_post_id: Number(incoming?.post_id) || 0,
    candidate_post_id: Number(previous?.post_id) || 0,
    candidate_source: listingSourceName(previous),
    confidence: hit?.confidence || 0,
    level: hit?.level || "",
    signals: hit?.evidence?.signals || [],
    veto_reasons,
    matcher_version: MATCHER_VERSION,
    evaluated_at,
    hit,
  };
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
    const housePartial = Boolean((houseA && !houseB) || (!houseA && houseB));
    const strong = sameCover || sameHouse || sameContact || sameComm;
    let level = previous.offline || sameCover || sameHouse ? "high" : "medium";
    if (housePartial && !strong) level = "medium";
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

export function matchFocusHints(listing) {
  return {
    street: streetKey(listing?.address),
    community: String(listing?.community_name || "").trim(),
    cover: String(listing?.cover || "").trim(),
  };
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
  const parts = listingRefreshParts(listing);
  return parts.kind === "relative" ? now - parts.relMs : parts.absMs;
}

/**
 * 把 listingRefreshAt 的解析拆成「相對 offset／絕對 ms／missing」三態，供寫入端固化
 * （fold_refresh_kind / fold_refresh_rel_ms / fold_refresh_abs_ms）使用。**不新增第二套解析**：
 * listingRefreshAt 就是由本函式還原，兩者逐位元一致。
 *   - relative：refresh_time 是相對字串（「16 小時內更新」），relMs 是倒退的毫秒數。
 *   - absolute：refresh_time 是絕對時間（或 fallback last_seen_at），absMs 是絕對毫秒。
 *   - missing：都解析不到，absMs = 0（與 listingRefreshAt 的 fallback 0 一致）。
 */
export function listingRefreshParts(listing) {
  const raw = String(listing?.refresh_time || "").trim();
  if (raw) {
    if (/剛剛/.test(raw)) return { kind: "relative", relMs: 0, absMs: null };
    let m = raw.match(/(\d+)\s*秒前/);
    if (m) return { kind: "relative", relMs: Number(m[1]) * 1000, absMs: null };
    m = raw.match(/(\d+)\s*分鐘前/);
    if (m) return { kind: "relative", relMs: Number(m[1]) * 60 * 1000, absMs: null };
    m = raw.match(/(\d+)\s*小時(?:前|內)/);
    if (m) return { kind: "relative", relMs: Number(m[1]) * 3600 * 1000, absMs: null };
    if (/今日|今天/.test(raw)) return { kind: "relative", relMs: 0, absMs: null };
    if (/昨日|昨天/.test(raw)) return { kind: "relative", relMs: 24 * 3600 * 1000, absMs: null };
    m = raw.match(/(\d+)\s*天前/);
    if (m) return { kind: "relative", relMs: Number(m[1]) * 24 * 3600 * 1000, absMs: null };
    const abs = Date.parse(raw);
    if (Number.isFinite(abs)) return { kind: "absolute", relMs: null, absMs: abs };
  }
  const seen = Date.parse(listing?.last_seen_at || "");
  if (Number.isFinite(seen)) return { kind: "absolute", relMs: null, absMs: seen };
  return { kind: "missing", relMs: null, absMs: 0 };
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
