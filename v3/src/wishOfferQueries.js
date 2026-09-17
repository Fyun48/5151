/** Owner / tenant offer lists。opaque cursor，不把 internal keys 放進 client token。 */

import { randomBytes } from "node:crypto";
import {
  assertWishOfferEnabled,
  clearWishOfferCursors,
  OFFER_CURSOR_MAX,
  OFFER_CURSOR_TTL_MS,
  OFFER_PAGE_DEFAULT,
  OFFER_PAGE_MAX,
  OFFER_SNAPSHOT_MAX,
  offerHttpError,
  publicOfferView,
} from "./wishOffers.js";

const snapshots = new Map();
const cursors = new Map();

export function resetWishOfferQueryCursors() {
  snapshots.clear();
  cursors.clear();
  clearWishOfferCursors();
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return OFFER_PAGE_DEFAULT;
  return Math.min(OFFER_PAGE_MAX, Math.max(1, Math.round(n)));
}

function evict(map, max) {
  while (map.size > max) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

function createSnapshot(items) {
  evict(snapshots, OFFER_SNAPSHOT_MAX);
  const id = randomBytes(12).toString("base64url");
  snapshots.set(id, {
    items,
    expires: Date.now() + OFFER_CURSOR_TTL_MS,
  });
  return id;
}

function createCursor(snapshotId, afterIndex) {
  evict(cursors, OFFER_CURSOR_MAX);
  const token = randomBytes(24).toString("base64url");
  cursors.set(token, {
    snapshotId,
    afterIndex,
    expires: Date.now() + OFFER_CURSOR_TTL_MS,
  });
  return token;
}

function consumeCursor(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const row = cursors.get(raw);
  cursors.delete(raw);
  if (!row || row.expires <= Date.now()) return null;
  const snap = snapshots.get(row.snapshotId);
  if (!snap || snap.expires <= Date.now()) return null;
  return { items: snap.items, afterIndex: row.afterIndex, snapshotId: row.snapshotId };
}

function pageFromItems(items, afterIndex, limit) {
  const size = clampLimit(limit);
  const start = Math.max(0, Number(afterIndex) || 0);
  const slice = items.slice(start, start + size);
  const nextIndex = start + slice.length;
  return {
    items: slice,
    total: items.length,
    next_cursor: nextIndex < items.length ? { snapshotId: null, afterIndex: nextIndex } : null,
  };
}

function applyCursor(allItems, cursor, limit) {
  if (cursor) {
    const stored = consumeCursor(cursor);
    if (!stored) throw offerHttpError("分頁已過期，請重新查詢", 400, "cursor_expired");
    const page = pageFromItems(stored.items, stored.afterIndex, limit);
    return {
      items: page.items,
      total: page.total,
      next_cursor: page.next_cursor
        ? createCursor(stored.snapshotId, page.next_cursor.afterIndex)
        : "",
    };
  }
  const snapshotId = createSnapshot(allItems);
  const page = pageFromItems(allItems, 0, limit);
  return {
    items: page.items,
    total: page.total,
    next_cursor: page.next_cursor
      ? createCursor(snapshotId, page.next_cursor.afterIndex)
      : "",
  };
}

function listOfferRows(db, { column, userId, status } = {}) {
  const uid = Number(userId) || 0;
  const params = [uid];
  let sql = `SELECT * FROM wish_offers WHERE ${column} = ?`;
  if (status) {
    sql += " AND status = ?";
    params.push(String(status));
  }
  sql += " ORDER BY created_at DESC, id DESC";
  return db.prepare(sql).all(...params);
}

export function listOwnerWishOffers(db, userId, { status, limit, cursor } = {}) {
  assertWishOfferEnabled();
  const rows = listOfferRows(db, { column: "owner_user_id", userId, status });
  const views = rows.map((row) => publicOfferView(db, row, userId)).filter(Boolean);
  const page = applyCursor(views, cursor, limit);
  return {
    role: "owner",
    total: page.total,
    limit: clampLimit(limit),
    next_cursor: page.next_cursor,
    items: page.items,
  };
}

export function listTenantWishOffers(db, userId, { status, limit, cursor } = {}) {
  assertWishOfferEnabled();
  const rows = listOfferRows(db, { column: "tenant_user_id", userId, status });
  const views = rows.map((row) => publicOfferView(db, row, userId)).filter(Boolean);
  const page = applyCursor(views, cursor, limit);
  return {
    role: "tenant",
    total: page.total,
    limit: clampLimit(limit),
    pending_count: rows.filter((row) => row.status === "pending").length,
    next_cursor: page.next_cursor,
    items: page.items,
  };
}

export function pendingInboxCount(db, userId) {
  return Number(db.prepare(
    "SELECT COUNT(*) AS n FROM wish_offers WHERE tenant_user_id = ? AND status = 'pending'",
  ).get(Number(userId) || 0)?.n) || 0;
}

export function ownerOfferMeta() {
  return {
    enabled: true,
  };
}
