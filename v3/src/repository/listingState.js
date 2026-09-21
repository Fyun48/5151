// Listing state writes used by the background loops (offline sweep, alive check, geo/route
// backfill, enrich worker) and by the member's "回報已下架" actions.
//
// db.js owns the SQLite versions of these statements, and with DB_DRIVER=postgres the reads have
// already moved to PostgreSQL - but the loops still wrote their results through SQLite, so the
// work they did (a listing going offline, a probe marking it alive again, the route cache being
// invalidated) never reached the store the site reads. Statement text below is copied verbatim
// from db.js (sqlDialect translates IFNULL/`?` for PostgreSQL), including the legacy fallback for
// stores that predate `content_seq`.
//
// None of the callers use the return value, so these return a small summary instead of the
// decorated row db.js re-reads.
export const MARK_OFFLINE_SQL = `UPDATE listings
       SET offline = 1,
           offline_at = COALESCE(offline_at, ?),
           offline_confirmed = 0,
           last_event = 'offline',
           last_checked_at = ?,
           content_seq = IFNULL(content_seq, 0) + 1
       WHERE post_id = ?`;

export const MARK_OFFLINE_LEGACY_SQL = `UPDATE listings
       SET offline = 1,
           offline_at = COALESCE(offline_at, ?),
           offline_confirmed = 0,
           last_event = 'offline',
           last_checked_at = ?
       WHERE post_id = ?`;

export const RESTORE_ONLINE_SQL = `UPDATE listings
       SET offline = 0,
           offline_at = NULL,
           offline_confirmed = 0,
           last_checked_at = ?,
           content_seq = IFNULL(content_seq, 0) + 1
       WHERE post_id = ?`;

export const RESTORE_ONLINE_LEGACY_SQL = `UPDATE listings
       SET offline = 0,
           offline_at = NULL,
           offline_confirmed = 0,
           last_checked_at = ?
       WHERE post_id = ?`;

export const MARK_ALIVE_SQL = `UPDATE listings
       SET alive_checked_at = ?,
           last_checked_at = ?,
           offline = CASE WHEN offline = 1 THEN 0 ELSE offline END,
           offline_at = CASE WHEN offline = 1 THEN NULL ELSE offline_at END,
           offline_confirmed = 0,
           content_seq = IFNULL(content_seq, 0) + 1
       WHERE post_id = ?`;

export const MARK_ALIVE_LEGACY_SQL = `UPDATE listings
       SET alive_checked_at = ?,
           last_checked_at = ?,
           offline = CASE WHEN offline = 1 THEN 0 ELSE offline END,
           offline_at = CASE WHEN offline = 1 THEN NULL ELSE offline_at END,
           offline_confirmed = 0
       WHERE post_id = ?`;

export const TOUCH_CHECKED_SQL = "UPDATE listings SET last_checked_at = ? WHERE post_id = ?";
export const CLEAR_ROUTE_JOBS_SQL = "DELETE FROM route_jobs WHERE post_id = ?";

// Mirrors db.js's `try { wide } catch { legacy }` shape: a store without content_seq still works.
async function runWithLegacyFallback(exec, sql, legacySql, params, legacyParams) {
  try {
    await exec(sql, params);
  } catch {
    await exec(legacySql, legacyParams);
  }
}

export async function markListingOffline(exec, postId, { now = new Date().toISOString() } = {}) {
  const id = Number(postId) || 0;
  if (!id) return { postId: 0, offline: false };
  await runWithLegacyFallback(exec, MARK_OFFLINE_SQL, MARK_OFFLINE_LEGACY_SQL, [now, now, id], [now, now, id]);
  return { postId: id, offline: true, at: now };
}

export async function restoreListingOnline(exec, postId, { now = new Date().toISOString() } = {}) {
  const id = Number(postId) || 0;
  if (!id) return { postId: 0, offline: false };
  await runWithLegacyFallback(exec, RESTORE_ONLINE_SQL, RESTORE_ONLINE_LEGACY_SQL, [now, id], [now, id]);
  return { postId: id, offline: false, at: now };
}

export async function markListingAlive(exec, postId, { now = new Date().toISOString(), wasOffline = false } = {}) {
  const id = Number(postId) || 0;
  if (!id) return { postId: 0, restored: false };
  await runWithLegacyFallback(exec, MARK_ALIVE_SQL, MARK_ALIVE_LEGACY_SQL, [now, now, id], [now, now, id]);
  return { postId: id, restored: Boolean(wasOffline), at: now };
}

export async function touchListingChecked(exec, postId, { now = new Date().toISOString() } = {}) {
  const id = Number(postId) || 0;
  if (!id) return { postId: 0 };
  await exec(TOUCH_CHECKED_SQL, [now, id]);
  return { postId: id, at: now };
}

// db.js invalidateListingLocation(): the durable part. The SQLite twin also clears its in-process
// route-cache memo; in PostgreSQL mode the route cache is read per request, so there is nothing
// to clear here.
export async function clearRouteJobs(exec, postId) {
  const id = Number(postId) || 0;
  if (!id) return { postId: 0, cleared: false };
  await exec(CLEAR_ROUTE_JOBS_SQL, [id]);
  return { postId: id, cleared: true };
}

