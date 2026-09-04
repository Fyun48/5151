/** 註冊信箱確認：點連結才算成功；連結用過即失效，未點擊 3 天後失效並補通知。 */
import { randomBytes } from "node:crypto";
import { findUserByEmail } from "./members.js";

export const VERIFY_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export function isEmailVerified(user) {
  if (!user) return false;
  if (String(user.role || "") === "admin") return true;
  if (user.email_verified == null) return true;
  return Number(user.email_verified) !== 0;
}

export function issueVerifyToken(conn, userId, { now = Date.now() } = {}) {
  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(now + VERIFY_TTL_MS).toISOString();
  conn.prepare(
    `UPDATE users
     SET email_verified = 0, verify_token = ?, verify_expires_at = ?, verify_expire_notified = 0, verify_used_at = NULL
     WHERE id = ?`,
  ).run(token, expiresAt, Number(userId) || 0);
  return { token, expiresAt };
}

export function confirmVerifyToken(conn, token, { now = Date.now() } = {}) {
  const key = String(token || "").trim();
  if (!key) {
    const err = new Error("找不到這個開通連結");
    err.status = 404;
    err.code = "missing";
    throw err;
  }
  const row = conn.prepare("SELECT * FROM users WHERE verify_token = ?").get(key);
  if (!row) {
    const err = new Error("找不到這個開通連結");
    err.status = 404;
    err.code = "missing";
    throw err;
  }
  if (String(row.verify_used_at || "").trim() || Number(row.email_verified) === 1) {
    const err = new Error("這個開通連結已經使用過");
    err.status = 409;
    err.code = "used";
    throw err;
  }
  const exp = Date.parse(String(row.verify_expires_at || ""));
  if (Number.isFinite(exp) && exp <= now) {
    const err = new Error("確認連結已失效，請重新註冊或等系統補寄說明信");
    err.status = 410;
    err.code = "expired";
    throw err;
  }
  const usedAt = new Date(now).toISOString();
  conn.prepare(
    "UPDATE users SET email_verified = 1, verify_used_at = ?, verify_expires_at = NULL, verify_expire_notified = 0 WHERE id = ?",
  ).run(usedAt, row.id);
  return findUserByEmail(conn, row.email) || row;
}

export function expireStaleVerifyTokens(conn, { now = Date.now(), onExpire } = {}) {
  const iso = new Date(now).toISOString();
  const stale = conn.prepare(
    `SELECT * FROM users
     WHERE IFNULL(email_verified, 1) = 0
       AND IFNULL(verify_token, '') != ''
       AND verify_expires_at IS NOT NULL
       AND verify_expires_at <= ?
       AND IFNULL(verify_expire_notified, 0) = 0`,
  ).all(iso);
  let n = 0;
  for (const user of stale) {
    conn.prepare(
      "UPDATE users SET verify_token = NULL, verify_expire_notified = 1 WHERE id = ?",
    ).run(user.id);
    if (typeof onExpire === "function") onExpire(user);
    n += 1;
  }
  return n;
}
