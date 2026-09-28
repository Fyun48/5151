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

// 三個查詢抽成介面：同步版（吃 handle）與 PG 版（吃注入式 runner，見 wishOffersAsync.js）
// 共用下面**同一段**分頁／游標／統計邏輯。語句文字不變——PG 版只是換人跑。
export function syncOfferListQueries(db) {
  return {
    count: ({ column, userId, status }) => countOfferRows(db, { column, userId, status }),
    page: ({ column, userId, status, afterCreatedAt, afterId, limit }) => (
      listOfferPageRows(db, { column, userId, status, afterCreatedAt, afterId, limit })
    ),
    pendingCount: (userId) => pendingInboxCount(db, userId),
    // 每一列的投影：同步版直接呼叫 `publicOfferView(db, row, userId)`。
    project: (row, userId) => publicOfferView(db, row, userId),
  };
}

// ⚠️ 共用主體是 **async**：查詢與投影都走 `await queries.*`。
// 同步版的 `queries` 只是把同步結果包成 resolved promise，所以兩邊跑的是**同一段**
// 分頁／游標／統計邏輯（不是兩份）。`publicOfferView()` 本身是純轉換，同步路徑不會因此變慢
// ——它只多了一層 microtask。
export async function listWishOffersWith(queries, {
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
    total = await queries.count({ column, userId, status });
    counted = true;
    countQueries += 1;
    if (includePendingCount) {
      pendingCount = await queries.pendingCount(userId);
      pendingCounted = true;
      countQueries += 1;
    }
  }
  const rows = await queries.page({
    column,
    userId,
    status,
    afterCreatedAt: boundary?.afterCreatedAt,
    afterId: boundary?.afterId,
    limit: size,
  });
  const pageRows = rows.slice(0, size);
  const views = [];
  for (const row of pageRows) {
    const view = await queries.project(row, userId);
    if (view) views.push(view);
  }
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

// 同步版：把同步查詢包成 resolved promise，共用上面那一段 async 主體。
export function syncOfferPagedQueries(db) {
  const q = syncOfferListQueries(db);
  return {
    count: (a) => Promise.resolve(q.count(a)),
    page: (a) => Promise.resolve(q.page(a)),
    pendingCount: (u) => Promise.resolve(q.pendingCount(u)),
    project: (row, u) => Promise.resolve(q.project(row, u)),
  };
}

export function listOwnerWishOffers(db, userId, { status, limit, cursor } = {}) {
  return listWishOffersWith(syncOfferPagedQueries(db), {
    role: "owner",
    column: "owner_user_id",
    userId,
    status,
    limit,
    cursor,
  });
}

export function listTenantWishOffers(db, userId, { status, limit, cursor } = {}) {
  return listWishOffersWith(syncOfferPagedQueries(db), {
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
