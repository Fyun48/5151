/** 同物件群組：穩定 group_id、主物件排序、摺疊與關注／通知綁定。 */

import { createHash } from "node:crypto";
import { publicSameHousePeer } from "./listingCompare.js";
import { preferPrimaryListing, sortGroupListings } from "./match.js";

export const GROUP_VISIBLE_SOURCES = 3;

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

export function bindListingsToGroup(db, listings, { evidence = {}, confidence = 0.8, now = new Date() } = {}) {
  const rows = (listings || []).filter((row) => Number(row?.post_id));
  if (rows.length < 2) return null;
  const existing = [];
  for (const row of rows) {
    const gid = groupIdForPost(db, row.post_id);
    if (gid) existing.push(gid);
  }
  const unique = [...new Set(existing)];
  const groupId = unique[0] || makeGroupId(rows.map((r) => Number(r.post_id)).sort((a, b) => a - b).join(":"));
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
    for (const old of unique.slice(1)) {
      db.prepare("UPDATE listing_group_members SET group_id = ? WHERE group_id = ?").run(groupId, old);
      db.prepare("DELETE FROM listing_groups WHERE group_id = ?").run(old);
    }
  }
  refreshGroupPrimary(db, groupId, now);
  return groupId;
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

export function alreadyNotifiedGroup(db, userId, groupId, type) {
  if (!groupId) return false;
  const row = db.prepare(
    "SELECT id FROM user_events WHERE user_id = ? AND group_id = ? AND type = ? LIMIT 1",
  ).get(Number(userId), groupId, type);
  return Boolean(row);
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
