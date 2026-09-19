// Gitea webhook signature verification (Phase 25). Gitea signs webhook payloads
// with HMAC-SHA256 using the configured secret, delivered in
// X-Gitea-Signature as "sha256=<hex>". Verify in constant time.
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGiteaWebhookSignature(secret, rawPayload, signature) {
  if (!secret || !signature) return false;
  const prefix = "sha256=";
  if (!String(signature).startsWith(prefix)) return false;
  const received = Buffer.from(String(signature).slice(prefix.length), "hex");
  const expected = createHmac("sha256", secret).update(rawPayload).digest();
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
