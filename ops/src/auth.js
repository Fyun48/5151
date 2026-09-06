import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

// Owner 授權：重用「既有 admin identity」憑證（AUTH_EMAIL / AUTH_PASSWORD），不建立第二組密碼。
// 但 session 簽章密鑰必須是「獨立的」OPS_SESSION_SECRET（由 server 注入），不重用 v3 SESSION_SECRET。
//
// Session 規則：
//  - Absolute expiration：12 小時（登入時固定，滑動不延長）。
//  - Idle expiration：2 小時（每次授權請求滑動延長，但不超過 absolute）。
//  - Cookie：HttpOnly、SameSite=Lax、HTTPS 下 Secure、Path=/ops（只在 ops API 送出）。
//  - Logout：清除 cookie（同 Path）。
//  - 絕不記錄憑證或 session token。
//
// CSRF / Origin：state-changing 端點需帶與 session 綁定的 CSRF token（X-CSRF-Token），
//  且若帶 Origin/Referer 必須同源。token = HMAC(secret, "csrf:"+nonce)，nonce 在 session cookie 內。

const COOKIE = "ops_session";
const COOKIE_PATH = "/ops";
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const IDLE_MS = 2 * 60 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
const LOGIN_BASE_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_LOCK_MS = 6 * 60 * 60 * 1000;

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

function firstHeader(req, name) {
  const v = req.headers?.[name];
  if (Array.isArray(v)) return String(v[0] || "");
  return String(v || "");
}

// config: { ownerEmail, ownerPassword, sessionSecret, cookieSecure }
export function makeAuth(config = {}) {
  const ownerEmail = normalizeEmail(config.ownerEmail);
  const ownerPassword = String(config.ownerPassword || "");
  const sessionSecret = String(config.sessionSecret || "");
  const configured = Boolean(ownerEmail && ownerPassword && sessionSecret);
  const forceSecure = config.cookieSecure;
  const attempts = new Map(); // key(ip|email) -> { fails, cycles, lockUntil }

  function sign(payload) {
    return createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  }

  function clientIp(req) {
    const fwd = firstHeader(req, "x-forwarded-for").split(",")[0].trim();
    return fwd || req.socket?.remoteAddress || "local";
  }

  // 限流 scope = IP + 帳號。遠端攻擊者從自己 IP 連打，只會鎖住 (attackerIP, ownerEmail)，
  // 不會鎖住 Owner 自己的 (ownerIP, ownerEmail) → 無法造成 Owner 全域 DoS。
  function attemptKey(req, email) {
    return `${clientIp(req)}|${normalizeEmail(email)}`;
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
    const rec = attempts.get(key) || { fails: 0, cycles: 0, lockUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= LOGIN_MAX_FAILS) {
      rec.cycles += 1;
      // 進階 backoff：每次達標鎖定時間加倍，設上限。
      rec.lockUntil = now + Math.min(LOGIN_BASE_LOCK_MS * 2 ** (rec.cycles - 1), LOGIN_MAX_LOCK_MS);
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
    const proto = firstHeader(req, "x-forwarded-proto").split(",")[0].trim();
    return proto === "https" || req.socket?.encrypted === true;
  }

  function buildCookie(req, { nonce, absoluteExp, now }) {
    const payload = Buffer.from(
      JSON.stringify({ e: ownerEmail, n: nonce, aexp: absoluteExp, seen: now }),
    ).toString("base64url");
    const token = `${payload}.${sign(payload)}`;
    const maxAge = Math.max(0, Math.floor((absoluteExp - now) / 1000));
    const parts = [
      `${COOKIE}=${token}`,
      `Path=${COOKIE_PATH}`,
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
    ];
    if (useSecure(req)) parts.push("Secure");
    return parts.join("; ");
  }

  function sessionCookie(req, now = Date.now()) {
    return buildCookie(req, { nonce: randomBytes(12).toString("hex"), absoluteExp: now + ABSOLUTE_MS, now });
  }

  function clearCookie(req) {
    const parts = [`${COOKIE}=`, `Path=${COOKIE_PATH}`, "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    if (useSecure(req)) parts.push("Secure");
    return parts.join("; ");
  }

  function readSession(req, now = Date.now()) {
    if (!configured) return null;
    const token = parseCookies(req)[COOKIE];
    if (!token || !token.includes(".")) return null;
    const [payload, mac] = token.split(".");
    if (!payload || !mac || !safeEqual(sign(payload), mac)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (normalizeEmail(data.e) !== ownerEmail) return null;
      const aexp = Number(data.aexp);
      const seen = Number(data.seen);
      if (!aexp || now > aexp) return null; // absolute expiry
      if (!seen || now - seen > IDLE_MS) return null; // idle expiry
      return { email: ownerEmail, role: "owner", nonce: String(data.n || ""), absoluteExp: aexp };
    } catch {
      return null;
    }
  }

  // 滑動 idle：授權成功後回一個更新 seen 的 cookie（absolute 不變）。
  function slideCookie(req, session, now = Date.now()) {
    return buildCookie(req, { nonce: session.nonce, absoluteExp: session.absoluteExp, now });
  }

  function csrfTokenFor(session) {
    if (!session?.nonce) return "";
    return createHmac("sha256", sessionSecret).update(`csrf:${session.nonce}`).digest("base64url");
  }

  function requireOwner(req, res, next) {
    const session = readSession(req);
    if (!session) {
      res.status(401).json({ error: "只有 Owner 可以存取", login: true });
      return;
    }
    req.owner = session;
    // 滑動延長 idle
    res.setHeader("Set-Cookie", slideCookie(req, session));
    next();
  }

  // state-changing 端點的保護：CSRF token 綁定 session nonce + （若有）Origin 同源。
  function verifyMutation(req) {
    const session = req.owner || readSession(req);
    if (!session) return { ok: false, status: 401, error: "只有 Owner 可以存取" };
    const provided = firstHeader(req, "x-csrf-token");
    const expected = csrfTokenFor(session);
    if (!provided || !safeEqual(provided, expected)) {
      return { ok: false, status: 403, error: "CSRF token 不正確" };
    }
    const origin = firstHeader(req, "origin");
    const referer = firstHeader(req, "referer");
    const host = firstHeader(req, "host");
    const proto = useSecure(req) ? "https" : "http";
    const expectedOrigin = host ? `${proto}://${host}` : "";
    if (origin) {
      if (!expectedOrigin || origin !== expectedOrigin) return { ok: false, status: 403, error: "跨來源請求被拒" };
    } else if (referer && expectedOrigin) {
      if (!referer.startsWith(`${expectedOrigin}/`)) return { ok: false, status: 403, error: "跨來源請求被拒" };
    }
    return { ok: true, session };
  }

  function requireOwnerMutation(req, res, next) {
    const check = verifyMutation(req);
    if (!check.ok) {
      res.status(check.status).json({ error: check.error, ...(check.status === 401 ? { login: true } : {}) });
      return;
    }
    req.owner = check.session;
    res.setHeader("Set-Cookie", slideCookie(req, check.session));
    next();
  }

  return {
    configured,
    ownerEmail,
    verify,
    sessionCookie,
    clearCookie,
    slideCookie,
    readSession,
    csrfTokenFor,
    verifyMutation,
    requireOwner,
    requireOwnerMutation,
    attemptKey,
    clientIp,
    assertNotLocked,
    recordFail,
    clearFails,
  };
}
