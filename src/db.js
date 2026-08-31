import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { shouldKeepListing, listingHasElevator } from "./floors.js";
import { isTrustedGeoSource, listingCommunityId } from "./location.js";
import { makeRouteKey } from "./route.js";
import { sameSearch } from "./client591.js";
import { districtNameFromListing } from "./regions.js";
import { applySettingPatch, hydrateSettings, parseSettingRows, snapshotSettings } from "./settingsState.js";

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
  searchUrls: [
    "https://rent.591.com.tw/list?region=1&section=5&kind=1&order=posttime&orderType=desc",
  ],
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
  excludeRooftop: true,
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
  return {
    ...row,
    extra_fees: Array.isArray(row.extra_fees) ? row.extra_fees : parseJson(row.extra_fees, []),
    has_elevator: listingHasElevator(row),
    commute_km: commute == null ? null : Math.round(commute * 10) / 10,
    commute_routes: Array.isArray(row.route_kms) ? row.route_kms : [],
    district: districtNameFromListing(row),
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
       ORDER BY hidden DESC, viewed DESC, last_seen_at DESC`,
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
     SET match_rejected = 1, hidden = 0, viewed = 0
     WHERE post_id = ?`,
  ).run(postId);
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
       ORDER BY last_seen_at DESC
       LIMIT 800`,
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
         last_event = 'offline',
         last_checked_at = ?
     WHERE post_id = ?`,
  ).run(now, now, postId);
  return getListing(postId);
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

export function resetListings() {
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM listings");
  return saveSettings({ hasBaseline: false });
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
  const watchNote =
    flags.watch_note === undefined
      ? listing.watch_note || ""
      : String(flags.watch_note || "").replace(/\r/g, "").trim().slice(0, 300);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE listings
    SET viewed = ?, watched = ?, hidden = ?, watch_note = ?,
        viewed_at = CASE WHEN ? = 1 THEN COALESCE(viewed_at, ?) ELSE viewed_at END,
        watched_at = CASE WHEN ? = 1 THEN COALESCE(watched_at, ?) ELSE watched_at END,
        hidden_at = CASE WHEN ? = 1 THEN COALESCE(hidden_at, ?) ELSE hidden_at END
    WHERE post_id = ?
  `).run(viewed, watched, hidden, watchNote, viewed, now, watched, now, hidden, now, postId);
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
    Number.isFinite(workLat) &&
    Number.isFinite(workLng) &&
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
  if (!(Number(settings.commuteKm) > 0) || !Number.isFinite(workLat) || !Number.isFinite(workLng)) return [];
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
  return rows.map((row) => applyCachedCoords(row, settings)).filter((row) => shouldKeepListing(row, settings));
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

export function listListings({ filter = "all", q = "", sort = "price_asc", limit = 500, searchKeys } = {}) {
  const clauses = [];
  const params = [];
  searchWhere(searchKeys, clauses, params);
  if (filter === "suspected") {
    clauses.push("IFNULL(match_rejected, 0) = 0");
    clauses.push("match_level IN ('high', 'medium')");
    clauses.push("IFNULL(offline, 0) = 0");
  } else if (filter === "offline") {
    clauses.push("IFNULL(offline, 0) = 1");
  } else if (filter === "hidden") {
    clauses.push("hidden = 1");
  } else {
    clauses.push("IFNULL(hidden, 0) = 0");
    clauses.push("IFNULL(offline, 0) = 0");
  }
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
  const order =
    sort === "price_desc"
      ? "price_num DESC, last_seen_at DESC"
      : sort === "newest"
        ? "last_seen_at DESC, post_id DESC"
        : "price_num ASC, last_seen_at DESC";
  const raw = db
    .prepare(`SELECT * FROM listings ${where} ORDER BY ${order}`)
    .all(...params);
  const settings = getSettings();
  let rows =
    filter === "offline"
      ? raw.map((row) => decorateListing(row, settings))
      : applyListingFilter(raw).map((row) => decorateListing(row, settings));
  if (filter === "elevator") rows = rows.filter((row) => listingHasElevator(row));
  if (sort === "commute_asc") {
    rows.sort((a, b) => (Number(a.commute_km) || 9999) - (Number(b.commute_km) || 9999));
  } else if (sort === "commute_desc") {
    rows.sort((a, b) => (Number(b.commute_km) || 0) - (Number(a.commute_km) || 0));
  }
  return rows.slice(0, limit);
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
  const raw = db.prepare(`SELECT viewed, watched, hidden, offline, last_event, floor_name, kind_name, title, address, lat, lng, geo_source, tags, match_level, match_rejected FROM listings ${where}`).all(...params);
  const rows = applyListingFilter(raw);
  const visible = rows.filter((row) => !row.hidden && !row.offline);
  const storedVisible = raw.filter((row) => !row.hidden && !row.offline);
  return {
    total: visible.length,
    unseen: visible.filter((row) => !row.viewed).length,
    watched: visible.filter((row) => row.watched).length,
    same_source: visible.filter((row) => ["same_source", "update", "price_drop", "title_update"].includes(row.last_event)).length,
    hidden: rows.filter((row) => row.hidden).length,
    offline: raw.filter((row) => row.offline).length,
    suspected: rows.filter((row) => row.match_level && !row.match_rejected).length,
    elevator: visible.filter((row) => listingHasElevator(row)).length,
    stored: storedVisible.length,
    filteredOut: Math.max(0, storedVisible.length - visible.length),
    missingGeo: storedVisible.filter((row) => !isTrustedGeoSource(row.geo_source) || row.lat == null || row.lng == null).length,
    missingRoute: storedVisible.filter((row) => {
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
