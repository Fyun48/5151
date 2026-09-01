import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { shouldKeepListing, passesAttributeFilters, passesDisplayFilters, listingHasElevator, matchesHousingKind, normalizeListQuery } from "./floors.js";
import { isTrustedGeoSource, listingCommunityId } from "./location.js";
import { makeRouteKey } from "./route.js";
import { sameSearch } from "./client591.js";
import { districtNameFromListing } from "./regions.js";
import { preferPrimaryListing } from "./match.js";
import { hasWorkPoint } from "./geo.js";
import { applySettingPatch, hydrateSettings, parseSettingRows, snapshotSettings } from "./settingsState.js";
import { defaultNotifyMatrix } from "./notifyMatrix.js";
import { DATA_EPOCH, shouldResetForEpoch } from "./dataEpoch.js";
import { nextWatchNote } from "./watchFlags.js";
import { countsTowardAllTotal, isConfirmedOffline, isPendingOffline } from "./offline.js";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "591.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 8000");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS listings (
    post_id INTEGER PRIMARY KEY,
    source_key TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    price TEXT,
    price_num INTEGER,
    address TEXT,
    area_name TEXT,
    layout TEXT,
    floor_name TEXT,
    kind_name TEXT,
    role_name TEXT,
    cover TEXT,
    tags TEXT,
    refresh_time TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_event TEXT NOT NULL DEFAULT 'new',
    viewed INTEGER NOT NULL DEFAULT 0,
    watched INTEGER NOT NULL DEFAULT 0,
    viewed_at TEXT,
    watched_at TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    source_key TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_listings_source ON listings(source_key);
  CREATE INDEX IF NOT EXISTS idx_listings_watched ON listings(watched);
  CREATE INDEX IF NOT EXISTS idx_listings_viewed ON listings(viewed);
  CREATE INDEX IF NOT EXISTS idx_listings_last_seen ON listings(last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
`);

try {
  db.exec("ALTER TABLE listings ADD COLUMN search_key TEXT NOT NULL DEFAULT ''");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN hidden_at TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN lat REAL");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN lng REAL");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN geo_source TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN watch_note TEXT NOT NULL DEFAULT ''");
} catch {
  // already migrated
}
db.exec(`
  CREATE TABLE IF NOT EXISTS geo_cache (
    address TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS route_cache (
    route_key TEXT PRIMARY KEY,
    distances TEXT NOT NULL,
    min_km REAL NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
try {
  db.exec("ALTER TABLE listings ADD COLUMN match_post_id INTEGER");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN match_level TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN match_detail TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN match_rejected INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN extra_fee INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN extra_fee_text TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN price_contain_text TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN extra_fees TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN extra_fees_fetched INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN contact_name TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN contact_role TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN agency TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN mobile TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN phone TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN line_url TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN avatar TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN contact_uid INTEGER");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN contact_fetched INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN community_id INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN community_name TEXT NOT NULL DEFAULT ''");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN offline INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN offline_at TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN last_checked_at TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN offline_confirmed INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN match_verdict TEXT");
} catch {
  // already migrated
}
db.exec(`
  CREATE TABLE IF NOT EXISTS community_cache (
    community_id INTEGER PRIMARY KEY,
    name TEXT,
    address TEXT,
    lat REAL,
    lng REAL,
    updated_at TEXT NOT NULL
  );
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_search ON listings(search_key)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_hidden ON listings(hidden)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_match ON listings(match_level)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_offline ON listings(offline)");

const DEFAULTS = {
  searchUrls: [],
  intervalMinutes: 5,
  pagesPerWatch: 40,
  notifyNew: true,
  notifySameSource: true,
  notifyViewed: false,
  notifyWatchedAlways: true,
  discordWebhook: "",
  webhookNotifyNew: true,
  webhookNotifyPriceDrop: true,
  webhookNotifyTitleUpdate: true,
  notifyMatrix: defaultNotifyMatrix(),
  windowsToast: true,
  hasBaseline: false,
  excludeLowFloors: true,
  wholeFloorOnly: true,
  minBuildingFloors: 4,
  excludeKeywords: [],
  excludeAgents: [],
  excludeAgentIds: [],
  excludeBoxes: [],
  workAddress: "",
  commuteKm: 0,
  workLat: null,
  workLng: null,
  settingProfiles: [],
  activeProfileId: "",
  watchDistricts: [],
  priceMin: 0,
  priceMax: 36000,
  areaMax: 0,
  excludeRooftop: true,
  offlineConfirmDays: 7,
  dataEpoch: DATA_EPOCH,
};

export function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  return hydrateSettings(parseSettingRows(rows), DEFAULTS);
}

export function saveSettings(partial) {
  const current = getSettings();
  const next = applySettingPatch(current, partial);
  const upsert = db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) continue;
      upsert.run(key, JSON.stringify(value));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return next;
}

export function saveAsProfile(name, livePatch) {
  const current = livePatch && typeof livePatch === "object" ? saveSettings(livePatch) : getSettings();
  const profiles = [...(current.settingProfiles || [])];
  const id = `p-${Date.now()}`;
  const label = String(name || "").trim().slice(0, 40) || `設定 ${profiles.length + 1}`;
  profiles.push({
    id,
    name: label,
    saved_at: new Date().toISOString(),
    data: snapshotSettings(current),
  });
  return saveSettings({
    settingProfiles: profiles,
    activeProfileId: id,
  });
}

export function loadProfile(id) {
  const current = getSettings();
  const profile = (current.settingProfiles || []).find((item) => item.id === id);
  if (!profile) {
    const err = new Error("找不到這個設定檔");
    err.status = 404;
    throw err;
  }
  return saveSettings({
    ...snapshotSettings({ ...DEFAULTS, ...profile.data }),
    settingProfiles: current.settingProfiles,
    activeProfileId: profile.id,
  });
}

export function deleteProfile(id) {
  const current = getSettings();
  const profiles = (current.settingProfiles || []).filter((item) => item.id !== id);
  const active = current.activeProfileId === id ? (profiles[0]?.id || "") : current.activeProfileId;
  return saveSettings({ settingProfiles: profiles, activeProfileId: active });
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function decorateListing(row, settings = getSettings()) {
  if (!row) return row;
  row = applyCachedCoords(row, settings);
  const commute = Number.isFinite(Number(row.route_km)) ? Number(row.route_km) : null;
  const matchPostId = Number(row.match_post_id) || 0;
  const matchPeer = matchPostId
    ? db.prepare("SELECT post_id, title, url, price, offline FROM listings WHERE post_id = ?").get(matchPostId)
    : null;
  return {
    ...row,
    extra_fees: Array.isArray(row.extra_fees) ? row.extra_fees : parseJson(row.extra_fees, []),
    has_elevator: listingHasElevator(row),
    commute_km: commute == null ? null : Math.round(commute * 10) / 10,
    commute_routes: Array.isArray(row.route_kms) ? row.route_kms : [],
    district: districtNameFromListing(row),
    match_peer: matchPeer || null,
  };
}

export function getListing(postId) {
  return decorateListing(db.prepare("SELECT * FROM listings WHERE post_id = ?").get(postId));
}

export function findBySourceKey(sourceKey, excludePostId) {
  return db
    .prepare(
      "SELECT * FROM listings WHERE source_key = ? AND post_id != ? ORDER BY last_seen_at DESC",
    )
    .all(sourceKey, excludePostId)
    .map(decorateListing);
}

export function listMatchCandidates(excludePostId) {
  return db
    .prepare(
      `SELECT * FROM listings
       WHERE post_id != ?
       ORDER BY IFNULL(offline, 0) DESC, hidden DESC, viewed DESC, last_seen_at DESC
       LIMIT 4000`,
    )
    .all(excludePostId)
    .map(decorateListing);
}

export function setListingMatch(postId, match) {
  db.prepare(
    `UPDATE listings
     SET match_post_id = ?, match_level = ?, match_detail = ?, match_rejected = 0
     WHERE post_id = ?`,
  ).run(match.match_post_id || null, match.match_level || null, match.match_detail || "", postId);
  return getListing(postId);
}

export function rejectSuspectedMatch(postId) {
  const listing = getListing(postId);
  if (!listing) return null;
  db.prepare(
    `UPDATE listings
     SET match_verdict = 'no', match_rejected = 1, hidden = 0, viewed = 0
     WHERE post_id = ?`,
  ).run(postId);
  return getListing(postId);
}

export function confirmSuspectedMatch(postId) {
  const listing = getListing(postId);
  if (!listing?.match_post_id) return null;
  const peer = getListing(listing.match_post_id);
  if (!peer) return null;
  const primary = preferPrimaryListing(listing, peer);
  const duplicate = Number(primary.post_id) === Number(listing.post_id) ? peer : listing;
  const now = new Date().toISOString();
  const watched = Number(primary.watched) === 1 || Number(duplicate.watched) === 1 ? 1 : 0;
  const watchNote = String(primary.watch_note || "").trim() || String(duplicate.watch_note || "").trim();
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE listings
       SET match_verdict = 'yes', match_rejected = 0, hidden = 1, viewed = 1,
           match_post_id = ?, hidden_at = COALESCE(hidden_at, ?), viewed_at = COALESCE(viewed_at, ?)
       WHERE post_id = ?`,
    ).run(primary.post_id, now, now, duplicate.post_id);
    db.prepare(
      `UPDATE listings
       SET match_verdict = '', match_rejected = 0, hidden = 0, match_level = NULL,
           match_detail = ?, match_post_id = ?, watched = ?, watch_note = ?,
           watched_at = CASE WHEN ? = 1 THEN COALESCE(watched_at, ?) ELSE watched_at END
       WHERE post_id = ?`,
    ).run(
      `已確認同一間，保留較低價／較新刊登，隱藏 #${duplicate.post_id}`,
      duplicate.post_id,
      watched,
      watchNote,
      watched,
      now,
      primary.post_id,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getListing(postId);
}

export function currentSearchKeys() {
  return (getSettings().searchUrls || []).map((url) => String(url).trim()).filter(Boolean);
}

function expandSearchKeys(keys) {
  if (!keys?.length) return keys;
  const stored = db
    .prepare("SELECT DISTINCT search_key FROM listings")
    .all()
    .map((row) => row.search_key)
    .filter(Boolean);
  const out = new Set(keys);
  for (const key of stored) {
    if (keys.some((url) => sameSearch(url, key))) out.add(key);
  }
  return [...out];
}

function searchWhere(searchKeys, clauses, params) {
  const keys = expandSearchKeys(searchKeys === undefined ? currentSearchKeys() : searchKeys);
  if (keys?.length) {
    clauses.push(`search_key IN (${keys.map(() => "?").join(",")})`);
    params.push(...keys);
  }
}

export function upsertListing(listing) {
  const extraFees =
    typeof listing.extra_fees === "string"
      ? listing.extra_fees
      : JSON.stringify(listing.extra_fees || []);
  const communityId = Number(listing.community_id) || listingCommunityId(listing) || 0;
  const communityName = String(listing.community_name || "").trim();
  db.prepare(`
    INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num, extra_fee, extra_fee_text,
      price_contain_text, extra_fees, extra_fees_fetched, address, area_name,
      layout, floor_name, kind_name, role_name, cover, tags, refresh_time,
      first_seen_at, last_seen_at, last_event, viewed, watched, lat, lng,
      community_id, community_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      source_key = excluded.source_key,
      search_key = excluded.search_key,
      title = excluded.title,
      url = excluded.url,
      price = excluded.price,
      price_num = excluded.price_num,
      extra_fee = excluded.extra_fee,
      extra_fee_text = excluded.extra_fee_text,
      price_contain_text = excluded.price_contain_text,
      extra_fees = CASE
        WHEN listings.extra_fees_fetched = 1 AND IFNULL(listings.extra_fees, '') NOT IN ('', '[]')
        THEN listings.extra_fees
        ELSE excluded.extra_fees
      END,
      address = CASE
        WHEN IFNULL(listings.geo_source, '') = 'community' AND IFNULL(listings.address, '') != ''
        THEN listings.address
        ELSE excluded.address
      END,
      area_name = excluded.area_name,
      layout = excluded.layout,
      floor_name = excluded.floor_name,
      kind_name = excluded.kind_name,
      role_name = excluded.role_name,
      cover = excluded.cover,
      tags = excluded.tags,
      refresh_time = excluded.refresh_time,
      last_seen_at = excluded.last_seen_at,
      last_event = CASE
        WHEN IFNULL(listings.offline, 0) = 1 AND excluded.last_event IN ('seen', 'offline', '') THEN 'same_source'
        ELSE excluded.last_event
      END,
      last_checked_at = excluded.last_seen_at,
      offline = 0,
      offline_at = NULL,
      offline_confirmed = 0,
      lat = CASE
        WHEN IFNULL(listings.geo_source, '') IN ('591', 'community') THEN listings.lat
        ELSE COALESCE(excluded.lat, listings.lat)
      END,
      lng = CASE
        WHEN IFNULL(listings.geo_source, '') IN ('591', 'community') THEN listings.lng
        ELSE COALESCE(excluded.lng, listings.lng)
      END,
      community_id = CASE
        WHEN excluded.community_id > 0 THEN excluded.community_id
        ELSE listings.community_id
      END,
      community_name = CASE
        WHEN IFNULL(excluded.community_name, '') != '' THEN excluded.community_name
        ELSE listings.community_name
      END
  `).run(
    listing.post_id,
    listing.source_key,
    listing.search_key || "",
    listing.title,
    listing.url,
    listing.price,
    listing.price_num,
    Number(listing.extra_fee) || 0,
    listing.extra_fee_text || "",
    listing.price_contain_text || "",
    extraFees,
    Number(listing.extra_fees_fetched) || 0,
    listing.address,
    listing.area_name,
    listing.layout,
    listing.floor_name,
    listing.kind_name,
    listing.role_name,
    listing.cover,
    listing.tags,
    listing.refresh_time,
    listing.first_seen_at,
    listing.last_seen_at,
    listing.last_event,
    listing.lat ?? null,
    listing.lng ?? null,
    communityId,
    communityName,
  );
}

export function setListingFees(postId, extraFees, fetched = 1) {
  return setListingDetail(postId, { extraFees, fetched });
}

export function setListingDetail(postId, { extraFees, contact, fetched = 1, lat, lng, address, community_id, community_name, geo_source } = {}) {
  const listing = getListing(postId);
  if (!listing) return null;
  const fees =
    extraFees === undefined
      ? JSON.stringify(listing.extra_fees || [])
      : JSON.stringify(extraFees || []);
  const next = {
    contact_name: contact?.contact_name ?? listing.contact_name ?? "",
    contact_role: contact?.contact_role ?? listing.contact_role ?? "",
    agency: contact?.agency ?? listing.agency ?? "",
    mobile: contact?.mobile ?? listing.mobile ?? "",
    phone: contact?.phone ?? listing.phone ?? "",
    line_url: contact?.line_url ?? listing.line_url ?? "",
    avatar: contact?.avatar ?? listing.avatar ?? "",
    contact_uid: contact?.contact_uid ?? listing.contact_uid ?? null,
  };
  const latNum = Number(lat);
  const lngNum = Number(lng);
  const hasCoords = Number.isFinite(latNum) && Number.isFinite(lngNum) && latNum !== 0 && lngNum !== 0;
  const upgradingToCommunity = hasCoords && geo_source === "community";
  const keepCommunity = listing.geo_source === "community" && !upgradingToCommunity;
  const applyCoords = hasCoords && !keepCommunity;
  const source = applyCoords ? (geo_source === "community" ? "community" : "591") : null;
  const nextAddress = String(address || "").trim();
  const keepAddress = !nextAddress || keepCommunity;
  const nextCommunityId = Number(community_id) || listing.community_id || 0;
  const nextCommunityName = String(community_name || listing.community_name || "").trim();
  db.prepare(
    `UPDATE listings SET
      extra_fees = ?, extra_fees_fetched = ?,
      contact_name = ?, contact_role = ?, agency = ?, mobile = ?, phone = ?,
      line_url = ?, avatar = ?, contact_uid = ?, contact_fetched = ?,
      lat = CASE WHEN ? IS NOT NULL THEN ? ELSE lat END,
      lng = CASE WHEN ? IS NOT NULL THEN ? ELSE lng END,
      geo_source = CASE WHEN ? IS NOT NULL THEN ? ELSE geo_source END,
      address = CASE WHEN ? THEN listings.address ELSE ? END,
      community_id = CASE WHEN ? > 0 THEN ? ELSE community_id END,
      community_name = CASE WHEN ? != '' THEN ? ELSE community_name END
     WHERE post_id = ?`,
  ).run(
    fees,
    Number(Boolean(fetched)),
    next.contact_name,
    next.contact_role,
    next.agency,
    next.mobile,
    next.phone,
    next.line_url,
    next.avatar,
    next.contact_uid,
    Number(Boolean(fetched)),
    applyCoords ? latNum : null,
    applyCoords ? latNum : null,
    applyCoords ? lngNum : null,
    applyCoords ? lngNum : null,
    source,
    source,
    keepAddress ? 1 : 0,
    nextAddress,
    nextCommunityId,
    nextCommunityId,
    nextCommunityName,
    nextCommunityName,
    postId,
  );
  return getListing(postId);
}

export function listingsNeedingFeeDetail(limit = 12) {
  return db
    .prepare(
      `SELECT post_id FROM listings
       WHERE IFNULL(hidden, 0) = 0 AND IFNULL(offline, 0) = 0 AND (
         IFNULL(contact_fetched, 0) = 0
         OR IFNULL(extra_fees_fetched, 0) = 0
         OR lat IS NULL OR lng IS NULL
       )
       ORDER BY CASE WHEN lat IS NULL OR lng IS NULL THEN 0 ELSE 1 END, last_seen_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Number(limit) || 12));
}

export function listingsNeeding591Geo(limit = 20) {
  const cap = Math.max(1, Number(limit) || 20);
  const rows = db
    .prepare(
      `SELECT post_id, community_id, source_key, lat, lng, geo_source FROM listings
       WHERE IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0
       ORDER BY last_seen_at DESC`,
    )
    .all();
  const out = [];
  for (const row of rows) {
    const trusted = isTrustedGeoSource(row.geo_source);
    const missing = row.lat == null || row.lng == null || !trusted;
    const commId = listingCommunityId(row);
    const needsCommunity = commId > 0 && row.geo_source !== "community" && !hasCommunityCache(commId);
    if (missing || needsCommunity) {
      out.push({ post_id: row.post_id });
      if (out.length >= cap) break;
    }
  }
  return out;
}

export function hideMany(ids) {
  const list = [...new Set((ids || []).map(Number).filter((id) => id > 0))];
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE listings SET hidden = 1, hidden_at = COALESCE(hidden_at, ?) WHERE post_id = ?`,
  );
  db.exec("BEGIN");
  try {
    for (const id of list) stmt.run(now, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { count: list.length, stats: stats() };
}

export function markListingOffline(postId) {
  const listing = getListing(postId);
  if (!listing) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE listings
     SET offline = 1,
         offline_at = COALESCE(offline_at, ?),
         offline_confirmed = 0,
         last_event = 'offline',
         last_checked_at = ?
     WHERE post_id = ?`,
  ).run(now, now, postId);
  return getListing(postId);
}

export function restoreListingOnline(postId) {
  const listing = getListing(postId);
  if (!listing) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE listings
     SET offline = 0,
         offline_at = NULL,
         offline_confirmed = 0,
         last_checked_at = ?
     WHERE post_id = ?`,
  ).run(now, postId);
  return getListing(postId);
}

export function confirmListingOffline(postId) {
  const listing = getListing(postId);
  if (!listing?.offline) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE listings
     SET offline = 1,
         offline_confirmed = 1,
         last_event = 'offline',
         last_checked_at = ?
     WHERE post_id = ?`,
  ).run(now, postId);
  return getListing(postId);
}

export function confirmExpiredOfflineListings(days = 7) {
  const n = Math.max(1, Math.min(Number(days) || 7, 30));
  const cutoff = new Date(Date.now() - n * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE listings
       SET offline_confirmed = 1,
           last_event = 'offline',
           last_checked_at = ?
       WHERE IFNULL(offline, 0) = 1
         AND IFNULL(offline_confirmed, 0) = 0
         AND IFNULL(offline_at, '') != ''
         AND offline_at <= ?`,
    )
    .run(now, cutoff);
  return Number(info.changes) || 0;
}

export function touchListingChecked(postId) {
  db.prepare("UPDATE listings SET last_checked_at = ? WHERE post_id = ?").run(new Date().toISOString(), postId);
}

export function listingsNeedingAliveCheck({ excludeIds = [], limit = 20 } = {}) {
  const cap = Math.max(1, Number(limit) || 20);
  const skip = new Set((excludeIds || []).map(Number).filter((id) => id > 0));
  const rows = db
    .prepare(
      `SELECT post_id FROM listings
       WHERE IFNULL(hidden, 0) = 0 AND IFNULL(offline, 0) = 0
       ORDER BY CASE WHEN last_checked_at IS NULL THEN 0 ELSE 1 END,
                IFNULL(last_checked_at, last_seen_at) ASC
       LIMIT 800`,
    )
    .all();
  const out = [];
  for (const row of rows) {
    if (skip.has(Number(row.post_id))) continue;
    out.push(row);
    if (out.length >= cap) break;
  }
  return out;
}

export function listingsNeedingOfflineRecheck({ limit = 8 } = {}) {
  const cap = Math.max(1, Number(limit) || 8);
  return db
    .prepare(
      `SELECT post_id, offline, offline_at, offline_confirmed, last_checked_at
       FROM listings
       WHERE IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 1
         AND IFNULL(offline_confirmed, 0) = 0
       ORDER BY CASE WHEN last_checked_at IS NULL THEN 0 ELSE 1 END,
                IFNULL(last_checked_at, offline_at) ASC
       LIMIT ?`,
    )
    .all(Math.max(cap, 40));
}

export function resetListings() {
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM listings");
  return saveSettings({ hasBaseline: false });
}

export { DATA_EPOCH };

export function resetAllData() {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM events");
    db.exec("DELETE FROM listings");
    db.exec("DELETE FROM settings");
    db.exec("DELETE FROM geo_cache");
    db.exec("DELETE FROM route_cache");
    db.exec("DELETE FROM community_cache");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // ignore checkpoint failures; rows are already gone
  }
  return saveSettings({
    dataEpoch: DATA_EPOCH,
    searchUrls: [],
    watchDistricts: [],
    settingProfiles: [],
    activeProfileId: "",
    hasBaseline: false,
    discordWebhook: "",
    workAddress: "",
    commuteKm: 0,
    workLat: null,
    workLng: null,
    excludeBoxes: [],
    excludeKeywords: [],
    excludeAgents: [],
    excludeAgentIds: [],
  });
}

function readDataEpoch() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'dataEpoch'").get();
    return row ? JSON.parse(row.value) : "";
  } catch {
    return "";
  }
}

function stampDataEpoch() {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("dataEpoch", JSON.stringify(DATA_EPOCH));
}

if (shouldResetForEpoch(readDataEpoch(), DATA_EPOCH)) {
  console.warn(`[5151] DATA_EPOCH 變更（${readDataEpoch()} → ${DATA_EPOCH}），執行整庫重置`);
  resetAllData();
} else if (readDataEpoch() !== DATA_EPOCH) {
  stampDataEpoch();
}

export function addEvent(event) {
  const result = db.prepare(`
    INSERT INTO events (post_id, source_key, type, title, detail, created_at, notified)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.post_id,
    event.source_key,
    event.type,
    event.title,
    event.detail,
    event.created_at,
    event.notified,
  );
  return Number(result.lastInsertRowid);
}

export function markEventNotified(id) {
  db.prepare("UPDATE events SET notified = 1 WHERE id = ?").run(id);
}

export function setFlags(postId, flags) {
  const listing = getListing(postId);
  if (!listing) return null;
  const viewed = flags.viewed === undefined ? listing.viewed : Number(Boolean(flags.viewed));
  const watched = flags.watched === undefined ? listing.watched : Number(Boolean(flags.watched));
  const hidden = flags.hidden === undefined ? listing.hidden : Number(Boolean(flags.hidden));
  const watchNote = nextWatchNote(listing, flags);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE listings
    SET viewed = ?, watched = ?, hidden = ?, watch_note = ?,
        viewed_at = CASE WHEN ? = 1 THEN COALESCE(viewed_at, ?) ELSE viewed_at END,
        watched_at = CASE
          WHEN ? = 1 AND IFNULL(watched, 0) = 0 THEN ?
          WHEN ? = 1 THEN COALESCE(watched_at, ?)
          ELSE watched_at
        END,
        hidden_at = CASE WHEN ? = 1 THEN COALESCE(hidden_at, ?) ELSE hidden_at END
    WHERE post_id = ?
  `).run(viewed, watched, hidden, watchNote, viewed, now, watched, now, watched, now, hidden, now, postId);
  return getListing(postId);
}

export function applyCachedCoords(row, settings) {
  if (!row) return row;
  if (!isTrustedGeoSource(row.geo_source)) return row;
  const conf = settings || getSettings();
  const workLat = Number(conf.workLat);
  const workLng = Number(conf.workLng);
  if (
    Number(conf.commuteKm) > 0 &&
    hasWorkPoint(conf) &&
    Number.isFinite(Number(row.lat)) &&
    Number.isFinite(Number(row.lng))
  ) {
    const route = getCachedRoute(row.lat, row.lng, workLat, workLng);
    if (route) {
      return { ...row, route_kms: route.distances, route_km: route.min_km };
    }
  }
  return row;
}

export function getCachedRoute(fromLat, fromLng, toLat, toLng) {
  const key = makeRouteKey(fromLat, fromLng, toLat, toLng);
  const row = db.prepare("SELECT distances, min_km FROM route_cache WHERE route_key = ?").get(key);
  if (!row) return null;
  const distances = parseJson(row.distances, []);
  if (!Array.isArray(distances) || !distances.length) return null;
  return { distances: distances.map(Number).filter(Number.isFinite), min_km: Number(row.min_km) };
}

export function setCachedRoute(fromLat, fromLng, toLat, toLng, distances) {
  const list = (Array.isArray(distances) ? distances : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!list.length) return;
  const key = makeRouteKey(fromLat, fromLng, toLat, toLng);
  const minKm = Math.min(...list);
  db.prepare(
    `INSERT INTO route_cache(route_key, distances, min_km, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(route_key) DO UPDATE SET
       distances = excluded.distances,
       min_km = excluded.min_km,
       updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(list), minKm, new Date().toISOString());
}

export function listingsNeedingRoute(limit = 40) {
  const settings = getSettings();
  const workLat = Number(settings.workLat);
  const workLng = Number(settings.workLng);
  if (!(Number(settings.commuteKm) > 0) || !hasWorkPoint(settings)) return [];
  const rows = db
    .prepare(
      `SELECT post_id, lat, lng FROM listings
       WHERE lat IS NOT NULL AND lng IS NOT NULL
         AND IFNULL(geo_source, '') IN ('591', 'community')
         AND IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0
       ORDER BY last_seen_at DESC
       LIMIT 2000`,
    )
    .all();
  const out = [];
  for (const row of rows) {
    if (getCachedRoute(row.lat, row.lng, workLat, workLng)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function applyListingFilter(rows) {
  const settings = getSettings();
  // 列表用非嚴格通勤：還沒算完路線的先顯示（排在離公司排序末端），避免新北等區整批空白
  return rows
    .map((row) => applyCachedCoords(row, settings))
    .filter((row) => shouldKeepListing(row, settings, { strict: false }));
}

export function addressesMissingGeo() {
  return db
    .prepare(
      `SELECT address, COUNT(*) AS n
       FROM listings
       WHERE (lat IS NULL OR lng IS NULL)
         AND IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0
         AND IFNULL(address, '') != ''
       GROUP BY address`,
    )
    .all();
}

export function updateListingsGeoByAddress(address, lat, lng) {
  setCachedGeo(address, lat, lng);
  const key = String(address || "").replace(/\s+/g, "").replace(/-/g, "");
  if (!key || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;
  db.prepare(
    `UPDATE listings
     SET lat = ?, lng = ?
     WHERE replace(replace(IFNULL(address, ''), ' ', ''), '-', '') = ?`,
  ).run(Number(lat), Number(lng), key);
}

function priceSortKey(row) {
  const n = Number(row?.price_num) || 0;
  return n > 0 ? n : Number.MAX_SAFE_INTEGER;
}

function descIso(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.localeCompare(left);
}

export function sortListingsRows(rows, sort = "price_asc", { filter } = {}) {
  const list = [...(rows || [])];
  if (sort === "commute_asc") {
    list.sort((a, b) => (Number(a.commute_km) || 9999) - (Number(b.commute_km) || 9999) || priceSortKey(a) - priceSortKey(b));
  } else if (sort === "commute_desc") {
    list.sort((a, b) => (Number(b.commute_km) || 0) - (Number(a.commute_km) || 0) || priceSortKey(a) - priceSortKey(b));
  } else if (sort === "price_desc") {
    list.sort((a, b) => {
      const pa = Number(a.price_num) || 0;
      const pb = Number(b.price_num) || 0;
      if ((pa > 0) !== (pb > 0)) return pa > 0 ? -1 : 1;
      return pb - pa || String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || ""));
    });
  } else if (sort === "newest") {
    list.sort((a, b) => {
      if (filter === "watched") {
        const byWatch = descIso(a.watched_at, b.watched_at);
        if (byWatch) return byWatch;
      }
      return descIso(a.first_seen_at, b.first_seen_at) || Number(b.post_id) - Number(a.post_id);
    });
  } else {
    list.sort((a, b) => priceSortKey(a) - priceSortKey(b) || String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || "")));
  }
  return list;
}

export function listListings({
  filter = "all",
  kind = "",
  q = "",
  sort = "price_asc",
  limit = 500,
  searchKeys,
  districts = [],
} = {}) {
  ({ filter, kind } = normalizeListQuery(filter, kind));
  const clauses = [];
  const params = [];
  searchWhere(searchKeys, clauses, params);
  if (filter === "suspected") {
    clauses.push("match_level IN ('high', 'medium')");
    clauses.push("IFNULL(offline, 0) = 0");
  } else if (filter === "offline") {
    clauses.push("IFNULL(offline, 0) = 1");
    clauses.push("IFNULL(offline_confirmed, 0) = 0");
  } else if (filter === "hidden") {
    clauses.push("hidden = 1");
  } else {
    clauses.push("IFNULL(hidden, 0) = 0");
    clauses.push("IFNULL(offline, 0) = 0");
    clauses.push("(IFNULL(match_verdict, '') != 'yes')");
  }
  if (filter === "all") clauses.push("IFNULL(watched, 0) = 0");
  if (filter === "unseen") clauses.push("viewed = 0");
  if (filter === "viewed") clauses.push("viewed = 1");
  if (filter === "watched") clauses.push("watched = 1");
  if (filter === "same_source") clauses.push("last_event IN ('same_source', 'update', 'price_drop', 'title_update')");
  if (q) {
    clauses.push("(title LIKE ? OR address LIKE ? OR CAST(post_id AS TEXT) LIKE ? OR IFNULL(watch_note, '') LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const raw = db.prepare(`SELECT * FROM listings ${where}`).all(...params);
  const settings = getSettings();
  let rows =
    filter === "offline" || filter === "suspected"
      ? raw.map((row) => decorateListing(row, settings))
      : applyListingFilter(raw).map((row) => decorateListing(row, settings));

  // 整層／1F、行政區要在 limit 前套用，否則「全庫最便宜 500 筆」再前端篩選會漏掉新北等區
  rows = rows.filter((row) => passesDisplayFilters(row, settings, { skipWholeFloor: kind === "suite" }));
  const districtSet = new Set(
    (Array.isArray(districts) ? districts : String(districts || "").split(","))
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  );
  if (districtSet.size) {
    rows = rows.filter((row) => districtSet.has(row.district));
  }

  rows = rows.filter((row) => matchesHousingKind(row, kind));

  rows = sortListingsRows(rows, sort, { filter });

  const totalMatched = rows.length;
  return { listings: rows.slice(0, limit), totalMatched };
}

export function sourceHistory(sourceKey) {
  return db
    .prepare(
      `SELECT post_id, title, price, url, first_seen_at, last_seen_at, last_event, viewed, watched
       FROM listings WHERE source_key = ? ORDER BY last_seen_at DESC`,
    )
    .all(sourceKey);
}

export function recentEvents(limit = 40) {
  return db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
}

export function pendingNotifyEvents(limit = 80) {
  return db
    .prepare("SELECT * FROM events WHERE IFNULL(notified, 0) = 0 ORDER BY id ASC LIMIT ?")
    .all(Math.max(1, Number(limit) || 80));
}

export function eventPayloadFromListing(event, listing) {
  if (!event) return event;
  const row = listing || {};
  return {
    ...event,
    title: row.title || event.title,
    url: row.url || event.url,
    price: row.price || event.price,
    extra_fee: row.extra_fee,
    extra_fee_text: row.extra_fee_text,
    extra_fees: row.extra_fees,
    address: row.address || event.address,
    layout: row.layout,
    floor_name: row.floor_name,
    kind_name: row.kind_name,
    cover: row.cover,
  };
}

export function getCommunityCache(communityId) {
  const id = Number(communityId);
  if (!id) return null;
  const row = db.prepare("SELECT community_id AS id, name, address, lat, lng FROM community_cache WHERE community_id = ?").get(id);
  if (!row) return null;
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  return {
    id: row.id,
    name: row.name || "",
    address: row.address || "",
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
  };
}

export function hasCommunityCache(communityId) {
  const id = Number(communityId);
  if (!id) return false;
  return Boolean(db.prepare("SELECT 1 AS ok FROM community_cache WHERE community_id = ?").get(id));
}

export function setCommunityCache(community) {
  const id = Number(community?.id || community?.community_id);
  if (!id) return;
  const lat = Number(community.lat);
  const lng = Number(community.lng);
  db.prepare(
    `INSERT INTO community_cache(community_id, name, address, lat, lng, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(community_id) DO UPDATE SET
       name = excluded.name,
       address = excluded.address,
       lat = excluded.lat,
       lng = excluded.lng,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    String(community.name || "").trim(),
    String(community.address || "").trim(),
    Number.isFinite(lat) ? lat : null,
    Number.isFinite(lng) ? lng : null,
    new Date().toISOString(),
  );
}

export function stats(searchKeys) {
  const settings = getSettings();
  const clauses = [];
  const params = [];
  searchWhere(searchKeys, clauses, params);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const raw = db
    .prepare(
      `SELECT viewed, watched, hidden, offline, offline_confirmed, last_event, floor_name, kind_name, title, address, area_name, lat, lng, geo_source, tags, match_level, match_rejected, match_verdict FROM listings ${where}`,
    )
    .all(...params);
  const attrRows = raw.filter((row) => passesAttributeFilters(row, settings));
  const base = attrRows.filter((row) => !row.hidden && !isPendingOffline(row) && !isConfirmedOffline(row) && row.match_verdict !== "yes");
  const browse = attrRows.filter(countsTowardAllTotal);
  const geoRows = applyListingFilter(raw).filter((row) => !row.hidden && !isPendingOffline(row) && !isConfirmedOffline(row) && row.match_verdict !== "yes" && !row.watched);
  return {
    total: browse.length,
    unseen: browse.filter((row) => !row.viewed).length,
    watched: base.filter((row) => row.watched).length,
    same_source: browse.filter((row) => ["same_source", "update", "price_drop", "title_update"].includes(row.last_event)).length,
    hidden: attrRows.filter((row) => row.hidden).length,
    offline: raw.filter((row) => isPendingOffline(row)).length,
    offlineConfirmed: raw.filter((row) => isConfirmedOffline(row)).length,
    suspected: attrRows.filter((row) => row.match_level && !row.offline).length,
    suspectedPending: attrRows.filter((row) => row.match_level && !row.match_verdict && !row.offline).length,
    elevator: browse.filter((row) => listingHasElevator(row)).length,
    stored: geoRows.length,
    filteredOut: Math.max(0, browse.length - geoRows.length),
    missingGeo: attrRows.filter((row) => !row.hidden && !isPendingOffline(row) && !isConfirmedOffline(row) && !row.watched && row.match_verdict !== "yes" && (!isTrustedGeoSource(row.geo_source) || row.lat == null || row.lng == null)).length,
    missingRoute: attrRows.filter((row) => {
      if (row.hidden || isPendingOffline(row) || isConfirmedOffline(row) || row.watched || row.match_verdict === "yes") return false;
      const geo = applyCachedCoords(row, settings);
      return (
        Number(settings.commuteKm) > 0 &&
        isTrustedGeoSource(geo.geo_source) &&
        Number.isFinite(Number(geo.lat)) &&
        Number.isFinite(Number(geo.lng)) &&
        !(Array.isArray(geo.route_kms) && geo.route_kms.length)
      );
    }).length,
    dbTotal: listingCount(),
  };
}

export function listingCount() {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM listings").get().n || 0);
}

export function listingCountForSearch(searchKey) {
  const keys = expandSearchKeys([searchKey].filter(Boolean));
  if (!keys.length) return 0;
  return Number(
    db
      .prepare(`SELECT COUNT(*) AS n FROM listings WHERE search_key IN (${keys.map(() => "?").join(",")})`)
      .get(...keys).n || 0,
  );
}

export function getCachedGeo(address) {
  const key = String(address || "").replace(/\s+/g, "").replace(/-/g, "");
  if (!key) return null;
  return db.prepare("SELECT lat, lng FROM geo_cache WHERE address = ?").get(key) || null;
}

export function setCachedGeo(address, lat, lng) {
  const key = String(address || "").replace(/\s+/g, "").replace(/-/g, "");
  if (!key || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;
  db.prepare(
    "INSERT INTO geo_cache(address, lat, lng, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, updated_at = excluded.updated_at",
  ).run(key, Number(lat), Number(lng), new Date().toISOString());
}

export { db };
