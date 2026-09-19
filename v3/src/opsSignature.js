import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Product 端：對送往 Ops 的 ingest 請求做 HMAC 簽名。
// 簽名涵蓋 method / path / timestamp / delivery_id / body-hash，避免 payload 被替換。
// 這份與 ops/src/ingestSignature.js 的 canonical 格式必須一致（有 contract 測試把關）。
// 注意：v3 部署只複製 v3/src，故此檔為自足（不 import ops/）。

export const SIG_VERSION = "v1";
export const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;

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

// 回傳 { signature, timestamp, deliveryId, bodyHash } 與要帶的 headers。
export function signIngestRequest({ method, path, deliveryId, rawBody, secret, now = Date.now() }) {
  if (!secret) throw new Error("signIngestRequest requires secret");
  const timestamp = String(now instanceof Date ? now.getTime() : now);
  const bh = bodyHashHex(rawBody);
  const signingString = buildSigningString({ method, path, timestamp, deliveryId, bodyHash: bh });
  const mac = createHmac("sha256", secret).update(signingString).digest("hex");
  const signature = `${SIG_VERSION}=${mac}`;
  return {
    signature,
    timestamp,
    deliveryId,
    bodyHash: bh,
    headers: {
      "Content-Type": "application/json",
      "X-Ops-Signature": signature,
      "X-Ops-Timestamp": timestamp,
      "X-Ops-Delivery": deliveryId,
    },
  };
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
