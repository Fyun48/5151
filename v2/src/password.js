import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 32;

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password || ""), salt, KEYLEN).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  let actual;
  let expected;
  try {
    actual = scryptSync(String(password || ""), salt, KEYLEN);
    expected = Buffer.from(hash, "hex");
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function validateEmail(email) {
  const key = normalizeEmail(email);
  if (!key || key.length > 120) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return "";
  return key;
}

export function validatePassword(password) {
  const text = String(password || "");
  if (text.length < 8) {
    const err = new Error("密碼至少 8 個字");
    err.status = 400;
    throw err;
  }
  if (text.length > 200) {
    const err = new Error("密碼太長");
    err.status = 400;
    throw err;
  }
  return text;
}
