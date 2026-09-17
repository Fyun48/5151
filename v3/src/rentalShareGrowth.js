/** First-party share attribution（PR D）。不接第三方追蹤。 */

import { createHash, randomBytes } from "node:crypto";
import { bumpAnalytics, rentalNotifyHttpError } from "./rentalNotify.js";
import { isWishLifecycleEnabled, normalizeRentalMarketplaceFlags } from "./rentalMarketplaceFlags.js";

export const SHARE_EVENT_TYPES = Object.freeze(["view", "cta", "signup", "listing", "offer"]);
export const PUBLIC_SHARE_EVENT_TYPES = Object.freeze(["view", "cta"]);
export const CONVERSION_SHARE_EVENT_TYPES = Object.freeze(["signup", "listing", "offer"]);
export const SHARE_VIEW_BURST = 20;
export const SHARE_VIEW_HIT_TTL_MS = 60_000;
export const SHARE_VIEW_HIT_MAX = 2048;
const viewHits = new Map();

export function resetShareGrowthLimits() {
  viewHits.clear();
}

export function shareLimiterSize() {
  return viewHits.size;
}

function iso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function looksLikeBot(ua = "") {
  return /bot|crawler|spider|preview|slurp|facebookexternalhit|whatsapp/i.test(String(ua || ""));
}

function visitorHash(ip, ua) {
  return createHash("sha256").update(`${ip || ""}|${String(ua || "").slice(0, 120)}`).digest("hex").slice(0, 32);
}

function evictViewHits(at) {
  for (const [hash, row] of viewHits) {
    if (at - row.start > SHARE_VIEW_HIT_TTL_MS) viewHits.delete(hash);
  }
  while (viewHits.size > SHARE_VIEW_HIT_MAX) {
    const oldest = viewHits.keys().next().value;
    if (oldest == null) break;
    viewHits.delete(oldest);
  }
}

function allowView(hash, now) {
  const at = now instanceof Date ? now.getTime() : Date.now();
  evictViewHits(at);
  const row = viewHits.get(hash) || { n: 0, start: at };
  if (at - row.start > SHARE_VIEW_HIT_TTL_MS) {
    row.n = 0;
    row.start = at;
  }
  row.n += 1;
  viewHits.set(hash, row);
  if (viewHits.size > SHARE_VIEW_HIT_MAX) evictViewHits(at);
  return row.n <= SHARE_VIEW_BURST;
}

export function resolveValidShareToken(db, token) {
  const raw = String(token || "").trim();
  if (!raw || /^\d+$/.test(raw) || raw.length < 8) return "";
  try {
    const row = db.prepare("SELECT public_token FROM demand_posts WHERE public_token = ?").get(raw);
    return row?.public_token ? String(row.public_token) : "";
  } catch {
    return "";
  }
}

export function shouldAttributeSignup({ newlyCreated = false, source = "" } = {}) {
  if (newlyCreated === true) return true;
  return source === "verify_email" || source === "oauth_register";
}

export function recordShareEvent(db, {
  shareToken,
  eventType,
  userId = null,
  ip = "",
  userAgent = "",
  now = new Date(),
  source = "public",
} = {}) {
  const type = SHARE_EVENT_TYPES.includes(eventType) ? eventType : "";
  const token = String(shareToken || "").trim();
  if (!type || !token || /^\d+$/.test(token)) throw rentalNotifyHttpError("無法記錄", 404, "share_not_found");
  if (source === "public" && !PUBLIC_SHARE_EVENT_TYPES.includes(type)) {
    throw rentalNotifyHttpError("無法記錄轉換", 403, "share_conversion_forbidden");
  }
  if (source === "server" && !CONVERSION_SHARE_EVENT_TYPES.includes(type)) {
    throw rentalNotifyHttpError("無法記錄", 404, "share_not_found");
  }
  const valid = resolveValidShareToken(db, token);
  if (!valid) throw rentalNotifyHttpError("找不到分享", 404, "share_not_found");
  const bot = looksLikeBot(userAgent);
  const hash = visitorHash(ip, userAgent);
  if (type === "view" && !allowView(hash, now)) throw rentalNotifyHttpError("請稍後再試", 429, "RATE_LIMITED");
  const day = iso(now).slice(0, 10);
  if (userId) {
    const dup = db.prepare(`
      SELECT id FROM rental_share_events
      WHERE share_token = ? AND event_type = ? AND user_id = ? AND created_at >= ?
      LIMIT 1
    `).get(valid, type, Number(userId), `${day}T00:00:00.000Z`);
    if (dup) return { recorded: false, reason: "deduped", is_bot: bot };
  } else if (type === "view") {
    const dup = db.prepare(`
      SELECT id FROM rental_share_events
      WHERE share_token = ? AND event_type = ? AND visitor_hash = ? AND created_at >= ?
      LIMIT 1
    `).get(valid, type, hash, `${day}T00:00:00.000Z`);
    if (dup) return { recorded: false, reason: "deduped", is_bot: bot };
  }
  db.prepare(`
    INSERT INTO rental_share_events(public_token, share_token, event_type, user_id, visitor_hash, is_bot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomBytes(12).toString("base64url"), valid, type, userId ? Number(userId) : null, hash, bot ? 1 : 0, iso(now));
  bumpAnalytics(db, bot ? `share_${type}_bot` : `share_${type}`, now);
  return { recorded: true, is_bot: bot };
}

export function sharePageExtras(flags = {}) {
  const row = normalizeRentalMarketplaceFlags(flags);
  return {
    share_v2: row.wish.public_share_v2_enabled === true && isWishLifecycleEnabled(flags),
    owner_cta: "我有符合的房子",
    owner_cta_href: "/login?next=%2F%23post",
  };
}
