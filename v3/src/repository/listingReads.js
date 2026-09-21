// Listing catalogue reads used by the crawler (PostgreSQL hot path).
//
// The crawler's change detection is "read the row I am about to update, then look for the same
// fingerprint under a different post_id". Both reads were bound to the synchronous SQLite
// handle (db.js `getListing` / `findBySourceKey`), which is exactly the split that makes
// DB_DRIVER=postgres dangerous: the crawler would write through PostgreSQL and then read its own
// rows back from SQLite, so every crawl would look like a brand-new listing.
//
// This module restates the fingerprint read against an injected `exec`, keeping the statement
// text and the personal-flag overlay identical to db.js findBySourceKey().
import { overlayRowsPersonal } from "../personalFlags.js";
import { loadAnyoneFlagMap } from "./decorationData.js";

// `SELECT * FROM listings WHERE source_key = ? AND post_id != ? ORDER BY last_seen_at DESC`
// (db.js findBySourceKey), plus the "anyone has flagged this" overlay the SQLite version applies.
export async function findBySourceKey(exec, { sourceKey, excludePostId = 0 } = {}) {
  const key = String(sourceKey || "");
  if (!key) return [];
  const rows = await exec(
    "SELECT * FROM listings WHERE source_key = ? AND post_id != ? ORDER BY last_seen_at DESC",
    [key, Number(excludePostId) || 0],
  );
  if (!rows?.length) return [];
  const anyone = await loadAnyoneFlagMap(exec);
  return overlayRowsPersonal(rows, anyone);
}

// db.js listMatchCandidates(): the same-house match candidates `classify()` scores. The blocking
// query and the post-filter come from the dependency bundle db.js publishes as
// crawlerReadsBuildContext() (same statement text as the SQLite path; the filter is pure JS).
export async function listMatchCandidates(exec, { deps, excludePostId = 0, incoming = null } = {}) {
  const context = deps || {};
  const pid = Number(excludePostId) || 0;
  const anyone = await loadAnyoneFlagMap(exec);
  if (incoming && typeof context.blockMatchCandidatesQuery === "function") {
    const { sql, params } = context.blockMatchCandidatesQuery(context.sqliteDb, {
      ...incoming,
      post_id: incoming.post_id || pid,
    });
    if (sql) {
      const blocked = context.filterBlockMatchRows(incoming, await exec(sql, params));
      if (blocked.length) return overlayRowsPersonal(blocked, anyone);
    }
  }
  const { sql, params } = context.matchCandidateQuery(context.sqliteDb, pid, incoming);
  return overlayRowsPersonal(await exec(sql, params), anyone);
}

