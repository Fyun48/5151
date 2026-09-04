/** 會員暱稱與頭像：系統與需求牆用這個名字稱呼，沒填才退回信箱。 */

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 20;

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
  ]) {
    try {
      db.exec(sql);
    } catch {
      // already migrated
    }
  }
}

export function publicProfile(row) {
  if (!row) return null;
  const nickname = String(row.nickname || "").trim();
  return {
    nickname,
    avatar_url: String(row.avatar_url || "").trim(),
    display_name: displayName(row),
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
    const next = String(input.avatar_url || "").trim();
    if (next && !/^\/media\/self\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(next)) {
      const err = new Error("頭像請用本站上傳的照片");
      err.status = 400;
      throw err;
    }
    avatar = next;
  }
  conn.prepare("UPDATE users SET nickname = ?, avatar_url = ? WHERE id = ?").run(nickname, avatar, uid);
  return conn.prepare("SELECT * FROM users WHERE id = ?").get(uid);
}
