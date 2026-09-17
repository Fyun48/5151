/** Owner / tenant offer lists。DB keyset pagination，cursor 只綁 query identity + immutable boundary。 */

import { randomBytes } from "node:crypto";
import {
  assertWishOfferEnabled,
  clearWishOfferCursors,
  OFFER_CURSOR_MAX,
  OFFER_CURSOR_TTL_MS,
  OFFER_PAGE_DEFAULT,
  OFFER_PAGE_MAX,
  offerHttpError,
  publicOfferView,
} from "./wishOffers.js";

const cursors = new Map();

let lastListStats = {
  fetched: 0,
  projected: 0,
  counted: false,
  pending_counted: false,
  count_queries: 0,
  total: 0,
  pending_count: 0,
};

export function resetWishOfferQueryCursors() {
  cursors.clear();
  clearWishOfferCursors();
  lastListStats = {
    fetched: 0,
    projected: 0,
    counted: false,
    pending_counted: false,
    count_queries: 0,
    total: 0,
    pending_count: 0,
  };
}

export function lastWishOfferListStats() {
  return { ...lastListStats };
}

export function wishOfferQueryMemory() {
  return { cursors: cursors.size, snapshots: 0 };
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

function createKeysetCursor({
  role,
  userId,
  status,
  afterCreatedAt,
  afterId,
  total,
  pendingCount,
}) {
  evict(cursors, OFFER_CURSOR_MAX);
  const token = randomBytes(24).toString("base64url");
  cursors.set(token, {
    role,
    userId: Number(userId) || 0,
    status: String(status || ""),
    afterCreatedAt: String(afterCreatedAt || ""),
    afterId: Number(afterId) || 0,
    total: Number(total) || 0,
    pendingCount: pendingCount == null ? null : Number(pendingCount) || 0,
    expires: Date.now() + OFFER_CURSOR_TTL_MS,
  });
  return token;
}

function consumeKeysetCursor(token, expected) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const row = cursors.get(raw);
  cursors.delete(raw);
  if (!row || row.expires <= Date.now()) {
    throw offerHttpError("分頁已過期，請重新查詢", 400, "cursor_expired");
  }
  const sameIdentity = row.role === expected.role
    && Number(row.userId) === Number(expected.userId)
    && String(row.status || "") === String(expected.status || "");
  if (!sameIdentity || !row.afterCreatedAt || !row.afterId) {
    throw offerHttpError("分頁已過期，請重新查詢", 400, "cursor_expired");
  }
  return row;
}

function countOfferRows(db, { column, userId, status } = {}) {
  const uid = Number(userId) || 0;
  const params = [uid];
  let sql = `SELECT COUNT(*) AS n FROM wish_offers WHERE ${column} = ?`;
  if (status) {
    sql += " AND status = ?";
    params.push(String(status));
  }
  return Number(db.prepare(sql).get(...params)?.n) || 0;
}

function listOfferPageRows(db, {
  column,
  userId,
  status,
  afterCreatedAt,
  afterId,
  limit,
} = {}) {
  const uid = Number(userId) || 0;
  const size = clampLimit(limit);
  const params = [uid];
  let sql = `SELECT * FROM wish_offers WHERE ${column} = ?`;
  if (status) {
    sql += " AND status = ?";
    params.push(String(status));
  }
  if (afterCreatedAt && afterId) {
    sql += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    params.push(String(afterCreatedAt), String(afterCreatedAt), Number(afterId));
  }
  sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
  params.push(size + 1);
  return db.prepare(sql).all(...params);
}

function listWishOffers(db, {
  role,
  column,
  userId,
  status,
  limit,
  cursor,
  includePendingCount = false,
} = {}) {
  assertWishOfferEnabled();
  const size = clampLimit(limit);
  const identity = { role, userId, status: status || "" };
  const boundary = cursor ? consumeKeysetCursor(cursor, identity) : null;
  let counted = false;
  let pendingCounted = false;
  let countQueries = 0;
  let total;
  let pendingCount = 0;
  if (boundary) {
    total = Number(boundary.total) || 0;
    pendingCount = includePendingCount ? Number(boundary.pendingCount) || 0 : 0;
  } else {
    total = countOfferRows(db, { column, userId, status });
    counted = true;
    countQueries += 1;
    if (includePendingCount) {
      pendingCount = pendingInboxCount(db, userId);
      pendingCounted = true;
      countQueries += 1;
    }
  }
  const rows = listOfferPageRows(db, {
    column,
    userId,
    status,
    afterCreatedAt: boundary?.afterCreatedAt,
    afterId: boundary?.afterId,
    limit: size,
  });
  const pageRows = rows.slice(0, size);
  const views = pageRows.map((row) => publicOfferView(db, row, userId)).filter(Boolean);
  lastListStats = {
    fetched: rows.length,
    projected: views.length,
    counted,
    pending_counted: pendingCounted,
    count_queries: countQueries,
    total,
    pending_count: pendingCount,
  };
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = rows.length > size && lastRow
    ? createKeysetCursor({
      role,
      userId,
      status,
      afterCreatedAt: lastRow.created_at,
      afterId: lastRow.id,
      total,
      pendingCount: includePendingCount ? pendingCount : null,
    })
    : "";
  const result = {
    role,
    total,
    limit: size,
    next_cursor: nextCursor,
    items: views,
  };
  if (includePendingCount) result.pending_count = pendingCount;
  return result;
}

export function listOwnerWishOffers(db, userId, { status, limit, cursor } = {}) {
  return listWishOffers(db, {
    role: "owner",
    column: "owner_user_id",
    userId,
    status,
    limit,
    cursor,
  });
}

export function listTenantWishOffers(db, userId, { status, limit, cursor } = {}) {
  return listWishOffers(db, {
    role: "tenant",
    column: "tenant_user_id",
    userId,
    status,
    limit,
    cursor,
    includePendingCount: true,
  });
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
