import { existsSync } from "node:fs";
import path from "node:path";
import { searchParts } from "./client591.js";

export const V1_CACHE_IMPORTED_KEY = "v1CacheImported";
export const V2_CACHE_IMPORTED_KEY = "v2CacheImported";
export const DEFAULT_V1_DB_PATH = "/v1-data/591.db";
export const DEFAULT_V2_DB_PATH = "/v2-data/v2.db";

function quotePath(filePath) {
  return `'${String(filePath).replace(/'/g, "''")}'`;
}

function tableColumns(conn, table, schema = "") {
  const name = schema ? `${schema}.table_info(${table})` : `table_info(${table})`;
  try {
    return conn.prepare(`PRAGMA ${name}`).all().map((row) => String(row.name));
  } catch {
    return [];
  }
}

function tableExists(conn, table, schema = "") {
  const master = schema ? `${schema}.sqlite_master` : "sqlite_master";
  try {
    return Boolean(
      conn.prepare(`SELECT 1 AS ok FROM ${master} WHERE type = 'table' AND name = ?`).get(table),
    );
  } catch {
    return false;
  }
}

function settingTrue(conn, key) {
  try {
    const row = conn.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) === true : false;
  } catch {
    return false;
  }
}

function writeSettingTrue(conn, key) {
  conn.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(true));
}

function resolvePeerPath(override, fallbackPath) {
  const raw = String(override || "").trim();
  if (raw) return raw;
  if (existsSync(fallbackPath)) return fallbackPath;
  return "";
}

export function resolveV1DbPath(override = process.env.V1_DB_PATH) {
  return resolvePeerPath(override, DEFAULT_V1_DB_PATH);
}

export function resolveV2DbPath(override = process.env.V2_DB_PATH) {
  return resolvePeerPath(override, DEFAULT_V2_DB_PATH);
}

function destSearchUrls(conn) {
  const urls = [];
  const read = (sql) => {
    try {
      return conn.prepare(sql).all();
    } catch {
      return [];
    }
  };
  for (const row of [
    ...read("SELECT value FROM settings WHERE key = 'searchUrls'"),
    ...read("SELECT value FROM user_settings WHERE key = 'searchUrls'"),
  ]) {
    try {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed)) urls.push(...parsed);
    } catch {
      // skip
    }
  }
  return [...new Set(urls.map((item) => String(item || "").trim()).filter(Boolean))];
}

function urlByRegion(urls) {
  const map = new Map();
  for (const url of urls) {
    const parts = searchParts(url);
    if (!parts?.region) continue;
    map.set(String(parts.region), url);
  }
  return map;
}

function attachPeer(dest, filePath, alias) {
  const abs = path.resolve(filePath);
  const uri = `file:${abs}?mode=ro`;
  try {
    dest.exec(`ATTACH DATABASE ${quotePath(uri)} AS ${alias}`);
    return true;
  } catch {
    try {
      dest.exec(`ATTACH DATABASE ${quotePath(abs)} AS ${alias}`);
      return true;
    } catch {
      return false;
    }
  }
}

function detachPeer(dest, alias) {
  try {
    dest.exec(`DETACH DATABASE ${alias}`);
  } catch {
    // ignore
  }
}

function copyTable(dest, table, alias) {
  if (!tableExists(dest, table, alias) || !tableExists(dest, table)) return 0;
  const srcCols = tableColumns(dest, table, alias);
  const destCols = new Set(tableColumns(dest, table));
  const cols = srcCols.filter((col) => destCols.has(col) && col !== "source" && col !== "source_id" && col !== "model_score");
  if (!cols.length) return 0;
  const list = cols.join(", ");
  const result = dest.prepare(`INSERT OR IGNORE INTO ${table} (${list}) SELECT ${list} FROM ${alias}.${table}`).run();
  return Number(result.changes) || 0;
}

function copyListings(dest, alias) {
  if (!tableExists(dest, "listings", alias) || !tableExists(dest, "listings")) return 0;
  const srcCols = tableColumns(dest, "listings", alias);
  const destCols = new Set(tableColumns(dest, "listings"));
  const cols = srcCols.filter((col) => destCols.has(col) && col !== "source" && col !== "source_id" && col !== "model_score");
  if (!cols.includes("post_id")) return 0;
  const hasVerdict = srcCols.includes("match_verdict");
  const select = cols.map((col) => {
    if (col === "viewed" || col === "watched") return `0 AS ${col}`;
    if (col === "watch_note") return "'' AS watch_note";
    if (col === "viewed_at" || col === "watched_at") return `NULL AS ${col}`;
    if (col === "hidden") {
      if (hasVerdict) return `CASE WHEN IFNULL(match_verdict, '') = 'yes' THEN IFNULL(hidden, 0) ELSE 0 END AS hidden`;
      return "0 AS hidden";
    }
    if (col === "hidden_at") {
      if (hasVerdict) return `CASE WHEN IFNULL(match_verdict, '') = 'yes' THEN hidden_at ELSE NULL END AS hidden_at`;
      return "NULL AS hidden_at";
    }
    return col;
  });
  const result = dest.prepare(
    `INSERT OR IGNORE INTO listings (${cols.join(", ")}) SELECT ${select.join(", ")} FROM ${alias}.listings`,
  ).run();
  return Number(result.changes) || 0;
}

function copyAdminFlags(dest, adminUserId, alias) {
  const uid = Number(adminUserId) || 0;
  if (!uid || !tableExists(dest, "listings", alias) || !tableExists(dest, "user_listing_flags")) return 0;
  const srcCols = new Set(tableColumns(dest, "listings", alias));
  const viewed = srcCols.has("viewed") ? "IFNULL(viewed, 0)" : "0";
  const watched = srcCols.has("watched") ? "IFNULL(watched, 0)" : "0";
  const note = srcCols.has("watch_note") ? "IFNULL(watch_note, '')" : "''";
  const viewedAt = srcCols.has("viewed_at") ? "viewed_at" : "NULL";
  const watchedAt = srcCols.has("watched_at") ? "watched_at" : "NULL";
  const hiddenAt = srcCols.has("hidden_at") ? "hidden_at" : "NULL";
  const verdict = srcCols.has("match_verdict") ? "IFNULL(match_verdict, '')" : "''";
  const hidden = srcCols.has("hidden")
    ? `CASE WHEN ${verdict} = 'yes' THEN 0 ELSE IFNULL(hidden, 0) END`
    : "0";
  const result = dest.prepare(
    `INSERT OR IGNORE INTO user_listing_flags (
       user_id, post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at
     )
     SELECT ?, post_id, ${viewed}, ${watched}, ${hidden}, ${note}, ${viewedAt}, ${watchedAt},
            CASE WHEN (${hidden}) = 1 THEN ${hiddenAt} ELSE NULL END
     FROM ${alias}.listings
     WHERE ${viewed} = 1 OR ${watched} = 1 OR ${hidden} = 1 OR ${note} != ''`,
  ).run(uid);
  return Number(result.changes) || 0;
}

function retagSearchKeys(dest, alias) {
  const urls = destSearchUrls(dest);
  if (!urls.length || !tableExists(dest, "listings", alias)) return 0;
  const byRegion = urlByRegion(urls);
  if (!byRegion.size) return 0;
  let changed = 0;
  const known = new Set(urls);
  const rows = dest.prepare(`SELECT post_id, source_key, search_key FROM ${alias}.listings`).all();
  const update = dest.prepare("UPDATE listings SET search_key = ? WHERE post_id = ? AND IFNULL(search_key, '') != ?");
  for (const row of rows) {
    if (known.has(String(row.search_key || ""))) continue;
    const region = String(row.source_key || "").split("|")[0] || "";
    const next = byRegion.get(region);
    if (!next) continue;
    changed += Number(update.run(next, row.post_id, next).changes) || 0;
  }
  return changed;
}

function backfillListingSource(dest) {
  try {
    dest.exec("UPDATE listings SET source = '591' WHERE IFNULL(source, '') = ''");
    dest.exec("UPDATE listings SET source_id = CAST(post_id AS TEXT) WHERE IFNULL(source_id, '') = ''");
  } catch {
    // columns may not exist in unit tests that stub a slim schema
  }
}

function importPeerCacheIfNeeded(dest, {
  file,
  settingKey,
  alias,
  adminUserId,
  force = false,
  copyFlags = true,
} = {}) {
  if (!file || !existsSync(file)) return { imported: false, reason: "missing" };
  if (!force && settingTrue(dest, settingKey)) return { imported: false, reason: "already" };
  if (!attachPeer(dest, file, alias)) return { imported: false, reason: "attach" };

  const result = {
    imported: true,
    listings: 0,
    flags: 0,
    geo: 0,
    routes: 0,
    communities: 0,
    retagged: 0,
  };
  dest.exec("BEGIN");
  try {
    result.listings = copyListings(dest, alias);
    result.geo = copyTable(dest, "geo_cache", alias);
    result.routes = copyTable(dest, "route_cache", alias);
    result.communities = copyTable(dest, "community_cache", alias);
    result.flags = copyFlags ? copyAdminFlags(dest, adminUserId, alias) : 0;
    result.retagged = retagSearchKeys(dest, alias);
    backfillListingSource(dest);
    if (result.listings > 0) writeSettingTrue(dest, "hasBaseline");
    writeSettingTrue(dest, settingKey);
    dest.exec("COMMIT");
  } catch (error) {
    dest.exec("ROLLBACK");
    detachPeer(dest, alias);
    throw error;
  }
  detachPeer(dest, alias);
  return result;
}

/**
 * 只讀匯入 v1 `591.db` 的刊登快取、地圖／路線／社區快取，以及管理員的已瀏覽／關注／隱藏。
 * 不寫入 v1、不拷通知事件、不覆蓋目的庫已有刊登。
 */
export function importV1CacheIfNeeded(dest, { v1Path, adminUserId, force = false } = {}) {
  return importPeerCacheIfNeeded(dest, {
    file: resolveV1DbPath(v1Path),
    settingKey: V1_CACHE_IMPORTED_KEY,
    alias: "v1",
    adminUserId,
    force,
    copyFlags: true,
  });
}

/**
 * 只讀匯入 v2 `v2.db` 的刊登與快取。不寫回 v2，不覆蓋 v3 已有刊登，不拷其他會員標記。
 */
export function importV2CacheIfNeeded(dest, { v2Path, force = false } = {}) {
  return importPeerCacheIfNeeded(dest, {
    file: resolveV2DbPath(v2Path),
    settingKey: V2_CACHE_IMPORTED_KEY,
    alias: "v2src",
    force,
    copyFlags: false,
  });
}
