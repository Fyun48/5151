/** PR D workers：lifecycle reminder、digest、delivery retry、cleanup。不綁 crawler。 */

import {
  addDigestItem,
  cleanupRentalNotify,
  closeDigestBuckets,
  deliverQueuedNotifications,
  emitRentalNotifyEvent,
  hasSeenMatch,
  listDueMatchSubscriptions,
  listingOpenForNotify,
  RENTAL_NOTIFY_BATCH,
  recordMatchSeen,
  scheduleLifecycleReminders,
  scheduleOfferExpiring,
  scheduleOwnerRetention,
  scheduleTenantRetention,
  setRentalNotifyHydrate,
} from "./rentalNotify.js";
import { isRentalDigestEnabled, isRentalNotificationsEnabled, isWishOwnerMatchingEnabled } from "./rentalMarketplaceFlags.js";

export function startRentalNotifyLoop(runTick, {
  intervalMs = 5 * 60 * 1000,
  log = () => {},
} = {}) {
  let running = false;
  let timer = null;
  const tick = () => {
    if (running) return { skipped: true };
    running = true;
    try {
      return runTick();
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => {
    try { tick(); } catch (error) { log("rental-notify-tick", { error: error.message }); }
  }, intervalMs);
  return {
    tick,
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

export function runRentalNotifyTick(db, now = new Date(), {
  flags = {},
  limit = RENTAL_NOTIFY_BATCH,
  matchFn = null,
} = {}) {
  setRentalNotifyHydrate(flags);
  if (!isRentalNotificationsEnabled(flags)) {
    return { skipped: true, reminders: { scanned: 0, emitted: 0 }, delivered: { scanned: 0 }, digest: { closed: 0 } };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const reminders = scheduleLifecycleReminders(db, now, { limit });
    const expiring = scheduleOfferExpiring(db, now, { limit });
    const tenantRetention = scheduleTenantRetention(db, now, { limit });
    const ownerRetention = scheduleOwnerRetention(db, now, { limit });
    const matches = processMatchSubscriptions(db, now, { limit, matchFn, flags });
    const digest = closeDigestBuckets(db, now, { limit });
    const delivered = deliverQueuedNotifications(db, now, { limit });
    const cleanup = cleanupRentalNotify(db, now, { limit });
    db.exec("COMMIT");
    return { skipped: false, reminders, matches, digest, delivered, cleanup, expiring, tenantRetention, ownerRetention };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
}

function processMatchSubscriptions(db, now, { limit, matchFn, flags }) {
  if (!isWishOwnerMatchingEnabled(flags) || typeof matchFn !== "function") {
    return { scanned: 0, emitted: 0 };
  }
  const rows = listDueMatchSubscriptions(db, { limit });
  let emitted = 0;
  for (const sub of rows) {
    if (!listingOpenForNotify(db, sub.owner_user_id, sub.listing_id)) continue;
    let page;
    try {
      page = matchFn(sub.listing_id, sub.owner_user_id) || { items: [], generation: 0 };
    } catch {
      continue;
    }
    const generation = Number(page.generation || page.epoch || 0);
    for (const item of (page.items || []).slice(0, 20)) {
      const wishRef = item.wish_ref || item.public_token || "";
      if (!wishRef || hasSeenMatch(db, sub.owner_user_id, sub.listing_id, wishRef, generation)) continue;
      const key = `owner_new_match_available:${sub.owner_user_id}:${sub.listing_id}:${wishRef}:${generation}`;
      const result = emitRentalNotifyEvent(db, {
        eventType: "owner_new_match_available",
        userId: sub.owner_user_id,
        eventKey: key,
        subjectType: "wish",
        subjectRef: wishRef,
        listingId: sub.listing_id,
        payload: { listing_ref: sub.listing_id },
        now,
      });
      recordMatchSeen(db, sub.owner_user_id, sub.listing_id, wishRef, generation, now);
      if (result.emitted) {
        emitted += 1;
        if (sub.mode === "daily_digest" && isRentalDigestEnabled(flags) && result.event_id) {
          addDigestItem(db, {
            userId: sub.owner_user_id,
            eventId: result.event_id,
            listingId: sub.listing_id,
            wishRef,
            now,
          });
        }
      }
    }
  }
  return { scanned: rows.length, emitted };
}
