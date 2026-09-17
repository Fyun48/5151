/** PR D workers：lifecycle reminder、digest、delivery retry、cleanup。不綁 crawler。 */

import {
  cleanupRentalNotify,
  closeDigestBuckets,
  deliverQueuedNotifications,
  listDueMatchSubscriptions,
  processMatchSubscriptionRow,
  RENTAL_NOTIFY_BATCH,
  scheduleLifecycleReminders,
  scheduleOfferExpiring,
  scheduleOwnerRetention,
  scheduleTenantRetention,
  setRentalNotifyHydrate,
} from "./rentalNotify.js";
import { isRentalNotificationsEnabled, isWishOwnerMatchingEnabled } from "./rentalMarketplaceFlags.js";

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
  hardGateFn = null,
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
    const matches = processMatchSubscriptions(db, now, { limit, matchFn, hardGateFn, flags });
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

function processMatchSubscriptions(db, now, { limit, matchFn, hardGateFn, flags }) {
  if (!isWishOwnerMatchingEnabled(flags) || typeof matchFn !== "function") {
    return { scanned: 0, emitted: 0 };
  }
  const rows = listDueMatchSubscriptions(db, { limit, now });
  let emitted = 0;
  for (const sub of rows) {
    let page;
    try {
      page = matchFn(sub.listing_id, sub.owner_user_id) || { items: [] };
    } catch {
      continue;
    }
    emitted += processMatchSubscriptionRow(db, sub, page, now, flags, { hardGateFn }).emitted;
  }
  return { scanned: rows.length, emitted };
}
