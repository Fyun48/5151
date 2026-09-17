/** Wish Offer domain（PR C）。獨立於 demand.js / selfListings.js / matching rank。 */

import { randomBytes } from "node:crypto";
import { defaultCatalog, normalizeCatalog } from "./rentalCatalog.js";
import { isWishOfferEnabled } from "./rentalMarketplaceFlags.js";
import {
  evaluateMatch,
  isListingMatchable,
  isWishMatchable,
  listingMatchSnapshot,
  ownerSafeWishCard,
  wishMatchSnapshot,
} from "./rentalMatch.js";
import { decorateSelfListing, expireOpenSelfListings, getSelfRow, publicListingView, setListingOfferHook } from "./selfListings.js";
import { setWishOfferLifecycleHook } from "./demand.js";
import { containsUnsafeMarkup, sanitizeDocumentText } from "./safeContent.js";
import { SELF_LISTING_IDEMPOTENCY_KEY_RE } from "./selfListingIdempotency.js";
import {
  ensureUserBlockSchema,
  insertUserBlock,
  isBlocked,
  listBlocksForUser,
  loadOwnedBlock,
  removeUserBlock,
  tenantBlocksOwner,
} from "./userBlocks.js";

export const OFFER_STATUSES = Object.freeze([
  "pending", "accepted", "declined", "withdrawn", "expired", "blocked",
]);
export const OFFER_ACTIVE_STATUSES = Object.freeze(["pending", "accepted"]);
export const OFFER_TERMINAL_STATUSES = Object.freeze(["declined", "withdrawn", "expired", "blocked"]);

export const OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OFFER_OWNER_DAILY_CAP = 8;
export const OFFER_LISTING_DAILY_CAP = 4;
export const OFFER_SAME_WISH_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const OFFER_ENDPOINT_BURST = 8;
export const OFFER_ENDPOINT_WINDOW_MS = 60 * 1000;
export const OFFER_FAIL_BURST = 12;
export const OFFER_FAIL_WINDOW_MS = 60 * 1000;
export const OFFER_REPORT_DAILY_CAP = 6;
export const OFFER_REPORT_DETAIL_MAX = 400;
export const OFFER_REPORT_REASONS = Object.freeze([
  "spam", "misleading_listing", "harassment", "unsafe_contact", "other",
]);
export const OFFER_PAGE_DEFAULT = 20;
export const OFFER_PAGE_MAX = 50;
export const OFFER_EXPIRE_BATCH = 80;
export const OFFER_IDEMPOTENCY_KEY_RE = SELF_LISTING_IDEMPOTENCY_KEY_RE;
export const OFFER_CURSOR_TTL_MS = 15_000;
export const OFFER_SNAPSHOT_MAX = 32;
export const OFFER_CURSOR_MAX = 64;

export const OFFER_EVENTS = Object.freeze([
  "offer_created",
  "offer_accepted",
  "offer_declined",
  "offer_withdrawn",
  "offer_expired",
  "offer_blocked",
  "offer_reported",
  "contact_projection_accessed",
]);

const burstHits = new Map();
const failHits = new Map();
const offerSnapshots = new Map();
const offerCursors = new Map();

let catalogCache = defaultCatalog();
let flagsCache = {};

export function setWishOfferHydrate(catalog, flags) {
  catalogCache = catalog ? normalizeCatalog(catalog) : defaultCatalog();
  flagsCache = flags || {};
}

export function currentOfferFlags() {
  return flagsCache;
}

export function currentOfferCatalog() {
  return catalogCache || defaultCatalog();
}

export function resetWishOfferRateLimits() {
  burstHits.clear();
  failHits.clear();
}

export function clearWishOfferCursors() {
  offerSnapshots.clear();
  offerCursors.clear();
}

export function newOfferToken() {
  return randomBytes(18).toString("base64url");
}

export function offerHttpError(message, status = 400, code = "", extra = {}) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  Object.assign(err, extra);
  return err;
}

export function assertWishOfferEnabled() {
  if (!isWishOfferEnabled(flagsCache)) {
    throw offerHttpError("房源提案尚未開放", 404, "wish_offer_disabled");
  }
}

function iso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function atMs(now = new Date()) {
  return now instanceof Date ? now.getTime() : (Number(now) || Date.now());
}

export function withImmediate(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
}

export function ensureWishOfferSchema(db) {
  ensureUserBlockSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wish_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_token TEXT NOT NULL UNIQUE,
      wish_id INTEGER NOT NULL,
      listing_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      tenant_user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      declined_at TEXT,
      withdrawn_at TEXT,
      blocked_at TEXT,
      expired_at TEXT,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wish_offers_pending_unique
      ON wish_offers(owner_user_id, listing_id, wish_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_wish_offers_owner_created
      ON wish_offers(owner_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_wish_offers_listing_created
      ON wish_offers(listing_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_wish_offers_wish_status
      ON wish_offers(wish_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_wish_offers_tenant_inbox
      ON wish_offers(tenant_user_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_wish_offers_owner_status
      ON wish_offers(owner_user_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_wish_offers_expires
      ON wish_offers(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_wish_offers_token
      ON wish_offers(public_token);
    CREATE TABLE IF NOT EXISTS wish_offer_idempotency (
      owner_user_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      offer_id INTEGER NOT NULL,
      listing_id INTEGER NOT NULL,
      wish_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (owner_user_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS wish_offer_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_token TEXT NOT NULL UNIQUE,
      offer_id INTEGER NOT NULL,
      reporter_user_id INTEGER NOT NULL,
      reported_user_id INTEGER NOT NULL,
      listing_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wish_offer_reports_dup
      ON wish_offer_reports(offer_id, reporter_user_id);
    CREATE INDEX IF NOT EXISTS idx_wish_offer_reports_reporter_created
      ON wish_offer_reports(reporter_user_id, created_at);
    CREATE TABLE IF NOT EXISTS wish_offer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id INTEGER,
      actor_user_id INTEGER,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_wish_offer_events_offer
      ON wish_offer_events(offer_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_wish_offer_events_type
      ON wish_offer_events(event_type, created_at);
  `);
  setWishOfferLifecycleHook(handleWishOfferLifecycle);
  setListingOfferHook(handleWishOfferLifecycle);
}

export function writeOfferEvent(db, {
  offerId = null,
  actorUserId = null,
  eventType,
  meta = {},
  now = new Date(),
} = {}) {
  if (!OFFER_EVENTS.includes(eventType)) return;
  const safe = { ...(meta && typeof meta === "object" ? meta : {}) };
  delete safe.phone;
  delete safe.email;
  delete safe.line_url;
  delete safe.contact;
  delete safe.session;
  db.prepare(
    `INSERT INTO wish_offer_events(offer_id, actor_user_id, event_type, created_at, meta_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(offerId || null, actorUserId || null, eventType, iso(now), JSON.stringify(safe));
}

function rollingWindowStart(now, ms) {
  return iso(new Date(atMs(now) - ms));
}

export function countOwnerOffersSince(db, ownerUserId, sinceIso) {
  return Number(db.prepare(
    "SELECT COUNT(*) AS n FROM wish_offers WHERE owner_user_id = ? AND created_at >= ?",
  ).get(Number(ownerUserId) || 0, sinceIso)?.n) || 0;
}

export function countListingOffersSince(db, listingId, sinceIso) {
  return Number(db.prepare(
    "SELECT COUNT(*) AS n FROM wish_offers WHERE listing_id = ? AND created_at >= ?",
  ).get(Number(listingId) || 0, sinceIso)?.n) || 0;
}

function hitWindow(map, key, now, limit, windowMs) {
  const at = atMs(now);
  const row = map.get(key) || { n: 0, start: at };
  if (at - row.start >= windowMs) {
    row.n = 0;
    row.start = at;
  }
  row.n += 1;
  map.set(key, row);
  if (row.n > limit) {
    const wait = Math.max(1, Math.ceil((windowMs - (at - row.start)) / 1000));
    throw offerHttpError("操作過於頻繁，請稍後再試", 429, "RATE_LIMITED", {
      retry_after: wait,
    });
  }
}

export function assertOfferBurst(actorKey, now = new Date()) {
  hitWindow(burstHits, `burst:${actorKey}`, now, OFFER_ENDPOINT_BURST, OFFER_ENDPOINT_WINDOW_MS);
}

export function recordOfferFail(actorKey, now = new Date()) {
  try {
    hitWindow(failHits, `fail:${actorKey}`, now, OFFER_FAIL_BURST, OFFER_FAIL_WINDOW_MS);
  } catch (error) {
    throw error;
  }
}

export function normalizeOfferIdempotencyKey(raw) {
  if (raw == null || raw === "") return "";
  const key = String(raw).trim();
  if (!key) return "";
  if (!OFFER_IDEMPOTENCY_KEY_RE.test(key)) {
    throw offerHttpError("idempotency_key 格式不正確", 400, "INVALID_IDEMPOTENCY_KEY");
  }
  return key;
}

export function loadWishByPublicRef(db, wishRef) {
  const raw = String(wishRef || "").trim();
  if (!raw || /^\d+$/.test(raw)) return null;
  return db.prepare("SELECT * FROM demand_posts WHERE public_token = ?").get(raw) || null;
}

export function loadOfferByPublicRef(db, offerRef) {
  const raw = String(offerRef || "").trim();
  if (!raw || /^\d+$/.test(raw)) return null;
  return db.prepare("SELECT * FROM wish_offers WHERE public_token = ?").get(raw) || null;
}

export function loadVisibleOffer(db, offerRef, userId) {
  const row = loadOfferByPublicRef(db, offerRef);
  if (!row) return null;
  const uid = Number(userId) || 0;
  if (Number(row.owner_user_id) !== uid && Number(row.tenant_user_id) !== uid) return null;
  return row;
}

function ownerBanned(db, ownerUserId, now = new Date()) {
  try {
    const until = String(db.prepare("SELECT self_ban_until FROM users WHERE id = ?").get(Number(ownerUserId))?.self_ban_until || "");
    if (!until) return false;
    const ts = Date.parse(until);
    return Number.isFinite(ts) && ts > atMs(now);
  } catch {
    return false;
  }
}

export function liveMatchEligible(db, listingRow, wishRow, now = new Date()) {
  const catalog = currentOfferCatalog();
  const listing = listingMatchSnapshot(listingRow, { catalog });
  const wish = wishMatchSnapshot(wishRow, { catalog });
  if (!isListingMatchable(listing, now)) return { eligible: false, reason: "listing_not_matchable" };
  if (!isWishMatchable(wish, now)) return { eligible: false, reason: "wish_not_matchable" };
  const match = evaluateMatch(listing, wish, { catalog, now });
  if (!match?.eligible) return { eligible: false, reason: "match_no_longer_eligible", match };
  return { eligible: true, listing, wish, match };
}

function lastTerminalOffer(db, ownerUserId, listingId, wishId) {
  return db.prepare(
    `SELECT * FROM wish_offers
     WHERE owner_user_id = ? AND listing_id = ? AND wish_id = ?
       AND status != 'pending'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(Number(ownerUserId), Number(listingId), Number(wishId));
}

function pendingOffer(db, ownerUserId, listingId, wishId) {
  return db.prepare(
    `SELECT * FROM wish_offers
     WHERE owner_user_id = ? AND listing_id = ? AND wish_id = ? AND status = 'pending'
     LIMIT 1`,
  ).get(Number(ownerUserId), Number(listingId), Number(wishId));
}

export function assertCreateOfferGates(db, {
  ownerUserId,
  listingRow,
  wishRow,
  now = new Date(),
} = {}) {
  if (!listingRow || Number(listingRow.listed_by_user_id) !== Number(ownerUserId)) {
    throw offerHttpError("找不到這則站內刊登", 404, "listing_not_found");
  }
  if (ownerBanned(db, ownerUserId, now)) {
    throw offerHttpError("目前無法提供", 409, "offer_unavailable");
  }
  if (tenantBlocksOwner(db, wishRow?.user_id, ownerUserId)) {
    throw offerHttpError("目前無法提供", 409, "offer_unavailable");
  }
  const live = liveMatchEligible(db, listingRow, wishRow, now);
  if (!live.eligible) {
    throw offerHttpError("目前無法提供", 409, "match_no_longer_eligible");
  }
  const since = rollingWindowStart(now, 24 * 60 * 60 * 1000);
  if (countOwnerOffersSince(db, ownerUserId, since) >= OFFER_OWNER_DAILY_CAP) {
    throw offerHttpError("今日提案次數已達上限", 429, "RATE_LIMITED", { retry_after: 3600 });
  }
  if (countListingOffersSince(db, listingRow.post_id, since) >= OFFER_LISTING_DAILY_CAP) {
    throw offerHttpError("此房源今日提案次數已達上限", 429, "RATE_LIMITED", { retry_after: 3600 });
  }
  const existingPending = pendingOffer(db, ownerUserId, listingRow.post_id, wishRow.id);
  if (existingPending) return { live, existingPending };
  const last = lastTerminalOffer(db, ownerUserId, listingRow.post_id, wishRow.id);
  if (last) {
    const created = Date.parse(last.created_at);
    if (Number.isFinite(created) && atMs(now) - created < OFFER_SAME_WISH_COOLDOWN_MS) {
      throw offerHttpError("稍後才能再提供", 429, "OFFER_COOLDOWN", {
        retry_after: Math.max(1, Math.ceil((OFFER_SAME_WISH_COOLDOWN_MS - (atMs(now) - created)) / 1000)),
      });
    }
  }
  return { live, existingPending: null };
}

export function insertPendingOffer(db, {
  ownerUserId,
  listingRow,
  wishRow,
  idempotencyKey = "",
  now = new Date(),
} = {}) {
  const stamp = iso(now);
  const expires = iso(new Date(atMs(now) + OFFER_TTL_MS));
  const token = newOfferToken();
  try {
    const ins = db.prepare(
      `INSERT INTO wish_offers(
         public_token, wish_id, listing_id, owner_user_id, tenant_user_id, status,
         idempotency_key, created_at, updated_at, expires_at, version
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 1)`,
    ).run(
      token,
      wishRow.id,
      listingRow.post_id,
      Number(ownerUserId),
      Number(wishRow.user_id),
      idempotencyKey || null,
      stamp,
      stamp,
      expires,
    );
    return db.prepare("SELECT * FROM wish_offers WHERE id = ?").get(Number(ins.lastInsertRowid));
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE") || String(error.code || "") === "SQLITE_CONSTRAINT_UNIQUE") {
      return pendingOffer(db, ownerUserId, listingRow.post_id, wishRow.id);
    }
    throw error;
  }
}

export function createWishOffer(db, ownerUserId, listingRef, wishRef, {
  idempotencyKey,
  now = new Date(),
  actorKey = "",
} = {}) {
  assertWishOfferEnabled();
  if (actorKey) assertOfferBurst(actorKey, now);
  const key = normalizeOfferIdempotencyKey(idempotencyKey);
  expireOpenSelfListings(db, now);
  return withImmediate(db, () => {
    if (key) {
      const replay = db.prepare(
        "SELECT * FROM wish_offer_idempotency WHERE owner_user_id = ? AND idempotency_key = ?",
      ).get(Number(ownerUserId), key);
      if (replay) {
        const offer = db.prepare("SELECT * FROM wish_offers WHERE id = ?").get(replay.offer_id);
        if (offer) return offer;
      }
    }
    const listingRow = getSelfRow(db, listingRef);
    const wishRow = loadWishByPublicRef(db, wishRef);
    if (!listingRow || !wishRow) {
      recordOfferFail(actorKey || `owner:${ownerUserId}`, now);
      throw offerHttpError("目前無法提供", 409, "match_no_longer_eligible");
    }
    let gates;
    try {
      gates = assertCreateOfferGates(db, { ownerUserId, listingRow, wishRow, now });
    } catch (error) {
      recordOfferFail(actorKey || `owner:${ownerUserId}`, now);
      throw error;
    }
    if (key && gates.existingPending) {
      const same = Number(gates.existingPending.listing_id) === Number(listingRow.post_id)
        && Number(gates.existingPending.wish_id) === Number(wishRow.id);
      if (!same) throw offerHttpError("此操作已用於另一筆提案", 409, "IDEMPOTENCY_CONFLICT");
    }
    const offer = gates.existingPending || insertPendingOffer(db, {
      ownerUserId,
      listingRow,
      wishRow,
      idempotencyKey: key,
      now,
    });
    if (!offer) throw offerHttpError("目前無法提供", 409, "match_no_longer_eligible");
    if (key) {
      try {
        db.prepare(
          `INSERT INTO wish_offer_idempotency(owner_user_id, idempotency_key, offer_id, listing_id, wish_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(Number(ownerUserId), key, offer.id, listingRow.post_id, wishRow.id, iso(now));
      } catch (error) {
        const replay = db.prepare(
          "SELECT * FROM wish_offer_idempotency WHERE owner_user_id = ? AND idempotency_key = ?",
        ).get(Number(ownerUserId), key);
        if (replay && Number(replay.offer_id) !== Number(offer.id)) {
          throw offerHttpError("此操作已用於另一筆提案", 409, "IDEMPOTENCY_CONFLICT");
        }
        if (!String(error.message || "").includes("UNIQUE")) throw error;
      }
    }
    writeOfferEvent(db, {
      offerId: offer.id,
      actorUserId: ownerUserId,
      eventType: "offer_created",
      meta: { listing_id: listingRow.post_id },
      now,
    });
    return offer;
  });
}

export function transitionOffer(db, offerId, {
  fromStatus,
  toStatus,
  version,
  stampField,
  now = new Date(),
} = {}) {
  const stamp = iso(now);
  const field = stampField || `${toStatus}_at`;
  const result = db.prepare(
    `UPDATE wish_offers
     SET status = ?, ${field} = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND status = ? AND version = ?`,
  ).run(toStatus, stamp, stamp, Number(offerId), fromStatus, Number(version));
  return Number(result.changes) || 0;
}

export function loadFreshOffer(db, offerId) {
  return db.prepare("SELECT * FROM wish_offers WHERE id = ?").get(Number(offerId));
}

export function terminalizeOffers(db, {
  wishId = null,
  listingId = null,
  ownerUserId = null,
  tenantUserId = null,
  toStatus = "expired",
  now = new Date(),
} = {}) {
  if (!OFFER_TERMINAL_STATUSES.includes(toStatus) && toStatus !== "blocked") return 0;
  const clauses = ["status IN ('pending', 'accepted')"];
  const params = [];
  if (wishId) {
    clauses.push("wish_id = ?");
    params.push(Number(wishId));
  }
  if (listingId) {
    clauses.push("listing_id = ?");
    params.push(Number(listingId));
  }
  if (ownerUserId) {
    clauses.push("owner_user_id = ?");
    params.push(Number(ownerUserId));
  }
  if (tenantUserId) {
    clauses.push("tenant_user_id = ?");
    params.push(Number(tenantUserId));
  }
  if (clauses.length === 1) return 0;
  const stamp = iso(now);
  const field = toStatus === "blocked" ? "blocked_at"
    : toStatus === "withdrawn" ? "withdrawn_at"
      : "expired_at";
  const rows = db.prepare(`SELECT id FROM wish_offers WHERE ${clauses.join(" AND ")}`).all(...params);
  if (!rows.length) return 0;
  db.prepare(
    `UPDATE wish_offers
     SET status = ?, ${field} = COALESCE(${field}, ?), updated_at = ?, version = version + 1
     WHERE ${clauses.join(" AND ")}`,
  ).run(toStatus, stamp, stamp, ...params);
  for (const row of rows) {
    writeOfferEvent(db, {
      offerId: row.id,
      eventType: toStatus === "blocked" ? "offer_blocked" : toStatus === "withdrawn" ? "offer_withdrawn" : "offer_expired",
      now,
    });
  }
  return rows.length;
}

export function onWishLifecycleChanged(db, { wishId, lifecycle, now = new Date() } = {}) {
  const life = String(lifecycle || "");
  if (life === "blocked") {
    return terminalizeOffers(db, { wishId, toStatus: "blocked", now });
  }
  if (["paused", "completed", "expired"].includes(life)) {
    return terminalizeOffers(db, { wishId, toStatus: "expired", now });
  }
  return 0;
}

export function onListingClosed(db, { listingId, now = new Date() } = {}) {
  return terminalizeOffers(db, { listingId, toStatus: "withdrawn", now });
}

export function sweepIneligiblePendingOffers(db, now = new Date()) {
  let changed = 0;
  try {
    const wishRows = db.prepare(`
      SELECT o.id FROM wish_offers o
      JOIN demand_posts p ON p.id = o.wish_id
      WHERE o.status = 'pending'
        AND (
          COALESCE(NULLIF(p.lifecycle, ''), 'active') IN ('paused', 'completed', 'expired', 'blocked', 'draft')
          OR p.status IN ('closed', 'hidden', 'expired', 'draft')
        )
    `).all();
    for (const row of wishRows) {
      const offer = loadFreshOffer(db, row.id);
      if (!offer || offer.status !== "pending") continue;
      const toStatus = String(db.prepare("SELECT lifecycle FROM demand_posts WHERE id = ?").get(offer.wish_id)?.lifecycle || "") === "blocked"
        ? "blocked"
        : "expired";
      if (transitionOffer(db, offer.id, {
        fromStatus: "pending",
        toStatus,
        version: offer.version,
        stampField: toStatus === "blocked" ? "blocked_at" : "expired_at",
        now,
      })) {
        writeOfferEvent(db, { offerId: offer.id, eventType: toStatus === "blocked" ? "offer_blocked" : "offer_expired", now });
        changed += 1;
      }
    }
  } catch { /* isolated tests may lack tables */ }
  try {
    const listingRows = db.prepare(`
      SELECT o.id FROM wish_offers o
      JOIN listings l ON l.post_id = o.listing_id
      WHERE o.status = 'pending'
        AND COALESCE(l.self_status, 'open') != 'open'
    `).all();
    for (const row of listingRows) {
      const offer = loadFreshOffer(db, row.id);
      if (!offer || offer.status !== "pending") continue;
      if (transitionOffer(db, offer.id, {
        fromStatus: "pending",
        toStatus: "withdrawn",
        version: offer.version,
        stampField: "withdrawn_at",
        now,
      })) {
        writeOfferEvent(db, { offerId: offer.id, eventType: "offer_withdrawn", now });
        changed += 1;
      }
    }
  } catch { /* isolated tests */ }
  return changed;
}

export function handleWishOfferLifecycle(db, payload = {}) {
  try {
    db.prepare("SELECT 1 FROM wish_offers LIMIT 1").get();
  } catch {
    return 0;
  }
  if (payload.sweep) return sweepIneligiblePendingOffers(db, payload.now);
  if (payload.wishId) return onWishLifecycleChanged(db, payload);
  if (payload.listingId) return onListingClosed(db, payload);
  return 0;
}

function truncateTime(value) {
  const raw = String(value || "");
  if (!raw) return "";
  return raw.slice(0, 16);
}

function safeWishSummary(wishRow, match = null) {
  const catalog = currentOfferCatalog();
  const publicWish = {
    public_token: wishRow.public_token,
    public_path: wishRow.public_token ? `/w/${wishRow.public_token}` : "",
    city: wishRow.city || "",
    districts: wishMatchSnapshot(wishRow, { catalog }).districts,
    district_labels: wishMatchSnapshot(wishRow, { catalog }).district_labels,
    rent_min: Number(wishRow.rent_min) || 0,
    rent_max: Number(wishRow.rent_max) || 0,
    housing_type: wishRow.housing_type || "",
    ping_min: Number(wishRow.ping_min) || 0,
    layout: wishRow.layout || "",
    move_in_date: wishRow.move_in_date || "",
    lease_duration: wishRow.lease_duration || "",
  };
  const card = ownerSafeWishCard(publicWish, match || {
    activity_bucket: "",
    activity_label: "",
    match_score: 0,
    matched_conditions: [],
    unmet_unknowns: [],
    explanation: [],
  });
  delete card.offer_available;
  delete card.offer_cta;
  return card;
}

function safeListingSummary(listingRow, { includePublicContact = false } = {}) {
  const decorated = decorateSelfListing(listingRow, { viewerId: 0 });
  const view = publicListingView(decorated, listingRow.post_id);
  const out = {
    listing_ref: Number(view.id) || 0,
    public_path: `/l/${view.id}`,
    title: view.title || "",
    price: view.price || "",
    price_num: Number(view.price_num) || 0,
    area_name: view.area_name || "",
    address: view.address || "",
    layout: view.layout || "",
    floor_name: view.floor_name || "",
    kind_name: view.kind_name || "",
    cover: view.cover || "",
    photos: Array.isArray(view.photos) ? view.photos : [],
    traits: Array.isArray(view.traits) ? view.traits : [],
    trait_labels: Array.isArray(view.trait_labels) ? view.trait_labels : [],
    deposit: view.deposit || "",
    body: view.body || "",
  };
  if (includePublicContact) {
    out.contact_name = view.contact_name || "";
    out.phone = view.phone || "";
    out.line_url = view.line_url || "";
  }
  return out;
}

export function viewerRoleForOffer(offer, userId) {
  if (Number(offer.owner_user_id) === Number(userId)) return "owner";
  if (Number(offer.tenant_user_id) === Number(userId)) return "tenant";
  return "";
}

export function publicOfferView(db, offer, userId, { includeMatch = true } = {}) {
  const role = viewerRoleForOffer(offer, userId);
  if (!role) return null;
  const wishRow = db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(offer.wish_id);
  const listingRow = getSelfRow(db, offer.listing_id);
  let match = null;
  if (includeMatch && wishRow && listingRow) {
    const live = liveMatchEligible(db, listingRow, wishRow);
    match = live.match || null;
  }
  const pending = offer.status === "pending";
  const accepted = offer.status === "accepted";
  const listing = listingRow
    ? safeListingSummary(listingRow, { includePublicContact: !pending || role === "tenant" })
    : { listing_ref: Number(offer.listing_id) || 0 };
  const wish = wishRow ? safeWishSummary(wishRow, match) : { wish_ref: "" };
  const view = {
    offer_ref: offer.public_token,
    status: offer.status,
    viewer_role: role,
    created_at: truncateTime(offer.created_at),
    expires_at: truncateTime(offer.expires_at),
    accepted_at: accepted ? truncateTime(offer.accepted_at) : "",
    listing,
    wish,
    match_summary: match ? {
      matched_count: (match.matched_conditions || []).length,
      explanation: match.explanation || [],
    } : { matched_count: 0, explanation: [] },
    actions: {
      accept: role === "tenant" && pending,
      decline: role === "tenant" && pending,
      withdraw: role === "owner" && pending,
      block: role === "tenant" && (pending || accepted),
      report: role === "tenant",
      contact: accepted && !tenantBlocksOwner(db, offer.tenant_user_id, offer.owner_user_id),
    },
  };
  return assertOfferSafeView(view);
}

const OFFER_BANNED_KEYS = Object.freeze([
  "user_id", "owner_user_id", "tenant_user_id", "wish_id", "id",
  "rank_score", "activity_score", "freshness_score", "last_login_at",
]);

export function assertOfferSafeView(view) {
  const json = JSON.stringify(view);
  for (const key of OFFER_BANNED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(view, key)) {
      throw offerHttpError("提案結果含有不該出現的資料", 500, "offer_projection_unsafe");
    }
  }
  if (/"wish_id"|"owner_user_id"|"tenant_user_id"|"rank_score"|"activity_score"/.test(json)) {
    throw offerHttpError("提案結果含有不該出現的資料", 500, "offer_projection_unsafe");
  }
  return view;
}

function contactFieldsFromWish(wishRow) {
  return {
    display_name: String(wishRow?.contact_name || "").trim(),
    phone: String(wishRow?.phone || "").trim(),
    line_url: String(wishRow?.line_url || "").trim(),
  };
}

function contactFieldsFromListing(listingRow) {
  const view = listingRow ? publicListingView(decorateSelfListing(listingRow), listingRow.post_id) : {};
  return {
    display_name: String(view.contact_name || "").trim(),
    phone: String(view.phone || view.mobile || "").trim(),
    line_url: String(view.line_url || "").trim(),
  };
}

function contactAvailable(fields) {
  return Boolean(fields.display_name || fields.phone || fields.line_url);
}

export function projectOfferContact(db, offer, userId, now = new Date()) {
  const role = viewerRoleForOffer(offer, userId);
  if (!role) throw offerHttpError("找不到這筆提案", 404, "offer_not_found");
  if (offer.status !== "accepted") {
    throw offerHttpError("尚未互相確認，無法查看聯絡方式", 404, "contact_unavailable");
  }
  if (tenantBlocksOwner(db, offer.tenant_user_id, offer.owner_user_id)) {
    throw offerHttpError("聯絡方式已無法使用", 404, "contact_unavailable");
  }
  const wishRow = db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(offer.wish_id);
  const listingRow = getSelfRow(db, offer.listing_id);
  const fields = role === "owner" ? contactFieldsFromWish(wishRow) : contactFieldsFromListing(listingRow);
  const available = contactAvailable(fields);
  writeOfferEvent(db, {
    offerId: offer.id,
    actorUserId: userId,
    eventType: "contact_projection_accessed",
    meta: { viewer_role: role, available },
    now,
  });
  return {
    offer_ref: offer.public_token,
    status: "accepted",
    viewer_role: role,
    contact: {
      display_name: fields.display_name,
      phone: fields.phone,
      line_url: fields.line_url,
      available,
      next_step: available
        ? "請用對方留下的方式聯絡，並可隨時封鎖或檢舉。"
        : (role === "owner"
          ? "對方尚未留下電話或 LINE。可先查看房源公開資訊，或等對方補上聯絡方式。"
          : "請用房源頁的公開聯絡方式聯繫，或請對方補上資料。"),
    },
  };
}

export function attachOfferCtas(db, items, { listingId, ownerUserId, now = new Date() } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!isWishOfferEnabled(flagsCache)) {
    return list.map((item) => ({
      ...item,
      offer_available: false,
      offer_cta: "提供房源（即將推出）",
    }));
  }
  const tokens = list.map((item) => item.wish_ref).filter(Boolean);
  const wishes = new Map();
  if (tokens.length) {
    const marks = tokens.map(() => "?").join(",");
    for (const row of db.prepare(`SELECT id, user_id, public_token FROM demand_posts WHERE public_token IN (${marks})`).all(...tokens)) {
      wishes.set(row.public_token, row);
    }
  }
  const pending = new Map();
  if (tokens.length) {
    for (const row of db.prepare(
      `SELECT public_token, wish_id, status FROM wish_offers
       WHERE owner_user_id = ? AND listing_id = ? AND status = 'pending'`,
    ).all(Number(ownerUserId), Number(listingId))) {
      pending.set(Number(row.wish_id), row);
    }
  }
  return list.map((item) => {
    const wish = wishes.get(item.wish_ref);
    if (!wish) {
      return { ...item, offer_available: false, offer_cta: "目前無法提供", offer_status: "unavailable" };
    }
    if (tenantBlocksOwner(db, wish.user_id, ownerUserId) || ownerBanned(db, ownerUserId, now)) {
      return { ...item, offer_available: false, offer_cta: "目前無法提供", offer_status: "unavailable" };
    }
    const open = pending.get(Number(wish.id));
    if (open) {
      return {
        ...item,
        offer_available: false,
        offer_cta: "已提供，等待對方回覆",
        offer_status: "pending",
        offer_ref: open.public_token,
      };
    }
    const last = lastTerminalOffer(db, ownerUserId, listingId, wish.id);
    if (last) {
      const created = Date.parse(last.created_at);
      if (Number.isFinite(created) && atMs(now) - created < OFFER_SAME_WISH_COOLDOWN_MS) {
        return { ...item, offer_available: false, offer_cta: "稍後才能再提供", offer_status: "cooldown" };
      }
    }
    return { ...item, offer_available: true, offer_cta: "提供我的房源", offer_status: "ready" };
  });
}

export function publicBlockView(row, listingRow = null) {
  return {
    block_ref: row.public_token,
    created_at: truncateTime(row.created_at),
    listing_title: listingRow?.title || "",
    listing_ref: listingRow?.post_id || row.listing_id || 0,
  };
}

export function listMyBlocks(db, userId) {
  return listBlocksForUser(db, userId).map((row) => {
    const listing = row.listing_id ? getSelfRow(db, row.listing_id) : null;
    return publicBlockView(row, listing);
  });
}

export function unblockByRef(db, userId, blockRef) {
  const result = removeUserBlock(db, userId, blockRef);
  if (!result) throw offerHttpError("找不到這筆封鎖", 404, "block_not_found");
  if (result.forbidden) throw offerHttpError("這筆封鎖不能自行解除", 403, "block_locked");
  return { ok: true, block_ref: result.row.public_token };
}

export function createOfferReport(db, userId, offer, { reason, detail = "", now = new Date(), actorKey = "" } = {}) {
  assertWishOfferEnabled();
  if (actorKey) assertOfferBurst(`report:${actorKey}`, now);
  const code = String(reason || "").trim();
  if (!OFFER_REPORT_REASONS.includes(code)) {
    throw offerHttpError("請選擇檢舉原因", 400, "invalid_report_reason");
  }
  if (containsUnsafeMarkup(detail)) {
    throw offerHttpError("檢舉內容含有不允許的標記", 400, "unsafe_report_detail");
  }
  const text = sanitizeDocumentText(detail, OFFER_REPORT_DETAIL_MAX);
  const since = rollingWindowStart(now, 24 * 60 * 60 * 1000);
  const used = Number(db.prepare(
    "SELECT COUNT(*) AS n FROM wish_offer_reports WHERE reporter_user_id = ? AND created_at >= ?",
  ).get(Number(userId), since)?.n) || 0;
  if (used >= OFFER_REPORT_DAILY_CAP) {
    throw offerHttpError("今日檢舉次數已達上限", 429, "RATE_LIMITED", { retry_after: 3600 });
  }
  const existing = db.prepare(
    "SELECT public_token FROM wish_offer_reports WHERE offer_id = ? AND reporter_user_id = ?",
  ).get(offer.id, Number(userId));
  if (existing) return { ok: true, already: true, report_ref: existing.public_token };
  const token = newOfferToken();
  try {
    db.prepare(
      `INSERT INTO wish_offer_reports(
         public_token, offer_id, reporter_user_id, reported_user_id, listing_id, reason, detail, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).run(token, offer.id, Number(userId), offer.owner_user_id, offer.listing_id, code, text, iso(now));
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) {
      const row = db.prepare(
        "SELECT public_token FROM wish_offer_reports WHERE offer_id = ? AND reporter_user_id = ?",
      ).get(offer.id, Number(userId));
      return { ok: true, already: true, report_ref: row?.public_token || "" };
    }
    throw error;
  }
  writeOfferEvent(db, {
    offerId: offer.id,
    actorUserId: userId,
    eventType: "offer_reported",
    meta: { reason: code },
    now,
  });
  return { ok: true, already: false, report_ref: token };
}

export function listAdminOfferReports(db, { limit = 50 } = {}) {
  const size = Math.min(100, Math.max(1, Number(limit) || 50));
  return db.prepare(
    `SELECT public_token, offer_id, reason, status, created_at, listing_id
     FROM wish_offer_reports ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(size).map((row) => ({
    report_ref: row.public_token,
    reason: row.reason,
    status: row.status,
    created_at: truncateTime(row.created_at),
    listing_ref: row.listing_id,
  }));
}

export function explainWishOfferPlans(db) {
  const explain = (sql) => {
    try {
      return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
    } catch (error) {
      return [{ error: error.message }];
    }
  };
  return {
    owner_daily: explain("SELECT COUNT(*) AS n FROM wish_offers WHERE owner_user_id = 1 AND created_at >= '2026-01-01'"),
    listing_daily: explain("SELECT COUNT(*) AS n FROM wish_offers WHERE listing_id = 1 AND created_at >= '2026-01-01'"),
    wish_pending: explain("SELECT id FROM wish_offers WHERE wish_id = 1 AND status = 'pending'"),
    tenant_inbox: explain("SELECT id FROM wish_offers WHERE tenant_user_id = 1 AND status = 'pending' ORDER BY created_at DESC"),
    owner_sent: explain("SELECT id FROM wish_offers WHERE owner_user_id = 1 AND status = 'pending' ORDER BY created_at DESC"),
    expiry: explain("SELECT id FROM wish_offers WHERE status = 'pending' AND expires_at <= '2026-12-01'"),
    block_lookup: explain("SELECT id FROM user_blocks WHERE blocker_user_id = 1 AND blocked_user_id = 2"),
    report_rate: explain("SELECT COUNT(*) AS n FROM wish_offer_reports WHERE reporter_user_id = 1 AND created_at >= '2026-01-01'"),
  };
}

export {
  insertUserBlock,
  isBlocked,
  loadOwnedBlock,
  tenantBlocksOwner,
};
