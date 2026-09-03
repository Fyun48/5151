import { lookupDistrict, normalizeWatchDistricts } from "./regions.js";
import { coverToListUrl } from "./covering.js";
import { bestMatch } from "./match.js";
import { isSelfPhotoPublicUrl, SELF_PHOTO_MAX_BYTES, SELF_PHOTO_MAX_COUNT } from "./selfPhotos.js";

export const SELF_POST_ID_BASE = 2_100_000_000;
export const SELF_POST_ID_END = 2_200_000_000;
export const SELF_MAX_OPEN = 3;
export const SELF_TTL_DAYS = 30;
export const SELF_NEW_ACCOUNT_WAIT_MS = 24 * 60 * 60 * 1000;
export const SELF_TITLE_MAX = 80;
export const SELF_BODY_MAX = 800;
export const SELF_BODY_MIN = 8;
export const SELF_CONTACT_MAX = 80;
export const SELF_PHOTO_URL_MAX = 500;
export const SELF_REPORT_HIDE_AFTER = 2;

export const SELF_KINDS = [
  { id: "whole", label: "整層住家" },
  { id: "suite", label: "獨立套房" },
  { id: "share", label: "分租套房" },
  { id: "room", label: "雅房" },
  { id: "other", label: "其他" },
];

export const SELF_ROLES = [
  { id: "owner", label: "屋主" },
  { id: "agent", label: "代理人" },
];

export const SELF_LEGAL = "這是免費找房工具，不是仲介、不保證媒合、不經手金錢。自行刊登是公開物件摘要，沒有即時私訊；聯絡方式會顯示給已登入會員。內容由刊登者負責，平台可隱藏或移除。跨站若判定可能同一間，會標成需確認同屋源，不會自動刪掉。";

export function isSelfListingId(postId) {
  const n = Number(postId);
  return Number.isFinite(n) && n >= SELF_POST_ID_BASE && n < SELF_POST_ID_END;
}

export function isSelfListingRow(row) {
  return String(row?.source || "") === "self" || isSelfListingId(row?.post_id);
}

export function selfSourceLabel(source) {
  const id = String(source || "591");
  if (id === "self") return "站內刊登";
  if (id === "hbhousing") return "住商";
  if (id === "591") return "591";
  return id;
}

export function selfListingMeta() {
  return {
    legal: SELF_LEGAL,
    max_open: SELF_MAX_OPEN,
    ttl_days: SELF_TTL_DAYS,
    kinds: SELF_KINDS,
    roles: SELF_ROLES,
    photos: {
      max_count: SELF_PHOTO_MAX_COUNT,
      max_bytes: SELF_PHOTO_MAX_BYTES,
      accept: "image/jpeg,image/png,image/webp",
    },
  };
}

export function ensureSelfListingSchema(db) {
  for (const sql of [
    "ALTER TABLE listings ADD COLUMN listed_by_user_id INTEGER",
    "ALTER TABLE listings ADD COLUMN self_status TEXT",
    "ALTER TABLE listings ADD COLUMN self_expires_at TEXT",
    "ALTER TABLE listings ADD COLUMN self_body TEXT",
    "ALTER TABLE listings ADD COLUMN self_photos TEXT",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // already migrated
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listings_self ON listings(source, self_status, listed_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_listing_reports_post ON listing_reports(post_id, user_id);
  `);
}

export function sqlNotSelfSource() {
  return `COALESCE(source, '591') != 'self'`;
}

export function sql591Source() {
  return `COALESCE(source, '591') = '591'`;
}

export function sqlOpenSelfListing(nowIso) {
  return {
    sql: `(
      COALESCE(source, '591') != 'self'
      OR (
        COALESCE(self_status, 'open') = 'open'
        AND (self_expires_at IS NULL OR self_expires_at > ?)
      )
    )`,
    params: [nowIso],
  };
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function nowMs(now) {
  return now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
}

function iso(now) {
  return new Date(nowMs(now)).toISOString();
}

function kindLabel(id) {
  return SELF_KINDS.find((row) => row.id === id)?.label || SELF_KINDS[0].label;
}

function kindId(value) {
  const id = String(value || "whole").trim();
  return SELF_KINDS.some((row) => row.id === id) ? id : "whole";
}

function roleLabel(id) {
  return SELF_ROLES.find((row) => row.id === id)?.label || "屋主";
}

function roleId(value) {
  const id = String(value || "owner").trim();
  return SELF_ROLES.some((row) => row.id === id) ? id : "owner";
}

function userCreatedAt(db, userId) {
  try {
    return String(db.prepare("SELECT created_at FROM users WHERE id = ?").get(userId)?.created_at || "");
  } catch {
    return "";
  }
}

export function expireOpenSelfListings(db, now = new Date()) {
  const stamp = iso(now);
  try {
    const result = db.prepare(
      `UPDATE listings
       SET self_status = 'expired'
       WHERE COALESCE(source, '591') = 'self'
         AND COALESCE(self_status, 'open') = 'open'
         AND IFNULL(self_expires_at, '') != ''
         AND self_expires_at <= ?`,
    ).run(stamp);
    return Number(result.changes) || 0;
  } catch {
    return 0;
  }
}

function assertCanPublish(db, userId, now = new Date()) {
  const created = Date.parse(userCreatedAt(db, userId));
  if (Number.isFinite(created) && nowMs(now) - created < SELF_NEW_ACCOUNT_WAIT_MS) {
    throw httpError("新帳號註冊滿 24 小時後才能自行刊登，避免洗版", 403);
  }
  expireOpenSelfListings(db, now);
  const open = db.prepare(
    `SELECT COUNT(*) AS n FROM listings
     WHERE listed_by_user_id = ?
       AND COALESCE(source, '591') = 'self'
       AND COALESCE(self_status, 'open') = 'open'`,
  ).get(userId);
  if (Number(open?.n) >= SELF_MAX_OPEN) {
    throw httpError(`同時最多 ${SELF_MAX_OPEN} 則未過期的站內刊登，請先關閉一則`, 403);
  }
}

function nextSelfPostId(db) {
  const row = db.prepare(
    "SELECT MAX(post_id) AS n FROM listings WHERE post_id >= ? AND post_id < ?",
  ).get(SELF_POST_ID_BASE, SELF_POST_ID_END);
  const current = Number(row?.n) || SELF_POST_ID_BASE;
  const next = Math.max(SELF_POST_ID_BASE, current) + 1;
  if (next >= SELF_POST_ID_END) throw httpError("站內刊登編號已滿", 500);
  return next;
}

function digitsPhone(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

function normalizePhotoUrl(value) {
  const raw = String(value || "").trim().slice(0, SELF_PHOTO_URL_MAX);
  if (!raw) return "";
  if (isSelfPhotoPublicUrl(raw)) return raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError("封面網址格式不正確");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpError("封面只接受 http 或 https 網址，或本站上傳的照片");
  }
  return url.toString().slice(0, SELF_PHOTO_URL_MAX);
}

function normalizePhotoList(input) {
  const raw = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of raw) {
    const url = normalizePhotoUrl(item);
    if (url && !out.includes(url)) out.push(url);
  }
  return out.slice(0, SELF_PHOTO_MAX_COUNT);
}

export function listingPhotoUrls(row) {
  let stored = [];
  try {
    const parsed = JSON.parse(row?.self_photos || "[]");
    stored = Array.isArray(parsed) ? parsed : [];
  } catch {
    stored = [];
  }
  const cover = String(row?.cover || "").trim();
  const out = [];
  for (const item of [cover, ...stored]) {
    const url = String(item || "").trim();
    if (url && !out.includes(url)) out.push(url);
  }
  return out.slice(0, SELF_PHOTO_MAX_COUNT);
}

function normalizeLineUrl(value) {
  const raw = String(value || "").trim().slice(0, 300);
  if (!raw) return "";
  if (/^https:\/\/(line\.me|lin\.ee)\//i.test(raw)) return raw;
  throw httpError("LINE 請貼 https://line.me 或 https://lin.ee 連結");
}

function layoutText(input) {
  const rooms = Math.max(0, Math.min(12, Math.round(Number(input.rooms) || 0)));
  const living = Math.max(0, Math.min(8, Math.round(Number(input.living) || 0)));
  const bath = Math.max(0, Math.min(8, Math.round(Number(input.bath) || 0)));
  if (rooms || living || bath) {
    return `${rooms}房${living}廳${bath}衛`;
  }
  const raw = String(input.layout || "").trim().slice(0, 20);
  return raw || "格局未填";
}

function floorText(input) {
  const floor = Math.max(0, Math.min(80, Math.round(Number(input.floor) || 0)));
  const total = Math.max(0, Math.min(80, Math.round(Number(input.total_floors) || 0)));
  if (floor && total) return `${floor}F/${total}F`;
  if (floor) return `${floor}F`;
  return String(input.floor_name || "").trim().slice(0, 20);
}

function selfSourceKey({ regionId, sectionId, address, floorName, areaName, layout }) {
  const addr = String(address || "").replace(/\s+/g, "").toLowerCase();
  const floor = String(floorName || "").split("/")[0].trim();
  const area = String(areaName || "").replace(/坪/g, "");
  return [regionId || "", sectionId || "", "", addr, floor, area, layout].join("|");
}

function selfSearchKey(regionId, sectionId) {
  return coverToListUrl({
    regionId,
    sectionIds: [sectionId],
    priceMin: 0,
    priceMax: 0,
  });
}

export function decorateSelfListing(row, { viewerId = 0 } = {}) {
  if (!row) return row;
  return {
    post_id: Number(row.post_id),
    source: "self",
    source_label: "站內刊登",
    title: String(row.title || ""),
    url: String(row.url || `/go/${row.post_id}`),
    price: String(row.price || ""),
    price_num: Number(row.price_num) || 0,
    address: String(row.address || ""),
    area_name: String(row.area_name || ""),
    layout: String(row.layout || ""),
    floor_name: String(row.floor_name || ""),
    kind_name: String(row.kind_name || ""),
    role_name: String(row.role_name || ""),
    cover: String(row.cover || ""),
    photos: listingPhotoUrls(row),
    body: String(row.self_body || ""),
    contact_name: String(row.contact_name || ""),
    contact_role: String(row.contact_role || row.role_name || ""),
    mobile: String(row.mobile || row.phone || ""),
    phone: String(row.phone || row.mobile || ""),
    line_url: String(row.line_url || ""),
    status: String(row.self_status || "open"),
    created_at: row.first_seen_at,
    expires_at: row.self_expires_at || null,
    match_level: row.match_level || null,
    match_detail: row.match_detail || "",
    match_post_id: Number(row.match_post_id) || 0,
    mine: Number(row.listed_by_user_id) === Number(viewerId),
  };
}

function getSelfRow(db, postId) {
  return db.prepare(
    "SELECT * FROM listings WHERE post_id = ? AND COALESCE(source, '591') = 'self'",
  ).get(Number(postId) || 0);
}

export function listMineSelfListings(db, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  expireOpenSelfListings(db);
  return db.prepare(
    `SELECT * FROM listings
     WHERE listed_by_user_id = ? AND COALESCE(source, '591') = 'self'
     ORDER BY post_id DESC LIMIT 30`,
  ).all(uid).map((row) => decorateSelfListing(row, { viewerId: uid }));
}

export function getSelfListing(db, postId, { viewerId = 0 } = {}) {
  expireOpenSelfListings(db);
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則站內刊登", 404);
  const status = String(row.self_status || "open");
  const mine = Number(row.listed_by_user_id) === Number(viewerId);
  if (status !== "open" && !mine) throw httpError("這則刊登已關閉或隱藏", 404);
  return decorateSelfListing(row, { viewerId });
}

export function createSelfListing(db, userId, input = {}, now = new Date(), { matchCandidates } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能刊登", 401);
  assertCanPublish(db, uid, now);

  const districts = normalizeWatchDistricts(
    input.district ? [input.district] : input.districts,
  ).slice(0, 1);
  if (!districts.length) throw httpError("請選一個行政區");
  const district = lookupDistrict(districts[0]);
  if (!district) throw httpError("請選一個有效行政區");

  const rent = Math.round(Number(input.rent || input.price_num) || 0);
  if (!(rent >= 1000 && rent <= 200000)) throw httpError("請填每月租金（1,000～200,000）");

  const ping = Number(String(input.ping || input.area || "").replace(/坪/g, ""));
  if (!(ping > 0 && ping <= 500)) throw httpError("請填坪數");

  const address = String(input.address || "").replace(/\s+/g, " ").trim();
  if (address.length < 6) throw httpError("請填完整地址（至少 6 個字）");

  const body = String(input.body || "").trim().slice(0, SELF_BODY_MAX);
  if (body.length < SELF_BODY_MIN) throw httpError(`請寫一點物件說明（至少 ${SELF_BODY_MIN} 個字）`);

  const kind = kindId(input.kind || input.housing_type);
  const role = roleId(input.role);
  const layout = layoutText(input);
  const floorName = floorText(input);
  if (!floorName) throw httpError("請填所在樓層");

  const contactName = String(input.contact_name || "").trim().slice(0, SELF_CONTACT_MAX);
  const phone = digitsPhone(input.phone || input.mobile);
  const lineUrl = normalizeLineUrl(input.line_url);
  if (!phone && !lineUrl) throw httpError("請至少留電話或 LINE 連結（公開顯示，不是私訊）");
  if (phone && phone.replace(/\D/g, "").length < 8) throw httpError("電話號碼太短");

  const photos = normalizePhotoList(input.photos || input.photo_urls);
  const cover = normalizePhotoUrl(input.cover || input.photo_url) || photos[0] || "";
  if (cover && !photos.includes(cover)) photos.unshift(cover);
  const storedPhotos = photos.slice(0, SELF_PHOTO_MAX_COUNT);
  const kindName = kindLabel(kind);
  const roleName = roleLabel(role);
  const areaName = `${String(Math.round(ping * 10) / 10).replace(/\.0$/, "")}坪`;
  const title = String(input.title || "").trim().slice(0, SELF_TITLE_MAX)
    || `${district.city}${district.name} ${kindName} ${rent}元`;

  const created = iso(now);
  const expires = new Date(nowMs(now) + SELF_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const postId = nextSelfPostId(db);
  const sourceKey = selfSourceKey({
    regionId: district.region,
    sectionId: district.id,
    address,
    floorName,
    areaName,
    layout,
  });
  const searchKey = selfSearchKey(district.region, district.id);
  const priceText = String(rent);

  db.prepare(`
    INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num,
      extra_fee, extra_fee_text, price_contain_text, extra_fees, extra_fees_fetched,
      address, area_name, layout, floor_name, kind_name, role_name, cover, tags,
      refresh_time, first_seen_at, last_seen_at, last_event, viewed, watched
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', '', '[]', 1, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'new', 0, 0)
  `).run(
    postId,
    sourceKey,
    searchKey,
    title,
    `/go/${postId}`,
    priceText,
    rent,
    address,
    areaName,
    layout,
    floorName,
    kindName,
    roleName,
    storedPhotos[0] || cover,
    JSON.stringify(["站內刊登"]),
    created,
    created,
  );

  db.prepare(`
    UPDATE listings SET
      source = 'self',
      source_id = ?,
      listed_by_user_id = ?,
      self_status = 'open',
      self_expires_at = ?,
      self_body = ?,
      self_photos = ?,
      contact_name = ?,
      contact_role = ?,
      mobile = ?,
      phone = ?,
      line_url = ?,
      contact_fetched = 1
    WHERE post_id = ?
  `).run(
    `self:${uid}:${postId}`,
    uid,
    expires,
    body,
    JSON.stringify(storedPhotos),
    contactName || roleName,
    roleName,
    phone,
    phone,
    lineUrl,
    postId,
  );

  const listing = db.prepare("SELECT * FROM listings WHERE post_id = ?").get(postId);
  const candidates = typeof matchCandidates === "function"
    ? matchCandidates(listing)
    : [];
  const hit = bestMatch(listing, candidates);
  if (hit?.listing) {
    db.prepare(
      `UPDATE listings
       SET match_post_id = ?, match_level = ?, match_detail = ?, match_rejected = 0
       WHERE post_id = ?`,
    ).run(
      hit.listing.post_id,
      hit.level,
      hit.detail,
      postId,
    );
  }

  return getSelfListing(db, postId, { viewerId: uid });
}

export function closeSelfListing(db, userId, postId, { admin = false } = {}, now = new Date()) {
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則站內刊登", 404);
  if (!admin && Number(row.listed_by_user_id) !== Number(userId)) {
    throw httpError("只能關閉自己的刊登", 403);
  }
  db.prepare(
    "UPDATE listings SET self_status = 'closed', last_event = 'offline', last_seen_at = ? WHERE post_id = ?",
  ).run(iso(now), row.post_id);
  return getSelfListing(db, row.post_id, { viewerId: userId });
}

export function hideSelfListing(db, postId, now = new Date()) {
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則站內刊登", 404);
  db.prepare(
    "UPDATE listings SET self_status = 'hidden', hidden = 1, hidden_at = ? WHERE post_id = ?",
  ).run(iso(now), row.post_id);
  return { ok: true, post_id: Number(row.post_id), hidden: true };
}

export function reportSelfListing(db, userId, postId, reason = "", now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能檢舉", 401);
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則站內刊登", 404);
  if (Number(row.listed_by_user_id) === uid) throw httpError("不能檢舉自己的刊登");
  const already = db.prepare(
    "SELECT id FROM listing_reports WHERE post_id = ? AND user_id = ?",
  ).get(row.post_id, uid);
  if (already) return { ok: true, already: true };
  db.prepare(
    "INSERT INTO listing_reports(post_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)",
  ).run(row.post_id, uid, String(reason || "").trim().slice(0, 200), iso(now));
  const count = Number(
    db.prepare("SELECT COUNT(*) AS n FROM listing_reports WHERE post_id = ?").get(row.post_id)?.n,
  ) || 0;
  if (count >= SELF_REPORT_HIDE_AFTER) {
    hideSelfListing(db, row.post_id, now);
  }
  return { ok: true, hidden: count >= SELF_REPORT_HIDE_AFTER };
}

export function keepSelfListingForViewer(row, uid, settings, listingInScope) {
  if (!isSelfListingRow(row)) return true;
  if (row.mine === true) return true;
  if (Number(row.listed_by_user_id) === Number(uid)) return true;
  if (Number(row.watched) === 1) return true;
  if (typeof listingInScope === "function") return listingInScope(row, settings);
  return false;
}
