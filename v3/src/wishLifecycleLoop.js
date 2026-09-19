/** 許願房生命週期 worker：獨立、idempotent、non-reentrant、bounded。不綁抓房 crawler。 */

import { planLifecycleTick, shouldApplyLifecyclePlan } from "./wishLifecycle.js";
import { isWishLifecycleEnabled } from "./rentalMarketplaceFlags.js";

const DEFAULT_LIMIT = 80;

/** Cursor job key。存在 `rental_notify_cursors`（與 notification worker 共用同一張表與推進語意）。 */
export const WISH_LIFECYCLE_CURSOR_JOB = "wish_lifecycle";

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

export function runWishLifecycleTick(db, now = new Date(), { limit = DEFAULT_LIMIT, flags, cursor = null } = {}) {
  if (!isWishLifecycleEnabled(flags)) return { changed: 0, scanned: 0, skipped: true, after_id: null, next_id: null, wrapped: false };
  const cap = Math.max(1, Number(limit) || DEFAULT_LIMIT);
  const afterId = Math.max(0, Number(cursor?.get?.()) || 0);
  let rows = selectLifecycleRowsAfter(db, afterId, cap);
  let wrapped = false;
  if (!rows.length && afterId > 0) {
    rows = selectLifecycleRowsAfter(db, 0, cap);
    wrapped = true;
  }
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
  const nextId = rows.length ? Number(rows[rows.length - 1].id) || 0 : afterId;
  if (typeof cursor?.set === "function" && nextId !== afterId) cursor.set(nextId);
  return { changed, scanned: rows.length, skipped: false, after_id: afterId, next_id: nextId, wrapped };
}

/**
 * 邊界掃描來源：只按 id 遞增，配合 cursor 讓每輪都往前走，
 * 避免「前 80 筆長期不變更 → 高 id 永遠掃不到」。尾端掃完由呼叫端回到 0 重新開始。
 */
function selectLifecycleRowsAfter(db, afterId, cap) {
  return db.prepare(
    `SELECT * FROM demand_posts
     WHERE status IN ('open', 'expired')
       AND id > ?
     ORDER BY id ASC LIMIT ?`,
  ).all(afterId, cap);
}
