import { lookupDistrict, normalizeWatchDistricts } from "./regions.js";

export const DEMAND_MAX_OPEN = 2;
export const DEMAND_TTL_DAYS = 14;
export const DEMAND_NEW_ACCOUNT_WAIT_MS = 24 * 60 * 60 * 1000;
export const DEMAND_REPLY_MIN_GAP_MS = 20 * 1000;
export const DEMAND_REPLY_MAX_PER_HOUR = 12;
export const DEMAND_BODY_MAX = 280;
export const DEMAND_REPLY_MAX = 200;
export const DEMAND_REPORT_HIDE_AFTER = 2;

export const DEMAND_HOUSING_TYPES = [
  { id: "any", label: "不限" },
  { id: "elevator", label: "電梯大樓" },
  { id: "apartment", label: "公寓" },
  { id: "suite", label: "套房" },
  { id: "whole", label: "整層住家" },
];

export const DEMAND_LEGAL = "這是免費找房工具，不是仲介、不保證媒合、不經手金錢。需求牆是公開留言板，沒有即時私訊。內容由使用者自行負責；平台可隱藏或移除不當貼文。";

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
  `);
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

function parseJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function housingTypeId(value) {
  const id = String(value || "any").trim();
  return DEMAND_HOUSING_TYPES.some((row) => row.id === id) ? id : "any";
}

function housingTypeLabel(id) {
  return DEMAND_HOUSING_TYPES.find((row) => row.id === id)?.label || "不限";
}

function districtLabels(keys) {
  return keys.map((key) => lookupDistrict(key)?.name || key).filter(Boolean);
}

function maskEmail(email) {
  const raw = String(email || "").trim();
  const at = raw.indexOf("@");
  if (at < 1) return "會員";
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

export function expireOpenPosts(db, now = new Date()) {
  const stamp = iso(now);
  const result = db.prepare(
    `UPDATE demand_posts SET status = 'expired', closed_at = COALESCE(closed_at, ?)
     WHERE status = 'open' AND expires_at <= ?`,
  ).run(stamp, stamp);
  return Number(result.changes) || 0;
}

function userEmail(db, userId) {
  try {
    return String(db.prepare("SELECT email FROM users WHERE id = ?").get(userId)?.email || "");
  } catch {
    return "";
  }
}

function userAuthorName(db, userId, email) {
  try {
    const row = db.prepare("SELECT nickname, email FROM users WHERE id = ?").get(userId);
    const nick = String(row?.nickname || "").trim();
    if (nick) return nick;
    return maskEmail(email || row?.email);
  } catch {
    return maskEmail(email);
  }
}

function userCreatedAt(db, userId) {
  try {
    return String(db.prepare("SELECT created_at FROM users WHERE id = ?").get(userId)?.created_at || "");
  } catch {
    return "";
  }
}

function assertCanPost(db, userId, now = new Date()) {
  const created = Date.parse(userCreatedAt(db, userId));
  if (Number.isFinite(created) && nowMs(now) - created < DEMAND_NEW_ACCOUNT_WAIT_MS) {
    throw httpError("新帳號註冊滿 24 小時後才能發需求，避免洗版", 403);
  }
  expireOpenPosts(db, now);
  const open = db.prepare(
    "SELECT COUNT(*) AS n FROM demand_posts WHERE user_id = ? AND status = 'open'",
  ).get(userId);
  if (Number(open?.n) >= DEMAND_MAX_OPEN) {
    throw httpError(`同時最多 ${DEMAND_MAX_OPEN} 則未過期的需求，請先關閉一則`, 403);
  }
}

function decoratePost(db, row, { viewerId = 0, includeHiddenReplies = false } = {}) {
  const districts = normalizeWatchDistricts(parseJsonArray(row.districts));
  const replies = db.prepare(
    `SELECT r.id, r.user_id, r.body, r.created_at, r.hidden, u.email
     FROM demand_replies r
     LEFT JOIN users u ON u.id = r.user_id
     WHERE r.post_id = ?
     ORDER BY r.id ASC`,
  ).all(row.id);
  const visible = replies.filter((item) => !item.hidden || includeHiddenReplies || Number(item.user_id) === viewerId);
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    author: userAuthorName(db, row.user_id, row.email || userEmail(db, row.user_id)),
    mine: Number(row.user_id) === Number(viewerId),
    districts,
    district_labels: districtLabels(districts),
    rent_max: Number(row.rent_max) || 0,
    housing_type: housingTypeId(row.housing_type),
    housing_label: housingTypeLabel(row.housing_type),
    mrt_walk: Number(row.mrt_walk) === 1,
    body: String(row.body || ""),
    status: String(row.status || "open"),
    created_at: row.created_at,
    expires_at: row.expires_at,
    closed_at: row.closed_at || null,
    replies: visible.map((item) => ({
      id: Number(item.id),
      author: userAuthorName(db, item.user_id, item.email),
      mine: Number(item.user_id) === Number(viewerId),
      body: String(item.body || ""),
      created_at: item.created_at,
      hidden: Number(item.hidden) === 1,
    })),
  };
}

export function listDemandPosts(db, { viewerId = 0, mine = false } = {}) {
  expireOpenPosts(db);
  const rows = mine && viewerId
    ? db.prepare(
      `SELECT p.*, u.email FROM demand_posts p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.user_id = ?
       ORDER BY p.id DESC LIMIT 50`,
    ).all(viewerId)
    : db.prepare(
      `SELECT p.*, u.email FROM demand_posts p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.status = 'open'
       ORDER BY p.id DESC LIMIT 80`,
    ).all();
  return rows.map((row) => decoratePost(db, row, { viewerId }));
}

export function getDemandPost(db, postId, { viewerId = 0 } = {}) {
  expireOpenPosts(db);
  const row = db.prepare(
    `SELECT p.*, u.email FROM demand_posts p
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.id = ?`,
  ).get(Number(postId) || 0);
  if (!row) throw httpError("找不到這則需求", 404);
  if (row.status === "hidden" && Number(row.user_id) !== Number(viewerId)) {
    throw httpError("這則需求已隱藏", 404);
  }
  return decoratePost(db, row, { viewerId });
}

export function createDemandPost(db, userId, input = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  assertCanPost(db, uid, now);
  const districts = normalizeWatchDistricts(input.districts).slice(0, 10);
  if (!districts.length) throw httpError("請至少選一個行政區");
  const rentMax = Math.max(0, Math.min(Math.round(Number(input.rent_max) || 0), 200000));
  const body = String(input.body || "").trim().slice(0, DEMAND_BODY_MAX);
  if (body.length < 4) throw httpError("請寫一點找房條件（至少 4 個字）");
  const created = iso(now);
  const expires = new Date(nowMs(now) + DEMAND_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(
    `INSERT INTO demand_posts(user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(
    uid,
    JSON.stringify(districts),
    rentMax,
    housingTypeId(input.housing_type),
    input.mrt_walk === true || input.mrt_walk === 1 ? 1 : 0,
    body,
    created,
    expires,
  );
  return getDemandPost(db, Number(result.lastInsertRowid), { viewerId: uid });
}

export function closeDemandPost(db, userId, postId, { admin = false } = {}, now = new Date()) {
  const row = db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(Number(postId) || 0);
  if (!row) throw httpError("找不到這則需求", 404);
  if (!admin && Number(row.user_id) !== Number(userId)) throw httpError("只能關閉自己的需求", 403);
  db.prepare(
    "UPDATE demand_posts SET status = 'closed', closed_at = ? WHERE id = ?",
  ).run(iso(now), row.id);
  return getDemandPost(db, row.id, { viewerId: userId });
}

export function addDemandReply(db, userId, postId, body, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能回覆", 401);
  const created = Date.parse(userCreatedAt(db, uid));
  if (Number.isFinite(created) && nowMs(now) - created < DEMAND_NEW_ACCOUNT_WAIT_MS) {
    throw httpError("新帳號註冊滿 24 小時後才能回覆", 403);
  }
  const post = db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(Number(postId) || 0);
  if (!post || post.status !== "open") throw httpError("這則需求已關閉或過期", 400);
  const text = String(body || "").trim().slice(0, DEMAND_REPLY_MAX);
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
    legal: DEMAND_LEGAL,
    maxOpen: DEMAND_MAX_OPEN,
    ttlDays: DEMAND_TTL_DAYS,
    housingTypes: DEMAND_HOUSING_TYPES,
  };
}
