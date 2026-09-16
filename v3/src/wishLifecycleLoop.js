/** 許願房生命週期 worker：獨立、idempotent、non-reentrant、bounded。不綁抓房 crawler。 */

import { planLifecycleTick, shouldApplyLifecyclePlan } from "./wishLifecycle.js";
import { isWishLifecycleEnabled } from "./rentalMarketplaceFlags.js";

const DEFAULT_LIMIT = 80;

export function startWishLifecycleLoop(runTick, { intervalMs = 60 * 1000, log = () => {} } = {}) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      const result = runTick();
      if (result && result.changed) log("wish-lifecycle", result);
    } catch (error) {
      log("wish-lifecycle-error", { error: error?.message || String(error) });
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

export function runWishLifecycleTick(db, now = new Date(), { limit = DEFAULT_LIMIT, flags } = {}) {
  if (!isWishLifecycleEnabled(flags)) return { changed: 0, scanned: 0, skipped: true };
  const rows = db.prepare(
    `SELECT * FROM demand_posts
     WHERE status IN ('open', 'expired')
     ORDER BY id ASC LIMIT ?`,
  ).all(Math.max(1, Number(limit) || DEFAULT_LIMIT));
  let changed = 0;
  const update = db.prepare(
    `UPDATE demand_posts
     SET lifecycle = ?, status = ?, expires_at = COALESCE(?, expires_at),
         last_confirmed_at = COALESCE(?, last_confirmed_at),
         last_active_at = COALESCE(?, last_active_at),
         closed_at = COALESCE(?, closed_at),
         closed_reason = COALESCE(?, closed_reason),
         updated_at = ?
     WHERE id = ?`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const planned = planLifecycleTick(row, now);
      const fresh = db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(row.id);
      if (!shouldApplyLifecyclePlan(fresh, planned, now)) continue;
      update.run(
        planned.lifecycle,
        planned.status,
        planned.expires_at || null,
        planned.last_confirmed_at || null,
        planned.last_active_at || null,
        planned.closed_at || null,
        planned.closed_reason || null,
        planned.updated_at,
        row.id,
      );
      changed += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
  return { changed, scanned: rows.length, skipped: false };
}
