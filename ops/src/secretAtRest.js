// OPS secret-at-rest: AES-256-GCM authenticated encryption for credential material.
// The key must come from an external env secret and is never written to the OPS DB.
// Stored form: "v1:<iv b64url>:<authTag b64url>:<ciphertext b64url>".
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SECRET_AT_REST_KEY_ENV = "OPS_SECRET_AT_REST_KEY";
export const SECRET_AT_REST_VERSION = "v1";
export const SECRET_AT_REST_ALGO = "aes-256-gcm";
const KEY_BYTES = 32;

// Accept a 64-hex or 44-char base64url 32-byte key. Anything else → null (fail-closed).
export function secretAtRestKey(env = process.env) {
  const raw = String(env[SECRET_AT_REST_KEY_ENV] || "").trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  if (/^[A-Za-z0-9_-]{43}=?$/.test(raw)) {
    const b = Buffer.from(raw.replace(/=+$/, ""), "base64url");
    if (b.length === KEY_BYTES) return b;
  }
  return null;
}

export function requireSecretAtRestKey(env = process.env) {
  const key = secretAtRestKey(env);
  if (!key) {
    const err = new Error("OPS_SECRET_AT_REST_KEY is not configured (32-byte key required)");
    err.status = 503;
    throw err;
  }
  return key;
}

export function encryptSecret(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(SECRET_AT_REST_ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_AT_REST_VERSION}:${iv.toString("base64url")}:${tag.toString("base64url")}:${enc.toString("base64url")}`;
}

export function isEncryptedSecretBlob(value) {
  return typeof value === "string" && value.startsWith(`${SECRET_AT_REST_VERSION}:`);
}

// Returns the plaintext, or null when the blob is not a supported encrypted blob or
// authentication fails. Unknown version / missing key / legacy plaintext → null (fail-closed).
export function decryptSecret(blob, key) {
  if (typeof blob !== "string" || !isEncryptedSecretBlob(blob)) return null;
  if (!key || key.length !== KEY_BYTES) return null;
  const [, ivB64, tagB64, ctB64] = blob.split(":");
  if (!ivB64 || !tagB64 || !ctB64) return null;
  try {
    const decipher = createDecipheriv(SECRET_AT_REST_ALGO, key, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const dec = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}
