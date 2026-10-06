// 租屋通知 worker tick 的 driver-aware 入口（PG 島嶼，2026-10）。
//
// 為什麼需要：`runRentalNotifyTick(db=本機)` 同步讀寫節點 SQLite，PG 模式下
// 「投遞／抑制／重試／摘要／清理」只碰本機表 ⇒ PG 的 `rental_notify_deliveries` 永遠 pending。
//
// 事件「產生」已有 async 路徑（`emitRentalNotifyEventAsync`／`queueDeliveriesAsync`）；
// 這一支補上 worker 那一整輪：reminder／offer expiring／retention 的排程、摘要關桶、
// 投遞 drain、清理，以及屋主配對訂閱的 episode 簿記。決策函式（`reminderWindowForWish`、
// `preferenceAllows`、`channelAllowed`、`renderRentalNotify`）全部重用同步版，這裡只把
// 「誰去跑 SQL」換成注入式 runner。
//
// 交易語意：同步版用 `BEGIN IMMEDIATE … COMMIT` 包住整輪。真 PG 路徑用
// `pgDriver.withTransaction()` 對齊；注入式 exec（離線 parity 夾具）維持自動提交
// （夾具是單執行緒 SQLite，無並行）。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import {
  RENTAL_ATTRIBUTION_RETENTION_DAYS,
  RENTAL_DELIVERY_MAX_ATTEMPTS,
  RENTAL_DIGEST_MAX_ITEMS,
  RENTAL_EVENT_RETENTION_DAYS,
  RENTAL_NOTIFY_BATCH,
  LISTING_OWNER_SQL,
  currentRentalNotifyFlags,
  getRentalNotifySinks,
  isoWeekKey,
  newToken,
  reminderWindowForWish,
  renderRentalNotify,
  setRentalNotifyHydrate,
  taipeiDay,
} from "./rentalNotify.js";
import { runRentalNotifyTick } from "./rentalNotifyWorker.js";
import {
  isRentalDigestEnabled,
  isRentalNotificationsEnabled,
  isRentalOutboundMailEnabled,
  isRentalOutboundPushEnabled,
  isWishOwnerMatchingEnabled,
} from "./rentalMarketplaceFlags.js";
import { emitRentalNotifyEventAsync } from "./rentalNotifyWriteAsync.js";
import { ensureRentalNotifyWriteOnce } from "./rentalNotifyWriteAsync.js";
import { bumpAnalyticsAsync } from "./rentalAnalyticsAsync.js";
import { tenantBlocksOwnerAsync } from "./wishOffersAsync.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
const iso = (now = new Date()) => (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
function atMs(now = new Date()) {
  return now instanceof Date ? now.getTime() : (Number(now) || Date.now());
}

// worker 會碰到的表。events／deliveries／prefs 由 `ensureRentalNotifyWriteOnce` 負責
// （含它補的兩條唯一索引）；其餘表與 `rental_digest_items` 的唯一索引在這裡補。
export const RENTAL_NOTIFY_WORKER_TABLES = [
  "rental_notify_cursors",
  "rental_digest_buckets",
  "rental_digest_items",
  "rental_match_seen",
  "rental_match_subscriptions",
  "rental_share_events",
];
export const RENTAL_NOTIFY_WORKER_UNIQUE_INDEXES = [
  // `rental_digest_items(bucket_id, event_id)` 是 SQLite 的表約束，鏡射時抓不到（同本系列已踩四次）。
  "CREATE UNIQUE INDEX IF NOT EXISTS rental_digest_items_bucket_event_key ON rental_digest_items(bucket_id, event_id)",
];

const schemaReady = new WeakMap();
export async function ensureRentalNotifyWorkerOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = (async () => {
    await ensureRentalNotifyWriteOnce(pgDriver);
    await ensurePgSchema(pgDriver, sqliteHandle(), { tables: RENTAL_NOTIFY_WORKER_TABLES, indexes: false });
    for (const sql of RENTAL_NOTIFY_WORKER_UNIQUE_INDEXES) await pgDriver.exec(sql);
  })();
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
}

async function withFallback(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureRentalNotifyWorkerOnce(pgDriver);
    return await pgDriver.withTransaction(async (client) => {
      const exec = async (sql, params = []) => {
        const res = await client.query(toPostgresSql(sql), params);
        return normalizeResult(res);
      };
      return await runPostgres(exec);
    });
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    return runSqlite();
  }
}

// ── cursor（`rental_notify_cursors`，與 lifecycle worker 共用同一張表）─────────────────

export const CURSOR_SELECT_SQL = "SELECT last_id FROM rental_notify_cursors WHERE job = ?";
export const CURSOR_UPSERT_SQL = `INSERT INTO rental_notify_cursors(job, last_id, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(job) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at`;

export async function getNotifyCursorAsync(run, job) {
  return Number(one((await run(CURSOR_SELECT_SQL, [job])).rows)?.last_id) || 0;
}

export async function setNotifyCursorAsync(run, job, lastId, now) {
  await run(CURSOR_UPSERT_SQL, [job, Number(lastId) || 0, iso(now)]);
}

async function takeAfterCursorAsync(run, job, now, limit, selectFn) {
  const cap = Math.min(RENTAL_NOTIFY_BATCH, Math.max(1, Number(limit) || 80));
  const lastId = await getNotifyCursorAsync(run, job);
  let rows = await selectFn(lastId, cap);
  if (!rows.length && lastId > 0) rows = await selectFn(0, cap);
  if (rows.length) await setNotifyCursorAsync(run, job, rows[rows.length - 1].id, now);
  return rows;
}

// ── 投遞 drain ──────────────────────────────────────────────────────────────────────────

const DELIVER_DUE_SQL = `SELECT d.*, e.event_type, e.payload_json, e.subject_ref
  FROM rental_notify_deliveries d
  JOIN rental_notify_events e ON e.id = d.event_id
  WHERE d.status IN ('queued', 'retrying')
    AND (d.next_retry_at IS NULL OR d.next_retry_at <= ?)
  ORDER BY d.id ASC LIMIT ?`;

async function deliverOneAsync(run, row, now, sinks, options) {
  const copy = renderRentalNotify(row.event_type);
  const flags = currentRentalNotifyFlags();
  if (row.channel === "dock") {
    if (sinks.dockWriter) {
      sinks.dockWriter({
        user_id: row.user_id,
        post_id: 0,
        type: row.event_type,
        title: copy.title,
        detail: copy.detail,
        source_key: `rental:${row.event_id}`,
        created_at: iso(now),
        notified: 0,
      });
    }
  } else if (row.channel === "mail") {
    if (!isRentalOutboundMailEnabled(flags)) throw new Error("mail_channel_off");
    if (!sinks.mailSink) throw new Error("mail_no_provider");
    sinks.mailSink({
      user_id: row.user_id,
      event_id: row.event_id,
      event_type: row.event_type,
      title: copy.title,
      detail: copy.detail,
    });
  } else if (row.channel === "push") {
    if (!isRentalOutboundPushEnabled(flags)) throw new Error("push_channel_off");
    if (!sinks.pushSink) throw new Error("push_no_provider");
    sinks.pushSink({
      user_id: row.user_id,
      event_id: row.event_id,
      event_type: row.event_type,
      title: copy.title,
      detail: copy.detail,
    });
  } else {
    throw new Error("unknown_channel");
  }
  await run(
    `UPDATE rental_notify_deliveries
     SET status = 'delivered', attempt = attempt + 1, next_retry_at = NULL, last_error = '', updated_at = ?
     WHERE id = ?`,
    [iso(now), row.id],
  );
  await bumpAnalyticsAsync("notify_delivered", now, 1, options);
  await finalizeDigestIfDeliveredAsync(run, row, now);
}

async function finalizeDigestIfDeliveredAsync(run, row, now) {
  if (row.event_type !== "owner_match_digest_ready") return;
  await run(
    `UPDATE rental_digest_buckets
     SET status = 'delivered', delivered_at = ?
     WHERE event_id = ? AND status IN ('queued', 'open')`,
    [iso(now), row.event_id],
  );
}

async function deliverQueuedNotificationsAsync(run, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}, options = {}) {
  const stamp = iso(now);
  const rows = (await run(DELIVER_DUE_SQL, [stamp, Math.min(RENTAL_NOTIFY_BATCH, Math.max(1, Number(limit) || 80))])).rows;
  let delivered = 0;
  let failed = 0;
  const sinks = getRentalNotifySinks();
  for (const row of rows) {
    try {
      await deliverOneAsync(run, row, now, sinks, options);
      delivered += 1;
    } catch (error) {
      failed += 1;
      const attempt = Number(row.attempt || 0) + 1;
      const terminal = attempt >= RENTAL_DELIVERY_MAX_ATTEMPTS;
      const next = iso(new Date(atMs(now) + Math.min(6 * 3600_000, 60_000 * (2 ** attempt))));
      await run(
        `UPDATE rental_notify_deliveries
         SET status = ?, attempt = ?, next_retry_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        [terminal ? "terminal_failed" : "retrying", attempt, terminal ? null : next, String(error.message || "").slice(0, 180), stamp, row.id],
      );
      await bumpAnalyticsAsync(terminal ? "notify_failed" : "notify_retrying", now, 1, options);
    }
  }
  return { scanned: rows.length, delivered, failed };
}

// ── 排程：lifecycle reminder / offer expiring / retention ───────────────────────────────

async function scheduleLifecycleRemindersAsync(run, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}, options = {}) {
  if (!isRentalNotificationsEnabled(currentRentalNotifyFlags())) return { scanned: 0, emitted: 0 };
  const until = iso(new Date(atMs(now) + 4 * 86400000));
  const rows = await takeAfterCursorAsync(run, "lifecycle_reminders", now, limit, async (afterId, cap) => (await run(
    `SELECT id, user_id, public_token, lifecycle, expires_at, last_confirmed_at, last_active_at
     FROM demand_posts
     WHERE status = 'open'
       AND COALESCE(lifecycle, 'active') IN ('active', 'needs_confirmation')
       AND expires_at <= ?
       AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
    [until, afterId, cap],
  )).rows);
  let emitted = 0;
  for (const row of rows) {
    const type = reminderWindowForWish(row, now);
    if (!type) continue;
    const deadline = String(row.expires_at || "").slice(0, 10);
    const result = await emitRentalNotifyEventAsync({
      eventType: type,
      userId: row.user_id,
      eventKey: `${type}:${row.id}:${deadline}`,
      subjectType: "wish",
      subjectRef: row.public_token,
      now,
    }, options);
    if (result.emitted) emitted += 1;
  }
  return { scanned: rows.length, emitted };
}

async function scheduleOfferExpiringAsync(run, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}, options = {}) {
  if (!isRentalNotificationsEnabled(currentRentalNotifyFlags())) return { scanned: 0, emitted: 0 };
  const soon = iso(new Date(atMs(now) + 36 * 3600_000));
  const laterThan = iso(now);
  let rows;
  try {
    rows = await takeAfterCursorAsync(run, "offer_expiring", now, limit, async (afterId, cap) => (await run(
      `SELECT id, tenant_user_id, owner_user_id, public_token, listing_id, expires_at
       FROM wish_offers
       WHERE status = 'pending' AND expires_at > ? AND expires_at <= ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
      [laterThan, soon, afterId, cap],
    )).rows);
  } catch (error) {
    if (error?.code === "42P01" || /does not exist|no such table/i.test(String(error.message || ""))) {
      return { scanned: 0, emitted: 0, error: "wish_offers_unavailable" };
    }
    throw error;
  }
  let emitted = 0;
  for (const row of rows) {
    const deadline = String(row.expires_at || "").slice(0, 10);
    const result = await emitRentalNotifyEventAsync({
      eventType: "offer_expiring_soon",
      userId: row.tenant_user_id,
      eventKey: `offer_expiring_soon:${row.id}:${deadline}`,
      subjectType: "offer",
      subjectRef: row.public_token,
      listingId: row.listing_id,
      now,
    }, options);
    if (result.emitted) emitted += 1;
  }
  return { scanned: rows.length, emitted };
}

async function wishHasActiveOfferAsync(run, wishId) {
  return Boolean(one((await run(
    "SELECT 1 AS n FROM wish_offers WHERE wish_id = ? AND status IN ('pending', 'accepted') LIMIT 1",
    [Number(wishId) || 0],
  )).rows));
}

async function scheduleTenantRetentionAsync(run, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}, options = {}) {
  if (!isRentalNotificationsEnabled(currentRentalNotifyFlags())) return { scanned: 0, emitted: 0 };
  const quietBefore = iso(new Date(atMs(now) - 14 * 86400000));
  const week = isoWeekKey(now);
  const rows = await takeAfterCursorAsync(run, "tenant_retention", now, limit, async (afterId, cap) => (await run(
    `SELECT id, user_id, public_token, lifecycle, last_active_at
     FROM demand_posts
     WHERE status = 'open'
       AND COALESCE(lifecycle, 'active') = 'active'
       AND COALESCE(last_active_at, created_at) <= ?
       AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
    [quietBefore, afterId, cap],
  )).rows);
  let emitted = 0;
  let skippedPolicy = 0;
  for (const row of rows) {
    let hasOffer;
    try {
      hasOffer = await wishHasActiveOfferAsync(run, row.id);
    } catch {
      skippedPolicy += 1;
      continue;
    }
    if (hasOffer) continue;
    const result = await emitRentalNotifyEventAsync({
      eventType: "tenant_retention_quiet",
      userId: row.user_id,
      eventKey: `tenant_retention_quiet:${row.id}:${week}`,
      subjectType: "wish",
      subjectRef: row.public_token,
      now,
    }, options);
    if (result.emitted) emitted += 1;
  }
  return { scanned: rows.length, emitted, skipped_policy: skippedPolicy };
}

async function listingOpenForNotifyAsync(run, ownerUserId, listingId) {
  try {
    const row = one((await run(LISTING_OWNER_SQL, [Number(listingId) || 0])).rows);
    if (!row) return false;
    return Number(row.listed_by_user_id) === Number(ownerUserId) && String(row.self_status || "open") === "open";
  } catch {
    return false;
  }
}

async function scheduleOwnerRetentionAsync(run, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}, options = {}) {
  if (!isRentalNotificationsEnabled(currentRentalNotifyFlags())) return { scanned: 0, emitted: 0 };
  const week = isoWeekKey(now);
  const rows = await takeAfterCursorAsync(run, "owner_retention", now, limit, async (afterId, cap) => (await run(
    `SELECT id, owner_user_id, listing_id
     FROM rental_match_subscriptions
     WHERE mode IN ('instant', 'daily_digest') AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
    [afterId, cap],
  )).rows);
  const owners = new Map();
  for (const row of rows) {
    if (!(await listingOpenForNotifyAsync(run, row.owner_user_id, row.listing_id))) continue;
    if (!owners.has(row.owner_user_id)) owners.set(row.owner_user_id, row.listing_id);
  }
  let emitted = 0;
  for (const [userId, listingId] of owners) {
    const result = await emitRentalNotifyEventAsync({
      eventType: "owner_retention_matches",
      userId,
      eventKey: `owner_retention_matches:${userId}:${week}`,
      subjectType: "listing",
      subjectRef: String(listingId),
      listingId,
      now,
    }, options);
    if (result.emitted) emitted += 1;
  }
  return { scanned: rows.length, emitted };
}

// ── 摘要 ─────────────────────────────────────────────────────────────────────────────────

async function closeDigestBucketsAsync(run, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}, options = {}) {
  if (!isRentalDigestEnabled(currentRentalNotifyFlags())) return { closed: 0 };
  const yesterday = taipeiDay(new Date(atMs(now) - 86400000));
  const rows = (await run(
    "SELECT * FROM rental_digest_buckets WHERE status = 'open' AND bucket_date <= ? ORDER BY id ASC LIMIT ?",
    [yesterday, Math.min(RENTAL_NOTIFY_BATCH, Number(limit) || 80)],
  )).rows;
  let closed = 0;
  for (const row of rows) {
    const result = await emitRentalNotifyEventAsync({
      eventType: "owner_match_digest_ready",
      userId: row.user_id,
      eventKey: `owner_match_digest_ready:${row.public_token}`,
      subjectType: "digest",
      subjectRef: row.public_token,
      payload: { item_count: row.item_count, overflow_count: row.overflow_count },
      now,
    }, options);
    const eventId = Number(result.event_id) || 0;
    if (!eventId) continue;
    const queued = one((await run(
      "SELECT 1 AS n FROM rental_notify_deliveries WHERE event_id = ? AND status IN ('queued', 'retrying') LIMIT 1",
      [eventId],
    )).rows);
    const already = one((await run(
      "SELECT 1 AS n FROM rental_notify_deliveries WHERE event_id = ? AND status = 'delivered' LIMIT 1",
      [eventId],
    )).rows);
    const nextStatus = queued ? "queued" : already ? "delivered" : "suppressed";
    await run(
      "UPDATE rental_digest_buckets SET status = ?, event_id = ?, delivered_at = ? WHERE id = ?",
      [nextStatus, eventId, nextStatus === "delivered" ? iso(now) : null, row.id],
    );
    if (nextStatus === "queued" || nextStatus === "delivered") {
      closed += 1;
      await bumpAnalyticsAsync("digest_count", now, 1, options);
    }
  }
  return { closed, scanned: rows.length };
}

async function addDigestItemAsync(run, { userId, eventId, listingId, wishRef, now = new Date() } = {}, options = {}) {
  if (!isRentalDigestEnabled(currentRentalNotifyFlags())) return null;
  const day = taipeiDay(now);
  let bucket = one((await run(
    "SELECT * FROM rental_digest_buckets WHERE user_id = ? AND channel = 'dock' AND bucket_date = ? AND kind = 'owner_new_match'",
    [Number(userId), day],
  )).rows);
  if (!bucket) {
    await run(
      `INSERT INTO rental_digest_buckets(public_token, user_id, channel, bucket_date, kind, status, item_count, overflow_count, created_at)
       VALUES (?, ?, 'dock', ?, 'owner_new_match', 'open', 0, 0, ?)`,
      [newToken(), Number(userId), day, iso(now)],
    );
    bucket = one((await run(
      "SELECT * FROM rental_digest_buckets WHERE user_id = ? AND channel = 'dock' AND bucket_date = ? AND kind = 'owner_new_match'",
      [Number(userId), day],
    )).rows);
  }
  if (bucket.status !== "open") return bucket;
  if (Number(bucket.item_count) >= RENTAL_DIGEST_MAX_ITEMS) {
    await run("UPDATE rental_digest_buckets SET overflow_count = overflow_count + 1 WHERE id = ?", [bucket.id]);
    return one((await run("SELECT * FROM rental_digest_buckets WHERE id = ?", [bucket.id])).rows);
  }
  const inserted = await run(
    `INSERT INTO rental_digest_items(bucket_id, event_id, listing_ref, wish_ref, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(bucket_id, event_id) DO NOTHING`,
    [bucket.id, eventId, listingId, wishRef || "", iso(now)],
  );
  if (Number(inserted?.rowCount) > 0) {
    await run("UPDATE rental_digest_buckets SET item_count = item_count + 1 WHERE id = ?", [bucket.id]);
  }
  return one((await run("SELECT * FROM rental_digest_buckets WHERE id = ?", [bucket.id])).rows);
}

// ── 屋主配對訂閱的 episode 簿記 ─────────────────────────────────────────────────────────

const MATCHABLE_NOTIFY_LIFECYCLES = new Set(["active", "needs_confirmation"]);

async function pairIsBlockedForNotifyAsync(run, tenantUserId, ownerUserId) {
  const tenant = Number(tenantUserId) || 0;
  const owner = Number(ownerUserId) || 0;
  if (!tenant || !owner) return true;
  try {
    return await tenantBlocksOwnerAsync(run, tenant, owner);
  } catch {
    return true;
  }
}

async function resolveWishTenantIdAsync(run, item = {}) {
  const direct = Number(item.user_id || item.tenant_user_id || 0);
  if (direct) return direct;
  if (item.wish_id) {
    try {
      const row = one((await run("SELECT user_id FROM demand_posts WHERE id = ?", [Number(item.wish_id)])).rows);
      if (row) return Number(row.user_id) || 0;
    } catch {
      return 0;
    }
  }
  const ref = item.wish_ref || item.public_token || "";
  if (!ref) return 0;
  try {
    const row = one((await run("SELECT user_id FROM demand_posts WHERE public_token = ?", [String(ref)])).rows);
    return Number(row?.user_id) || 0;
  } catch {
    return 0;
  }
}

async function wishStillHardEligibleForNotifyAsync(run, ownerUserId, listingId, wishRef, hardGateFn) {
  let wish;
  try {
    wish = one((await run(
      "SELECT id, user_id, public_token, lifecycle, status FROM demand_posts WHERE public_token = ?",
      [String(wishRef || "")],
    )).rows);
  } catch {
    return false;
  }
  if (!wish) return false;
  if (await pairIsBlockedForNotifyAsync(run, wish.user_id, ownerUserId)) return false;
  const life = String(wish.lifecycle || "active");
  if (!MATCHABLE_NOTIFY_LIFECYCLES.has(life)) return false;
  if (String(wish.status || "") === "hidden") return false;
  if (String(wish.status || "") === "draft") return false;
  if (String(wish.status || "") === "closed" && life !== "needs_confirmation") return false;
  if (typeof hardGateFn !== "function") return true;
  try {
    return (await hardGateFn(listingId, ownerUserId, wishRef)) === true;
  } catch {
    return false;
  }
}

export async function openMatchEpisodeIfNeededAsync(run, ownerUserId, listingId, wishRef, now = new Date()) {
  const owner = Number(ownerUserId) || 0;
  const listing = Number(listingId) || 0;
  const ref = String(wishRef || "");
  if (!owner || !listing || !ref) return { notify: false, episode: 0 };
  const row = one((await run(
    "SELECT eligible, episode FROM rental_match_seen WHERE owner_user_id = ? AND listing_id = ? AND wish_ref = ?",
    [owner, listing, ref],
  )).rows);
  if (!row) {
    // ⚠️ 多節點 HA：兩台 web 各跑一支 tick、共享同一 PG，這一段是 SELECT-then-INSERT。
    // `rental_match_seen` 已有複合主鍵 (owner_user_id, listing_id, wish_ref) 擋重複，但若兩個
    // 節點同時命中「無 row」的同一組鍵，第二筆 INSERT 會以 23505 unique_violation 讓**整筆 tick
    // 交易回滾**（PG 撞唯一鍵＝交易進入 aborted，後續語句全失敗）。因此改成冪等 INSERT：
    // `ON CONFLICT DO NOTHING` 把「撞鍵」從例外降級為「沒寫入」；以 rowCount 判定誰贏，
    // 輸家重新讀取贏家剛寫入的那一筆，回報與單次呼叫一致的結果（不重複 notify）。
    const inserted = await run(
      `INSERT INTO rental_match_seen(owner_user_id, listing_id, wish_ref, generation, eligible, episode, created_at)
       VALUES (?, ?, ?, 0, 1, 1, ?)
       ON CONFLICT (owner_user_id, listing_id, wish_ref) DO NOTHING`,
      [owner, listing, ref, iso(now)],
    );
    if ((Number(inserted.rowCount) || 0) > 0) return { notify: true, episode: 1 };
    const winner = one((await run(
      "SELECT eligible, episode FROM rental_match_seen WHERE owner_user_id = ? AND listing_id = ? AND wish_ref = ?",
      [owner, listing, ref],
    )).rows);
    if (!winner) return { notify: false, episode: 0 };
    return { notify: false, episode: Number(winner.episode) || 1 };
  }
  if (Number(row.eligible) === 1) return { notify: false, episode: Number(row.episode) || 1 };
  const episode = (Number(row.episode) || 0) + 1;
  await run(
    "UPDATE rental_match_seen SET eligible = 1, episode = ? WHERE owner_user_id = ? AND listing_id = ? AND wish_ref = ?",
    [episode, owner, listing, ref],
  );
  return { notify: true, episode };
}

async function closeMatchEpisodeAsync(run, ownerUserId, listingId, wishRef) {
  await run(
    `UPDATE rental_match_seen SET eligible = 0
     WHERE owner_user_id = ? AND listing_id = ? AND wish_ref = ? AND eligible = 1`,
    [Number(ownerUserId) || 0, Number(listingId) || 0, String(wishRef || "")],
  );
}

async function markMissingMatchesIneligibleAsync(run, ownerUserId, listingId, eligibleWishRefs = []) {
  const keep = new Set((eligibleWishRefs || []).map((ref) => String(ref || "")).filter(Boolean));
  const rows = (await run(
    "SELECT wish_ref FROM rental_match_seen WHERE owner_user_id = ? AND listing_id = ? AND eligible = 1",
    [Number(ownerUserId) || 0, Number(listingId) || 0],
  )).rows;
  for (const row of rows) {
    if (!keep.has(String(row.wish_ref))) {
      await closeMatchEpisodeAsync(run, ownerUserId, listingId, row.wish_ref);
    }
  }
}

async function recheckSeenMatchEligibilityAsync(run, ownerUserId, listingId, {
  now = new Date(),
  limit = RENTAL_NOTIFY_BATCH,
  hardGateFn = null,
  listingOpen = true,
} = {}) {
  const owner = Number(ownerUserId) || 0;
  const listing = Number(listingId) || 0;
  if (!owner || !listing) return { scanned: 0, closed: 0 };
  // ⚠️ 同步版用 `rowid` 當游標（SQLite 特有）；PG 的 `rental_match_seen` 是複合主鍵、沒有 rowid。
  // 這裡改為「每次只掃該 owner＋listing 的 eligible 列（依 wish_ref 排序）」：close 本身冪等
  // （`AND eligible = 1`），單一 listing 的 seen 列數量很小 ⇒ 最終狀態與同步版相同。
  const cap = Math.min(RENTAL_NOTIFY_BATCH, Math.max(1, Number(limit) || 80));
  const rows = (await run(
    `SELECT wish_ref FROM rental_match_seen
     WHERE owner_user_id = ? AND listing_id = ? AND eligible = 1
     ORDER BY wish_ref ASC LIMIT ?`,
    [owner, listing, cap],
  )).rows;
  let closed = 0;
  for (const row of rows) {
    const still = listingOpen && (await wishStillHardEligibleForNotifyAsync(run, owner, listing, row.wish_ref, hardGateFn));
    if (still) continue;
    await closeMatchEpisodeAsync(run, owner, listing, row.wish_ref);
    closed += 1;
  }
  return { scanned: rows.length, closed };
}

async function listDueMatchSubscriptionsAsync(run, { limit = RENTAL_NOTIFY_BATCH, now = new Date() } = {}) {
  return takeAfterCursorAsync(run, "match_subscriptions", now, limit, async (afterId, cap) => (await run(
    `SELECT * FROM rental_match_subscriptions
     WHERE mode IN ('instant', 'daily_digest') AND id > ?
     ORDER BY id ASC LIMIT ?`,
    [afterId, cap],
  )).rows);
}

async function processMatchSubscriptionRowAsync(run, sub, page, now, flags, { hardGateFn = null } = {}, options = {}) {
  if (sub.mode === "off") return { emitted: 0 };
  const listingOpen = await listingOpenForNotifyAsync(run, sub.owner_user_id, sub.listing_id);
  if (page?.complete === true) {
    const refs = Array.isArray(page.eligible_refs)
      ? page.eligible_refs
      : (page.items || []).map((item) => item.wish_ref || item.public_token || "").filter(Boolean);
    await markMissingMatchesIneligibleAsync(run, sub.owner_user_id, sub.listing_id, listingOpen ? refs : []);
  } else {
    await recheckSeenMatchEligibilityAsync(run, sub.owner_user_id, sub.listing_id, { now, hardGateFn, listingOpen });
  }
  if (!listingOpen) return { emitted: 0 };
  const items = (page?.items || []).slice(0, 20);
  let emitted = 0;
  for (const item of items) {
    const wishRef = item.wish_ref || item.public_token || "";
    if (!wishRef) continue;
    const tenantId = await resolveWishTenantIdAsync(run, item);
    if (await pairIsBlockedForNotifyAsync(run, tenantId, sub.owner_user_id)) {
      await closeMatchEpisodeAsync(run, sub.owner_user_id, sub.listing_id, wishRef);
      continue;
    }
    if (!(await wishStillHardEligibleForNotifyAsync(run, sub.owner_user_id, sub.listing_id, wishRef, hardGateFn))) {
      await closeMatchEpisodeAsync(run, sub.owner_user_id, sub.listing_id, wishRef);
      continue;
    }
    const episode = await openMatchEpisodeIfNeededAsync(run, sub.owner_user_id, sub.listing_id, wishRef, now);
    if (!episode.notify) continue;
    const result = await emitRentalNotifyEventAsync({
      eventType: "owner_new_match_available",
      userId: sub.owner_user_id,
      eventKey: `owner_new_match_available:${sub.owner_user_id}:${sub.listing_id}:${wishRef}:${episode.episode}`,
      subjectType: "wish",
      subjectRef: wishRef,
      listingId: sub.listing_id,
      payload: { listing_ref: sub.listing_id, episode: episode.episode },
      now,
      queue: sub.mode === "instant",
    }, options);
    if (result.emitted) {
      emitted += 1;
      if (sub.mode === "daily_digest" && isRentalDigestEnabled(flags) && result.event_id) {
        await addDigestItemAsync(run, {
          userId: sub.owner_user_id,
          eventId: result.event_id,
          listingId: sub.listing_id,
          wishRef,
          now,
        }, options);
      }
    }
  }
  return { emitted };
}

async function processMatchSubscriptionsAsync(run, now, { limit, flags, matchFn, hardGateFn } = {}, options = {}) {
  if (!isWishOwnerMatchingEnabled(flags) || typeof matchFn !== "function") {
    return { scanned: 0, emitted: 0 };
  }
  const rows = await listDueMatchSubscriptionsAsync(run, { limit, now });
  let emitted = 0;
  for (const sub of rows) {
    let page;
    try {
      page = (await matchFn(sub.listing_id, sub.owner_user_id)) || { items: [] };
    } catch {
      continue;
    }
    emitted += (await processMatchSubscriptionRowAsync(run, sub, page, now, flags, { hardGateFn }, options)).emitted;
  }
  return { scanned: rows.length, emitted };
}

// ── 清理 ─────────────────────────────────────────────────────────────────────────────────

async function cleanupRentalNotifyAsync(run, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}) {
  const eventCut = iso(new Date(atMs(now) - RENTAL_EVENT_RETENTION_DAYS * 86400000));
  const attrCut = iso(new Date(atMs(now) - RENTAL_ATTRIBUTION_RETENTION_DAYS * 86400000));
  const cap = Math.min(RENTAL_NOTIFY_BATCH, Math.max(1, Number(limit) || 80));
  const eligible = (await run(
    `SELECT e.id FROM rental_notify_events e
     WHERE e.created_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM rental_notify_deliveries d
         WHERE d.event_id = e.id AND d.status IN ('queued', 'retrying')
       )
       AND NOT EXISTS (
         SELECT 1 FROM rental_digest_items i
         JOIN rental_digest_buckets b ON b.id = i.bucket_id
         WHERE i.event_id = e.id AND b.status IN ('open', 'queued')
       )
     ORDER BY e.id ASC
     LIMIT ?`,
    [eventCut, cap],
  )).rows;
  const ids = eligible.map((row) => row.id);
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    await run(`DELETE FROM rental_digest_items WHERE event_id IN (${marks})`, ids);
    await run(
      `DELETE FROM rental_notify_deliveries
       WHERE event_id IN (${marks}) AND status NOT IN ('queued', 'retrying')`,
      ids,
    );
    await run(`DELETE FROM rental_notify_events WHERE id IN (${marks})`, ids);
  }
  const share = await run(
    `DELETE FROM rental_share_events
     WHERE created_at < ? AND id IN (SELECT id FROM rental_share_events WHERE created_at < ? LIMIT ?)`,
    [attrCut, attrCut, cap],
  );
  return { events: ids.length, share: Number(share?.rowCount) || 0 };
}

// ── 產業務入口 ───────────────────────────────────────────────────────────────────────────

export async function runRentalNotifyTickAsync(now = new Date(), extra = {}, options = {}) {
  const flags = extra.flags || {};
  setRentalNotifyHydrate(flags);
  if (!isRentalNotificationsEnabled(flags)) {
    return { skipped: true, reminders: { scanned: 0, emitted: 0 }, delivered: { scanned: 0 }, digest: { closed: 0 } };
  }
  const limit = extra.limit || RENTAL_NOTIFY_BATCH;
  return withFallback(options, async (run) => {
    // 把同一份 runner 傳進所有巢狀 async 呼叫（emit／analytics／prefs），
    // 真 PG 路徑下它們就會在**同一筆交易**裡跑（對齊同步版的 BEGIN IMMEDIATE）。
    const txOptions = { ...options, exec: run };
    const reminders = await scheduleLifecycleRemindersAsync(run, now, { limit }, txOptions);
    const expiring = await scheduleOfferExpiringAsync(run, now, { limit }, txOptions);
    const tenantRetention = await scheduleTenantRetentionAsync(run, now, { limit }, txOptions);
    const ownerRetention = await scheduleOwnerRetentionAsync(run, now, { limit }, txOptions);
    const matches = await processMatchSubscriptionsAsync(run, now, { limit, flags, ...extra }, txOptions);
    const digest = await closeDigestBucketsAsync(run, now, { limit }, txOptions);
    const delivered = await deliverQueuedNotificationsAsync(run, now, { limit }, txOptions);
    const cleanup = await cleanupRentalNotifyAsync(run, now, { limit });
    return { skipped: false, reminders, matches, digest, delivered, cleanup, expiring, tenantRetention, ownerRetention };
  }, () => runRentalNotifyTick(sqliteHandle(), now, {
    flags,
    limit,
    matchFn: extra.matchFn,
    hardGateFn: extra.hardGateFn,
  }));
}
