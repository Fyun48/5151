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

