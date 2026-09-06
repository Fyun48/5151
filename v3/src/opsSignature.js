import { createHash, createHmac } from "node:crypto";

// Product 端：對送往 Ops 的 ingest 請求做 HMAC 簽名。
// 簽名涵蓋 method / path / timestamp / delivery_id / body-hash，避免 payload 被替換。
// 這份與 ops/src/ingestSignature.js 的 canonical 格式必須一致（有 contract 測試把關）。
// 注意：v3 部署只複製 v3/src，故此檔為自足（不 import ops/）。

export const SIG_VERSION = "v1";

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
