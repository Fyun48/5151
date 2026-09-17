/** Tenant → owner block（PR C）。repo 原本沒有 user-to-user block，這是第一套，不是第二套。 */

import { randomBytes } from "node:crypto";

export function newBlockToken() {
  return randomBytes(18).toString("base64url");
}

export function ensureUserBlockSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_token TEXT NOT NULL UNIQUE,
      blocker_user_id INTEGER NOT NULL,
      blocked_user_id INTEGER NOT NULL,
      context TEXT NOT NULL DEFAULT 'wish_offer',
      offer_id INTEGER,
      listing_id INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE (blocker_user_id, blocked_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
      ON user_blocks(blocked_user_id, blocker_user_id);
    CREATE INDEX IF NOT EXISTS idx_user_blocks_token
      ON user_blocks(public_token);
  `);
}

export function isBlocked(db, blockerUserId, blockedUserId) {
  const a = Number(blockerUserId) || 0;
  const b = Number(blockedUserId) || 0;
  if (!a || !b) return false;
  return Boolean(
    db.prepare(
      "SELECT id FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?",
    ).get(a, b),
  );
}

export function tenantBlocksOwner(db, tenantUserId, ownerUserId) {
  return isBlocked(db, tenantUserId, ownerUserId);
}

export function insertUserBlock(db, {
  blockerUserId,
  blockedUserId,
  context = "wish_offer",
  offerId = null,
  listingId = null,
  now = new Date(),
} = {}) {
  const blocker = Number(blockerUserId) || 0;
  const blocked = Number(blockedUserId) || 0;
  if (!blocker || !blocked || blocker === blocked) return null;
  const existing = db.prepare(
    "SELECT * FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?",
  ).get(blocker, blocked);
  if (existing) return existing;
  const token = newBlockToken();
  const created = now instanceof Date ? now.toISOString() : String(now);
  try {
    db.prepare(
      `INSERT INTO user_blocks(public_token, blocker_user_id, blocked_user_id, context, offer_id, listing_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(token, blocker, blocked, String(context || "wish_offer"), offerId || null, listingId || null, created);
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) {
      return db.prepare(
        "SELECT * FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?",
      ).get(blocker, blocked);
    }
    throw error;
  }
  return db.prepare(
    "SELECT * FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?",
  ).get(blocker, blocked);
}

export function listBlocksForUser(db, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  return db.prepare(
    "SELECT * FROM user_blocks WHERE blocker_user_id = ? ORDER BY created_at DESC, id DESC",
  ).all(uid);
}

export function loadOwnedBlock(db, userId, blockRef) {
  const token = String(blockRef || "").trim();
  if (!token || /^\d+$/.test(token)) return null;
  const row = db.prepare("SELECT * FROM user_blocks WHERE public_token = ?").get(token);
  if (!row || Number(row.blocker_user_id) !== Number(userId)) return null;
  return row;
}

export function removeUserBlock(db, userId, blockRef) {
  const row = loadOwnedBlock(db, userId, blockRef);
  if (!row) return null;
  if (String(row.context || "") === "moderation") return { forbidden: true, row };
  db.prepare("DELETE FROM user_blocks WHERE id = ? AND blocker_user_id = ?").run(row.id, Number(userId));
  return { ok: true, row };
}
