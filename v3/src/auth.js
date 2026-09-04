import { timingSafeEqual, createHmac, randomBytes } from "node:crypto";
import {
  findUserByEmail,
  publicUser,
  setUserPassword,
  verifyUserPassword,
} from "./db.js";
import { normalizeEmail } from "./password.js";
import { assertNotLocked, clearAuthFailures, recordAuthFailure } from "./rateLimit.js";
import { isEmailVerified } from "./emailVerify.js";

const COOKIE = "591_session";
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function adminEmail() {
  return String(process.env.AUTH_EMAIL || "").trim().toLowerCase();
}

function adminPassword() {
  return String(process.env.AUTH_PASSWORD || "");
}

export function envAdminConfigured() {
  return Boolean(adminEmail() && adminPassword());
}

export function authConfigured() {
  return envAdminConfigured() || Boolean(findUserByEmail(adminEmail()) || findUserByEmail("admin@local"));
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

function sign(payload) {
  return createHmac("sha256", process.env.SESSION_SECRET || "missing").update(payload).digest("base64url");
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
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

export function readSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || !token.includes(".")) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac || !safeEqual(sign(payload), mac)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data?.exp || Date.now() > Number(data.exp)) return null;
    const user = findUserByEmail(data.e);
    if (!user || String(user.deleted_at || "").trim()) return null;
    return { email: user.email, userId: Number(user.id), role: user.role || "member", plan: user.plan || "free" };
  } catch {
    return null;
  }
}

function cookieHeader(req, token, clear = false, { secure } = {}) {
  const parts = [
    `${COOKIE}=${clear ? "" : token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    clear ? "Max-Age=0" : `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (clear) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  const proto = String(req.get?.("x-forwarded-proto") || "").split(",")[0].trim();
  const useSecure = secure ?? (proto === "https" || req.secure === true);
  if (useSecure) parts.push("Secure");
  return parts.join("; ");
}

export function sessionCookie(req, email) {
  const payload = Buffer.from(
    JSON.stringify({
      e: normalizeEmail(email),
      exp: Date.now() + MAX_AGE_MS,
      n: randomBytes(8).toString("hex"),
    }),
  ).toString("base64url");
  return cookieHeader(req, `${payload}.${sign(payload)}`);
}

export function clearSessionCookie(req) {
  return [
    cookieHeader(req, "", true),
    cookieHeader(req, "", true, { secure: true }),
    cookieHeader(req, "", true, { secure: false }),
  ];
}

export function verifyLogin(email, password, { keys, now } = {}) {
  if (keys?.length) assertNotLocked(keys, now);
  const key = normalizeEmail(email);
  const pass = String(password || "");
  const hashed = verifyUserPassword(key, pass);
  if (hashed) {
    if (!isEmailVerified(hashed)) {
      const err = new Error("請先到信箱點確認連結才能登入");
      err.status = 403;
      throw err;
    }
    if (keys?.length) clearAuthFailures(keys);
    return publicUser(hashed);
  }
  if (envAdminConfigured() && safeEqual(key, adminEmail()) && safeEqual(pass.trim(), adminPassword().trim())) {
    const user = findUserByEmail(key);
    if (user && !String(user.password_hash || "").trim()) {
      try {
        setUserPassword(user.id, pass);
      } catch {
        // env 密碼短於 8 碼時略過寫入，下次仍可用 AUTH_PASSWORD
      }
    }
    if (keys?.length) clearAuthFailures(keys);
    return publicUser(user) || { id: 0, email: adminEmail(), role: "admin", plan: "free" };
  }
  if (keys?.length) recordAuthFailure(keys, now);
  const err = new Error("帳號或密碼不正確");
  err.status = 401;
  throw err;
}

export function publicPath(req) {
  const p = req.path || "";
  return (
    p === "/" ||
    p === "/index.html" ||
    p === "/login.html" ||
    p === "/disclaimer.html" ||
    p === "/logout" ||
    p === "/api/login" ||
    p === "/api/register" ||
    p === "/verify-email" ||
    p === "/api/forgot-password" ||
    p === "/api/logout" ||
    p === "/api/me" ||
    p === "/api/health" ||
    p === "/api/demo" ||
    p === "/api/disclaimer" ||
    p === "/api/help-qa" ||
    p === "/api/ads" ||
    p === "/api/brand" ||
    p === "/api/broadcasts" ||
    p === "/api/captcha" ||
    p === "/api/demand" ||
    p === "/api/push/vapid" ||
    p === "/manifest.webmanifest" ||
    p === "/sw.js" ||
    p === "/tokens.css" ||
    p === "/mascot.js" ||
    p === "/cities-embed.js" ||
    p === "/cities.json" ||
    p.startsWith("/api/demand/") ||
    p.startsWith("/vendor/") ||
    p.startsWith("/icons/") ||
    p.startsWith("/brand/") ||
    p.startsWith("/media/self/") ||
    p.startsWith("/media/brand/") ||
    p.startsWith("/go/")
  );
}

export function requireAuth(req, res, next) {
  if (publicPath(req)) return next();
  if (readSession(req)) return next();
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "請先登入", login: true });
    return;
  }
  if (req.accepts("html")) {
    res.redirect("/login.html");
    return;
  }
  res.status(401).json({ error: "請先登入", login: true });
}

export { adminEmail };
