import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

// Owner 授權：重用「既有 admin identity」的憑證（AUTH_EMAIL / AUTH_PASSWORD），
// 不建立第二組 Owner 密碼。session 用 HMAC 簽章 cookie（同 v3 作法），密鑰用 SESSION_SECRET。
// requireOwner 一律在後端驗證，不看前端狀態。

const COOKIE = "ops_session";
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 小時
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    const dummy = Buffer.alloc(left.length);
    timingSafeEqual(left, dummy);
    return false;
  }
  return timingSafeEqual(left, right);
}

function parseCookies(req) {
  const raw = String(req.headers?.cookie || "");
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

// config: { ownerEmail, ownerPassword, sessionSecret, cookieSecure }
export function makeAuth(config = {}) {
  const ownerEmail = normalizeEmail(config.ownerEmail);
  const ownerPassword = String(config.ownerPassword || "");
  const sessionSecret = String(config.sessionSecret || "");
  const configured = Boolean(ownerEmail && ownerPassword && sessionSecret);
  const forceSecure = config.cookieSecure;
  const attempts = new Map(); // key -> { fails, lockUntil }

  function sign(payload) {
    return createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  }

  function attemptKey(req, email) {
    const ip = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "local";
    return `${ip}|${normalizeEmail(email)}`;
  }

  function assertNotLocked(key, now = Date.now()) {
    const rec = attempts.get(key);
    if (rec && rec.lockUntil && now < rec.lockUntil) {
      const err = new Error("登入嘗試過多，請稍後再試");
      err.status = 429;
      throw err;
    }
  }

  function recordFail(key, now = Date.now()) {
    const rec = attempts.get(key) || { fails: 0, lockUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= LOGIN_MAX_FAILS) {
      rec.lockUntil = now + LOGIN_LOCK_MS;
      rec.fails = 0;
    }
    attempts.set(key, rec);
  }

  function clearFails(key) {
    attempts.delete(key);
  }

  function verify(inputEmail, inputPassword) {
    if (!configured) return false;
    const emailOk = safeEqual(normalizeEmail(inputEmail), ownerEmail);
    const passOk = safeEqual(String(inputPassword || ""), ownerPassword);
    return emailOk && passOk;
  }

  function useSecure(req) {
    if (typeof forceSecure === "boolean") return forceSecure;
    const proto = String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
    return proto === "https" || req.socket?.encrypted === true;
  }

  function sessionCookie(req) {
    const payload = Buffer.from(
      JSON.stringify({ e: ownerEmail, exp: Date.now() + MAX_AGE_MS, n: randomBytes(8).toString("hex") }),
    ).toString("base64url");
    const token = `${payload}.${sign(payload)}`;
    const parts = [
      `${COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
    ];
    if (useSecure(req)) parts.push("Secure");
    return parts.join("; ");
  }

  function clearCookie(req) {
    const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    if (useSecure(req)) parts.push("Secure");
    return parts.join("; ");
  }

  function readSession(req) {
    if (!configured) return null;
    const token = parseCookies(req)[COOKIE];
    if (!token || !token.includes(".")) return null;
    const [payload, mac] = token.split(".");
    if (!payload || !mac || !safeEqual(sign(payload), mac)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (!data?.exp || Date.now() > Number(data.exp)) return null;
      if (normalizeEmail(data.e) !== ownerEmail) return null;
      return { email: ownerEmail, role: "owner" };
    } catch {
      return null;
    }
  }

  function requireOwner(req, res, next) {
    const session = readSession(req);
    if (session) {
      req.owner = session;
      return next();
    }
    res.status(401).json({ error: "只有 Owner 可以存取", login: true });
  }

  return {
    configured,
    ownerEmail,
    verify,
    sessionCookie,
    clearCookie,
    readSession,
    requireOwner,
    attemptKey,
    assertNotLocked,
    recordFail,
    clearFails,
  };
}
