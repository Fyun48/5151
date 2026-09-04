/** 會員暱稱、頭像與選填聯絡資料。聯絡欄預設不公開。 */

import { validateEmail } from "./password.js";
import { DEFAULT_PRIVACY_TEXT } from "./legalCopy.js";

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 20;

export const PROFILE_PRIVACY = DEFAULT_PRIVACY_TEXT;

export function normalizeNickname(value, { required = false } = {}) {
  const raw = String(value || "").trim().replace(/\s+/g, " ");
  if (!raw) {
    if (required) {
      const err = new Error("請填暱稱");
      err.status = 400;
      throw err;
    }
    return "";
  }
  if (raw.length < NICKNAME_MIN || raw.length > NICKNAME_MAX) {
    const err = new Error(`暱稱請在 ${NICKNAME_MIN}～${NICKNAME_MAX} 個字`);
    err.status = 400;
    throw err;
  }
  if (/@/.test(raw) || /https?:\/\//i.test(raw)) {
    const err = new Error("暱稱請不要填信箱或網址");
    err.status = 400;
    throw err;
  }
  return raw;
}

export function displayName(user) {
  const nick = String(user?.nickname || "").trim();
  if (nick) return nick;
  return String(user?.email || "").trim();
}

export function publicAuthorLabel(user, { maskEmail } = {}) {
  const nick = String(user?.nickname || "").trim();
  if (nick) return nick;
  const email = String(user?.email || "").trim();
  if (typeof maskEmail === "function") return maskEmail(email);
  return email;
}

export function ensureProfileSchema(db) {
  for (const sql of [
    "ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN self_ban_until TEXT",
    "ALTER TABLE users ADD COLUMN home_address TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN company_address TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN contact_phone TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN line_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN line_qr_url TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN contact_email TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN profile_privacy_at TEXT",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // already migrated
    }
  }
}

function cleanLine(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function mediaUrl(value, label) {
  const next = String(value || "").trim();
  if (!next) return "";
  if (/^\/media\/self\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(next)) return next;
  const err = new Error(`${label}請用本站上傳的照片`);
  err.status = 400;
  throw err;
}

export function publicProfile(row) {
  if (!row) return null;
  const nickname = String(row.nickname || "").trim();
  return {
    nickname,
    avatar_url: String(row.avatar_url || "").trim(),
    display_name: displayName(row),
    home_address: String(row.home_address || "").trim(),
    company_address: String(row.company_address || "").trim(),
    contact_phone: String(row.contact_phone || "").trim(),
    line_id: String(row.line_id || "").trim(),
    line_qr_url: String(row.line_qr_url || "").trim(),
    contact_email: String(row.contact_email || "").trim(),
    privacy_accepted: Boolean(String(row.profile_privacy_at || row.accepted_disclaimer_at || "").trim()),
    privacy_text: PROFILE_PRIVACY,
  };
}

export function updateUserProfile(conn, userId, input = {}) {
  const uid = Number(userId) || 0;
  if (!uid) {
    const err = new Error("請先登入");
    err.status = 401;
    throw err;
  }
  const row = conn.prepare("SELECT * FROM users WHERE id = ?").get(uid);
  if (!row) {
    const err = new Error("找不到這個會員");
    err.status = 404;
    throw err;
  }
  const nickname = Object.prototype.hasOwnProperty.call(input, "nickname")
    ? normalizeNickname(input.nickname)
    : String(row.nickname || "");
  let avatar = String(row.avatar_url || "");
  if (Object.prototype.hasOwnProperty.call(input, "avatar_url")) {
    avatar = mediaUrl(input.avatar_url, "頭像");
  }
  const home = Object.prototype.hasOwnProperty.call(input, "home_address")
    ? cleanLine(input.home_address, 120)
    : String(row.home_address || "");
  const company = Object.prototype.hasOwnProperty.call(input, "company_address")
    ? cleanLine(input.company_address, 120)
    : String(row.company_address || "");
  const phone = Object.prototype.hasOwnProperty.call(input, "contact_phone")
    ? cleanLine(input.contact_phone, 40)
    : String(row.contact_phone || "");
  const lineId = Object.prototype.hasOwnProperty.call(input, "line_id")
    ? cleanLine(input.line_id, 40)
    : String(row.line_id || "");
  let lineQr = String(row.line_qr_url || "");
  if (Object.prototype.hasOwnProperty.call(input, "line_qr_url")) {
    lineQr = mediaUrl(input.line_qr_url, "LINE QR");
  }
  let contactEmail = Object.prototype.hasOwnProperty.call(input, "contact_email")
    ? cleanLine(input.contact_email, 120)
    : String(row.contact_email || "");
  if (contactEmail) {
    const ok = validateEmail(contactEmail);
    if (!ok) {
      const err = new Error("聯絡 Email 格式不對");
      err.status = 400;
      throw err;
    }
    contactEmail = ok;
  }
  const next = {
    ...row,
    nickname,
    avatar_url: avatar,
    home_address: home,
    company_address: company,
    contact_phone: phone,
    line_id: lineId,
    line_qr_url: lineQr,
    contact_email: contactEmail,
  };
  let privacyAt = String(row.profile_privacy_at || row.accepted_disclaimer_at || "").trim();
  if (!privacyAt) privacyAt = String(row.accepted_disclaimer_at || "").trim();
  conn.prepare(`
    UPDATE users SET
      nickname = ?, avatar_url = ?, home_address = ?, company_address = ?,
      contact_phone = ?, line_id = ?, line_qr_url = ?, contact_email = ?, profile_privacy_at = ?
    WHERE id = ?
  `).run(nickname, avatar, home, company, phone, lineId, lineQr, contactEmail, privacyAt || null, uid);
  return conn.prepare("SELECT * FROM users WHERE id = ?").get(uid);
}
