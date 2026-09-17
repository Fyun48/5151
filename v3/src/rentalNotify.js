/** Rental Marketplace notification orchestrator（PR D）。重用 user_events / mail / push，不另造平台。 */

import { randomBytes } from "node:crypto";
import {
  isRentalDigestEnabled,
  isRentalNotificationsEnabled,
  isRentalOutboundMailEnabled,
  isRentalOutboundPushEnabled,
} from "./rentalMarketplaceFlags.js";
import { remainingTtlDays, WISH_CONFIRM_GRACE_DAYS } from "./wishLifecycle.js";
import { sanitizeDocumentText } from "./safeContent.js";
import { ensureUserBlockSchema, tenantBlocksOwner } from "./userBlocks.js";

export const RENTAL_NOTIFY_EVENT_TYPES = Object.freeze([
  "wish_lifecycle_due_3d",
  "wish_lifecycle_due_1d",
  "wish_needs_confirmation",
  "wish_paused_inactive",
  "owner_new_match_available",
  "owner_match_digest_ready",
  "tenant_offer_received",
  "tenant_offer_accepted_ack",
  "owner_offer_accepted",
  "offer_expiring_soon",
  "wish_completed",
  "completion_survey_due",
  "tenant_retention_quiet",
  "owner_retention_matches",
]);

export const RENTAL_NOTIFY_CHANNELS = Object.freeze(["dock", "mail", "push"]);
export const RENTAL_MATCH_MODES = Object.freeze(["off", "instant", "daily_digest"]);
export const RENTAL_NOTIFY_BATCH = 80;
export const RENTAL_DIGEST_MAX_ITEMS = 8;
export const RENTAL_UNSUBSCRIBE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RENTAL_DELIVERY_MAX_ATTEMPTS = 5;
export const RENTAL_EVENT_RETENTION_DAYS = 180;
export const RENTAL_ATTRIBUTION_RETENTION_DAYS = 90;
export const RENTAL_SITE_TZ = "Asia/Taipei";

const PII_KEYS = Object.freeze(["phone", "email", "line_url", "contact", "session", "user_id", "wish_id"]);

let flagsCache = {};
let dockWriter = null;
let mailSink = null;
let pushSink = null;

export function setRentalNotifyHydrate(flags) {
  flagsCache = flags || {};
}

export function setRentalNotifyDockWriter(fn) {
  dockWriter = typeof fn === "function" ? fn : null;
}

export function setRentalNotifyMailSink(fn) {
  mailSink = typeof fn === "function" ? fn : null;
}

export function setRentalNotifyPushSink(fn) {
  pushSink = typeof fn === "function" ? fn : null;
}

export function assertRentalNotificationsEnabled() {
  if (!isRentalNotificationsEnabled(flagsCache)) {
    const err = new Error("租屋通知尚未開放");
    err.status = 404;
    err.code = "rental_notify_disabled";
    throw err;
  }
}

function iso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

export function taipeiDay(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: RENTAL_SITE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function isoWeekKey(now = new Date()) {
  const day = taipeiDay(now);
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  const dow = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - dow + 3);
  const first = new Date(Date.UTC(utc.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((utc - first) / 604800000);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function policyCheckError(message, cause) {
  const err = new Error(message);
  err.code = "policy_check_failed";
  err.status = 500;
  if (cause) err.cause = cause;
  return err;
}

export function wishHasActiveOffer(db, wishId) {
  if (!hasTable(db, "wish_offers")) {
    throw policyCheckError("wish_offers_unavailable");
  }
  try {
    return Boolean(db.prepare(
      "SELECT 1 AS n FROM wish_offers WHERE wish_id = ? AND status IN ('pending', 'accepted') LIMIT 1",
    ).get(Number(wishId) || 0));
  } catch (error) {
    throw policyCheckError("wish_offer_lookup_failed", error);
  }
}

export function listingOwnedBy(db, ownerUserId, listingId) {
  if (!hasTable(db, "listings")) {
    throw policyCheckError("listings_unavailable");
  }
  try {
    const row = db.prepare(
      "SELECT listed_by_user_id, COALESCE(self_status, 'open') AS self_status FROM listings WHERE post_id = ? AND COALESCE(source, '591') = 'self'",
    ).get(Number(listingId) || 0);
    if (!row) return { found: false, open: false };
    return {
      found: Number(row.listed_by_user_id) === Number(ownerUserId),
      open: String(row.self_status || "open") === "open",
    };
  } catch (error) {
    if (error?.code === "policy_check_failed") throw error;
    throw policyCheckError("listing_ownership_lookup_failed", error);
  }
}

function atMs(now = new Date()) {
  return now instanceof Date ? now.getTime() : (Number(now) || Date.now());
}

function newToken(bytes = 18) {
  return randomBytes(bytes).toString("base64url");
}

function safePayload(meta = {}) {
  const out = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (PII_KEYS.includes(key)) continue;
    if (value == null) continue;
    const text = typeof value === "string" ? sanitizeDocumentText(value).slice(0, 240) : value;
    out[key] = text;
  }
  return out;
}

export function rentalNotifyHttpError(message, status = 400, code = "") {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

export function ensureRentalNotifySchema(db) {
  ensureUserBlockSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rental_notify_prefs (
      user_id INTEGER PRIMARY KEY,
      lifecycle_reminder INTEGER NOT NULL DEFAULT 1,
      new_match INTEGER NOT NULL DEFAULT 0,
      offer_transactional INTEGER NOT NULL DEFAULT 1,
      daily_digest INTEGER NOT NULL DEFAULT 0,
      channel_dock INTEGER NOT NULL DEFAULT 1,
      channel_mail INTEGER NOT NULL DEFAULT 0,
      channel_push INTEGER NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rental_match_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_token TEXT NOT NULL UNIQUE,
      owner_user_id INTEGER NOT NULL,
      listing_id INTEGER NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id, listing_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rental_match_subs_owner
      ON rental_match_subscriptions(owner_user_id, mode);
    CREATE TABLE IF NOT EXISTS rental_notify_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      subject_type TEXT,
      subject_ref TEXT,
      listing_id INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rental_notify_events_user
      ON rental_notify_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_rental_notify_events_type
      ON rental_notify_events(event_type, created_at);
    CREATE TABLE IF NOT EXISTS rental_notify_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(event_id, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_rental_notify_deliveries_retry
      ON rental_notify_deliveries(status, next_retry_at, id);
    CREATE TABLE IF NOT EXISTS rental_digest_buckets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_token TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      bucket_date TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      overflow_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      event_id INTEGER,
      UNIQUE(user_id, channel, bucket_date, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_rental_digest_status
      ON rental_digest_buckets(status, bucket_date);
    CREATE TABLE IF NOT EXISTS rental_digest_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL,
      listing_ref INTEGER,
      wish_ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(bucket_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS rental_match_seen (
      owner_user_id INTEGER NOT NULL,
      listing_id INTEGER NOT NULL,
      wish_ref TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      eligible INTEGER NOT NULL DEFAULT 1,
      episode INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      PRIMARY KEY (owner_user_id, listing_id, wish_ref)
    );
    CREATE TABLE IF NOT EXISTS rental_notify_cursors (
      job TEXT PRIMARY KEY,
      last_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rental_unsubscribe_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      scope TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rental_unsub_user
      ON rental_unsubscribe_tokens(user_id, expires_at);
    CREATE TABLE IF NOT EXISTS rental_share_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_token TEXT NOT NULL UNIQUE,
      share_token TEXT NOT NULL,
      event_type TEXT NOT NULL,
      user_id INTEGER,
      visitor_hash TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rental_share_lookup
      ON rental_share_events(share_token, event_type, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_share_dedup_user
      ON rental_share_events(share_token, event_type, user_id, created_at)
      WHERE user_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS rental_completion_surveys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_token TEXT NOT NULL UNIQUE,
      wish_id INTEGER NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      found_via_site TEXT NOT NULL,
      via_feature TEXT NOT NULL DEFAULT '',
      helpful INTEGER,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rental_survey_user
      ON rental_completion_surveys(user_id, created_at);
    CREATE TABLE IF NOT EXISTS rental_analytics_daily (
      day TEXT NOT NULL,
      metric TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, metric)
    );
    CREATE INDEX IF NOT EXISTS idx_rental_analytics_metric
      ON rental_analytics_daily(metric, day);
    CREATE INDEX IF NOT EXISTS idx_demand_lifecycle_expires
      ON demand_posts(lifecycle, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_demand_lifecycle_active
      ON demand_posts(status, lifecycle, last_active_at, id);
    CREATE INDEX IF NOT EXISTS idx_rental_notify_events_created
      ON rental_notify_events(created_at, id);
    CREATE INDEX IF NOT EXISTS idx_rental_share_created
      ON rental_share_events(created_at, id);
    CREATE INDEX IF NOT EXISTS idx_rental_share_visitor
      ON rental_share_events(share_token, event_type, visitor_hash, created_at);
    CREATE INDEX IF NOT EXISTS idx_rental_match_subs_mode_id
      ON rental_match_subscriptions(mode, id);
  `);
  for (const [table, def] of [
    ["rental_match_seen", "eligible INTEGER NOT NULL DEFAULT 1"],
    ["rental_match_seen", "episode INTEGER NOT NULL DEFAULT 1"],
    ["rental_digest_buckets", "event_id INTEGER"],
  ]) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`); } catch { /* already present */ }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_rental_digest_event ON rental_digest_buckets(event_id)");
}

export function defaultRentalNotifyPrefs() {
  return {
    lifecycle_reminder: true,
    new_match: false,
    offer_transactional: true,
    daily_digest: false,
    channel_dock: true,
    channel_mail: false,
    channel_push: false,
    timezone: RENTAL_SITE_TZ,
  };
}

export function getRentalNotifyPrefs(db, userId) {
  const row = db.prepare("SELECT * FROM rental_notify_prefs WHERE user_id = ?").get(Number(userId) || 0);
  if (!row) return defaultRentalNotifyPrefs();
  return {
    lifecycle_reminder: Number(row.lifecycle_reminder) === 1,
    new_match: Number(row.new_match) === 1,
    offer_transactional: Number(row.offer_transactional) === 1,
    daily_digest: Number(row.daily_digest) === 1,
    channel_dock: Number(row.channel_dock) === 1,
    channel_mail: Number(row.channel_mail) === 1,
    channel_push: Number(row.channel_push) === 1,
    timezone: row.timezone || RENTAL_SITE_TZ,
  };
}

export function saveRentalNotifyPrefs(db, userId, patch = {}, now = new Date()) {
  assertRentalNotificationsEnabled();
  const uid = Number(userId) || 0;
  if (!uid) throw rentalNotifyHttpError("請先登入", 401, "auth_required");
  const current = getRentalNotifyPrefs(db, uid);
  const next = {
    ...current,
    ...Object.fromEntries(Object.entries(patch || {}).filter(([key]) => key in current)),
  };
  next.timezone = String(next.timezone || RENTAL_SITE_TZ).slice(0, 64);
  db.prepare(`
    INSERT INTO rental_notify_prefs(
      user_id, lifecycle_reminder, new_match, offer_transactional, daily_digest,
      channel_dock, channel_mail, channel_push, timezone, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      lifecycle_reminder = excluded.lifecycle_reminder,
      new_match = excluded.new_match,
      offer_transactional = excluded.offer_transactional,
      daily_digest = excluded.daily_digest,
      channel_dock = excluded.channel_dock,
      channel_mail = excluded.channel_mail,
      channel_push = excluded.channel_push,
      timezone = excluded.timezone,
      updated_at = excluded.updated_at
  `).run(
    uid,
    next.lifecycle_reminder ? 1 : 0,
    next.new_match ? 1 : 0,
    next.offer_transactional ? 1 : 0,
    next.daily_digest ? 1 : 0,
    next.channel_dock ? 1 : 0,
    next.channel_mail ? 1 : 0,
    next.channel_push ? 1 : 0,
    next.timezone,
    iso(now),
  );
  bumpAnalytics(db, "pref_updated", now);
  return getRentalNotifyPrefs(db, uid);
}

export function createUnsubscribeToken(db, userId, scope = "all", now = new Date()) {
  const token = newToken(24);
  db.prepare(
    `INSERT INTO rental_unsubscribe_tokens(token, user_id, scope, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(token, Number(userId), String(scope || "all"), iso(new Date(atMs(now) + RENTAL_UNSUBSCRIBE_TTL_MS)));
  return token;
}

export function applyUnsubscribeToken(db, token, now = new Date()) {
  const raw = String(token || "").trim();
  if (!raw || /^\d+$/.test(raw)) throw rentalNotifyHttpError("找不到取消連結", 404, "unsub_not_found");
  const row = db.prepare("SELECT * FROM rental_unsubscribe_tokens WHERE token = ?").get(raw);
  if (!row) throw rentalNotifyHttpError("找不到取消連結", 404, "unsub_not_found");
  if (row.used_at) return { ok: true, already: true };
  if (Date.parse(row.expires_at) <= atMs(now)) throw rentalNotifyHttpError("取消連結已過期", 400, "unsub_expired");
  const scope = String(row.scope || "all");
  const patch = scope === "lifecycle" ? { lifecycle_reminder: false }
    : scope === "new_match" ? { new_match: false, daily_digest: false }
      : scope === "digest" ? { daily_digest: false }
        : { lifecycle_reminder: false, new_match: false, daily_digest: false, channel_mail: false, channel_push: false };
  if (scope === "new_match" || scope === "all") {
    db.prepare("UPDATE rental_match_subscriptions SET mode = 'off', updated_at = ? WHERE owner_user_id = ?")
      .run(iso(now), row.user_id);
  } else if (scope === "digest") {
    db.prepare("UPDATE rental_match_subscriptions SET mode = 'off', updated_at = ? WHERE owner_user_id = ? AND mode = 'daily_digest'")
      .run(iso(now), row.user_id);
  }
  const prev = flagsCache;
  flagsCache = { ...prev, wish: { ...(prev.wish || {}), notifications_enabled: true } };
  try {
    saveRentalNotifyPrefs(db, row.user_id, patch, now);
  } finally {
    flagsCache = prev;
  }
  db.prepare("UPDATE rental_unsubscribe_tokens SET used_at = ? WHERE token = ?").run(iso(now), raw);
  return { ok: true, already: false };
}

export function getMatchSubscription(db, ownerUserId, listingId) {
  const row = db.prepare(
    "SELECT * FROM rental_match_subscriptions WHERE owner_user_id = ? AND listing_id = ?",
  ).get(Number(ownerUserId) || 0, Number(listingId) || 0);
  return {
    listing_ref: Number(listingId) || 0,
    mode: row?.mode || "off",
    subscription_ref: row?.public_token || "",
  };
}

export function saveMatchSubscription(db, ownerUserId, listingId, mode, now = new Date()) {
  assertRentalNotificationsEnabled();
  const next = RENTAL_MATCH_MODES.includes(mode) ? mode : "off";
  const uid = Number(ownerUserId) || 0;
  const lid = Number(listingId) || 0;
  if (!uid || !lid) throw rentalNotifyHttpError("找不到這則刊登", 404, "listing_not_found");
  const owned = listingOwnedBy(db, uid, lid);
  if (!owned.found) throw rentalNotifyHttpError("找不到這則刊登", 404, "listing_not_found");
  const stamp = iso(now);
  const existing = db.prepare(
    "SELECT * FROM rental_match_subscriptions WHERE owner_user_id = ? AND listing_id = ?",
  ).get(uid, lid);
  if (existing) {
    db.prepare("UPDATE rental_match_subscriptions SET mode = ?, updated_at = ? WHERE id = ?")
      .run(next, stamp, existing.id);
    return getMatchSubscription(db, uid, lid);
  }
  db.prepare(
    `INSERT INTO rental_match_subscriptions(public_token, owner_user_id, listing_id, mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(newToken(), uid, lid, next, stamp, stamp);
  return getMatchSubscription(db, uid, lid);
}

export function publicRentalNotifyCaps(flags = flagsCache) {
  return {
    enabled: isRentalNotificationsEnabled(flags),
    digest_enabled: isRentalDigestEnabled(flags),
    outbound_mail_enabled: isRentalOutboundMailEnabled(flags),
    outbound_push_enabled: isRentalOutboundPushEnabled(flags),
    offer_transactional_locked: false,
  };
}

export function bumpAnalytics(db, metric, now = new Date(), n = 1) {
  const day = taipeiDay(now);
  db.prepare(`
    INSERT INTO rental_analytics_daily(day, metric, value) VALUES (?, ?, ?)
    ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value
  `).run(day, String(metric), Number(n) || 1);
}

function preferenceAllows(prefs, eventType) {
  if (["wish_lifecycle_due_3d", "wish_lifecycle_due_1d", "wish_needs_confirmation", "wish_paused_inactive", "tenant_retention_quiet"].includes(eventType)) {
    return prefs.lifecycle_reminder;
  }
  if (["owner_new_match_available", "owner_match_digest_ready", "owner_retention_matches"].includes(eventType)) {
    // 訂閱 mode 是新配對的權威來源；帳號 prefs 只當 channel gate。
    return true;
  }
  if (["tenant_offer_received", "tenant_offer_accepted_ack", "owner_offer_accepted", "offer_expiring_soon"].includes(eventType)) {
    return prefs.offer_transactional;
  }
  if (["wish_completed", "completion_survey_due"].includes(eventType)) return true;
  return true;
}

function channelAllowed(prefs, channel, flags) {
  if (channel === "dock") return prefs.channel_dock;
  if (channel === "mail") return prefs.channel_mail && isRentalOutboundMailEnabled(flags);
  if (channel === "push") return prefs.channel_push && isRentalOutboundPushEnabled(flags);
  return false;
}

export function renderRentalNotify(eventType) {
  const copy = {
    wish_lifecycle_due_3d: { title: "許願房還有三天", detail: "條件若仍正確，確認一下就能繼續曝光。" },
    wish_lifecycle_due_1d: { title: "許願房明天到期", detail: "今天確認條件，以免暫停曝光。" },
    wish_needs_confirmation: { title: "請確認許願房條件", detail: "確認後會繼續幫你找符合的房子。" },
    wish_paused_inactive: { title: "許願房已暫停", detail: "若還在找房，可以重新開始一則。" },
    owner_new_match_available: { title: "有新的符合需求", detail: "有租客條件和你的房源相符。" },
    owner_match_digest_ready: { title: "今日符合需求摘要", detail: "整理今天新增的符合需求。" },
    tenant_offer_received: { title: "收到房源提案", detail: "屋主提供了可能符合的房子，可先看條件。" },
    tenant_offer_accepted_ack: { title: "已互相確認", detail: "雙方同意後，可查看允許的聯絡方式。" },
    owner_offer_accepted: { title: "租客接受了你的提案", detail: "可查看允許的聯絡方式。" },
    offer_expiring_soon: { title: "提案即將到期", detail: "若仍有興趣，請儘快回覆。" },
    wish_completed: { title: "已結束找房", detail: "願意的話可留一句回饋，可跳過。" },
    completion_survey_due: { title: "找房回饋", detail: "30 秒問卷，可跳過。" },
    tenant_retention_quiet: { title: "還在找房嗎", detail: "條件若有變，改一下會更準。" },
    owner_retention_matches: { title: "房源有新的符合需求", detail: "可到有房刊登查看。" },
  };
  return copy[eventType] || { title: "租屋通知", detail: "" };
}

export function emitRentalNotifyEvent(db, {
  eventType,
  userId,
  eventKey,
  subjectType = "",
  subjectRef = "",
  listingId = null,
  payload = {},
  now = new Date(),
  queue = true,
} = {}) {
  if (!isRentalNotificationsEnabled(flagsCache)) return { emitted: false, reason: "flag_off" };
  if (!RENTAL_NOTIFY_EVENT_TYPES.includes(eventType)) return { emitted: false, reason: "unknown_type" };
  const uid = Number(userId) || 0;
  if (!uid) return { emitted: false, reason: "no_user" };
  const key = String(eventKey || `${eventType}:${uid}:${subjectRef}`).slice(0, 240);
  const stamp = iso(now);
  let inserted = false;
  try {
    const result = db.prepare(`
      INSERT INTO rental_notify_events(event_key, event_type, user_id, subject_type, subject_ref, listing_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(key, eventType, uid, subjectType, String(subjectRef || ""), listingId, JSON.stringify(safePayload(payload)), stamp);
    inserted = Number(result.changes) > 0;
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) {
      bumpAnalytics(db, "notify_deduped", now);
      const existing = db.prepare("SELECT id FROM rental_notify_events WHERE event_key = ?").get(key);
      return { emitted: false, reason: "deduped", event_key: key, event_id: existing?.id || 0 };
    }
    throw error;
  }
  const event = db.prepare("SELECT * FROM rental_notify_events WHERE event_key = ?").get(key);
  if (!inserted) return { emitted: false, reason: "deduped", event_key: key, event_id: event?.id || 0 };
  bumpAnalytics(db, "notify_generated", now);
  if (queue !== false) queueDeliveries(db, event, now);
  return { emitted: true, event_id: event.id, event_key: key };
}

export function queueDeliveries(db, event, now = new Date()) {
  const prefs = getRentalNotifyPrefs(db, event.user_id);
  if (!preferenceAllows(prefs, event.event_type)) {
    insertDelivery(db, event, "dock", "suppressed", now);
    bumpAnalytics(db, "notify_suppressed", now);
    return;
  }
  for (const channel of RENTAL_NOTIFY_CHANNELS) {
    if (!channelAllowed(prefs, channel, flagsCache)) {
      insertDelivery(db, event, channel, "suppressed", now);
      bumpAnalytics(db, "notify_suppressed", now);
      continue;
    }
    if (event.event_type === "owner_new_match_available" && channel !== "dock" && !isRentalDigestEnabled(flagsCache)) {
      insertDelivery(db, event, channel, "suppressed", now);
      continue;
    }
    insertDelivery(db, event, channel, "queued", now);
    bumpAnalytics(db, "notify_queued", now);
  }
}

function insertDelivery(db, event, channel, status, now) {
  const stamp = iso(now);
  try {
    db.prepare(`
      INSERT INTO rental_notify_deliveries(event_id, user_id, channel, status, attempt, next_retry_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, '', ?, ?)
    `).run(event.id, event.user_id, channel, status, status === "queued" ? stamp : null, stamp, stamp);
  } catch (error) {
    if (!String(error.message || "").includes("UNIQUE")) throw error;
  }
}

export function deliverQueuedNotifications(db, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}) {
  const stamp = iso(now);
  const rows = db.prepare(`
    SELECT d.*, e.event_type, e.payload_json, e.subject_ref
    FROM rental_notify_deliveries d
    JOIN rental_notify_events e ON e.id = d.event_id
    WHERE d.status IN ('queued', 'retrying')
      AND (d.next_retry_at IS NULL OR d.next_retry_at <= ?)
    ORDER BY d.id ASC LIMIT ?
  `).all(stamp, Math.min(RENTAL_NOTIFY_BATCH, Math.max(1, Number(limit) || 80)));
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      deliverOne(db, row, now);
      delivered += 1;
    } catch (error) {
      failed += 1;
      const attempt = Number(row.attempt || 0) + 1;
      const terminal = attempt >= RENTAL_DELIVERY_MAX_ATTEMPTS;
      const next = iso(new Date(atMs(now) + Math.min(6 * 3600_000, 60_000 * (2 ** attempt))));
      db.prepare(`
        UPDATE rental_notify_deliveries
        SET status = ?, attempt = ?, next_retry_at = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(terminal ? "terminal_failed" : "retrying", attempt, terminal ? null : next, String(error.message || "").slice(0, 180), stamp, row.id);
      bumpAnalytics(db, terminal ? "notify_failed" : "notify_retrying", now);
    }
  }
  return { scanned: rows.length, delivered, failed };
}

function deliverOne(db, row, now) {
  const copy = renderRentalNotify(row.event_type);
  if (row.channel === "dock") {
    if (dockWriter) {
      dockWriter({
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
    if (!isRentalOutboundMailEnabled(flagsCache)) throw new Error("mail_channel_off");
    if (!mailSink) throw new Error("mail_no_provider");
    mailSink({
      user_id: row.user_id,
      event_id: row.event_id,
      event_type: row.event_type,
      title: copy.title,
      detail: copy.detail,
    });
  } else if (row.channel === "push") {
    if (!isRentalOutboundPushEnabled(flagsCache)) throw new Error("push_channel_off");
    if (!pushSink) throw new Error("push_no_provider");
    pushSink({
      user_id: row.user_id,
      event_id: row.event_id,
      event_type: row.event_type,
      title: copy.title,
      detail: copy.detail,
    });
  } else {
    throw new Error("unknown_channel");
  }
  db.prepare(`
    UPDATE rental_notify_deliveries
    SET status = 'delivered', attempt = attempt + 1, next_retry_at = NULL, last_error = '', updated_at = ?
    WHERE id = ?
  `).run(iso(now), row.id);
  bumpAnalytics(db, "notify_delivered", now);
  finalizeDigestIfDelivered(db, row, now);
}

function finalizeDigestIfDelivered(db, row, now) {
  if (row.event_type !== "owner_match_digest_ready") return;
  db.prepare(`
    UPDATE rental_digest_buckets
    SET status = 'delivered', delivered_at = ?
    WHERE event_id = ? AND status IN ('queued', 'open')
  `).run(iso(now), row.event_id);
}

export function reminderWindowForWish(row, now = new Date()) {
  const life = String(row.lifecycle || "");
  if (!["active", "needs_confirmation"].includes(life)) return null;
  const days = remainingTtlDays(row.expires_at, now);
  if (days === 3) return "wish_lifecycle_due_3d";
  if (days === 1) return "wish_lifecycle_due_1d";
  if (life === "needs_confirmation") return "wish_needs_confirmation";
  return null;
}

function getNotifyCursor(db, job) {
  return Number(db.prepare("SELECT last_id FROM rental_notify_cursors WHERE job = ?").get(job)?.last_id) || 0;
}

function setNotifyCursor(db, job, lastId, now) {
  db.prepare(`
    INSERT INTO rental_notify_cursors(job, last_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(job) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at
  `).run(job, Number(lastId) || 0, iso(now));
}

function takeAfterCursor(db, job, now, limit, selectFn) {
  const cap = Math.min(RENTAL_NOTIFY_BATCH, Math.max(1, Number(limit) || 80));
  const lastId = getNotifyCursor(db, job);
  let rows = selectFn(lastId, cap);
  if (!rows.length && lastId > 0) rows = selectFn(0, cap);
  if (rows.length) setNotifyCursor(db, job, rows[rows.length - 1].id, now);
  return rows;
}

export function scheduleLifecycleReminders(db, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}) {
  if (!isRentalNotificationsEnabled(flagsCache)) return { scanned: 0, emitted: 0 };
  const until = iso(new Date(atMs(now) + 4 * 86400000));
  const rows = takeAfterCursor(db, "lifecycle_reminders", now, limit, (afterId, cap) => db.prepare(`
    SELECT id, user_id, public_token, lifecycle, expires_at, last_confirmed_at, last_active_at
    FROM demand_posts
    WHERE status = 'open'
      AND COALESCE(lifecycle, 'active') IN ('active', 'needs_confirmation')
      AND expires_at <= ?
      AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(until, afterId, cap));
  let emitted = 0;
  for (const row of rows) {
    const type = reminderWindowForWish(row, now);
    if (!type) continue;
    const deadline = String(row.expires_at || "").slice(0, 10);
    const result = emitRentalNotifyEvent(db, {
      eventType: type,
      userId: row.user_id,
      eventKey: `${type}:${row.id}:${deadline}`,
      subjectType: "wish",
      subjectRef: row.public_token,
      now,
    });
    if (result.emitted) emitted += 1;
  }
  return { scanned: rows.length, emitted };
}

export function addDigestItem(db, {
  userId,
  eventId,
  listingId,
  wishRef,
  now = new Date(),
} = {}) {
  if (!isRentalDigestEnabled(flagsCache)) return null;
  const day = taipeiDay(now);
  let bucket = db.prepare(
    "SELECT * FROM rental_digest_buckets WHERE user_id = ? AND channel = 'dock' AND bucket_date = ? AND kind = 'owner_new_match'",
  ).get(Number(userId), day);
  if (!bucket) {
    db.prepare(`
      INSERT INTO rental_digest_buckets(public_token, user_id, channel, bucket_date, kind, status, item_count, overflow_count, created_at)
      VALUES (?, ?, 'dock', ?, 'owner_new_match', 'open', 0, 0, ?)
    `).run(newToken(), Number(userId), day, iso(now));
    bucket = db.prepare(
      "SELECT * FROM rental_digest_buckets WHERE user_id = ? AND channel = 'dock' AND bucket_date = ? AND kind = 'owner_new_match'",
    ).get(Number(userId), day);
  }
  if (bucket.status !== "open") return bucket;
  if (Number(bucket.item_count) >= RENTAL_DIGEST_MAX_ITEMS) {
    db.prepare("UPDATE rental_digest_buckets SET overflow_count = overflow_count + 1 WHERE id = ?").run(bucket.id);
    return db.prepare("SELECT * FROM rental_digest_buckets WHERE id = ?").get(bucket.id);
  }
  try {
    db.prepare(
      "INSERT INTO rental_digest_items(bucket_id, event_id, listing_ref, wish_ref, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(bucket.id, eventId, listingId, wishRef || "", iso(now));
    db.prepare("UPDATE rental_digest_buckets SET item_count = item_count + 1 WHERE id = ?").run(bucket.id);
  } catch (error) {
    if (!String(error.message || "").includes("UNIQUE")) throw error;
  }
  return db.prepare("SELECT * FROM rental_digest_buckets WHERE id = ?").get(bucket.id);
}

export function closeDigestBuckets(db, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}) {
  if (!isRentalDigestEnabled(flagsCache)) return { closed: 0 };
  const yesterday = taipeiDay(new Date(atMs(now) - 86400000));
  const rows = db.prepare(
    "SELECT * FROM rental_digest_buckets WHERE status = 'open' AND bucket_date <= ? ORDER BY id ASC LIMIT ?",
  ).all(yesterday, Math.min(RENTAL_NOTIFY_BATCH, Number(limit) || 80));
  let closed = 0;
  for (const row of rows) {
    const result = emitRentalNotifyEvent(db, {
      eventType: "owner_match_digest_ready",
      userId: row.user_id,
      eventKey: `owner_match_digest_ready:${row.public_token}`,
      subjectType: "digest",
      subjectRef: row.public_token,
      payload: { item_count: row.item_count, overflow_count: row.overflow_count },
      now,
    });
    const eventId = Number(result.event_id) || 0;
    if (!eventId) continue;
    const queued = db.prepare(
      "SELECT 1 AS n FROM rental_notify_deliveries WHERE event_id = ? AND status IN ('queued', 'retrying') LIMIT 1",
    ).get(eventId);
    const already = db.prepare(
      "SELECT 1 AS n FROM rental_notify_deliveries WHERE event_id = ? AND status = 'delivered' LIMIT 1",
    ).get(eventId);
    const nextStatus = queued ? "queued" : already ? "delivered" : "suppressed";
    db.prepare("UPDATE rental_digest_buckets SET status = ?, event_id = ?, delivered_at = ? WHERE id = ?")
      .run(nextStatus, eventId, nextStatus === "delivered" ? iso(now) : null, row.id);
    if (nextStatus === "queued" || nextStatus === "delivered") {
      closed += 1;
      bumpAnalytics(db, "digest_count", now);
    }
  }
  return { closed, scanned: rows.length };
}

export function openMatchEpisodeIfNeeded(db, ownerUserId, listingId, wishRef, now = new Date()) {
  const owner = Number(ownerUserId) || 0;
  const listing = Number(listingId) || 0;
  const ref = String(wishRef || "");
  if (!owner || !listing || !ref) return { notify: false, episode: 0 };
  const row = db.prepare(
    "SELECT eligible, episode FROM rental_match_seen WHERE owner_user_id = ? AND listing_id = ? AND wish_ref = ?",
  ).get(owner, listing, ref);
  if (!row) {
    db.prepare(`
      INSERT INTO rental_match_seen(owner_user_id, listing_id, wish_ref, generation, eligible, episode, created_at)
      VALUES (?, ?, ?, 0, 1, 1, ?)
    `).run(owner, listing, ref, iso(now));
    return { notify: true, episode: 1 };
  }
  if (Number(row.eligible) === 1) return { notify: false, episode: Number(row.episode) || 1 };
  const episode = (Number(row.episode) || 0) + 1;
  db.prepare(`
    UPDATE rental_match_seen SET eligible = 1, episode = ? WHERE owner_user_id = ? AND listing_id = ? AND wish_ref = ?
  `).run(episode, owner, listing, ref);
  return { notify: true, episode };
}

export function markMissingMatchesIneligible(db, ownerUserId, listingId, eligibleWishRefs = []) {
  const keep = new Set((eligibleWishRefs || []).map((ref) => String(ref || "")).filter(Boolean));
  const rows = db.prepare(
    "SELECT wish_ref FROM rental_match_seen WHERE owner_user_id = ? AND listing_id = ? AND eligible = 1",
  ).all(Number(ownerUserId) || 0, Number(listingId) || 0);
  const update = db.prepare(
    "UPDATE rental_match_seen SET eligible = 0 WHERE owner_user_id = ? AND listing_id = ? AND wish_ref = ?",
  );
  for (const row of rows) {
    if (!keep.has(String(row.wish_ref))) update.run(Number(ownerUserId), Number(listingId), row.wish_ref);
  }
}

export function resolveWishTenantId(db, item = {}) {
  const direct = Number(item.user_id || item.tenant_user_id || 0);
  if (direct) return direct;
  if (item.wish_id) {
    try {
      const row = db.prepare("SELECT user_id FROM demand_posts WHERE id = ?").get(Number(item.wish_id));
      if (row) return Number(row.user_id) || 0;
    } catch {
      return 0;
    }
  }
  const ref = item.wish_ref || item.public_token || "";
  if (!ref) return 0;
  try {
    const row = db.prepare("SELECT user_id FROM demand_posts WHERE public_token = ?").get(String(ref));
    return Number(row?.user_id) || 0;
  } catch {
    return 0;
  }
}

export function pairIsBlockedForNotify(db, tenantUserId, ownerUserId) {
  const tenant = Number(tenantUserId) || 0;
  const owner = Number(ownerUserId) || 0;
  if (!tenant || !owner) return true;
  try {
    return tenantBlocksOwner(db, tenant, owner);
  } catch {
    return true;
  }
}

export function processMatchSubscriptionRow(db, sub, page, now, flags) {
  if (!listingOpenForNotify(db, sub.owner_user_id, sub.listing_id)) return { emitted: 0 };
  if (sub.mode === "off") return { emitted: 0 };
  const items = (page?.items || []).slice(0, 20);
  const eligibleRefs = [];
  let emitted = 0;
  for (const item of items) {
    const wishRef = item.wish_ref || item.public_token || "";
    if (!wishRef) continue;
    const tenantId = resolveWishTenantId(db, item);
    if (pairIsBlockedForNotify(db, tenantId, sub.owner_user_id)) continue;
    eligibleRefs.push(wishRef);
    const episode = openMatchEpisodeIfNeeded(db, sub.owner_user_id, sub.listing_id, wishRef, now);
    if (!episode.notify) continue;
    const result = emitRentalNotifyEvent(db, {
      eventType: "owner_new_match_available",
      userId: sub.owner_user_id,
      eventKey: `owner_new_match_available:${sub.owner_user_id}:${sub.listing_id}:${wishRef}:${episode.episode}`,
      subjectType: "wish",
      subjectRef: wishRef,
      listingId: sub.listing_id,
      payload: { listing_ref: sub.listing_id, episode: episode.episode },
      now,
      queue: sub.mode === "instant",
    });
    if (result.emitted) {
      emitted += 1;
      if (sub.mode === "daily_digest" && isRentalDigestEnabled(flags) && result.event_id) {
        addDigestItem(db, {
          userId: sub.owner_user_id,
          eventId: result.event_id,
          listingId: sub.listing_id,
          wishRef,
          now,
        });
      }
    }
  }
  markMissingMatchesIneligible(db, sub.owner_user_id, sub.listing_id, eligibleRefs);
  return { emitted };
}

export function recordMatchSeen(db, ownerUserId, listingId, wishRef, _generation, now = new Date()) {
  openMatchEpisodeIfNeeded(db, ownerUserId, listingId, wishRef, now);
}

export function hasSeenMatch(db, ownerUserId, listingId, wishRef) {
  const row = db.prepare(
    "SELECT eligible FROM rental_match_seen WHERE owner_user_id = ? AND listing_id = ? AND wish_ref = ?",
  ).get(Number(ownerUserId), Number(listingId), String(wishRef || ""));
  return Boolean(row && Number(row.eligible) === 1);
}

export function listDueMatchSubscriptions(db, { limit = RENTAL_NOTIFY_BATCH, now = new Date() } = {}) {
  return takeAfterCursor(db, "match_subscriptions", now, limit, (afterId, cap) => db.prepare(`
    SELECT * FROM rental_match_subscriptions
    WHERE mode IN ('instant', 'daily_digest') AND id > ?
    ORDER BY id ASC LIMIT ?
  `).all(afterId, cap));
}

export function listingOpenForNotify(db, ownerUserId, listingId) {
  try {
    const owned = listingOwnedBy(db, ownerUserId, listingId);
    return owned.found && owned.open;
  } catch {
    return false;
  }
}

export function scheduleOfferExpiring(db, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}) {
  if (!isRentalNotificationsEnabled(flagsCache)) return { scanned: 0, emitted: 0 };
  if (!hasTable(db, "wish_offers")) return { scanned: 0, emitted: 0, error: "wish_offers_unavailable" };
  const soon = iso(new Date(atMs(now) + 36 * 3600_000));
  const laterThan = iso(now);
  const rows = takeAfterCursor(db, "offer_expiring", now, limit, (afterId, cap) => db.prepare(`
    SELECT id, tenant_user_id, owner_user_id, public_token, listing_id, expires_at
    FROM wish_offers
    WHERE status = 'pending' AND expires_at > ? AND expires_at <= ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(laterThan, soon, afterId, cap));
  let emitted = 0;
  for (const row of rows) {
    const deadline = String(row.expires_at || "").slice(0, 10);
    const result = emitRentalNotifyEvent(db, {
      eventType: "offer_expiring_soon",
      userId: row.tenant_user_id,
      eventKey: `offer_expiring_soon:${row.id}:${deadline}`,
      subjectType: "offer",
      subjectRef: row.public_token,
      listingId: row.listing_id,
      now,
    });
    if (result.emitted) emitted += 1;
  }
  return { scanned: rows.length, emitted };
}

export function scheduleTenantRetention(db, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}) {
  if (!isRentalNotificationsEnabled(flagsCache)) return { scanned: 0, emitted: 0 };
  const quietBefore = iso(new Date(atMs(now) - 14 * 86400000));
  const week = isoWeekKey(now);
  const rows = takeAfterCursor(db, "tenant_retention", now, limit, (afterId, cap) => db.prepare(`
    SELECT id, user_id, public_token, lifecycle, last_active_at
    FROM demand_posts
    WHERE status = 'open'
      AND COALESCE(lifecycle, 'active') = 'active'
      AND COALESCE(last_active_at, created_at) <= ?
      AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(quietBefore, afterId, cap));
  let emitted = 0;
  let skippedPolicy = 0;
  for (const row of rows) {
    let hasOffer;
    try {
      hasOffer = wishHasActiveOffer(db, row.id);
    } catch {
      skippedPolicy += 1;
      continue;
    }
    if (hasOffer) continue;
    const result = emitRentalNotifyEvent(db, {
      eventType: "tenant_retention_quiet",
      userId: row.user_id,
      eventKey: `tenant_retention_quiet:${row.id}:${week}`,
      subjectType: "wish",
      subjectRef: row.public_token,
      now,
    });
    if (result.emitted) emitted += 1;
  }
  return { scanned: rows.length, emitted, skipped_policy: skippedPolicy };
}

export function scheduleOwnerRetention(db, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}) {
  if (!isRentalNotificationsEnabled(flagsCache)) return { scanned: 0, emitted: 0 };
  const week = isoWeekKey(now);
  const rows = takeAfterCursor(db, "owner_retention", now, limit, (afterId, cap) => db.prepare(`
    SELECT id, owner_user_id, listing_id
    FROM rental_match_subscriptions
    WHERE mode IN ('instant', 'daily_digest') AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(afterId, cap));
  const owners = new Map();
  for (const row of rows) {
    if (!listingOpenForNotify(db, row.owner_user_id, row.listing_id)) continue;
    if (!owners.has(row.owner_user_id)) owners.set(row.owner_user_id, row.listing_id);
  }
  let emitted = 0;
  for (const [userId, listingId] of owners) {
    const result = emitRentalNotifyEvent(db, {
      eventType: "owner_retention_matches",
      userId,
      eventKey: `owner_retention_matches:${userId}:${week}`,
      subjectType: "listing",
      subjectRef: String(listingId),
      listingId,
      now,
    });
    if (result.emitted) emitted += 1;
  }
  return { scanned: rows.length, emitted };
}

export function cleanupRentalNotify(db, now = new Date(), { limit = RENTAL_NOTIFY_BATCH } = {}) {
  const eventCut = iso(new Date(atMs(now) - RENTAL_EVENT_RETENTION_DAYS * 86400000));
  const attrCut = iso(new Date(atMs(now) - RENTAL_ATTRIBUTION_RETENTION_DAYS * 86400000));
  const cap = Math.min(RENTAL_NOTIFY_BATCH, Math.max(1, Number(limit) || 80));
  const eligible = db.prepare(`
    SELECT e.id FROM rental_notify_events e
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
    LIMIT ?
  `).all(eventCut, cap);
  const ids = eligible.map((row) => row.id);
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM rental_digest_items WHERE event_id IN (${placeholders})`).run(...ids);
    db.prepare(`
      DELETE FROM rental_notify_deliveries
      WHERE event_id IN (${placeholders}) AND status NOT IN ('queued', 'retrying')
    `).run(...ids);
    db.prepare(`DELETE FROM rental_notify_events WHERE id IN (${placeholders})`).run(...ids);
  }
  const share = db.prepare("DELETE FROM rental_share_events WHERE created_at < ? AND id IN (SELECT id FROM rental_share_events WHERE created_at < ? LIMIT ?)").run(attrCut, attrCut, cap);
  return { events: ids.length, share: Number(share.changes) || 0 };
}

export function explainRentalNotifyPlans(db) {
  const explain = (sql) => {
    try { return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(); } catch (error) { return [{ error: error.message }]; }
  };
  return {
    lifecycle_due: explain("SELECT id FROM demand_posts WHERE status = 'open' AND lifecycle IN ('active','needs_confirmation') AND expires_at <= '2026-10-01' ORDER BY expires_at ASC LIMIT 80"),
    notify_dedup: explain("SELECT id FROM rental_notify_events WHERE event_key = 'x'"),
    delivery_retry: explain("SELECT id FROM rental_notify_deliveries WHERE status IN ('queued','retrying') AND next_retry_at <= '2026-10-01' ORDER BY id ASC LIMIT 80"),
    digest_bucket: explain("SELECT id FROM rental_digest_buckets WHERE user_id = 1 AND channel = 'dock' AND bucket_date = '2026-09-17' AND kind = 'owner_new_match'"),
    match_sub: explain("SELECT id FROM rental_match_subscriptions WHERE owner_user_id = 1 AND mode IN ('instant','daily_digest')"),
    match_seen: explain("SELECT eligible, episode FROM rental_match_seen WHERE owner_user_id = 1 AND listing_id = 1 AND wish_ref = 'abc'"),
    survey_due: explain("SELECT id FROM demand_posts WHERE lifecycle = 'completed' ORDER BY updated_at DESC LIMIT 80"),
    analytics_range: explain("SELECT day, value FROM rental_analytics_daily WHERE metric = 'notify_generated' AND day >= '2026-09-01' AND day <= '2026-09-17'"),
    share_lookup: explain("SELECT id FROM rental_share_events WHERE share_token = 'abc' AND event_type = 'view' ORDER BY created_at DESC LIMIT 20"),
    offer_expiring: explain("SELECT id FROM wish_offers WHERE status = 'pending' AND expires_at > '2026-09-16' AND expires_at <= '2026-09-18' ORDER BY expires_at ASC LIMIT 80"),
    tenant_retention: explain("SELECT id FROM demand_posts WHERE status = 'open' AND lifecycle = 'active' AND last_active_at <= '2026-09-01' ORDER BY last_active_at ASC LIMIT 80"),
    admin_drill: explain("SELECT public_token, status, created_at FROM wish_offers WHERE created_at >= '2026-09-01' AND created_at <= '2026-09-17' ORDER BY created_at DESC, id DESC LIMIT 21"),
  };
}

export {
  WISH_CONFIRM_GRACE_DAYS,
};
