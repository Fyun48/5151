import { allDistricts, lookupDistrict, normalizeWatchDistricts } from "./regions.js";
import { coverToListUrl } from "./covering.js";
import { bestMatch } from "./match.js";
import { isSelfPhotoPublicUrl, SELF_PHOTO_MAX_BYTES, SELF_PHOTO_MAX_COUNT } from "./selfPhotos.js";
import { isMemberMediaUrl } from "./memberMedia.js";
import {
  SELF_BODY_TEMPLATES,
  SELF_DEPOSIT_OPTIONS,
  SELF_TRAIT_GROUPS,
  depositLabel,
  normalizeDeposit,
  normalizeSelfTraits,
  normalizeSelfTraitsInput,
  selfTraitLabels,
} from "./selfTraits.js";
import { ensureProfileSchema } from "./profile.js";
import { listingBodyPlain, sanitizeListingBodyHtml } from "./listingBody.js";

export const SELF_POST_ID_BASE = 2_100_000_000;
export const SELF_POST_ID_END = 2_200_000_000;
export const SELF_MAX_OPEN = 10;
export const SELF_TTL_DAYS = 30;
export const SELF_NEW_ACCOUNT_WAIT_MS = 24 * 60 * 60 * 1000;
export const SELF_TITLE_MAX = 80;
export const SELF_BODY_MAX = 500;
export const SELF_BAN_DAYS = 14;
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

export const SELF_LEGAL = "這是免費找房工具，不是仲介、不經手金錢。全站免責已於註冊時同意。自行刊登是公開摘要，沒有即時私訊。此處只需再確認本次刊登的屋主／授權事實。";

export const SELF_AUDIT = "站內物件會不定期抽查。若發現不實、惡作劇或明顯誤導，系統會自動下架，並暫停該帳號上傳物件 14 天。這不是仲介認證，也不保證屋況屬實；請租屋族仍以現場與合約為準。";

export const SELF_RICH_HINT = "來看的人最常問的，其實多半寫在這裡就能先答完。多勾一項、多寫一句，之後就少被重複打擾，也比較快遇到適合的人。";

export const SELF_PLEDGE = "我是這間房子的屋主，或已取得屋主授權的代理人。我確認刊登內容屬實，了解平台會抽查，不實刊登會被下架並暫停上傳。平台不驗證權狀、不保證真實，法律責任由我自行負擔。";

export function isSelfListingId(postId) {
  const n = Number(postId);
  return Number.isFinite(n) && n >= SELF_POST_ID_BASE && n < SELF_POST_ID_END;
}

export function isSelfListingRow(row) {
  return String(row?.source || "") === "self" || isSelfListingId(row?.post_id);
}

export function selfSourceLabel(source) {
  const id = String(source || "591");
  if (id === "self") return "吉比本站";
  if (id === "hbhousing") return "住商";
  if (id === "sinyi") return "信義";
  if (id === "houseprice") return "5168";
  if (id === "ddroom") return "租租通";
  if (id === "housefun") return "好房";
  if (id === "rakuya") return "樂屋網";
  if (id === "591") return "591";
  return id;
}

export function selfListingMeta() {
  return {
    legal: `${SELF_LEGAL} ${SELF_AUDIT}`,
    max_open: SELF_MAX_OPEN,
    ttl_days: SELF_TTL_DAYS,
    kinds: SELF_KINDS,
    roles: SELF_ROLES,
    traits: SELF_TRAIT_GROUPS,
    deposits: SELF_DEPOSIT_OPTIONS,
    templates: SELF_BODY_TEMPLATES,
    body_max: SELF_BODY_MAX,
    audit: SELF_AUDIT,
    rich_hint: SELF_RICH_HINT,
    pledge: SELF_PLEDGE,
    ban_days: SELF_BAN_DAYS,
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
    "ALTER TABLE listings ADD COLUMN self_traits TEXT",
    "ALTER TABLE listings ADD COLUMN self_pledge_at TEXT",
    "ALTER TABLE listings ADD COLUMN self_deposit TEXT",
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
  ensureProfileSchema(db);
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

function selfBanUntil(db, userId) {
  try {
    return String(db.prepare("SELECT self_ban_until FROM users WHERE id = ?").get(userId)?.self_ban_until || "");
  } catch {
    return "";
  }
}

export function banSelfPublisher(db, userId, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) return "";
  const until = new Date(nowMs(now) + SELF_BAN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    db.prepare("UPDATE users SET self_ban_until = ? WHERE id = ?").run(until, uid);
  } catch {
    // 測試庫可能還沒有這欄
  }
  return until;
}

function assertCanPublish(db, userId, now = new Date()) {
  const banned = Date.parse(selfBanUntil(db, userId));
  if (Number.isFinite(banned) && banned > nowMs(now)) {
    const when = new Date(banned).toISOString().slice(0, 10);
    throw httpError(`因不實刊登暫停上傳，直到 ${when}`, 403);
  }
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

export function nextSelfPostId(db) {
  const row = db.prepare(
    "SELECT MAX(post_id) AS n FROM listings WHERE post_id >= ? AND post_id < ?",
  ).get(SELF_POST_ID_BASE, SELF_POST_ID_END);
  const current = Number(row?.n) || SELF_POST_ID_BASE;
  const next = Math.max(SELF_POST_ID_BASE, current) + 1;
  if (next >= SELF_POST_ID_END) throw httpError("站內刊登編號已滿", 500);
  return next;
}

export function composeSelfAddress(district, streetOrFull) {
  const prefix = `${district.city}${district.name}`;
  let street = String(streetOrFull || "").replace(/\s+/g, " ").trim();
  if (street.startsWith(prefix)) street = street.slice(prefix.length).trim();
  if (!/[路街巷弄大道]/.test(street) || street.replace(/\s+/g, "").length < 2) {
    throw httpError("請至少加上路名（例如 中正路 100 號）");
  }
  return `${prefix}${street}`;
}

export function digitsPhone(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

function normalizePhotoUrl(value) {
  const raw = String(value || "").trim().slice(0, SELF_PHOTO_URL_MAX);
  if (!raw) return "";
  if (isSelfPhotoPublicUrl(raw)) return raw;
  if (isMemberMediaUrl(raw)) return raw; // 會員素材庫照片（/media/lib/...）；所有權由路由層驗證
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

export function normalizeLineUrl(value) {
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
    source_label: "吉比本站",
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
    body: sanitizeListingBodyHtml(String(row.self_body || ""), SELF_BODY_MAX),
    traits: (() => {
      try {
        return normalizeSelfTraits(JSON.parse(row.self_traits || "[]"));
      } catch {
        return [];
      }
    })(),
    trait_labels: (() => {
      try {
        return selfTraitLabels(JSON.parse(row.self_traits || "[]"));
      } catch {
        return [];
      }
    })(),
    deposit: String(row.self_deposit || ""),
    pledged: Boolean(row.self_pledge_at),
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

/** 公開分享頁／API 白名單：不含帳號、所有權、媒合與刊登狀態等私有欄位。 */
export function publicListingView(listing, id) {
  return {
    id: Number(listing?.post_id || listing?.id || id) || 0,
    title: listing?.title || "",
    price: listing?.price || "",
    price_num: Number(listing?.price_num) || 0,
    address: listing?.address || "",
    area_name: listing?.area_name || "",
    layout: listing?.layout || "",
    floor_name: listing?.floor_name || "",
    kind_name: listing?.kind_name || "",
    role_name: listing?.role_name || "",
    cover: listing?.cover || "",
    photos: Array.isArray(listing?.photos) ? listing.photos : [],
    body: listing?.body || "",
    traits: Array.isArray(listing?.traits) ? listing.traits : [],
    trait_labels: Array.isArray(listing?.trait_labels) ? listing.trait_labels : [],
    deposit: listing?.deposit || "",
    contact_name: listing?.contact_name || "",
    contact_role: listing?.contact_role || "",
    mobile: listing?.mobile || "",
    phone: listing?.phone || "",
    line_url: listing?.line_url || "",
    created_at: listing?.created_at || null,
  };
}

export function getSelfRow(db, postId) {
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

  if (input.accept_pledge !== true) {
    throw httpError("請勾選屋主／代理人聲明後才能刊登");
  }

  const address = composeSelfAddress(district, input.street || input.address);

  const body = sanitizeListingBodyHtml(input.body || "", SELF_BODY_MAX);
  const plainBody = listingBodyPlain(body);
  if (plainBody.length < SELF_BODY_MIN) throw httpError(`請寫一點物件說明（至少 ${SELF_BODY_MIN} 個字）`);

  const kind = kindId(input.kind || input.housing_type);
  const role = roleId(input.role);
  const layout = layoutText(input);
  const floorName = floorText(input);
  if (!floorName) throw httpError("請填所在樓層");

  let contactName = String(input.contact_name || "").trim().slice(0, SELF_CONTACT_MAX);
  if (!contactName) {
    try {
      contactName = String(db.prepare("SELECT nickname FROM users WHERE id = ?").get(uid)?.nickname || "").trim();
    } catch {
      contactName = "";
    }
  }
  const phone = digitsPhone(input.phone || input.mobile);
  const lineUrl = normalizeLineUrl(input.line_url);
  if (phone && phone.replace(/\D/g, "").length < 8) throw httpError("電話號碼太短");
  const traitIds = normalizeSelfTraitsInput(input.traits);
  const deposit = normalizeDeposit(input.deposit);

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
    JSON.stringify(["吉比本站", ...selfTraitLabels(traitIds), depositLabel(deposit)].filter(Boolean)),
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
      self_traits = ?,
      self_deposit = ?,
      self_pledge_at = ?,
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
    JSON.stringify(traitIds),
    deposit,
    created,
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

/** 匯入結果寫成草稿：不公開、不填聯絡／設施／聲明。工作者不得呼叫 publish。 */
export function createImportedDraftListing(db, userId, input = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能匯入", 401);
  const title = String(input.title || "").trim().slice(0, SELF_TITLE_MAX);
  const body = sanitizeListingBodyHtml(input.body || "", SELF_BODY_MAX);
  if (!title && listingBodyPlain(body).length < SELF_BODY_MIN) throw httpError("匯入內容不足以建立草稿", 400);
  const photos = normalizePhotoList(input.photos || []);
  const created = iso(now);
  const postId = nextSelfPostId(db);
  const sourceKey = `import-draft:${uid}:${postId}`;
  const address = String(input.address || "").trim();
  const areaName = String(input.area_name || "").trim();
  const layout = String(input.layout || "").trim();
  const floorName = String(input.floor_name || "").trim();
  const kindName = String(input.kind || input.kind_name || "").trim();
  const community = String(input.community || input.community_name || "").trim();
  const tags = ["吉比本站", community].filter(Boolean);
  db.prepare(`
    INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num,
      extra_fee, extra_fee_text, price_contain_text, extra_fees, extra_fees_fetched,
      address, area_name, layout, floor_name, kind_name, role_name, cover, tags,
      refresh_time, first_seen_at, last_seen_at, last_event, viewed, watched
    ) VALUES (?, ?, '', ?, ?, '', 0, 0, '', '', '[]', 1, ?, ?, ?, ?, ?, '', ?, ?, '', ?, ?, 'draft', 0, 0)
  `).run(postId, sourceKey, title || "匯入草稿", `/go/${postId}`, address, areaName, layout, floorName, kindName, photos[0] || "", JSON.stringify(tags), created, created);
  db.prepare(`
    UPDATE listings SET
      source = 'self',
      source_id = ?,
      listed_by_user_id = ?,
      self_status = 'draft',
      self_body = ?,
      self_photos = ?,
      self_traits = '[]',
      self_deposit = '',
      contact_name = '',
      contact_role = '',
      mobile = '',
      phone = '',
      line_url = '',
      contact_fetched = 0
    WHERE post_id = ?
  `).run(`import:${uid}:${postId}`, uid, body, JSON.stringify(photos), postId);
  if (community) {
    try { db.prepare("UPDATE listings SET community_name=? WHERE post_id=?").run(community, postId); } catch { /* optional column */ }
  }
  return getSelfListing(db, postId, { viewerId: uid });
}

/** 會員自己的內容草稿（複製刊登）。不公開、不帶舊聲明／舊匯入身分。 */
export function insertSelfDraftListing(db, userId, fields = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const created = iso(now);
  const postId = nextSelfPostId(db);
  const title = String(fields.title || "").trim().slice(0, SELF_TITLE_MAX) || "複製草稿";
  const body = String(fields.body || "").trim().slice(0, SELF_BODY_MAX);
  const photos = normalizePhotoList(fields.photos || []);
  const rent = Math.max(0, Math.round(Number(fields.price_num || fields.rent) || 0));
  const address = String(fields.address || "").trim().slice(0, 160);
  const areaName = String(fields.area_name || "").trim().slice(0, 40);
  const layout = String(fields.layout || "").trim().slice(0, 20);
  const floorName = String(fields.floor_name || "").trim().slice(0, 20);
  const kindName = String(fields.kind_name || "").trim().slice(0, 20);
  const roleName = String(fields.role_name || "").trim().slice(0, 20);
  const traits = normalizeSelfTraits(fields.traits);
  const deposit = normalizeDeposit(fields.deposit);
  const contactName = String(fields.contact_name || "").trim().slice(0, SELF_CONTACT_MAX);
  const phone = digitsPhone(fields.phone || fields.mobile);
  let lineUrl = "";
  try {
    lineUrl = normalizeLineUrl(fields.line_url);
  } catch {
    lineUrl = "";
  }
  const sourceKey = `copy-draft:${uid}:${postId}`;
  db.prepare(`
    INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num,
      extra_fee, extra_fee_text, price_contain_text, extra_fees, extra_fees_fetched,
      address, area_name, layout, floor_name, kind_name, role_name, cover, tags,
      refresh_time, first_seen_at, last_seen_at, last_event, viewed, watched
    ) VALUES (?, ?, '', ?, ?, ?, ?, 0, '', '', '[]', 1, ?, ?, ?, ?, ?, ?, ?, '[]', '', ?, ?, 'draft', 0, 0)
  `).run(
    postId, sourceKey, title, `/go/${postId}`, rent ? String(rent) : "", rent,
    address, areaName, layout, floorName, kindName, roleName, photos[0] || "",
    created, created,
  );
  db.prepare(`
    UPDATE listings SET
      source = 'self',
      source_id = ?,
      listed_by_user_id = ?,
      self_status = 'draft',
      self_body = ?,
      self_photos = ?,
      self_traits = ?,
      self_deposit = ?,
      contact_name = ?,
      contact_role = ?,
      mobile = ?,
      phone = ?,
      line_url = ?,
      contact_fetched = 0
    WHERE post_id = ?
  `).run(
    `copy:${uid}:${postId}`,
    uid,
    body,
    JSON.stringify(photos),
    JSON.stringify(traits),
    deposit,
    contactName,
    roleName,
    phone,
    phone,
    lineUrl,
    postId,
  );
  return getSelfListing(db, postId, { viewerId: uid });
}

export function listingFormFields(row) {
  if (!row) return {};
  const decorated = row.post_id && row.self_body == null && row.body != null ? row : null;
  const title = String(decorated?.title || row.title || "");
  const body = String(decorated?.body || row.self_body || row.body || "");
  const address = String(decorated?.address || row.address || "");
  const areaName = String(decorated?.area_name || row.area_name || "");
  const layout = String(decorated?.layout || row.layout || "");
  const floorName = String(decorated?.floor_name || row.floor_name || "");
  const kindName = String(decorated?.kind_name || row.kind_name || "");
  const roleName = String(decorated?.role_name || row.role_name || "");
  const ping = Number(String(areaName).replace(/坪/g, "")) || 0;
  const layoutBits = layout.match(/(\d+)\s*房\s*(\d+)\s*廳\s*(\d+)\s*衛/);
  const floorBits = floorName.match(/(\d+)\s*F(?:\s*\/\s*(\d+)\s*F)?/i);
  const kind = SELF_KINDS.find((item) => item.label === kindName || item.id === row.kind)?.id || "whole";
  const role = SELF_ROLES.find((item) => item.label === roleName || item.id === row.role)?.id || "owner";
  let district = "";
  let street = address;
  const bits = String(row.source_key || "").split("|");
  if (bits.length >= 2 && bits[0] && bits[1] && lookupDistrict(`${bits[0]}-${bits[1]}`)) {
    district = `${bits[0]}-${bits[1]}`;
  }
  if (!district) {
    const found = allDistricts()
      .slice()
      .sort((a, b) => `${b.city}${b.name}`.length - `${a.city}${a.name}`.length)
      .find((item) => address.startsWith(`${item.city}${item.name}`));
    if (found) district = `${found.region}-${found.id}`;
  }
  if (district) {
    const info = lookupDistrict(district);
    const prefix = info ? `${info.city}${info.name}` : "";
    if (prefix && street.startsWith(prefix)) street = street.slice(prefix.length).trim();
  }
  return {
    title,
    body,
    rent: Number(decorated?.price_num || row.price_num) || 0,
    ping,
    kind,
    role,
    district,
    street,
    floor: floorBits ? Number(floorBits[1]) : 0,
    total_floors: floorBits && floorBits[2] ? Number(floorBits[2]) : 0,
    rooms: layoutBits ? Number(layoutBits[1]) : 0,
    living: layoutBits ? Number(layoutBits[2]) : 0,
    bath: layoutBits ? Number(layoutBits[3]) : 0,
    deposit: String(decorated?.deposit || row.self_deposit || row.deposit || ""),
    traits: Array.isArray(decorated?.traits)
      ? decorated.traits
      : (() => {
        try { return normalizeSelfTraits(JSON.parse(row.self_traits || "[]")); } catch { return []; }
      })(),
    contact_name: String(decorated?.contact_name || row.contact_name || ""),
    phone: String(decorated?.phone || row.phone || row.mobile || ""),
    line_url: String(decorated?.line_url || row.line_url || ""),
    photos: Array.isArray(decorated?.photos) ? decorated.photos : listingPhotoUrls(row),
    address,
  };
}

export function updateImportedDraftListing(db, userId, postId, input = {}) {
  const uid = Number(userId) || 0;
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則匯入草稿", 404);
  if (Number(row.listed_by_user_id) !== uid) throw httpError("只能改自己的匯入草稿", 403);
  if (String(row.self_status || "") !== "draft") throw httpError("只有草稿可以修改匯入內容", 409);
  const title = input.title != null ? String(input.title || "").trim().slice(0, SELF_TITLE_MAX) : row.title;
  const body = sanitizeListingBodyHtml(input.body != null ? input.body : row.self_body || "", SELF_BODY_MAX);
  const photos = input.photos != null ? normalizePhotoList(input.photos) : listingPhotoUrls(row);
  db.prepare(
    "UPDATE listings SET title=?, self_body=?, self_photos=?, cover=? WHERE post_id=?",
  ).run(title || row.title, body, JSON.stringify(photos), photos[0] || "", row.post_id);
  return getSelfListing(db, row.post_id, { viewerId: uid });
}

export function abandonImportedDraftListing(db, userId, postId, now = new Date()) {
  const uid = Number(userId) || 0;
  const row = getSelfRow(db, postId);
  if (!row) return null;
  if (Number(row.listed_by_user_id) !== uid) throw httpError("只能取消自己的匯入草稿", 403);
  if (String(row.self_status || "") !== "draft") return getSelfListing(db, row.post_id, { viewerId: uid });
  db.prepare(
    "UPDATE listings SET self_status='cancelled', last_event='offline', last_seen_at=? WHERE post_id=?",
  ).run(iso(now), row.post_id);
  return getSelfListing(db, row.post_id, { viewerId: uid });
}

/** 會員確認匯入後，以一般刊登欄位把同一則草稿轉成公開。工作者不得呼叫。 */
export function publishImportedDraftListing(db, userId, postId, input = {}, now = new Date(), { matchCandidates } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能刊登", 401);
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則匯入草稿", 404);
  if (Number(row.listed_by_user_id) !== uid) throw httpError("只能刊登自己的匯入草稿", 403);
  if (String(row.self_status || "") !== "draft") throw httpError("這則不是待刊登的匯入草稿", 409);
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
  if (input.accept_pledge !== true) throw httpError("請勾選屋主／代理人聲明後才能刊登");
  const address = composeSelfAddress(district, input.street || input.address);
  const body = sanitizeListingBodyHtml(input.body != null ? input.body : row.self_body || "", SELF_BODY_MAX);
  const plainBody = listingBodyPlain(body);
  if (plainBody.length < SELF_BODY_MIN) throw httpError(`請寫一點物件說明（至少 ${SELF_BODY_MIN} 個字）`);
  const kind = kindId(input.kind || input.housing_type);
  const role = roleId(input.role);
  const layout = layoutText(input);
  const floorName = floorText(input);
  if (!floorName) throw httpError("請填所在樓層");
  let contactName = String(input.contact_name || "").trim().slice(0, SELF_CONTACT_MAX);
  if (!contactName) {
    try {
      contactName = String(db.prepare("SELECT nickname FROM users WHERE id = ?").get(uid)?.nickname || "").trim();
    } catch {
      contactName = "";
    }
  }
  const phone = digitsPhone(input.phone || input.mobile);
  const lineUrl = normalizeLineUrl(input.line_url);
  if (phone && phone.replace(/\D/g, "").length < 8) throw httpError("電話號碼太短");
  const traitIds = normalizeSelfTraitsInput(input.traits);
  const deposit = normalizeDeposit(input.deposit);
  const photos = normalizePhotoList(input.photos != null ? input.photos : listingPhotoUrls(row));
  const kindName = kindLabel(kind);
  const roleName = roleLabel(role);
  const areaName = `${String(Math.round(ping * 10) / 10).replace(/\.0$/, "")}坪`;
  const title = String(input.title != null ? input.title : row.title || "").trim().slice(0, SELF_TITLE_MAX)
    || `${district.city}${district.name} ${kindName} ${rent}元`;
  const created = iso(now);
  const expires = new Date(nowMs(now) + SELF_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const sourceKey = selfSourceKey({
    regionId: district.region,
    sectionId: district.id,
    address,
    floorName,
    areaName,
    layout,
  });
  db.prepare(`
    UPDATE listings SET
      source_key=?, search_key=?, title=?, url=?, price=?, price_num=?,
      address=?, area_name=?, layout=?, floor_name=?, kind_name=?, role_name=?,
      cover=?, tags=?,
      self_status='open', self_expires_at=?, self_body=?, self_photos=?,
      self_traits=?, self_deposit=?, self_pledge_at=?,
      contact_name=?, contact_role=?, mobile=?, phone=?, line_url=?, contact_fetched=1,
      last_event='new', last_seen_at=?
    WHERE post_id=?
  `).run(
    sourceKey,
    selfSearchKey(district.region, district.id),
    title,
    `/go/${postId}`,
    String(rent),
    rent,
    address,
    areaName,
    layout,
    floorName,
    kindName,
    roleName,
    photos[0] || "",
    JSON.stringify(["吉比本站", ...selfTraitLabels(traitIds), depositLabel(deposit)].filter(Boolean)),
    expires,
    body,
    JSON.stringify(photos.slice(0, SELF_PHOTO_MAX_COUNT)),
    JSON.stringify(traitIds),
    deposit,
    created,
    contactName || roleName,
    roleName,
    phone,
    phone,
    lineUrl,
    created,
    row.post_id,
  );
  const listing = db.prepare("SELECT * FROM listings WHERE post_id = ?").get(row.post_id);
  const candidates = typeof matchCandidates === "function" ? matchCandidates(listing) : [];
  const hit = bestMatch(listing, candidates);
  if (hit?.listing) {
    db.prepare(
      `UPDATE listings SET match_post_id=?, match_level=?, match_detail=?, match_rejected=0 WHERE post_id=?`,
    ).run(hit.listing.post_id, hit.level, hit.detail, row.post_id);
  }
  return getSelfListing(db, row.post_id, { viewerId: uid });
}

export function publishOwnedDraftListing(db, userId, postId, input = {}, now = new Date(), opts = {}) {
  return publishImportedDraftListing(db, userId, postId, input, now, opts);
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
  const until = banSelfPublisher(db, row.listed_by_user_id, now);
  return { ok: true, post_id: Number(row.post_id), hidden: true, ban_until: until };
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
