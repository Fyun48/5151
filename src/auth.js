import { timingSafeEqual, createHmac, randomBytes } from "node:crypto";

const COOKIE = "591_session";
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const fails = { n: 0, until: 0 };

function adminEmail() {
  return String(process.env.AUTH_EMAIL || "").trim().toLowerCase();
}

function adminPassword() {
  return String(process.env.AUTH_PASSWORD || "");
}

export function authConfigured() {
  return Boolean(adminEmail() && adminPassword());
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
  if (!authConfigured()) return null;
  const token = parseCookies(req)[COOKIE];
  if (!token || !token.includes(".")) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac || !safeEqual(sign(payload), mac)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data?.exp || Date.now() > Number(data.exp)) return null;
    if (!safeEqual(String(data.e || "").toLowerCase(), adminEmail())) return null;
    return { email: adminEmail() };
  } catch {
    return null;
  }
}

function cookieHeader(req, token, clear = false) {
  const parts = [
    `${COOKIE}=${clear ? "" : token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    clear ? "Max-Age=0" : `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  const proto = String(req.get?.("x-forwarded-proto") || "").split(",")[0].trim();
  if (proto === "https" || req.secure === true) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function sessionCookie(req) {
  const payload = Buffer.from(
    JSON.stringify({ e: adminEmail(), exp: Date.now() + MAX_AGE_MS, n: randomBytes(8).toString("hex") }),
  ).toString("base64url");
  return cookieHeader(req, `${payload}.${sign(payload)}`);
}

export function clearSessionCookie(req) {
  return cookieHeader(req, "", true);
}

export function verifyLogin(email, password) {
  if (!authConfigured()) {
    const err = new Error("尚未設定登入帳號。請在 .env 或 data/auth.env 設定 AUTH_EMAIL 與 AUTH_PASSWORD。");
    err.status = 503;
    throw err;
  }
  if (Date.now() < fails.until) {
    const wait = Math.ceil((fails.until - Date.now()) / 1000);
    const err = new Error(`嘗試太多次，請 ${wait} 秒後再試`);
    err.status = 429;
    throw err;
  }
  const okEmail = safeEqual(String(email || "").trim().toLowerCase(), adminEmail());
  const okPass = safeEqual(String(password || "").trim(), adminPassword().trim());
  if (!okEmail || !okPass) {
    fails.n += 1;
    if (fails.n >= 10) {
      fails.until = Date.now() + 2 * 60 * 1000;
      fails.n = 0;
    }
    const err = new Error("帳號或密碼不正確");
    err.status = 401;
    throw err;
  }
  fails.n = 0;
  return { email: adminEmail() };
}

export function publicPath(req) {
  const p = req.path || "";
  return p === "/login.html" || p === "/api/login" || p === "/api/logout" || p === "/api/me";
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
