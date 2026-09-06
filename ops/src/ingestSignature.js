import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Ops 端：驗證 ingest 請求的 HMAC 簽名（與 v3/src/opsSignature.js 的 canonical 格式一致）。
// 使用 constant-time 比較；檢查 timestamp 時窗（replay）與 body-hash（防 payload 替換）。
// 自足（只用 node:crypto），不 import v3/。

export const SIG_VERSION = "v1";
export const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000; // ±5 分鐘

export function bodyHashHex(rawBody) {
  return createHash("sha256").update(Buffer.from(rawBody ?? "", "utf8")).digest("hex");
}

export function buildSigningString({ method, path, timestamp, deliveryId, bodyHash }) {
  return [
    String(method || "").toUpperCase(),
    String(path || ""),
    String(timestamp || ""),
    String(deliveryId || ""),
    String(bodyHash || ""),
  ].join("\n");
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, Buffer.alloc(ba.length));
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// 回傳 { ok, reason }。reason 僅供內部/稽核（不外洩密鑰或簽章內容）。
export function verifyIngestRequest({ method, path, headers = {}, rawBody, secret, now = Date.now(), maxSkewMs = DEFAULT_MAX_SKEW_MS }) {
  if (!secret) return { ok: false, reason: "no_secret_configured" };
  const signature = String(headers["x-ops-signature"] || "");
  const timestamp = String(headers["x-ops-timestamp"] || "");
  const deliveryId = String(headers["x-ops-delivery"] || "");
  if (!signature || !timestamp || !deliveryId) return { ok: false, reason: "missing_headers" };
  if (!signature.startsWith(`${SIG_VERSION}=`)) return { ok: false, reason: "bad_signature_format" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (Math.abs(nowMs - ts) > maxSkewMs) return { ok: false, reason: "expired_timestamp" };

  const bh = bodyHashHex(rawBody);
  const expected = `${SIG_VERSION}=${createHmac("sha256", secret).update(
    buildSigningString({ method, path, timestamp, deliveryId, bodyHash: bh }),
  ).digest("hex")}`;

  if (!safeEqualHex(signature, expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true, deliveryId, bodyHash: bh };
}
