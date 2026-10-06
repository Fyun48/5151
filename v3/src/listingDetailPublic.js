// 通用物件公開內頁（Phase 2）：`/p/:id` 與 `/api/public/listings/:id/*` 的資料投影。
//
// 對齊 591／租租通的資訊架構，但欄位以**實際拿得到的資料**為準：拿不到的一律 `null`／空陣列，
// 前端會跳過 null，不編造。這裡只做純讀取投影＋相似物件查詢，不寫任何資料、不接第三方。
//
// 鐵則（承自設計規劃 §4.5）：
//   - 不得 import support/sponsor 模組（相似推薦與詳細欄位都不吃贊助資料）。
//   - 相似推薦是「同行政區＋租金 ±20%＋排除自身與同屋源群」的簡單公開查詢，
//     不是爬蟲側的 `matchCandidatesAsync()`（那是同屋源分類用途）。
import { areaNum } from "./match.js";
import { buildingTotalFloors } from "./floors.js";
import { extraFeeRows, extraMonthlyAmount, rentAmount } from "./listingCost.js";
import { resolveDbDriver } from "./dbDriver.js";

// ---- 純字串／數值 helper（不碰 DB，可獨立單元測試） ----

function parseTags(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => (typeof item === "string" ? item : item?.name || item?.value || ""))
      .map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    try { return parseTags(JSON.parse(raw)); } catch { return []; }
  }
  return [];
}

function parseFloorNumber(floorName) {
  const text = String(floorName || "").replace(/\s+/g, "");
  const match = text.match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function parseLayout(layout) {
  const raw = String(layout || "").trim();
  const full = raw.match(/(\d+)\s*房\s*(\d+)\s*廳\s*(\d+)\s*衛/);
  if (full) return { rooms: Number(full[1]), halls: Number(full[2]), baths: Number(full[3]) };
  const rooms = raw.match(/(\d+)\s*房/);
  return { rooms: rooms ? Number(rooms[1]) : null, halls: null, baths: null };
}

function equipmentList(listing) {
  let items = listing?.furnish_items;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { items = []; }
  }
  return (Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter(Boolean);
}

function rentIncludes(listing) {
  const out = [];
  const contain = String(listing?.price_contain_text || "").replace(/[()（）]/g, "").trim();
  if (contain) out.push(contain);
  for (const row of extraFeeRows(listing)) {
    if (row?.key === "contain" || row?.included === true) {
      out.push(String(row?.value || row?.name || "").trim());
    }
  }
  return [...new Set(out.filter(Boolean))];
}

function depositOf(listing) {
  for (const row of extraFeeRows(listing)) {
    if (/押金|保證金/.test(String(row?.name || ""))) {
      return String(row?.value || "").trim() || null;
    }
  }
  return null;
}

function statusOf(listing) {
  if (Number(listing?.offline_confirmed) === 1) return "已下架";
  if (Number(listing?.offline) === 1) return "物件暫離";
  return "刊登中";
}

// 捷運步行：裝飾層只給 `mrt_station` 與 `mrt_walk_m`（原始公尺），
// 分鐘依 4.5 km/h（75 m/min）換算（與 mrt.js 的 WALK_KMH 一致）。
function walkMinutesFromMeters(meters) {
  const n = Number(meters);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 0;
  return Math.max(1, Math.round(n / 75));
}

function mrtOf(listing) {
  const station = String(listing?.mrt_station || "").trim();
  if (!station) return null;
  return { station, walkMinutes: walkMinutesFromMeters(listing?.mrt_walk_m) };
}

// ---- 公開可見性：與 `listingShare.js` 的 `listingIsPublicRow` 同一套規則（hidden／站內 self_status）----

export function isPublicListingDetail(listing, id) {
  if (!listing) return false;
  if (Number(listing?.hidden) === 1) return false;
  const source = String(listing?.source || "591");
  const n = Number(id);
  const selfId = Number.isFinite(n) && n >= 2_100_000_000 && n < 2_200_000_000;
  if (source === "self" || selfId) {
    return String(listing?.self_status || "open") === "open";
  }
  return true;
}

// ---- contact：D6 收斂（訪客遮蔽，登入才露電話／LINE）----

export function publicListingContact(listing, { loggedIn = false } = {}) {
  if (!loggedIn) {
    return { masked: true, phone: null, line: null, lineUrl: null, hint: "登入會員後顯示聯絡方式" };
  }
  return {
    masked: false,
    phone: String(listing?.phone || listing?.mobile || "").trim() || null,
    line: null,
    lineUrl: String(listing?.line_url || "").trim() || null,
    ownerNick: String(listing?.contact_name || "").trim() || null,
  };
}

// ---- 公開內頁投影 ----

export function publicListingDetailView(listing, id, { loggedIn = false } = {}) {
  if (!listing) return null;
  const floorName = String(listing?.floor_name || "");
  const totalFloors = buildingTotalFloors(floorName);
  const rent = rentAmount(listing);
  const extra = extraMonthlyAmount(listing);
  const photos = (Array.isArray(listing?.photos) ? listing.photos : [])
    .map((url) => String(url || "").trim()).filter(Boolean)
    .map((url) => ({ url }));
  return {
    listingId: Number(listing?.post_id || id) || 0,
    source: String(listing?.source || "591") || "591",
    title: String(listing?.title || "").trim() || null,
    rent: rent > 0 ? rent : null,
    rentIncludes: rentIncludes(listing),
    extraMonthlyFee: extra > 0 ? extra : null,
    deposit: depositOf(listing),
    areaPing: areaNum(listing?.area_name),
    floor: parseFloorNumber(floorName),
    floorsTotal: totalFloors > 0 ? totalFloors : null,
    layout: parseLayout(listing?.layout),
    address: String(listing?.address || "").trim() || null,
    district: String(listing?.district || "").trim() || null,
    community: String(listing?.community_name || "").trim() || null,
    mrt: mrtOf(listing),
    photos,
    tags: parseTags(listing?.tags),
    equipment: equipmentList(listing),
    description: String(listing?.self_body || listing?.body || "").trim() || null,
    status: statusOf(listing),
    updatedAt: String(listing?.last_seen_at || listing?.refresh_time || listing?.first_seen_at || "").trim() || null,
    contact: publicListingContact(listing, { loggedIn }),
    share: { enabled: true },
  };
}

// 路由層的 200／404 收斂：不存在或非公開回 404（前端 empty 態走頁面，不是這支 API）。
export function buildPublicListingDetailResponse(listing, id, { loggedIn = false } = {}) {
  if (!isPublicListingDetail(listing, id)) {
    return { status: 404, body: { error: "找不到物件", code: "listing_not_found" } };
  }
  return { status: 200, body: publicListingDetailView(listing, id, { loggedIn }) };
}

// ---- OG（/p/:id 伺服器注入用；title／description 純字串，image 由 server 用既有 helper 組） ----

export function listingDetailOgTitle(listing) {
  return String(listing?.title || "").trim() || "吉比租房物件追蹤";
}

export function listingDetailOgDescription(listing) {
  const bits = [
    String(listing?.layout || "").trim(),
    String(listing?.price || "").trim(),
    String(listing?.district || listing?.area_name || "").trim(),
  ].filter(Boolean);
  const text = bits.join("、");
  return text ? text.slice(0, 160) : "租房物件追蹤，租金、格局、交通與聯絡方式一次看齊。";
}

// ---- 相似物件（公開查詢；與爬蟲側 matchCandidatesAsync 無關） ----

// SQLite 佔位符 `?`；PG 路徑由 toPostgresSql 統一轉成 $n，兩邊跑同一句，欄位順序不會漂移。
export function similarListingsSql() {
  return `SELECT l.post_id, l.title, l.price_num, l.price, l.area_name, l.cover, l.floor_name, l.layout,
            p.district, p.updated_at
     FROM listings l
     LEFT JOIN listing_search_projection p ON p.post_id = l.post_id
     WHERE l.post_id != ?
       AND COALESCE(l.hidden, 0) != 1
       AND (COALESCE(l.source, '591') != 'self' OR COALESCE(l.self_status, 'open') = 'open')
       AND COALESCE(p.district, '') = ?
       AND COALESCE(l.price_num, 0) BETWEEN ? AND ?
       AND NOT EXISTS (
         SELECT 1 FROM listing_group_members g1
         WHERE g1.post_id = l.post_id
           AND g1.group_id IN (SELECT group_id FROM listing_group_members g2 WHERE g2.post_id = ?)
       )
     ORDER BY COALESCE(p.updated_at, 0) DESC
     LIMIT ?`;
}

export function mapSimilarListingRows(rows) {
  const list = Array.isArray(rows) ? rows : (rows?.rows || []);
  return list
    .map((row) => ({
      listingId: Number(row?.post_id) || 0,
      title: String(row?.title || "").trim(),
      rent: Number(row?.price_num) || 0,
      district: String(row?.district || "").trim(),
      layoutLabel: String(row?.layout || "").trim(),
      photoUrl: String(row?.cover || "").trim(),
      url: `/p/${Number(row?.post_id) || 0}`,
    }))
    .filter((item) => item.listingId > 0);
}

export function similarPublicListings(db, { postId, district, rent, limit = 4 }) {
  const pid = Number(postId) || 0;
  const d = String(district || "").trim();
  const r = Math.max(0, Number(rent) || 0);
  if (!pid || !d || r <= 0) return [];
  const lo = Math.round(r * 0.8);
  const hi = Math.round(r * 1.2);
  const n = Math.max(1, Math.min(Number(limit) || 4, 10));
  try {
    return mapSimilarListingRows(db.prepare(similarListingsSql()).all(pid, d, lo, hi, pid, n));
  } catch (error) {
    console.warn("相似物件查詢失敗：", error.message);
    return [];
  }
}

export async function similarPublicListingsAsync({ postId, district, rent, limit = 4 } = {}, options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") {
    const { sqliteHandle } = await import("./db.js");
    return similarPublicListings(options.db || sqliteHandle(), { postId, district, rent, limit });
  }
  try {
    const pid = Number(postId) || 0;
    const d = String(district || "").trim();
    const r = Math.max(0, Number(rent) || 0);
    if (!pid || !d || r <= 0) return [];
    const n = Math.max(1, Math.min(Number(limit) || 4, 10));
    const exec = options.exec || (async (sql, params = []) => {
      const { sharedPgDriver } = await import("./pgSharedDriver.js");
      const { toPostgresSql } = await import("./sqlDialect.js");
      const pg = options.pgDriver || await sharedPgDriver();
      const res = await pg.query(toPostgresSql(sql), params);
      return res.rows;
    });
    const rows = await exec(similarListingsSql(), [
      pid,
      d,
      Math.round(r * 0.8),
      Math.round(r * 1.2),
      pid,
      n,
    ]);
    return mapSimilarListingRows(rows);
  } catch (error) {
    console.warn("相似物件查詢失敗：", error.message);
    return [];
  }
}
