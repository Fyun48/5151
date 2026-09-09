/** 同物件群組：穩定 group_id、主物件排序、摺疊與關注／通知綁定。
 *
 * 群組合併時選最早建立、再以 group_id 字典序的 canonical id。
 * 作用中的 `user_listing_flags.watch_group_id` 與 `user_events.group_id`
 * 一併遷到 canonical（事件當歷史列保留，但 group_id 正規化，去重／關注
 * 不再依賴已刪除的 loser id）。未關注列的 watch_group_id 不搬。
 */

import { createHash } from "node:crypto";
import { publicSameHousePeer } from "./listingCompare.js";
import { preferPrimaryListing, sortGroupListings } from "./match.js";

function sameNotifyDetail(previous, next) {
  if (previous == null) return false;
  return String(previous).replace(/\s+/g, "") === String(next ?? "").replace(/\s+/g, "");
}

export const GROUP_VISIBLE_SOURCES = 3;
/** 群組通知只對這些類型採「終身一次」；其餘依語意 detail 去重。 */
export const ONCE_EVER_GROUP_NOTIFY_TYPES = Object.freeze(["new"]);

function runInTransaction(db, fn) {
  if (typeof db.transaction === "function") return db.transaction(fn)();
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
}

export function makeGroupId(seed) {
  const raw = String(seed || "").trim() || `g-${Date.now()}`;
  return `lg_${createHash("sha256").update(raw).digest("hex").slice(0, 20)}`;
}

export function ensureListingGroupSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_groups (
      group_id TEXT PRIMARY KEY,
      primary_post_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS listing_group_members (
      post_id INTEGER PRIMARY KEY,
      group_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      match_confidence REAL,
      match_evidence TEXT NOT NULL DEFAULT '{}',
      joined_at TEXT NOT NULL,
      FOREIGN KEY (group_id) REFERENCES listing_groups(group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_listing_group_members_group ON listing_group_members(group_id);
  `);
  for (const sql of [
    "ALTER TABLE user_listing_flags ADD COLUMN watch_group_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE user_events ADD COLUMN group_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE user_events ADD COLUMN notify_profile_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE user_events ADD COLUMN notify_profile_version INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { db.exec(sql); } catch { /* already migrated */ }
  }
}

export function groupIdForPost(db, postId) {
  const row = db.prepare("SELECT group_id FROM listing_group_members WHERE post_id = ?").get(Number(postId));
  return row?.group_id || "";
}

export function listGroupMembers(db, groupId) {
  if (!groupId) return [];
  return db.prepare(`
    SELECT l.*, m.group_id, m.match_confidence, m.match_evidence
    FROM listing_group_members m
    JOIN listings l ON l.post_id = m.post_id
    WHERE m.group_id = ?
  `).all(groupId);
}

function stamp(now) {
  return (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
}

export function pickCanonicalGroupId(db, groupIds) {
  const ids = [...new Set((groupIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (ids.length <= 1) return ids[0] || "";
  const rows = db.prepare(
    `SELECT group_id, created_at FROM listing_groups WHERE group_id IN (${ids.map(() => "?").join(",")})`,
  ).all(...ids);
  const createdAt = new Map(rows.map((row) => [row.group_id, String(row.created_at || "")]));
  return ids.slice().sort((a, b) => {
    const ca = createdAt.get(a) || "";
    const cb = createdAt.get(b) || "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a < b ? -1 : 1;
  })[0];
}

function migrateGroupBindings(db, loserIds, winnerId) {
  const losers = [...new Set((loserIds || []).filter((id) => id && id !== winnerId))];
  if (!winnerId || !losers.length) return;
  const marks = losers.map(() => "?").join(",");
  // Required on the production schema. Failures must propagate so the
  // enclosing merge transaction rolls back member moves and loser deletes.
  db.prepare(
    `UPDATE user_listing_flags SET watch_group_id = ? WHERE watched = 1 AND watch_group_id IN (${marks})`,
  ).run(winnerId, ...losers);
  db.prepare(
    `UPDATE user_events SET group_id = ? WHERE group_id IN (${marks})`,
  ).run(winnerId, ...losers);
}

export function bindListingsToGroup(db, listings, { evidence = {}, confidence = 0.8, now = new Date() } = {}) {
  const rows = (listings || []).filter((row) => Number(row?.post_id));
  if (rows.length < 2) return null;
  return runInTransaction(db, () => {
    const existing = [];
    for (const row of rows) {
      const gid = groupIdForPost(db, row.post_id);
      if (gid) existing.push(gid);
    }
    const unique = [...new Set(existing)];
    const groupId = pickCanonicalGroupId(db, unique)
      || makeGroupId(rows.map((r) => Number(r.post_id)).sort((a, b) => a - b).join(":"));
    const created = stamp(now);
    db.prepare(`
      INSERT INTO listing_groups(group_id, primary_post_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(groupId, Number(rows[0].post_id), created, created);
    const ev = JSON.stringify(evidence || {});
    for (const row of rows) {
      db.prepare(`
        INSERT INTO listing_group_members(post_id, group_id, source, match_confidence, match_evidence, joined_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(post_id) DO UPDATE SET
          group_id = excluded.group_id,
          source = CASE WHEN excluded.source != '' THEN excluded.source ELSE listing_group_members.source END,
          match_confidence = COALESCE(excluded.match_confidence, listing_group_members.match_confidence),
          match_evidence = excluded.match_evidence
      `).run(Number(row.post_id), groupId, String(row.source || ""), confidence, ev, created);
    }
    if (unique.length > 1) {
      const losers = unique.filter((id) => id !== groupId);
      for (const old of losers) {
        db.prepare("UPDATE listing_group_members SET group_id = ? WHERE group_id = ?").run(groupId, old);
      }
      migrateGroupBindings(db, losers, groupId);
      for (const old of losers) {
        db.prepare("DELETE FROM listing_groups WHERE group_id = ?").run(old);
      }
    }
    refreshGroupPrimary(db, groupId, now);
    return groupId;
  });
}

export function refreshGroupPrimary(db, groupId, now = new Date()) {
  const members = listGroupMembers(db, groupId);
  if (!members.length) return null;
  const primary = sortGroupListings(members, now instanceof Date ? now.getTime() : Number(now) || Date.now())[0];
  db.prepare("UPDATE listing_groups SET primary_post_id = ?, updated_at = ? WHERE group_id = ?")
    .run(Number(primary.post_id), stamp(now), groupId);
  return primary;
}

export function collapseGroupSources(members, now = Date.now()) {
  const ordered = sortGroupListings(members, now);
  const visible = ordered.slice(0, GROUP_VISIBLE_SOURCES);
  const collapsed = ordered.slice(GROUP_VISIBLE_SOURCES).map((row) => ({
    post_id: Number(row.post_id),
    title: row.title || "",
    source: String(row.source || "591"),
    source_label: row.source_label || "",
    url: row.url || "",
  }));
  const primary = ordered[0] || null;
  return {
    group_id: members.find((row) => row.group_id)?.group_id || "",
    primary_id: primary ? Number(primary.post_id) : 0,
    visible,
    collapsed,
    hidden_count: collapsed.length,
    fold_label: collapsed.length ? `另有 ${collapsed.length} 筆同物件來源` : "",
    peers: visible.filter((row) => Number(row.post_id) !== Number(primary?.post_id)).map(publicSameHousePeer),
  };
}

export function watchGroupIdForFlags(db, postId, fallbackGroupId = "") {
  return groupIdForPost(db, postId) || fallbackGroupId || "";
}

export function alreadyNotifiedGroup(db, userId, groupId, type, detail) {
  if (!groupId) return false;
  const uid = Number(userId);
  const kind = String(type || "");
  if (ONCE_EVER_GROUP_NOTIFY_TYPES.includes(kind)) {
    const row = db.prepare(
      "SELECT id FROM user_events WHERE user_id = ? AND group_id = ? AND type = ? LIMIT 1",
    ).get(uid, groupId, kind);
    return Boolean(row);
  }
  const rows = db.prepare(
    "SELECT detail FROM user_events WHERE user_id = ? AND group_id = ? AND type = ? ORDER BY id DESC",
  ).all(uid, groupId, kind);
  return rows.some((row) => sameNotifyDetail(row.detail, detail));
}

export function bindWatchToGroup(db, userId, postId) {
  const gid = groupIdForPost(db, postId);
  if (!gid) return "";
  try {
    db.prepare("UPDATE user_listing_flags SET watch_group_id = ? WHERE user_id = ? AND post_id = ?")
      .run(gid, Number(userId), Number(postId));
  } catch {
    // column may not exist in isolated tests
  }
  return gid;
}

export function watchedInGroup(db, userId, groupId) {
  if (!groupId) return false;
  const row = db.prepare(
    "SELECT 1 FROM user_listing_flags WHERE user_id = ? AND watch_group_id = ? AND watched = 1 LIMIT 1",
  ).get(Number(userId), groupId);
  return Boolean(row);
}

export { preferPrimaryListing };
