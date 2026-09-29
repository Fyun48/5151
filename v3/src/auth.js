import { timingSafeEqual, createHmac, randomBytes } from "node:crypto";
import {
  findUserByEmail,
  publicUser,
  setUserPassword,
  verifyUserPassword,
} from "./db.js";
import { normalizeEmail } from "./password.js";
import {
  defaultUserIdAsync,
  findUserByEmailAsync,
  setUserPasswordAsync,
  verifyUserPasswordAsync,
} from "./usersAsync.js";
import { assertNotLocked, clearAuthFailures, recordAuthFailure } from "./rateLimit.js";
import { isEmailVerified } from "./emailVerify.js";
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";

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

// ── Session 解析（driver-aware，2026-09-27）────────────────────────────────
//
// 為什麼要動這裡：`readSession()` 走 `findUserByEmail()` → 節點本機 `v3.db`，
// 是步驟 3 剩下的**最大單一卡點**——`server.js` 有 113 個呼叫點、尺規上有 137 條路由
// 因此被判成 SQLite／MIXED，而且只要它在，後面每一批移植都會停在 MIXED、數字不會動。
//
// 解法（Owner 決定，方案 A）：**非同步中介層每請求預先解析一次**，把結果掛在 `req` 上；
// `readSession()` 改成優先讀快取。113 個呼叫點完全不用改，而且因為同一請求內
// `readSession()` 常被呼叫好幾次，每請求的 `users` 查詢次數反而**變少**。
export const SESSION_BY_EMAIL_SQL = "SELECT * FROM users WHERE email = ?";

const SESSION_SLOT = Symbol("591.session");

// token 驗證（純函式、不碰 DB）：同步／PG／fallback 三條路共用同一份，
// 所以簽章與到期判斷不可能有兩份實作而漂移。
function sessionClaim(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || !token.includes(".")) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac || !safeEqual(sign(payload), mac)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data?.exp || Date.now() > Number(data.exp)) return null;
    const email = normalizeEmail(data.e);
    return email ? { email } : null;
  } catch {
    return null;
  }
}

// 身分欄位只有這一份：同步版、PG 版、fallback 版都經過它，回傳形狀不可能漂移。
// `deleted_at` 的判斷留在這裡（原本 readSession 內就是這兩個條件）。
export function sessionFromUser(user) {
  if (!user || String(user.deleted_at || "").trim()) return null;
  return { email: user.email, userId: Number(user.id), role: user.role || "member", plan: user.plan || "free" };
}

export function readSession(req) {
  // 中介層解析過就以它為準（連「已解析為未登入」也快取，才不會每次都回頭查 SQLite）。
  if (req && Object.prototype.hasOwnProperty.call(req, SESSION_SLOT)) return req[SESSION_SLOT];
  const claim = sessionClaim(req);
  if (!claim) return null;
  return sessionFromUser(findUserByEmail(claim.email));
}

export async function readSessionAsync(req, options = {}) {
  const claim = sessionClaim(req);
  if (!claim) return null;
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return sessionFromUser(findUserByEmail(claim.email));
  try {
    if (options.exec) return sessionFromUser((await options.exec(SESSION_BY_EMAIL_SQL, [claim.email]))[0] || null);
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    const res = await pgDriver.query(toPostgresSql(SESSION_BY_EMAIL_SQL), [claim.email]);
    return sessionFromUser(res.rows[0] || null);
  } catch (error) {
    // 讀取維持 fail-open（與其他 PG 島嶼同一政策）：PG 讀不到時退回本機 SQLite，
    // 免得「PG 抖一下」被放大成「全站登出」。`strict` 仍可讓它往上丟（驗證用）。
    if (!sqliteFallbackAllowed(options)) throw error;
    return sessionFromUser(findUserByEmail(claim.email));
  }
}

// 靜態資產不需要 session；帶 cookie 載入 30 個檔案不該換來 30 次 users 查詢。
//
// 規則：**符合靜態副檔名、且不在 `/api/` 底下**就當靜態。
// ⚠️ 第一版只認 `/vendor/`、`/icons/`、`/brand/`、`/media/` 四個前綴，於是
// `express.static(v3/public)` 服務的**根目錄檔案**（`/app.js`、`/support-page.css`…）
// 全部沒被跳過——那才是最大一批。改成看副檔名之後，四個前綴自然被涵蓋。
//
// 安全前提：目前唯一「符合副檔名卻不是靜態檔」的路由是 `GET /sw.js`（純 `sendFile`，
// 用 `_req` 不讀 session）。`route-data-map.test.js` 有一條守衛會盯著這件事：
// 之後若有人加了會讀 session 的副檔名路由，那一條會紅，屆時把它加進 DYNAMIC_ASSET_PATHS。
const STATIC_EXT = /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot)$/i;
export const DYNAMIC_ASSET_PATHS = Object.freeze([]);

export function isStaticAssetPath(pathname) {
  const p = String(pathname || "");
  if (!STATIC_EXT.test(p)) return false;
  if (p.startsWith("/api/")) return false;
  return !DYNAMIC_ASSET_PATHS.includes(p);
}

// 掛在 app 層（所有路由註冊之前）：每請求解析一次並快取。
// 沒有 cookie 或純靜態資產直接寫入 null，完全不碰 DB。
export function resolveSession(options = {}) {
  return async function resolveSessionMiddleware(req, _res, next) {
    const cookie = String(req.headers?.cookie || "");
    if (!cookie.includes(`${COOKIE}=`) || isStaticAssetPath(req.path)) {
      req[SESSION_SLOT] = null;
      next();
      return;
    }
    try {
      req[SESSION_SLOT] = await readSessionAsync(req, options);
    } catch {
      // 解析失敗一律當成未登入：與舊 readSession() 「從不丟錯」的契約一致，
      // 免得 auth 的例外變成 500。
      req[SESSION_SLOT] = null;
    }
    next();
  };
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

// `verifyLogin()` 的 PG 版：**同一串規則**（鎖定 → 雜湊比對 → 未驗證擋下 → env admin 後備），
// 只把「跑語句的人」換成 PG 島嶼。非 postgres 直接走同步版，SQLite 站行為完全不變。
//
// 為什麼需要：登入讀的是 `users`（已在 PG 上），同步版在 PG 模式下讀的是**節點本機**的
// users ⇒ 只有剛好在本機建過帳號的人登得進去，其他節點建立的成員一律「帳號或密碼不正確」。
export async function verifyLoginAsync(email, password, { keys, now, ...options } = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") return verifyLogin(email, password, { keys, now });
  if (keys?.length) assertNotLocked(keys, now);
  const key = normalizeEmail(email);
  const pass = String(password || "");
  const hashed = await verifyUserPasswordAsync(key, pass, options);
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
    const user = await findUserByEmailAsync(key, options);
    if (user && !String(user.password_hash || "").trim()) {
      try {
        await setUserPasswordAsync(user.id, pass, options);
      } catch {
        // env 密碼短於 8 碼時略過寫入，下次仍可用 AUTH_PASSWORD（與同步版同義）
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

export function verifyLogin(email, password, { keys, now } = {}) {
  // 同步版（SQLite 站）：行為完全不變。

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

export function isPublicKitPath(p) {
  if (typeof p !== "string" || !p.startsWith("/kit/")) return false;
  const rest = p.slice("/kit/".length);
  if (!rest || rest.includes("..") || rest.includes("\\") || rest.includes("//")) return false;
  return /^(tokens\.css|components\.css|VERSION|README\.md|MANIFEST\.json|themes\/[a-z0-9-]+\.css)$/.test(rest);
}

export function publicPath(req) {
  const p = req.path || "";
  return (
    p === "/" ||
    p === "/index.html" ||
    p === "/login.html" ||
    p === "/disclaimer.html" ||
    p === "/terms.html" ||
    p === "/data.html" ||
    p === "/support" ||
    p === "/support.html" ||
    p === "/support-page.js" ||
    p === "/support-cta.js" ||
    p.startsWith("/api/support/") ||
    p === "/logout" ||
    p === "/api/login" ||
    p === "/api/register" ||
    p === "/verify-email" ||
    p.startsWith("/auth/") ||
    p === "/api/oauth" ||
    p === "/api/forgot-password" ||
    p === "/api/logout" ||
    p === "/api/me" ||
    p === "/api/health" ||
    p === "/api/demo" ||
    p === "/api/disclaimer" ||
    p === "/api/public/documents" ||
    p.startsWith("/api/public/documents/") ||
    p === "/api/spirit" ||
    p === "/api/housing-data" ||
    p === "/api/help-qa" ||
    p === "/api/feedback/meta" ||
    p === "/api/ops/commands/apply" ||
    p === "/api/ads" ||
    p === "/api/brand" ||
    p === "/api/broadcasts" ||
    p === "/api/announcements" ||
    p === "/api/sponsored" ||
    p === "/api/comms" ||
    p === "/api/captcha" ||
    p === "/api/demand" ||
    p === "/api/wish-rooms" ||
    p === "/api/push/vapid" ||
    p === "/manifest.webmanifest" ||
    p === "/sw.js" ||
    p === "/tokens.css" ||
    isPublicKitPath(p) ||
    p === "/mascot.js" ||
    p === "/pra-helpers.js" ||
    p === "/guest-search-state.js" ||
    p === "/cities-embed.js" ||
    p === "/cities.json" ||
    p.startsWith("/api/demand/") ||
    p.startsWith("/api/wish-rooms/") ||
    p.startsWith("/api/announcements/") ||
    p.startsWith("/api/sponsored/") ||
    p.startsWith("/vendor/") ||
    p.startsWith("/icons/") ||
    p.startsWith("/brand/") ||
    p.startsWith("/media/self/") ||
    p.startsWith("/media/lib/") ||
    p.startsWith("/media/brand/") ||
    p.startsWith("/l/") ||
    p.startsWith("/w/") ||
    p.startsWith("/api/public/") ||
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
