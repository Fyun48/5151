/** Google / LINE / Facebook 登入：後台填 client id／secret。新帳號仍須完成信箱開通。 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeEmail, validateEmail } from "./password.js";

export const OAUTH_PROVIDERS = ["google", "line", "facebook"];
export const OAUTH_STATE_COOKIE = "591_oauth";
const STATE_TTL_MS = 15 * 60 * 1000;

export function defaultOauthConfig() {
  return {
    google: { enabled: false, clientId: "", clientSecret: "" },
    line: { enabled: false, clientId: "", clientSecret: "" },
    facebook: { enabled: false, clientId: "", clientSecret: "" },
  };
}

function clip(value, max = 400) {
  return String(value || "").trim().slice(0, max);
}

export function oauthFromEnv(env = process.env) {
  return {
    google: {
      enabled: Boolean(String(env.GOOGLE_OAUTH_CLIENT_ID || "").trim() && String(env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim()),
      clientId: clip(env.GOOGLE_OAUTH_CLIENT_ID),
      clientSecret: clip(env.GOOGLE_OAUTH_CLIENT_SECRET),
    },
    line: {
      enabled: Boolean(String(env.LINE_LOGIN_CHANNEL_ID || "").trim() && String(env.LINE_LOGIN_CHANNEL_SECRET || "").trim()),
      clientId: clip(env.LINE_LOGIN_CHANNEL_ID),
      clientSecret: clip(env.LINE_LOGIN_CHANNEL_SECRET),
    },
    facebook: {
      enabled: Boolean(String(env.FACEBOOK_APP_ID || "").trim() && String(env.FACEBOOK_APP_SECRET || "").trim()),
      clientId: clip(env.FACEBOOK_APP_ID),
      clientSecret: clip(env.FACEBOOK_APP_SECRET),
    },
  };
}

export function normalizeOauthConfig(input = {}, previous = {}, env = process.env) {
  const defaults = defaultOauthConfig();
  const envCfg = oauthFromEnv(env);
  const src = input && typeof input === "object" ? input : {};
  const prev = previous && typeof previous === "object" ? previous : {};
  const out = {};
  for (const key of OAUTH_PROVIDERS) {
    const row = src[key] && typeof src[key] === "object" ? src[key] : {};
    const older = prev[key] && typeof prev[key] === "object" ? prev[key] : {};
    const submitted = clip(row.clientSecret);
    const keep = !submitted || submitted === "(unchanged)";
    const clientId = clip(row.clientId ?? older.clientId ?? envCfg[key].clientId, 200);
    const clientSecret = keep ? clip(older.clientSecret || envCfg[key].clientSecret) : submitted;
    const enabled = row.enabled === true || (row.enabled == null && Boolean(clientId && clientSecret) && older.enabled !== false);
    out[key] = {
      enabled: enabled && Boolean(clientId && clientSecret),
      clientId,
      clientSecret,
    };
  }
  return { ...defaults, ...out };
}

export function publicOauthConfig(config) {
  const row = normalizeOauthConfig(config);
  const out = {};
  for (const key of OAUTH_PROVIDERS) {
    out[key] = {
      enabled: row[key].enabled === true,
      configured: Boolean(row[key].clientId && row[key].clientSecret),
      clientId: row[key].clientId,
    };
  }
  return out;
}

export function oauthToEnv(config) {
  const row = normalizeOauthConfig(config);
  return {
    GOOGLE_OAUTH_CLIENT_ID: row.google.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: row.google.clientSecret,
    LINE_LOGIN_CHANNEL_ID: row.line.clientId,
    LINE_LOGIN_CHANNEL_SECRET: row.line.clientSecret,
    FACEBOOK_APP_ID: row.facebook.clientId,
    FACEBOOK_APP_SECRET: row.facebook.clientSecret,
  };
}

export function applyOauthEnv(config) {
  const env = oauthToEnv(config);
  for (const [key, value] of Object.entries(env)) {
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
  return env;
}

function signState(payload, secret) {
  return createHmac("sha256", secret || "missing").update(payload).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createOauthState({ provider, accept = false, now = Date.now() } = {}, secret = process.env.SESSION_SECRET) {
  const payload = Buffer.from(JSON.stringify({
    p: String(provider || ""),
    a: accept === true ? 1 : 0,
    n: randomBytes(8).toString("hex"),
    exp: now + STATE_TTL_MS,
  })).toString("base64url");
  return `${payload}.${signState(payload, secret)}`;
}

export function readOauthState(token, secret = process.env.SESSION_SECRET, now = Date.now()) {
  const raw = String(token || "");
  if (!raw.includes(".")) return null;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac || !safeEqual(signState(payload, secret), mac)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data?.exp || Number(now) > Number(data.exp)) return null;
    const provider = String(data.p || "");
    if (!OAUTH_PROVIDERS.includes(provider)) return null;
    return { provider, accept: Number(data.a) === 1 };
  } catch {
    return null;
  }
}

export function oauthStateCookie(req, token, { clear = false } = {}) {
  const secure = String(req?.headers?.["x-forwarded-proto"] || req?.protocol || "").includes("https");
  const parts = [
    `${OAUTH_STATE_COOKIE}=${clear ? "" : encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    clear ? "Max-Age=0" : `Max-Age=${Math.round(STATE_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function providerAuthorizeUrl(provider, { clientId, redirectUri, state }) {
  const id = encodeURIComponent(clientId);
  const redirect = encodeURIComponent(redirectUri);
  const st = encodeURIComponent(state);
  if (provider === "google") {
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${id}&redirect_uri=${redirect}&response_type=code&scope=${encodeURIComponent("openid email profile")}&state=${st}&prompt=select_account`;
  }
  if (provider === "line") {
    return `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${id}&redirect_uri=${redirect}&state=${st}&scope=${encodeURIComponent("openid email profile")}`;
  }
  if (provider === "facebook") {
    return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${id}&redirect_uri=${redirect}&state=${st}&scope=email`;
  }
  return "";
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function exchangeOauthCode(provider, { code, redirectUri, clientId, clientSecret }, { fetchImpl = fetch } = {}) {
  const key = String(provider || "");
  const tokenCode = String(code || "").trim();
  if (!tokenCode) {
    const err = new Error("授權碼無效");
    err.status = 400;
    throw err;
  }
  if (key === "google") {
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: tokenCode,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const body = await readJson(res);
    if (!res.ok || !body.access_token) {
      const err = new Error("Google 授權失敗");
      err.status = 400;
      throw err;
    }
    const me = await fetchImpl("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    const profile = await readJson(me);
    const email = validateEmail(profile.email);
    if (!email) {
      const err = new Error("這個 Google 帳號沒有可用的 Email，請改用信箱註冊");
      err.status = 400;
      throw err;
    }
    return { email, subject: String(profile.sub || profile.id || email), name: String(profile.name || "") };
  }
  if (key === "line") {
    const res = await fetchImpl("https://api.line.me/oauth2/v2.1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: tokenCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const body = await readJson(res);
    if (!res.ok || !body.access_token) {
      const err = new Error("LINE 授權失敗");
      err.status = 400;
      throw err;
    }
    const me = await fetchImpl("https://api.line.me/oauth2/v2.1/userinfo", {
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    const profile = await readJson(me);
    const email = validateEmail(profile.email);
    if (!email) {
      const err = new Error("這個 LINE 帳號沒有提供 Email，請改用信箱註冊");
      err.status = 400;
      throw err;
    }
    return { email, subject: String(profile.sub || profile.userId || email), name: String(profile.name || "") };
  }
  if (key === "facebook") {
    const url = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("client_secret", clientSecret);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code", tokenCode);
    const res = await fetchImpl(url);
    const body = await readJson(res);
    if (!res.ok || !body.access_token) {
      const err = new Error("Facebook 授權失敗");
      err.status = 400;
      throw err;
    }
    const meUrl = new URL("https://graph.facebook.com/me");
    meUrl.searchParams.set("fields", "id,name,email");
    meUrl.searchParams.set("access_token", body.access_token);
    const me = await fetchImpl(meUrl);
    const profile = await readJson(me);
    const email = validateEmail(profile.email);
    if (!email) {
      const err = new Error("這個 Facebook 帳號沒有可用的 Email，請改用信箱註冊");
      err.status = 400;
      throw err;
    }
    return { email, subject: String(profile.id || email), name: String(profile.name || "") };
  }
  const err = new Error("不支援的登入方式");
  err.status = 400;
  throw err;
}

export function randomOauthPassword() {
  return `oauth-${randomBytes(18).toString("hex")}`;
}

export { normalizeEmail };
