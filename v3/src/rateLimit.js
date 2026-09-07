import { normalizeEmail } from "./password.js";

const FAIL_LIMIT = 8;
const FAIL_LOCK_MS = 15 * 60 * 1000;
const CAPTCHA_LIMIT = 40;
const CAPTCHA_WINDOW_MS = 10 * 60 * 1000;

const fails = new Map();
const captchaHits = new Map();

export function clientIp(req) {
  return String(req?.ip || req?.socket?.remoteAddress || "").replace(/^::ffff:/, "") || "unknown";
}

export function authAttemptKeys(req, email) {
  const keys = [`ip:${clientIp(req)}`];
  const key = normalizeEmail(email);
  if (key) keys.push(`email:${key}`);
  return keys;
}

export function assertNotLocked(keys, now = Date.now()) {
  for (const key of keys || []) {
    const row = fails.get(key);
    if (row?.until && now < row.until) {
      const wait = Math.max(1, Math.ceil((row.until - now) / 1000));
      const err = new Error(`嘗試太多次，請 ${wait} 秒後再試`);
      err.status = 429;
      throw err;
    }
  }
}

export function recordAuthFailure(keys, now = Date.now()) {
  for (const key of keys || []) {
    const row = fails.get(key) || { n: 0, until: 0 };
    if (row.until && now >= row.until) {
      row.n = 0;
      row.until = 0;
    }
    row.n += 1;
    if (row.n >= FAIL_LIMIT) {
      row.until = now + FAIL_LOCK_MS;
      row.n = 0;
    }
    fails.set(key, row);
  }
}

export function clearAuthFailures(keys) {
  for (const key of keys || []) fails.delete(key);
}

export function assertCaptchaIssuable(ip, now = Date.now()) {
  const key = `ip:${ip || "unknown"}`;
  const row = captchaHits.get(key) || { n: 0, start: now };
  if (now - row.start >= CAPTCHA_WINDOW_MS) {
    row.n = 0;
    row.start = now;
  }
  row.n += 1;
  captchaHits.set(key, row);
  if (row.n > CAPTCHA_LIMIT) {
    const wait = Math.max(1, Math.ceil((CAPTCHA_WINDOW_MS - (now - row.start)) / 1000));
    const err = new Error(`驗證圖換太多次，請 ${wait} 秒後再試`);
    err.status = 429;
    throw err;
  }
}

const demoHits = new Map();
const DEMO_LIMIT = 40;
const DEMO_WINDOW_MS = 10 * 60 * 1000;

export function assertDemoReadable(ip, now = Date.now()) {
  const key = `ip:${ip || "unknown"}`;
  const row = demoHits.get(key) || { n: 0, start: now };
  if (now - row.start >= DEMO_WINDOW_MS) {
    row.n = 0;
    row.start = now;
  }
  row.n += 1;
  demoHits.set(key, row);
  if (row.n > DEMO_LIMIT) {
    const wait = Math.max(1, Math.ceil((DEMO_WINDOW_MS - (now - row.start)) / 1000));
    const err = new Error(`示範列表讀太多次，請 ${wait} 秒後再試`);
    err.status = 429;
    throw err;
  }
}

const importHits = new Map();
export const IMPORT_RATE = {
  userLimit: 8,
  ipLimit: 20,
  windowMs: 15 * 60 * 1000,
};

export function assertImportAllowed(userId, ip, now = Date.now()) {
  const keys = [
    { key: `user:${Number(userId) || 0}`, limit: IMPORT_RATE.userLimit },
    { key: `ip:${ip || "unknown"}`, limit: IMPORT_RATE.ipLimit },
  ];
  for (const { key, limit } of keys) {
    const row = importHits.get(key) || { n: 0, start: now };
    if (now - row.start >= IMPORT_RATE.windowMs) {
      row.n = 0;
      row.start = now;
    }
    row.n += 1;
    importHits.set(key, row);
    if (row.n > limit) {
      const wait = Math.max(1, Math.ceil((IMPORT_RATE.windowMs - (now - row.start)) / 1000));
      const err = new Error(`匯入次數稍多，請 ${wait} 秒後再試`);
      err.status = 429;
      err.code = "RATE_LIMITED";
      throw err;
    }
  }
}

export function resetAuthRateLimits() {
  fails.clear();
  captchaHits.clear();
  demoHits.clear();
  importHits.clear();
}
