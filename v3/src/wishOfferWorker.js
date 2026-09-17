/** Offer expiry worker：idempotent、bounded、non-reentrant。不綁 crawler、不寄信。 */

import { isWishOfferEnabled } from "./rentalMarketplaceFlags.js";
import { OFFER_EXPIRE_BATCH, writeOfferEvent } from "./wishOffers.js";

export function startWishOfferExpiryLoop(runTick, { intervalMs = 60 * 1000, log = () => {} } = {}) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      const result = runTick();
      if (result && result.changed) log("wish-offer-expiry", result);
    } catch (error) {
      log("wish-offer-expiry-error", { error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  return {
    stop() { clearInterval(timer); },
    tick,
  };
}

export function runWishOfferExpiryTick(db, now = new Date(), { limit = OFFER_EXPIRE_BATCH, flags } = {}) {
  if (!isWishOfferEnabled(flags)) return { changed: 0, scanned: 0, skipped: true };
  const stamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const rows = db.prepare(
    `SELECT id, version FROM wish_offers
     WHERE status = 'pending' AND expires_at <= ?
     ORDER BY expires_at ASC, id ASC
     LIMIT ?`,
  ).all(stamp, Math.max(1, Number(limit) || OFFER_EXPIRE_BATCH));
  if (!rows.length) return { changed: 0, scanned: 0, skipped: false };
  let changed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare(
      `UPDATE wish_offers
       SET status = 'expired', expired_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND status = 'pending' AND version = ?`,
    );
    for (const row of rows) {
      const fresh = db.prepare("SELECT status, version FROM wish_offers WHERE id = ?").get(row.id);
      if (!fresh || fresh.status !== "pending") continue;
      const result = update.run(stamp, stamp, row.id, fresh.version);
      if (Number(result.changes)) {
        writeOfferEvent(db, { offerId: row.id, eventType: "offer_expired", now });
        changed += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
  return { changed, scanned: rows.length, skipped: false };
}
