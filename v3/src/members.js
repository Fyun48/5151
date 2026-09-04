/** 會員帳號：註冊、密碼、免責聲明。只接受 db 連線。 */
import { hashPassword, normalizeEmail, validateEmail, validatePassword, verifyPassword } from "./password.js";

export const DISCLAIMER_VERSION = "2026-09-01";

export const DISCLAIMER_TEXT = `這是免費的個人租屋追蹤工具，用來幫忙看 591 刊登，不是仲介、不是保證、也不是正式服務。

591 上的價格、是否還在、地址與現況可能延遲、缺漏或與現場不符。請以 591 原頁與實際看屋為準。

使用本系統即表示你了解以上限制。贊助是自願的；有沒有贊助都不改變「這是免費系統」。未來若有贊助方案，只會影響檢查間隔或覆蓋範圍，不會變成付費才能用。`;

export function findUserByEmail(conn, email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  return conn.prepare("SELECT * FROM users WHERE email = ?").get(key) || null;
}

export function getUserById(conn, userId) {
  const id = Number(userId) || 0;
  if (!id) return null;
  return conn.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}

export function isUserDeleted(row) {
  return Boolean(String(row?.deleted_at || "").trim());
}

export function listUsers(conn, { includeDeleted = true, sort = "id", order = "asc", q = "" } = {}) {
  const dir = String(order).toLowerCase() === "desc" ? "DESC" : "ASC";
  const sortKey = String(sort) === "created_at" ? "created_at" : "id";
  const needle = String(q || "").trim().toLowerCase();
  const rows = conn.prepare(
    `SELECT id, email, role, plan, created_at, accepted_disclaimer_at, disclaimer_version,
            signup_count, deleted_at, deleted_by, deleted_reason, deleted_reason_code
     FROM users ORDER BY ${sortKey} ${dir}, id ${dir}`,
  ).all();
  return rows.filter((row) => {
    if (!includeDeleted && isUserDeleted(row)) return false;
    if (!needle) return true;
    return String(row.email || "").toLowerCase().includes(needle);
  });
}

export function setUserPlan(conn, userId, plan) {
  const id = Number(userId) || 0;
  if (!id) return null;
  const next = plan === "sponsor" ? "sponsor" : "free";
  conn.prepare("UPDATE users SET plan = ? WHERE id = ?").run(next, id);
  return publicUser(getUserById(conn, id));
}

export function listUserIds(conn) {
  return conn.prepare(
    "SELECT id FROM users WHERE deleted_at IS NULL OR deleted_at = '' ORDER BY id",
  ).all().map((row) => Number(row.id));
}

export function setUserPassword(conn, userId, password) {
  const id = Number(userId) || 0;
  if (!id) return;
  conn.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(validatePassword(password)), id);
}

export function changeUserPassword(conn, userId, currentPassword, nextPassword) {
  const user = getUserById(conn, userId);
  if (!user) {
    const err = new Error("請先登入");
    err.status = 401;
    throw err;
  }
  if (!verifyPassword(currentPassword, user.password_hash)) {
    const err = new Error("目前密碼不對");
    err.status = 400;
    throw err;
  }
  const next = validatePassword(nextPassword);
  if (next === String(currentPassword || "")) {
    const err = new Error("新密碼不能跟目前密碼一樣");
    err.status = 400;
    throw err;
  }
  setUserPassword(conn, user.id, next);
  return publicUser(user);
}

export function publicUser(row) {
  if (!row) return null;
  const nickname = String(row.nickname || "").trim();
  return {
    id: Number(row.id),
    email: row.email,
    role: row.role || "member",
    plan: row.plan || "free",
    deleted: isUserDeleted(row),
    nickname,
    avatar_url: String(row.avatar_url || "").trim(),
    display_name: nickname || String(row.email || ""),
  };
}

export function registerUser(conn, { email, password, acceptDisclaimer, emailVerified = true } = {}) {
  if (!acceptDisclaimer) {
    const err = new Error("請先閱讀並同意免責聲明");
    err.status = 400;
    throw err;
  }
  const key = validateEmail(email);
  if (!key) {
    const err = new Error("請輸入有效的 Email");
    err.status = 400;
    throw err;
  }
  const pass = validatePassword(password);
  const existing = findUserByEmail(conn, key);
  const now = new Date().toISOString();
  const verifiedFlag = emailVerified === false ? 0 : 1;
  if (existing) {
    if (!isUserDeleted(existing) && Number(existing.email_verified) === 0 && emailVerified === false) {
      conn.prepare(
        `UPDATE users
         SET password_hash = ?, accepted_disclaimer_at = ?, disclaimer_version = ?
         WHERE id = ?`,
      ).run(hashPassword(pass), now, DISCLAIMER_VERSION, existing.id);
      return getUserById(conn, existing.id);
    }
    if (!isUserDeleted(existing)) {
      const err = new Error("這個 Email 已經註冊過了");
      err.status = 409;
      throw err;
    }
    const signups = Number(existing.signup_count) || 1;
    if (signups >= 2) {
      const err = new Error("這個 Email 已刪除兩次，不能再註冊");
      err.status = 409;
      throw err;
    }
    conn.prepare(
      `UPDATE users
       SET password_hash = ?, plan = 'free', accepted_disclaimer_at = ?, disclaimer_version = ?,
           signup_count = ?, deleted_at = NULL, deleted_by = '', deleted_reason = '', deleted_reason_code = '',
           email_verified = ?
       WHERE id = ?`,
    ).run(hashPassword(pass), now, DISCLAIMER_VERSION, signups + 1, verifiedFlag, existing.id);
    return getUserById(conn, existing.id);
  }
  const result = conn.prepare(
    `INSERT INTO users(email, password_hash, role, plan, created_at, accepted_disclaimer_at, disclaimer_version, signup_count, email_verified)
     VALUES (?, ?, 'member', 'free', ?, ?, ?, 1, ?)`,
  ).run(key, hashPassword(pass), now, now, DISCLAIMER_VERSION, verifiedFlag);
  return getUserById(conn, Number(result.lastInsertRowid));
}

export const ADMIN_DELETE_REASONS = [
  {
    id: "multi_ip",
    label: "不當使用：同時間多個不同 IP 使用",
    text: "因偵測到同時間從多個不同 IP 使用帳號等不當使用，管理員已關閉此會員。",
  },
  {
    id: "abuse",
    label: "異常行為多次",
    text: "因多次異常行為，管理員已關閉此會員。",
  },
  {
    id: "tos",
    label: "違反使用規範",
    text: "因違反使用規範，管理員已關閉此會員。",
  },
  {
    id: "custom",
    label: "自訂內容",
    text: "",
  },
];

export function resolveDeleteReason(code, customText = "") {
  const id = String(code || "").trim() || "custom";
  const preset = ADMIN_DELETE_REASONS.find((row) => row.id === id) || ADMIN_DELETE_REASONS.find((row) => row.id === "custom");
  const custom = String(customText || "").trim();
  if (preset.id === "custom") {
    return { code: "custom", label: preset.label, text: custom };
  }
  return { code: preset.id, label: preset.label, text: custom || preset.text };
}

export function deleteUser(conn, userId, { by = "self", reason = "", reasonCode = "" } = {}) {
  const user = getUserById(conn, userId);
  if (!user) {
    const err = new Error("找不到這位會員");
    err.status = 404;
    throw err;
  }
  if (user.role === "admin") {
    const err = new Error("不能刪除管理員帳號");
    err.status = 400;
    throw err;
  }
  if (isUserDeleted(user)) {
    const err = new Error("這位會員已經刪除");
    err.status = 400;
    throw err;
  }
  const now = new Date().toISOString();
  const who = by === "admin" ? "admin" : "self";
  conn.prepare(
    `UPDATE users
     SET deleted_at = ?, deleted_by = ?, deleted_reason = ?, deleted_reason_code = ?
     WHERE id = ?`,
  ).run(now, who, String(reason || "").slice(0, 2000), String(reasonCode || "").slice(0, 40), user.id);
  return getUserById(conn, user.id);
}

export function restoreUser(conn, userId) {
  const user = getUserById(conn, userId);
  if (!user) {
    const err = new Error("找不到這位會員");
    err.status = 404;
    throw err;
  }
  if (!isUserDeleted(user)) {
    const err = new Error("這位會員尚未刪除");
    err.status = 400;
    throw err;
  }
  conn.prepare(
    "UPDATE users SET deleted_at = NULL, deleted_by = '', deleted_reason = '', deleted_reason_code = '' WHERE id = ?",
  ).run(user.id);
  return getUserById(conn, user.id);
}

export function verifyUserPassword(conn, email, password) {
  const user = findUserByEmail(conn, email);
  if (!user || isUserDeleted(user)) return null;
  if (user.password_hash && verifyPassword(password, user.password_hash)) return user;
  return null;
}

export function acceptDisclaimer(conn, userId) {
  const id = Number(userId) || 0;
  if (!id) return;
  const now = new Date().toISOString();
  conn.prepare(
    "UPDATE users SET accepted_disclaimer_at = ?, disclaimer_version = ? WHERE id = ?",
  ).run(now, DISCLAIMER_VERSION, id);
}

export function bootstrapAdminUser(conn, email, password, { ensureUser } = {}) {
  const key = normalizeEmail(email);
  if (!key) return 0;
  let user = findUserByEmail(conn, key);
  if (!user && typeof ensureUser === "function") {
    ensureUser(conn, key, { role: "admin" });
    user = findUserByEmail(conn, key);
  }
  if (!user) return 0;
  if (user.role !== "admin") {
    conn.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  }
  if (password && !String(user.password_hash || "").trim()) {
    conn.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), user.id);
  }
  try {
    conn.prepare("UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = ?").run(user.id);
  } catch {
    // 舊庫還沒加欄位時略過
  }
  if (!user.accepted_disclaimer_at) {
    acceptDisclaimer(conn, user.id);
  }
  return Number(user.id);
}
