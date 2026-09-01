import { timingSafeEqual, createHmac, randomBytes } from "node:crypto";
import {
  findUserByEmail,
  publicUser,
  setUserPassword,
  verifyUserPassword,
} from "./db.js";
import { normalizeEmail } from "./password.js";

const COOKIE = "591_session";
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const fails = { n: 0, until: 0 };

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
    if (!user) return null;
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

function rateLimited() {
  if (Date.now() < fails.until) {
    const wait = Math.ceil((fails.until - Date.now()) / 1000);
    const err = new Error(`嘗試太多次，請 ${wait} 秒後再試`);
    err.status = 429;
    throw err;
  }
}

function bumpFail() {
  fails.n += 1;
  if (fails.n >= 10) {
    fails.until = Date.now() + 2 * 60 * 1000;
    fails.n = 0;
  }
  const err = new Error("帳號或密碼不正確");
  err.status = 401;
  throw err;
}

export function verifyLogin(email, password) {
  rateLimited();
  const key = normalizeEmail(email);
  const pass = String(password || "");
  const hashed = verifyUserPassword(key, pass);
  if (hashed) {
    fails.n = 0;
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
    fails.n = 0;
    return publicUser(user) || { id: 0, email: adminEmail(), role: "admin", plan: "free" };
  }
  bumpFail();
}

export function publicPath(req) {
  const p = req.path || "";
  return (
    p === "/login.html" ||
    p === "/disclaimer.html" ||
    p === "/logout" ||
    p === "/api/login" ||
    p === "/api/register" ||
    p === "/api/logout" ||
    p === "/api/me" ||
    p === "/api/health" ||
    p === "/api/disclaimer" ||
    p.startsWith("/vendor/") ||
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
