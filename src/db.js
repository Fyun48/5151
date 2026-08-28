import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { shouldKeepListing } from "./floors.js";
import { normalizeBoxes, normalizeKeywords } from "./geo.js";
import { sameSearch } from "./client591.js";

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
  pagesPerWatch: 2,
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
};

export function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const stored = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
  return { ...DEFAULTS, ...stored };
}

export function saveSettings(partial) {
  const current = getSettings();
  const next = { ...current, ...partial };
  next.excludeKeywords = normalizeKeywords(next.excludeKeywords);
  next.excludeAgents = normalizeKeywords(next.excludeAgents);
  next.excludeAgentIds = [...new Set((next.excludeAgentIds || []).map(Number).filter((id) => id > 0))].slice(0, 80);
  next.excludeBoxes = normalizeBoxes(next.excludeBoxes);
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

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function decorateListing(row) {
  if (!row) return row;
  return {
    ...row,
    extra_fees: Array.isArray(row.extra_fees) ? row.extra_fees : parseJson(row.extra_fees, []),
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
      lat = excluded.lat,
      lng = excluded.lng
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

export function setListingDetail(postId, { extraFees, contact, fetched = 1 } = {}) {
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
      line_url = ?, avatar = ?, contact_uid = ?, contact_fetched = ?
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
    postId,
  );
  return getListing(postId);
}

export function listingsNeedingFeeDetail(limit = 12) {
  return db
    .prepare(
      `SELECT post_id FROM listings
       WHERE IFNULL(contact_fetched, 0) = 0 OR IFNULL(extra_fees_fetched, 0) = 0
       ORDER BY last_seen_at DESC
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

function applyListingFilter(rows) {
  const settings = getSettings();
  return rows.filter((row) => shouldKeepListing(row, settings));
}

export function listListings({ filter = "all", q = "", sort = "price_asc", limit = 80, searchKeys } = {}) {
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
  const rows = db
    .prepare(`SELECT * FROM listings ${where} ORDER BY ${order}`)
    .all(...params);
  return applyListingFilter(rows).slice(0, limit).map(decorateListing);
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
  const raw = db.prepare(`SELECT viewed, watched, hidden, last_event, floor_name, kind_name, title, address, lat, lng, match_level, match_rejected FROM listings ${where}`).all(...params);
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
    stored: storedVisible.length,
    filteredOut: Math.max(0, storedVisible.length - visible.length),
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
