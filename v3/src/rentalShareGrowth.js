/** First-party share attribution（PR D）。不接第三方追蹤。 */

import { createHash, randomBytes } from "node:crypto";
import { bumpAnalytics, ensureRentalNotifySchema, rentalNotifyHttpError } from "./rentalNotify.js";
import { isWishLifecycleEnabled, normalizeRentalMarketplaceFlags } from "./rentalMarketplaceFlags.js";

export const SHARE_EVENT_TYPES = Object.freeze(["view", "cta", "signup", "listing", "offer"]);
export const SHARE_VIEW_BURST = 20;
const viewHits = new Map();

export function resetShareGrowthLimits() {
  viewHits.clear();
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

function allowView(hash, now) {
  const at = now instanceof Date ? now.getTime() : Date.now();
  const row = viewHits.get(hash) || { n: 0, start: at };
  if (at - row.start > 60_000) {
    row.n = 0;
    row.start = at;
  }
  row.n += 1;
  viewHits.set(hash, row);
  return row.n <= SHARE_VIEW_BURST;
}

export function recordShareEvent(db, {
  shareToken,
  eventType,
  userId = null,
  ip = "",
  userAgent = "",
  now = new Date(),
} = {}) {
  const type = SHARE_EVENT_TYPES.includes(eventType) ? eventType : "";
  const token = String(shareToken || "").trim();
  if (!type || !token || /^\d+$/.test(token)) throw rentalNotifyHttpError("無法記錄", 404, "share_not_found");
  const bot = looksLikeBot(userAgent);
  const hash = visitorHash(ip, userAgent);
  if (type === "view" && !allowView(hash, now)) throw rentalNotifyHttpError("請稍後再試", 429, "RATE_LIMITED");
  const day = iso(now).slice(0, 10);
  if (userId) {
    const dup = db.prepare(`
      SELECT id FROM rental_share_events
      WHERE share_token = ? AND event_type = ? AND user_id = ? AND created_at >= ?
      LIMIT 1
    `).get(token, type, Number(userId), `${day}T00:00:00.000Z`);
    if (dup) return { recorded: false, reason: "deduped", is_bot: bot };
  } else if (type === "view") {
    const dup = db.prepare(`
      SELECT id FROM rental_share_events
      WHERE share_token = ? AND event_type = ? AND visitor_hash = ? AND created_at >= ?
      LIMIT 1
    `).get(token, type, hash, `${day}T00:00:00.000Z`);
    if (dup) return { recorded: false, reason: "deduped", is_bot: bot };
  }
  db.prepare(`
    INSERT INTO rental_share_events(public_token, share_token, event_type, user_id, visitor_hash, is_bot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomBytes(12).toString("base64url"), token, type, userId ? Number(userId) : null, hash, bot ? 1 : 0, iso(now));
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
