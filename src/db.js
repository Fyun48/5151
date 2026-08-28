import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { shouldKeepListing, listingHasElevator } from "./floors.js";
import { distanceKm, normalizeBoxes, normalizeKeywords } from "./geo.js";
import { sameSearch } from "./client591.js";
import { buildSearchUrls, districtNameFromListing, districtsFromSearchUrls, normalizeWatchDistricts, priceFromSearchUrls } from "./regions.js";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "591.db"));
db.exec("PRAGMA journal_mode = WAL");
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
db.exec(`
  CREATE TABLE IF NOT EXISTS geo_cache (
    address TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    updated_at TEXT NOT NULL
  )
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
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_search ON listings(search_key)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_hidden ON listings(hidden)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_match ON listings(match_level)");

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
  const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
  const next = { ...DEFAULTS, ...stored };
  if (Number(next.pagesPerWatch) <= 5) next.pagesPerWatch = 40;
  if (!Array.isArray(stored.watchDistricts) || !stored.watchDistricts.length) {
    next.watchDistricts = districtsFromSearchUrls(next.searchUrls);
  } else {
    next.watchDistricts = normalizeWatchDistricts(next.watchDistricts);
  }
  if (stored.priceMax == null && stored.priceMin == null) {
    const parsed = priceFromSearchUrls(next.searchUrls);
    if (parsed.max || parsed.min) {
      next.priceMin = parsed.min;
      next.priceMax = parsed.max;
    }
  }
  return next;
}

export function saveSettings(partial) {
  const current = getSettings();
  const next = { ...current, ...partial };
  next.excludeKeywords = normalizeKeywords(next.excludeKeywords);
  next.excludeAgents = normalizeKeywords(next.excludeAgents);
  next.excludeAgentIds = [...new Set((next.excludeAgentIds || []).map(Number).filter((id) => id > 0))].slice(0, 80);
  next.excludeBoxes = normalizeBoxes(next.excludeBoxes);
  next.pagesPerWatch = Math.max(1, Math.min(Number(next.pagesPerWatch) || 40, 40));
  next.commuteKm = Math.max(0, Math.min(Number(next.commuteKm) || 0, 80));
  next.workAddress = String(next.workAddress || "").trim().slice(0, 120);
  const workLat = Number(next.workLat);
  const workLng = Number(next.workLng);
  next.workLat = Number.isFinite(workLat) ? workLat : null;
  next.workLng = Number.isFinite(workLng) ? workLng : null;
  next.watchDistricts = normalizeWatchDistricts(next.watchDistricts);
  next.priceMin = Math.max(0, Number(next.priceMin) || 0);
  next.priceMax = Math.max(0, Number(next.priceMax) || 0);
  next.excludeRooftop = next.excludeRooftop !== false;
  if (next.watchDistricts.length) {
    next.searchUrls = buildSearchUrls({
      districts: next.watchDistricts,
      priceMin: next.priceMin,
      priceMax: next.priceMax,
      excludeRooftop: next.excludeRooftop,
      wholeFloorOnly: next.wholeFloorOnly !== false,
    });
  }
  next.settingProfiles = normalizeProfiles(next.settingProfiles);
  next.activeProfileId = String(next.activeProfileId || "");
  if (next.activeProfileId) {
    next.settingProfiles = next.settingProfiles.map((profile) =>
      profile.id === next.activeProfileId
        ? { ...profile, saved_at: new Date().toISOString(), data: snapshotSettings(next) }
        : profile,
    );
  }
  const upsert = db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(next)) {
      upsert.run(key, JSON.stringify(value));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return next;
}

const PROFILE_FIELDS = [
  "searchUrls",
  "intervalMinutes",
  "pagesPerWatch",
  "minBuildingFloors",
  "wholeFloorOnly",
  "excludeLowFloors",
  "notifyNew",
  "notifySameSource",
  "notifyViewed",
  "notifyWatchedAlways",
  "windowsToast",
  "excludeKeywords",
  "excludeAgents",
  "excludeAgentIds",
  "excludeBoxes",
  "discordWebhook",
  "workAddress",
  "commuteKm",
  "workLat",
  "workLng",
  "watchDistricts",
  "priceMin",
  "priceMax",
  "excludeRooftop",
];

function normalizeProfiles(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "").trim();
    const name = String(raw.name || "").trim().slice(0, 40);
    if (!id || !name) continue;
    out.push({
      id,
      name,
      saved_at: String(raw.saved_at || new Date().toISOString()),
      data: raw.data && typeof raw.data === "object" ? raw.data : {},
    });
    if (out.length >= 12) break;
  }
  return out;
}

function snapshotSettings(settings) {
  const out = {};
  for (const key of PROFILE_FIELDS) out[key] = settings[key];
  return out;
}

export function saveAsProfile(name) {
  const current = getSettings();
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
  row = applyCachedCoords(row);
  const commute =
    Number(settings.commuteKm) > 0 &&
    Number.isFinite(Number(settings.workLat)) &&
    Number.isFinite(Number(settings.workLng)) &&
    row.lat != null &&
    row.lng != null
      ? distanceKm(settings.workLat, settings.workLng, row.lat, row.lng)
      : null;
  return {
    ...row,
    extra_fees: Array.isArray(row.extra_fees) ? row.extra_fees : parseJson(row.extra_fees, []),
    has_elevator: listingHasElevator(row),
    commute_km: commute == null ? null : Math.round(commute * 10) / 10,
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
  db.prepare(`
    INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num, extra_fee, extra_fee_text,
      price_contain_text, extra_fees, extra_fees_fetched, address, area_name,
      layout, floor_name, kind_name, role_name, cover, tags, refresh_time,
      first_seen_at, last_seen_at, last_event, viewed, watched, lat, lng
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
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
      address = excluded.address,
      area_name = excluded.area_name,
      layout = excluded.layout,
      floor_name = excluded.floor_name,
      kind_name = excluded.kind_name,
      role_name = excluded.role_name,
      cover = excluded.cover,
      tags = excluded.tags,
      refresh_time = excluded.refresh_time,
      last_seen_at = excluded.last_seen_at,
      last_event = excluded.last_event,
      lat = COALESCE(excluded.lat, listings.lat),
      lng = COALESCE(excluded.lng, listings.lng)
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
  );
}

export function setListingFees(postId, extraFees, fetched = 1) {
  return setListingDetail(postId, { extraFees, fetched });
}

export function setListingDetail(postId, { extraFees, contact, fetched = 1, lat, lng } = {}) {
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
  db.prepare(
    `UPDATE listings SET
      extra_fees = ?, extra_fees_fetched = ?,
      contact_name = ?, contact_role = ?, agency = ?, mobile = ?, phone = ?,
      line_url = ?, avatar = ?, contact_uid = ?, contact_fetched = ?,
      lat = COALESCE(?, lat), lng = COALESCE(?, lng)
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
    Number.isFinite(Number(lat)) ? Number(lat) : null,
    Number.isFinite(Number(lng)) ? Number(lng) : null,
    postId,
  );
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && listing.address) {
    setCachedGeo(listing.address, lat, lng);
  }
  return getListing(postId);
}

export function listingsNeedingFeeDetail(limit = 12) {
  return db
    .prepare(
      `SELECT post_id FROM listings
       WHERE IFNULL(contact_fetched, 0) = 0 OR IFNULL(extra_fees_fetched, 0) = 0
       ORDER BY CASE WHEN lat IS NULL OR lng IS NULL THEN 0 ELSE 1 END, last_seen_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Number(limit) || 12));
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
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE listings
    SET viewed = ?, watched = ?, hidden = ?,
        viewed_at = CASE WHEN ? = 1 THEN COALESCE(viewed_at, ?) ELSE viewed_at END,
        watched_at = CASE WHEN ? = 1 THEN COALESCE(watched_at, ?) ELSE watched_at END,
        hidden_at = CASE WHEN ? = 1 THEN COALESCE(hidden_at, ?) ELSE hidden_at END
    WHERE post_id = ?
  `).run(viewed, watched, hidden, viewed, now, watched, now, hidden, now, postId);
  return getListing(postId);
}

export function applyCachedCoords(row) {
  if (!row) return row;
  if (Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng)) && Number(row.lat) !== 0) {
    return row;
  }
  const cached = getCachedGeo(row.address);
  if (!cached) return row;
  return { ...row, lat: cached.lat, lng: cached.lng };
}

function applyListingFilter(rows) {
  const settings = getSettings();
  return rows.map(applyCachedCoords).filter((row) => shouldKeepListing(row, settings));
}

export function addressesMissingGeo() {
  return db
    .prepare(
      `SELECT address, COUNT(*) AS n
       FROM listings
       WHERE (lat IS NULL OR lng IS NULL)
         AND IFNULL(hidden, 0) = 0
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
  } else if (filter === "hidden") {
    clauses.push("hidden = 1");
  } else {
    clauses.push("IFNULL(hidden, 0) = 0");
  }
  if (filter === "unseen") clauses.push("viewed = 0");
  if (filter === "viewed") clauses.push("viewed = 1");
  if (filter === "watched") clauses.push("watched = 1");
  if (filter === "same_source") clauses.push("last_event IN ('same_source', 'update')");
  if (q) {
    clauses.push("(title LIKE ? OR address LIKE ? OR CAST(post_id AS TEXT) LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
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
  let rows = applyListingFilter(raw);
  if (filter === "elevator") rows = rows.filter((row) => listingHasElevator(row));
  return rows.slice(0, limit).map((row) => decorateListing(row, settings));
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

export function stats(searchKeys) {
  const clauses = [];
  const params = [];
  searchWhere(searchKeys, clauses, params);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const raw = db.prepare(`SELECT viewed, watched, hidden, last_event, floor_name, kind_name, title, address, lat, lng, tags, match_level, match_rejected FROM listings ${where}`).all(...params);
  const rows = applyListingFilter(raw);
  const visible = rows.filter((row) => !row.hidden);
  const storedVisible = raw.filter((row) => !row.hidden);
  return {
    total: visible.length,
    unseen: visible.filter((row) => !row.viewed).length,
    watched: visible.filter((row) => row.watched).length,
    same_source: visible.filter((row) => row.last_event === "same_source" || row.last_event === "update").length,
    hidden: rows.filter((row) => row.hidden).length,
    suspected: rows.filter((row) => row.match_level && !row.match_rejected).length,
    elevator: visible.filter((row) => listingHasElevator(row)).length,
    stored: storedVisible.length,
    filteredOut: Math.max(0, storedVisible.length - visible.length),
    missingGeo: storedVisible.filter((row) => {
      const geo = applyCachedCoords(row);
      return geo.lat == null || geo.lng == null;
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
