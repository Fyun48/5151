import { lookupDistrict, normalizeWatchDistricts } from "./regions.js";
import { containsUnsafeMarkup, sanitizeDocumentText } from "./safeContent.js";
import { digitsPhone, normalizeLineUrl, SELF_CONTACT_MAX } from "./selfListings.js";
import {
  DEFAULT_WISH_CONDITIONS,
  WISH_FORBIDDEN_CONDITION_IDS,
  activeWishConditions,
  allWishConditions,
  conditionMap,
} from "./wishConditions.js";

export const DEMAND_MAX_OPEN = 1;
export const DEMAND_TTL_DAYS = 14;
export const DEMAND_NEW_ACCOUNT_WAIT_MS = 24 * 60 * 60 * 1000;
export const DEMAND_REPLY_MIN_GAP_MS = 20 * 1000;
export const DEMAND_REPLY_MAX_PER_HOUR = 12;
export const DEMAND_BODY_MAX = 800;
export const DEMAND_REPLY_MAX = 200;
export const DEMAND_REPORT_HIDE_AFTER = 2;
export const WISH_LOCATION_NOTE_MAX = 80;
export const WISH_TRANSIT_MAX = 80;
export const WISH_FAR_EXPIRE = "9999-12-31T00:00:00.000Z";
export const WISH_PRODUCT_NAME = "許願房";

/** 舊需求牆長聲明：僅供 CMS 種子／相容欄位，許願房表單不再重複貼上。 */
export const DEMAND_LEGAL = "這是免費找房工具，不是仲介、不經手金錢。需求牆是公開留言板。全站使用條款以註冊時同意的版本為準。";

export const DEMAND_HOUSING_TYPES = [
  { id: "any", label: "不限" },
  { id: "whole", label: "整層住家" },
  { id: "suite", label: "獨立套房" },
  { id: "share", label: "分租套房" },
  { id: "room", label: "雅房" },
  { id: "elevator", label: "電梯大樓" },
  { id: "apartment", label: "公寓" },
  { id: "other", label: "其他" },
];

export const WISH_LAYOUTS = [
  { id: "", label: "不限" },
  { id: "1", label: "1 房" },
  { id: "2", label: "2 房" },
  { id: "3", label: "3 房" },
  { id: "4plus", label: "4 房以上" },
];

export const WISH_LEASE_DURATIONS = [
  { id: "", label: "不限" },
  { id: "short", label: "短期（未滿一年）" },
  { id: "year", label: "約一年" },
  { id: "long", label: "一年以上" },
];

export const WISH_CONDITIONS = DEFAULT_WISH_CONDITIONS;
export { WISH_FORBIDDEN_CONDITION_IDS };

export function ensureDemandSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS demand_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      districts TEXT NOT NULL DEFAULT '[]',
      rent_max INTEGER NOT NULL DEFAULT 0,
      housing_type TEXT NOT NULL DEFAULT 'any',
      mrt_walk INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS demand_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (post_id) REFERENCES demand_posts(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS demand_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_demand_posts_status ON demand_posts(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_demand_replies_post ON demand_replies(post_id, created_at);
    CREATE TABLE IF NOT EXISTS wish_room_example (
      user_id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  addWishColumns(db);
  closeLegacyExtraOpenPosts(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_demand_one_open
      ON demand_posts(user_id) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_demand_posts_updated
      ON demand_posts(status, updated_at, id);
  `);
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function addWishColumns(db) {
  const cols = tableColumns(db, "demand_posts");
  const additions = [
    ["city", "TEXT NOT NULL DEFAULT ''"],
    ["location_note", "TEXT NOT NULL DEFAULT ''"],
    ["rent_min", "INTEGER NOT NULL DEFAULT 0"],
    ["includes_management", "INTEGER NOT NULL DEFAULT 0"],
    ["ping_min", "REAL NOT NULL DEFAULT 0"],
    ["layout", "TEXT NOT NULL DEFAULT ''"],
    ["move_in_date", "TEXT NOT NULL DEFAULT ''"],
    ["lease_duration", "TEXT NOT NULL DEFAULT ''"],
    ["transit_note", "TEXT NOT NULL DEFAULT ''"],
    ["destination_note", "TEXT NOT NULL DEFAULT ''"],
    ["commute_minutes", "INTEGER NOT NULL DEFAULT 0"],
    ["must_have", "TEXT NOT NULL DEFAULT '[]'"],
    ["nice_to_have", "TEXT NOT NULL DEFAULT '[]'"],
    ["avoid", "TEXT NOT NULL DEFAULT '[]'"],
    ["contact_name", "TEXT NOT NULL DEFAULT ''"],
    ["phone", "TEXT NOT NULL DEFAULT ''"],
    ["line_url", "TEXT NOT NULL DEFAULT ''"],
    ["updated_at", "TEXT"],
    ["published_at", "TEXT"],
  ];
  for (const [name, def] of additions) {
    if (!cols.has(name)) db.exec(`ALTER TABLE demand_posts ADD COLUMN ${name} ${def}`);
  }
}

/** 舊額度為 2 則 open：保留較新一則為 ACTIVE，其餘改 closed（不刪資料）。 */
function closeLegacyExtraOpenPosts(db, now = new Date()) {
  const stamp = iso(now);
  const extras = db.prepare(`
    SELECT id FROM demand_posts
    WHERE status = 'open'
      AND id NOT IN (
        SELECT MAX(id) FROM demand_posts WHERE status = 'open' GROUP BY user_id
      )
  `).all();
  const upd = db.prepare("UPDATE demand_posts SET status = 'closed', closed_at = COALESCE(closed_at, ?) WHERE id = ?");
  for (const row of extras) upd.run(stamp, row.id);
}

function httpError(message, status = 400, code = "") {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function nowMs(now) {
  return now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
}

function iso(now) {
  return new Date(nowMs(now)).toISOString();
}

function parseJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function withImmediate(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    if (String(error?.message || "").includes("UNIQUE constraint failed: demand_posts.user_id")) {
      throw httpError("同時只能有一則公開的許願房", 409, "wish_active_limit");
    }
    throw error;
  }
}

function stripUnsafePlain(value, max) {
  let text = sanitizeDocumentText(value, max);
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (containsUnsafeMarkup(text)) {
    text = text
      .replace(/<\s*script[\s\S]*?>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
      .replace(/<\s*(iframe|object|embed|style)[\s\S]*?>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
      .replace(/javascript\s*:/gi, "")
      .replace(/on[a-z]+\s*=/gi, "")
      .replace(/<[^>]+>/g, "");
  }
  return text.slice(0, max);
}

export function housingTypeId(value) {
  const id = String(value || "any").trim();
  return DEMAND_HOUSING_TYPES.some((row) => row.id === id) ? id : "any";
}

function housingTypeLabel(id) {
  return DEMAND_HOUSING_TYPES.find((row) => row.id === id)?.label || "不限";
}

function layoutId(value) {
  const id = String(value || "").trim();
  return WISH_LAYOUTS.some((row) => row.id === id) ? id : "";
}

function layoutLabel(id) {
  return WISH_LAYOUTS.find((row) => row.id === id)?.label || "";
}

function leaseId(value) {
  const id = String(value || "").trim();
  return WISH_LEASE_DURATIONS.some((row) => row.id === id) ? id : "";
}

function leaseLabel(id) {
  return WISH_LEASE_DURATIONS.find((row) => row.id === id)?.label || "";
}

function districtLabels(keys) {
  return keys.map((key) => lookupDistrict(key)?.name || key).filter(Boolean);
}

function cityFromDistricts(keys) {
  for (const key of keys) {
    const row = lookupDistrict(key);
    if (row?.city) return row.city;
  }
  return "";
}

function conditionIds(input) {
  const raw = Array.isArray(input) ? input : parseJsonArray(input);
  const allowed = conditionMap(allWishConditions());
  const ids = [];
  for (const item of raw) {
    const id = String(item || "").trim();
    if (!id || WISH_FORBIDDEN_CONDITION_IDS.includes(id)) continue;
    if (allowed.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 16);
}

function conditionLabels(ids) {
  const map = conditionMap(allWishConditions());
  return conditionIds(ids).map((id) => map.get(id)?.label || id);
}

function splitPriorityGroups(must, nice, avoid) {
  const mustHave = conditionIds(must);
  const used = new Set(mustHave);
  const niceToHave = conditionIds(nice).filter((id) => !used.has(id));
  niceToHave.forEach((id) => used.add(id));
  const avoidIds = conditionIds(avoid).filter((id) => !used.has(id));
  return { must_have: mustHave, nice_to_have: niceToHave, avoid: avoidIds };
}

export function listingCompatibilityForWish(mustHave = []) {
  const ids = conditionIds(mustHave);
  const map = conditionMap(allWishConditions());
  const incompatible = [];
  const compatible = [];
  const inverted = [];
  for (const id of ids) {
    const row = map.get(id);
    if (!row) continue;
    for (const trait of row.listing_incompatible || []) incompatible.push(trait);
    for (const trait of row.listing_compatible || []) compatible.push(trait);
    for (const trait of row.listing_legacy_positive || []) compatible.push(trait);
  }
  if (ids.includes("need_cook") && incompatible.includes("nocook") && !ids.includes("nocook")) {
    inverted.push("need_cook_not_nocook");
  }
  return {
    listing_incompatible: [...new Set(incompatible)],
    listing_compatible: [...new Set(compatible)],
    semantic_guard: inverted,
  };
}

function rentPair(minRaw, maxRaw) {
  const rentMin = Math.max(0, Math.min(Math.round(Number(minRaw) || 0), 200000));
  const rentMax = Math.max(0, Math.min(Math.round(Number(maxRaw) || 0), 200000));
  if (rentMin && rentMax && rentMin > rentMax) throw httpError("最低預算不能高於最高預算");
  return { rent_min: rentMin, rent_max: rentMax };
}

function moveInDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw httpError("入住日請用 YYYY-MM-DD");
  const t = Date.parse(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(t)) throw httpError("入住日格式不正確");
  return raw;
}

function userEmail(db, userId) {
  try {
    return String(db.prepare("SELECT email FROM users WHERE id = ?").get(userId)?.email || "");
  } catch {
    return "";
  }
}

function userAuthorName(db, userId) {
  try {
    const row = db.prepare("SELECT nickname FROM users WHERE id = ?").get(userId);
    const nick = String(row?.nickname || "").trim();
    if (nick) return nick;
  } catch { /* nickname column may be absent in isolated tests */ }
  return "會員";
}

function userCreatedAt(db, userId) {
  try {
    return String(db.prepare("SELECT created_at FROM users WHERE id = ?").get(userId)?.created_at || "");
  } catch {
    return "";
  }
}

export function expireOpenPosts(db, now = new Date()) {
  const stamp = iso(now);
  const result = db.prepare(
    `UPDATE demand_posts SET status = 'expired', closed_at = COALESCE(closed_at, ?)
     WHERE status = 'open' AND expires_at <= ? AND expires_at < ?`,
  ).run(stamp, stamp, WISH_FAR_EXPIRE);
  return Number(result.changes) || 0;
}

function assertMatureAccount(db, userId, now, actionLabel) {
  const created = Date.parse(userCreatedAt(db, userId));
  if (Number.isFinite(created) && nowMs(now) - created < DEMAND_NEW_ACCOUNT_WAIT_MS) {
    throw httpError(`新帳號註冊滿 24 小時後才能${actionLabel}，避免洗版`, 403);
  }
}

function countOpen(db, userId, exceptId = 0) {
  const row = exceptId
    ? db.prepare("SELECT COUNT(*) AS n FROM demand_posts WHERE user_id = ? AND status = 'open' AND id != ?").get(userId, exceptId)
    : db.prepare("SELECT COUNT(*) AS n FROM demand_posts WHERE user_id = ? AND status = 'open'").get(userId);
  return Number(row?.n) || 0;
}

function snapshotContact(db, userId, input = {}, fallback = {}) {
  const profileId = Number(input.contact_profile_id) || 0;
  if (profileId) {
    let row;
    try {
      row = db.prepare("SELECT * FROM listing_contact_profile WHERE id = ?").get(profileId);
    } catch {
      throw httpError("找不到這個聯絡人", 404);
    }
    if (!row) throw httpError("找不到這個聯絡人", 404);
    if (Number(row.user_id) !== Number(userId)) throw httpError("只能使用自己的聯絡人", 403);
    return {
      contact_name: stripUnsafePlain(row.contact_name, SELF_CONTACT_MAX),
      phone: digitsPhone(row.phone),
      line_url: row.line_url || "",
    };
  }
  const contactName = stripUnsafePlain(
    input.contact_name != null ? input.contact_name : fallback.contact_name,
    SELF_CONTACT_MAX,
  );
  const phone = digitsPhone(input.phone != null ? input.phone : fallback.phone);
  if (phone && phone.replace(/\D/g, "").length < 8) throw httpError("電話號碼太短");
  let lineUrl = "";
  const rawLine = input.line_url != null ? input.line_url : fallback.line_url;
  if (rawLine) lineUrl = normalizeLineUrl(rawLine);
  return { contact_name: contactName, phone, line_url: lineUrl };
}

function normalizeWishInput(db, userId, input = {}, fallback = {}) {
  const districts = normalizeWatchDistricts(input.districts ?? parseJsonArray(fallback.districts)).slice(0, 12);
  const city = stripUnsafePlain(input.city != null ? input.city : fallback.city, 40) || cityFromDistricts(districts);
  const locationNote = stripUnsafePlain(
    input.location_note != null ? input.location_note : fallback.location_note,
    WISH_LOCATION_NOTE_MAX,
  );
  const { rent_min, rent_max } = rentPair(
    input.rent_min != null ? input.rent_min : fallback.rent_min,
    input.rent_max != null ? input.rent_max : fallback.rent_max,
  );
  const includesManagement = input.includes_management != null
    ? (input.includes_management === true || input.includes_management === 1 ? 1 : 0)
    : (Number(fallback.includes_management) === 1 ? 1 : 0);
  const housing = housingTypeId(input.housing_type ?? fallback.housing_type);
  const pingMin = Math.max(0, Math.min(Number(input.ping_min != null ? input.ping_min : fallback.ping_min) || 0, 200));
  const layout = layoutId(input.layout ?? fallback.layout);
  const moveIn = moveInDate(input.move_in_date != null ? input.move_in_date : fallback.move_in_date);
  const lease = leaseId(input.lease_duration ?? fallback.lease_duration);
  const transit = stripUnsafePlain(input.transit_note != null ? input.transit_note : fallback.transit_note, WISH_TRANSIT_MAX);
  const destination = stripUnsafePlain(
    input.destination_note != null ? input.destination_note : fallback.destination_note,
    WISH_TRANSIT_MAX,
  );
  const commute = Math.max(0, Math.min(Math.round(Number(input.commute_minutes != null ? input.commute_minutes : fallback.commute_minutes) || 0), 180));
  const groups = splitPriorityGroups(
    input.must_have ?? fallback.must_have,
    input.nice_to_have ?? fallback.nice_to_have,
    input.avoid ?? fallback.avoid,
  );
  const mrtWalk = input.mrt_walk != null
    ? (input.mrt_walk === true || input.mrt_walk === 1 ? 1 : 0)
    : (Number(fallback.mrt_walk) === 1 ? 1 : 0);
  const body = stripUnsafePlain(input.body != null ? input.body : fallback.body, DEMAND_BODY_MAX);
  const contact = snapshotContact(db, userId, input, fallback);
  return {
    city,
    districts,
    location_note: locationNote,
    rent_min,
    rent_max,
    includes_management: includesManagement,
    housing_type: housing,
    ping_min: pingMin,
    layout,
    move_in_date: moveIn,
    lease_duration: lease,
    transit_note: transit,
    destination_note: destination,
    commute_minutes: commute,
    mrt_walk: mrtWalk,
    ...groups,
    body,
    ...contact,
  };
}

function assertPublishable(fields) {
  if (!fields.districts.length) throw httpError("請至少選一個行政區");
  if (fields.body.length < 4) throw httpError("請寫一點找房條件（至少 4 個字）");
}

function recencyStamp(row) {
  return row.updated_at || row.published_at || row.created_at || "";
}

function decoratePost(db, row, { viewerId = 0, includeHiddenReplies = false, owner = false } = {}) {
  const districts = normalizeWatchDistricts(parseJsonArray(row.districts));
  const groups = splitPriorityGroups(parseJsonArray(row.must_have), parseJsonArray(row.nice_to_have), parseJsonArray(row.avoid));
  const replies = db.prepare(
    `SELECT r.id, r.user_id, r.body, r.created_at, r.hidden
     FROM demand_replies r
     WHERE r.post_id = ?
     ORDER BY r.id ASC`,
  ).all(row.id);
  const visible = replies.filter((item) => !item.hidden || includeHiddenReplies || Number(item.user_id) === viewerId);
  const mine = Number(row.user_id) === Number(viewerId);
  const publicContact = {
    contact_name: String(row.contact_name || ""),
    phone: String(row.phone || ""),
    line_url: String(row.line_url || ""),
  };
  const hasContact = Boolean(publicContact.contact_name || publicContact.phone || publicContact.line_url);
  const out = {
    id: Number(row.id),
    product: WISH_PRODUCT_NAME,
    author: userAuthorName(db, row.user_id),
    mine,
    city: String(row.city || "") || cityFromDistricts(districts),
    districts,
    district_labels: districtLabels(districts),
    location_note: String(row.location_note || ""),
    rent_min: Number(row.rent_min) || 0,
    rent_max: Number(row.rent_max) || 0,
    includes_management: Number(row.includes_management) === 1,
    housing_type: housingTypeId(row.housing_type),
    housing_label: housingTypeLabel(row.housing_type),
    ping_min: Number(row.ping_min) || 0,
    layout: layoutId(row.layout),
    layout_label: layoutLabel(row.layout),
    move_in_date: String(row.move_in_date || ""),
    lease_duration: leaseId(row.lease_duration),
    lease_label: leaseLabel(row.lease_duration),
    transit_note: String(row.transit_note || ""),
    destination_note: String(row.destination_note || ""),
    commute_minutes: Number(row.commute_minutes) || 0,
    mrt_walk: Number(row.mrt_walk) === 1,
    must_have: groups.must_have,
    must_have_labels: conditionLabels(groups.must_have),
    nice_to_have: groups.nice_to_have,
    nice_to_have_labels: conditionLabels(groups.nice_to_have),
    avoid: groups.avoid,
    avoid_labels: conditionLabels(groups.avoid),
    body: String(row.body || ""),
    status: String(row.status || "open"),
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
    published_at: row.published_at || (row.status === "open" ? row.created_at : null),
    expires_at: row.expires_at,
    closed_at: row.closed_at || null,
    public_path: `/w/${row.id}`,
    contact: hasContact ? publicContact : null,
    replies: visible.map((item) => ({
      id: Number(item.id),
      author: userAuthorName(db, item.user_id),
      mine: Number(item.user_id) === Number(viewerId),
      body: String(item.body || ""),
      created_at: item.created_at,
      hidden: Number(item.hidden) === 1,
    })),
  };
  if (mine || owner) {
    out.lifecycle = row.status === "open" ? "active" : row.status;
  }
  return out;
}

export function publicWishRoomView(post) {
  if (!post) return null;
  return {
    id: post.id,
    product: WISH_PRODUCT_NAME,
    author: post.author,
    city: post.city,
    districts: post.districts,
    district_labels: post.district_labels,
    location_note: post.location_note,
    rent_min: post.rent_min,
    rent_max: post.rent_max,
    includes_management: post.includes_management,
    housing_type: post.housing_type,
    housing_label: post.housing_label,
    ping_min: post.ping_min,
    layout: post.layout,
    layout_label: post.layout_label,
    move_in_date: post.move_in_date,
    lease_duration: post.lease_duration,
    lease_label: post.lease_label,
    transit_note: post.transit_note,
    destination_note: post.destination_note,
    commute_minutes: post.commute_minutes,
    mrt_walk: post.mrt_walk,
    must_have: post.must_have,
    must_have_labels: post.must_have_labels,
    nice_to_have: post.nice_to_have,
    nice_to_have_labels: post.nice_to_have_labels,
    avoid: post.avoid,
    avoid_labels: post.avoid_labels,
    body: post.body,
    status: post.status,
    created_at: post.created_at,
    updated_at: post.updated_at,
    published_at: post.published_at,
    contact: post.contact,
    public_path: post.public_path,
    replies: (post.replies || []).map((item) => ({
      id: item.id,
      author: item.author,
      body: item.body,
      created_at: item.created_at,
    })),
  };
}

function assertPublicFields(view) {
  const banned = ["user_id", "email", "contact_profile_id", "example", "ip", "consent", "admin"];
  for (const key of banned) {
    if (Object.prototype.hasOwnProperty.call(view, key)) {
      throw httpError("公開欄位含有不該出現的資料", 500);
    }
  }
  return view;
}

function rowById(db, postId) {
  return db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(Number(postId) || 0);
}

function matchesFilters(row, filters = {}) {
  const districts = normalizeWatchDistricts(parseJsonArray(row.districts));
  const city = String(row.city || "") || cityFromDistricts(districts);
  if (filters.city) {
    const want = String(filters.city).trim();
    const hit = city === want || districts.some((key) => lookupDistrict(key)?.city === want);
    if (!hit) return false;
  }
  if (filters.district) {
    const key = String(filters.district).trim();
    if (!districts.includes(key)) return false;
  }
  const housing = housingTypeId(filters.housing_type);
  if (housing && housing !== "any" && housingTypeId(row.housing_type) !== housing) return false;
  const fMin = Math.max(0, Math.round(Number(filters.rent_min) || 0));
  const fMax = Math.max(0, Math.round(Number(filters.rent_max) || 0));
  if (fMin || fMax) {
    const wMin = Number(row.rent_min) || 0;
    const wMax = Number(row.rent_max) || 0;
    const wishLow = wMin || 0;
    const wishHigh = wMax || 200000;
    const filterLow = fMin || 0;
    const filterHigh = fMax || 200000;
    if (wishHigh < filterLow || wishLow > filterHigh) return false;
  }
  return true;
}

export function listDemandPosts(db, { viewerId = 0, mine = false, ...filters } = {}) {
  expireOpenPosts(db);
  const rows = mine && viewerId
    ? db.prepare(
      `SELECT * FROM demand_posts
       WHERE user_id = ?
       ORDER BY COALESCE(updated_at, published_at, created_at) DESC, id DESC LIMIT 50`,
    ).all(viewerId)
    : db.prepare(
      `SELECT * FROM demand_posts
       WHERE status = 'open'
       ORDER BY COALESCE(updated_at, published_at, created_at) DESC, id DESC LIMIT 80`,
    ).all();
  const filtered = mine ? rows : rows.filter((row) => matchesFilters(row, filters));
  filtered.sort((a, b) => {
    const ta = recencyStamp(a);
    const tb = recencyStamp(b);
    if (ta !== tb) return tb.localeCompare(ta);
    return Number(b.id) - Number(a.id);
  });
  const decorated = filtered.map((row) => decoratePost(db, row, { viewerId }));
  return mine ? decorated : decorated.map((row) => assertPublicFields(publicWishRoomView({ ...row, mine: false, replies: row.replies })));
}

export function listPublicWishRooms(db, filters = {}) {
  return listDemandPosts(db, { ...filters, mine: false, viewerId: 0 });
}

export function getDemandPost(db, postId, { viewerId = 0, publicOnly = false } = {}) {
  expireOpenPosts(db);
  const row = rowById(db, postId);
  if (!row) throw httpError("找不到這則許願房", 404);
  const mine = Number(row.user_id) === Number(viewerId);
  if (row.status === "hidden" && !mine) throw httpError("這則許願房已隱藏", 404);
  if (row.status === "draft" && !mine) throw httpError("找不到這則許願房", 404);
  if (!mine && row.status !== "open") throw httpError("找不到這則許願房", 404);
  if (publicOnly && row.status !== "open") throw httpError("找不到這則許願房", 404);
  const decorated = decoratePost(db, row, { viewerId });
  if (!mine || publicOnly) return assertPublicFields(publicWishRoomView(decorated));
  return decorated;
}

function insertRow(db, uid, fields, status, now) {
  const created = iso(now);
  const published = status === "open" ? created : null;
  const expires = status === "open" ? WISH_FAR_EXPIRE : created;
  const result = db.prepare(
    `INSERT INTO demand_posts(
      user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, expires_at,
      city, location_note, rent_min, includes_management, ping_min, layout, move_in_date, lease_duration,
      transit_note, destination_note, commute_minutes, must_have, nice_to_have, avoid,
      contact_name, phone, line_url, updated_at, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uid,
    JSON.stringify(fields.districts),
    fields.rent_max,
    fields.housing_type,
    fields.mrt_walk,
    fields.body,
    status,
    created,
    expires,
    fields.city,
    fields.location_note,
    fields.rent_min,
    fields.includes_management,
    fields.ping_min,
    fields.layout,
    fields.move_in_date,
    fields.lease_duration,
    fields.transit_note,
    fields.destination_note,
    fields.commute_minutes,
    JSON.stringify(fields.must_have),
    JSON.stringify(fields.nice_to_have),
    JSON.stringify(fields.avoid),
    fields.contact_name,
    fields.phone,
    fields.line_url,
    created,
    published,
  );
  return Number(result.lastInsertRowid);
}

function writeRow(db, id, fields, extra = {}) {
  db.prepare(
    `UPDATE demand_posts SET
      districts=?, rent_max=?, housing_type=?, mrt_walk=?, body=?,
      city=?, location_note=?, rent_min=?, includes_management=?, ping_min=?, layout=?,
      move_in_date=?, lease_duration=?, transit_note=?, destination_note=?, commute_minutes=?,
      must_have=?, nice_to_have=?, avoid=?, contact_name=?, phone=?, line_url=?,
      updated_at=?, status=COALESCE(?, status), expires_at=COALESCE(?, expires_at),
      published_at=COALESCE(?, published_at), closed_at=COALESCE(?, closed_at)
     WHERE id=?`,
  ).run(
    JSON.stringify(fields.districts),
    fields.rent_max,
    fields.housing_type,
    fields.mrt_walk,
    fields.body,
    fields.city,
    fields.location_note,
    fields.rent_min,
    fields.includes_management,
    fields.ping_min,
    fields.layout,
    fields.move_in_date,
    fields.lease_duration,
    fields.transit_note,
    fields.destination_note,
    fields.commute_minutes,
    JSON.stringify(fields.must_have),
    JSON.stringify(fields.nice_to_have),
    JSON.stringify(fields.avoid),
    fields.contact_name,
    fields.phone,
    fields.line_url,
    extra.updated_at,
    extra.status || null,
    extra.expires_at || null,
    extra.published_at || null,
    extra.closed_at === undefined ? null : extra.closed_at,
    id,
  );
}

export function createDemandPost(db, userId, input = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const asDraft = input.draft === true || input.status === "draft";
  if (!asDraft) assertMatureAccount(db, uid, now, "刊登許願房");
  expireOpenPosts(db, now);
  const fields = normalizeWishInput(db, uid, input);
  if (!asDraft) assertPublishable(fields);
  else if (fields.body && fields.body.length && fields.body.length < 4) throw httpError("請寫一點找房條件（至少 4 個字）");
  return withImmediate(db, () => {
    if (!asDraft && countOpen(db, uid) >= DEMAND_MAX_OPEN) {
      throw httpError("同時只能有一則公開的許願房", 409, "wish_active_limit");
    }
    const id = insertRow(db, uid, fields, asDraft ? "draft" : "open", now);
    return getDemandPost(db, id, { viewerId: uid });
  });
}

export function updateWishRoom(db, userId, postId, input = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const row = rowById(db, postId);
  if (!row) throw httpError("找不到這則許願房", 404);
  if (Number(row.user_id) !== uid) throw httpError("只能修改自己的許願房", 403);
  if (row.status === "hidden") throw httpError("已隱藏的許願房不能再改", 400);
  const fields = normalizeWishInput(db, uid, input, row);
  if (row.status === "open") assertPublishable(fields);
  writeRow(db, row.id, fields, { updated_at: iso(now) });
  return getDemandPost(db, row.id, { viewerId: uid });
}

export function publishWishRoom(db, userId, postId, input = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  assertMatureAccount(db, uid, now, "刊登許願房");
  expireOpenPosts(db, now);
  return withImmediate(db, () => {
    const row = rowById(db, postId);
    if (!row) throw httpError("找不到這則許願房", 404);
    if (Number(row.user_id) !== uid) throw httpError("只能刊登自己的許願房", 403);
    const fields = Object.keys(input || {}).length ? normalizeWishInput(db, uid, input, row) : normalizeWishInput(db, uid, {}, row);
    assertPublishable(fields);
    if (row.status !== "open" && countOpen(db, uid, row.id) >= DEMAND_MAX_OPEN) {
      throw httpError("同時只能有一則公開的許願房", 409, "wish_active_limit");
    }
    const stamp = iso(now);
    writeRow(db, row.id, fields, {
      updated_at: stamp,
      status: "open",
      expires_at: WISH_FAR_EXPIRE,
      published_at: row.published_at || stamp,
      closed_at: null,
    });
    if (!row.published_at) {
      db.prepare("UPDATE demand_posts SET published_at = ? WHERE id = ? AND published_at IS NULL").run(stamp, row.id);
    }
    db.prepare("UPDATE demand_posts SET closed_at = NULL, status = 'open', expires_at = ? WHERE id = ?").run(WISH_FAR_EXPIRE, row.id);
    return getDemandPost(db, row.id, { viewerId: uid });
  });
}

export function closeDemandPost(db, userId, postId, { admin = false } = {}, now = new Date()) {
  const row = rowById(db, postId);
  if (!row) throw httpError("找不到這則許願房", 404);
  if (!admin && Number(row.user_id) !== Number(userId)) throw httpError("只能關閉自己的許願房", 403);
  const stamp = iso(now);
  db.prepare(
    "UPDATE demand_posts SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?",
  ).run(stamp, stamp, row.id);
  return getDemandPost(db, row.id, { viewerId: userId });
}

export function reopenWishRoom(db, userId, postId, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  assertMatureAccount(db, uid, now, "重新公開許願房");
  expireOpenPosts(db, now);
  return withImmediate(db, () => {
    const row = rowById(db, postId);
    if (!row) throw httpError("找不到這則許願房", 404);
    if (Number(row.user_id) !== uid) throw httpError("只能重開自己的許願房", 403);
    if (row.status === "open") return getDemandPost(db, row.id, { viewerId: uid });
    if (row.status === "hidden") throw httpError("已隱藏的許願房不能重開", 400);
    if (row.status === "draft") throw httpError("草稿請改用刊登", 400);
    if (countOpen(db, uid, row.id) >= DEMAND_MAX_OPEN) {
      throw httpError("同時只能有一則公開的許願房", 409, "wish_active_limit");
    }
    const fields = normalizeWishInput(db, uid, {}, row);
    assertPublishable(fields);
    const stamp = iso(now);
    writeRow(db, row.id, fields, {
      updated_at: stamp,
      status: "open",
      expires_at: WISH_FAR_EXPIRE,
      published_at: row.published_at || stamp,
      closed_at: null,
    });
    db.prepare("UPDATE demand_posts SET closed_at = NULL, status = 'open' WHERE id = ?").run(row.id);
    return getDemandPost(db, row.id, { viewerId: uid });
  });
}

function examplePayload(fields) {
  return {
    city: fields.city || "",
    districts: fields.districts,
    location_note: fields.location_note,
    rent_min: fields.rent_min,
    rent_max: fields.rent_max,
    includes_management: fields.includes_management === 1,
    housing_type: fields.housing_type,
    ping_min: fields.ping_min,
    layout: fields.layout,
    move_in_date: fields.move_in_date,
    lease_duration: fields.lease_duration,
    transit_note: fields.transit_note,
    destination_note: fields.destination_note,
    commute_minutes: fields.commute_minutes,
    mrt_walk: fields.mrt_walk === 1,
    must_have: fields.must_have,
    nice_to_have: fields.nice_to_have,
    avoid: fields.avoid,
    body: fields.body,
    contact_name: fields.contact_name,
    phone: fields.phone,
    line_url: fields.line_url,
  };
}

export function getWishExample(db, userId) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const row = db.prepare("SELECT * FROM wish_room_example WHERE user_id = ?").get(uid);
  if (!row) return null;
  try {
    return { ...JSON.parse(row.payload || "{}"), updated_at: row.updated_at };
  } catch {
    return { updated_at: row.updated_at };
  }
}

export function saveWishExample(db, userId, input = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const fields = normalizeWishInput(db, uid, input);
  const stamp = iso(now);
  const payload = JSON.stringify(examplePayload(fields));
  db.prepare(
    `INSERT INTO wish_room_example(user_id, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).run(uid, payload, stamp, stamp);
  return getWishExample(db, uid);
}

export function deleteWishExample(db, userId) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  db.prepare("DELETE FROM wish_room_example WHERE user_id = ?").run(uid);
  return { deleted: true };
}

export function addDemandReply(db, userId, postId, body, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能回覆", 401);
  assertMatureAccount(db, uid, now, "回覆");
  const post = rowById(db, postId);
  if (!post || post.status !== "open") throw httpError("這則許願房已關閉或過期", 400);
  const text = stripUnsafePlain(body, DEMAND_REPLY_MAX);
  if (text.length < 2) throw httpError("回覆請至少寫 2 個字");
  const last = db.prepare(
    "SELECT created_at FROM demand_replies WHERE user_id = ? ORDER BY id DESC LIMIT 1",
  ).get(uid);
  if (last && nowMs(now) - Date.parse(last.created_at) < DEMAND_REPLY_MIN_GAP_MS) {
    throw httpError("回覆太密集，請稍候再試", 429);
  }
  const hourAgo = new Date(nowMs(now) - 60 * 60 * 1000).toISOString();
  const hourly = db.prepare(
    "SELECT COUNT(*) AS n FROM demand_replies WHERE user_id = ? AND created_at >= ?",
  ).get(uid, hourAgo);
  if (Number(hourly?.n) >= DEMAND_REPLY_MAX_PER_HOUR) {
    throw httpError("這一小時回覆次數已達上限", 429);
  }
  db.prepare(
    "INSERT INTO demand_replies(post_id, user_id, body, created_at, hidden) VALUES (?, ?, ?, ?, 0)",
  ).run(post.id, uid, text, iso(now));
  return getDemandPost(db, post.id, { viewerId: uid });
}

export function reportDemand(db, userId, { targetType, targetId, reason } = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能檢舉", 401);
  const kind = targetType === "reply" ? "reply" : "post";
  const id = Number(targetId) || 0;
  if (!id) throw httpError("請指定要檢舉的內容");
  const exists = kind === "reply"
    ? db.prepare("SELECT id FROM demand_replies WHERE id = ?").get(id)
    : db.prepare("SELECT id FROM demand_posts WHERE id = ?").get(id);
  if (!exists) throw httpError("找不到要檢舉的內容", 404);
  const already = db.prepare(
    "SELECT id FROM demand_reports WHERE target_type = ? AND target_id = ? AND user_id = ?",
  ).get(kind, id, uid);
  if (already) return { ok: true, already: true };
  db.prepare(
    "INSERT INTO demand_reports(target_type, target_id, user_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(kind, id, uid, String(reason || "").trim().slice(0, 200), iso(now));
  const count = Number(
    db.prepare("SELECT COUNT(*) AS n FROM demand_reports WHERE target_type = ? AND target_id = ?").get(kind, id)?.n,
  ) || 0;
  if (count >= DEMAND_REPORT_HIDE_AFTER) {
    if (kind === "reply") {
      db.prepare("UPDATE demand_replies SET hidden = 1 WHERE id = ?").run(id);
    } else {
      db.prepare("UPDATE demand_posts SET status = 'hidden', closed_at = COALESCE(closed_at, ?) WHERE id = ?").run(iso(now), id);
    }
  }
  return { ok: true, hidden: count >= DEMAND_REPORT_HIDE_AFTER };
}

export function demandMeta() {
  return {
    product: WISH_PRODUCT_NAME,
    legal: DEMAND_LEGAL,
    rules_type: "wish_room_rules",
    maxOpen: DEMAND_MAX_OPEN,
    ttlDays: DEMAND_TTL_DAYS,
    auto_expire: false,
    housingTypes: DEMAND_HOUSING_TYPES,
    layouts: WISH_LAYOUTS,
    leaseDurations: WISH_LEASE_DURATIONS,
    conditions: activeWishConditions().map((row) => ({ id: row.id, label: row.label })),
    bodyMax: DEMAND_BODY_MAX,
    forbidden_fields: ["適合對象", ...WISH_FORBIDDEN_CONDITION_IDS],
  };
}

export function wishRoomOwnerSummary(db, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return { active: null, draft: null, closed: [], has_example: false };
  expireOpenPosts(db);
  const rows = db.prepare(
    "SELECT * FROM demand_posts WHERE user_id = ? ORDER BY id DESC",
  ).all(uid);
  const active = rows.find((row) => row.status === "open") || null;
  const draft = rows.find((row) => row.status === "draft") || null;
  return {
    active: active ? decoratePost(db, active, { viewerId: uid }) : null,
    draft: draft ? decoratePost(db, draft, { viewerId: uid }) : null,
    has_example: Boolean(db.prepare("SELECT user_id FROM wish_room_example WHERE user_id = ?").get(uid)),
    can_create: !active,
  };
}
