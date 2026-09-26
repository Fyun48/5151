// Decoration data loaders (PostgreSQL hot path, step 1 of the decoration port).
//
// Listing cards are built in two stages: load side data (personal flags, same-house peers,
// listing_prep, personal groups), then decorate purely in JS. The JS stage is already
// driver-agnostic, but every loader lived inside db.js / personalFlags.js / userSameHouse.js
// bound to a synchronous node:sqlite handle - which is why the PostgreSQL path could only
// return RAW rows.
//
// This module re-states those queries against an injected `exec(sql, params, { one })`
// executor, so the same statement text runs on either driver (the PostgreSQL executor
// translates `?` -> `$n` through sqlDialect). createDecorationDataLoader() adds per-request
// memoisation; the individual functions stay exported for direct use.
//
// Statement text is deliberately copied verbatim from the SQLite helpers (same columns,
// same ORDER, same LIMIT) so a parity test can compare both drivers row for row.

import { numberFromPg } from "../dbDriverPostgres.js";

// Columns that SQLite hands back as numbers but node-postgres returns as strings (int8):
// normalising them here keeps the decorated card identical on both drivers.
const NUMERIC_KEYS = {
  flags: ["user_id", "post_id", "viewed", "watched", "hidden"],
  personal: ["user_id", "post_id", "system_agrees"],
  group: ["post_id"],
  peer: ["post_id", "price_num", "offline", "offline_confirmed", "hidden", "match_post_id"],
  prep: ["post_id", "display_ready"],
};

function normalizeRow(row, keys) {
  if (!row) return row;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) row[key] = numberFromPg(row[key]);
  }
  return row;
}

const PEER_COLUMNS = `post_id, source_id, title, url, price, price_num, extra_fee, extra_fees, extra_fee_text,
       price_contain_text, floor_name, area_name, layout, source, offline, offline_confirmed,
       hidden, match_post_id, match_level, match_verdict, match_detail,
       cost_changed_at, cost_change_detail, cost_change_type, last_seen_at, refresh_time`;

// Every column has to carry the `l.` prefix: the join also reads listing_group_members, and an
// unqualified name that exists in both tables makes PostgreSQL reject the statement
// ("column reference \"source\" is ambiguous") - SQLite tolerated it.
const PEER_COLUMNS_QUALIFIED = PEER_COLUMNS.split(",").map((part) => `l.${part.trim()}`).join(", ");

function normalizeUserId(userId) {
  return Number(userId) || 0;
}

function normalizeId(value) {
  return Number(value) || 0;
}

function inList(ids, driver, offset = 0) {
  return (driver === "postgres" ? ids.map((_, i) => `$${offset + i + 1}`) : ids.map(() => "?")).join(",");
}

// `SELECT * FROM user_listing_flags WHERE user_id = ?` (personalFlags.loadFlagMap)
export async function loadPersonalFlagMap(exec, userId) {
  const map = new Map();
  const uid = normalizeUserId(userId);
  if (!uid) return map;
  const rows = await exec("SELECT * FROM user_listing_flags WHERE user_id = ?", [uid]);
  for (const row of rows || []) map.set(Number(row.post_id), normalizeRow(row, NUMERIC_KEYS.flags));
  return map;
}

// `SELECT post_id, MAX(viewed) ... GROUP BY post_id` (personalFlags.loadAnyoneFlagMap)
export async function loadAnyoneFlagMap(exec) {
  const map = new Map();
  const rows = await exec(
    `SELECT post_id,
            MAX(viewed) AS viewed,
            MAX(watched) AS watched,
            MAX(hidden) AS hidden
     FROM user_listing_flags
     GROUP BY post_id`,
    [],
  );
  for (const row of rows || []) map.set(Number(row.post_id), normalizeRow(row, NUMERIC_KEYS.flags));
  return map;
}

// userSameHouse.loadPersonalSameHouseIndex: group_key per post + peers per group key,
// plus the MIN(system_agrees) aggregate personalGroupAgrees() needs.
export async function loadPersonalSameHouseIndex(exec, userId) {
  const byPost = new Map();
  const groups = new Map();
  const agrees = new Map();
  const uid = normalizeUserId(userId);
  if (uid) {
    const rows = await exec(
      `SELECT post_id, group_key, system_agrees FROM user_same_house_members WHERE user_id = ?`,
      [uid],
    );
    for (const raw of rows || []) {
      const row = normalizeRow(raw, NUMERIC_KEYS.personal);
      const id = Number(row.post_id);
      const key = String(row.group_key || "");
      byPost.set(id, key);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
      const current = agrees.has(key) ? agrees.get(key) : 1;
      agrees.set(key, Number(row.system_agrees) === 0 ? 0 : current);
    }
  }
  return {
    groupKey: (id) => byPost.get(Number(id)) || "",
    peers: (id) => (groups.get(byPost.get(Number(id))) || []).filter((peer) => peer !== Number(id)),
    // Mirrors personalGroupAgrees(): no group -> true.
    agrees: (key) => (key ? Number(agrees.get(key) ?? 1) !== 0 : true),
    size: byPost.size,
  };
}

// ⚠️ astra6 §0.1 實測（2026-09-25）：PG 的擴充查詢協定以 **int16** 表示參數個數與格式
// ⇒ **單一 statement 最多 32,767 個參數**。用 `IN ($1,$2,…)` 傳上萬個 id 會踩到：
//     08P01 bind message has 36300 parameter formats but 0 parameters
// 而且會**直接打斷連線**（實測：無行政區的全表候選 36,300 個 id ⇒ node_pg 失敗；
// 極可能就是「30 秒／Connection terminated unexpectedly」的根因）。
// ⇒ PG 改用**單一陣列參數**綁定（app 已有先例：行政區 closure 用 `= ANY(?::bigint[])`）；
//    SQLite 維持原本的 IN 佔位符。
function idFilter(column, ids, driver, offset = 0) {
  if (driver === "postgres") return { sql: `${column} = ANY(?::bigint[])`, params: [ids] };
  return { sql: `${column} IN (${inList(ids, driver, offset)})`, params: ids };
}

// listingGroups.groupIdForPost for a whole page in one round trip.
export async function loadGroupIds(exec, postIds, driver = "sqlite") {
  const map = new Map();
  const ids = [...new Set((postIds || []).map(normalizeId).filter(Boolean))];
  if (!ids.length) return map;
  const filter = idFilter("post_id", ids, driver);
  const rows = await exec(
    `SELECT post_id, group_id FROM listing_group_members WHERE ${filter.sql}`,
    filter.params,
  );
  for (const row of rows || []) map.set(Number(row.post_id), String(row.group_id || ""));
  return map;
}

// db.js loadSameHousePeers(): the direct listings neighbours (post_id / match_post_id).
// The id list appears twice, so the PostgreSQL placeholders must keep counting
// ($1..$n for the first IN list, then $n+1.. for the second) while SQLite just repeats `?`.
// db.js loadSameHousePeers(): 一頁內所有 post_id 的 peer 列。
//
// ⚠️ astra6 2026-09-25 §0.2（已證實）：原版在**整批**共用一個 `LIMIT 8` ✗ ——
// 80 個頁面 id 只會拿到 8 筆 peer 列，角色／total 的計算看到被截斷的資料（靜默錯誤）。
// 計算角色與 total 所需的資料**不得截斷**；若要限制「顯示」的 peer 筆數，
// 必須在角色計算**之後**、以穩定排序另行處理。
// 效能前提：`listings(match_post_id, post_id)` 索引（astra6 §3.2 的檢查清單）。
export async function loadPeerRows(exec, ids, driver = "sqlite") {
  const list = [...new Set((ids || []).map(normalizeId).filter(Boolean))];
  if (!list.length) return [];
  // PG 以單一陣列參數綁定（見 idFilter 的說明）；SQLite 沿用兩個 IN 清單。
  const byPost = idFilter("post_id", list, driver);
  const byMatch = idFilter("match_post_id", list, driver, list.length);
  const rows = await exec(
    `SELECT ${PEER_COLUMNS}
       FROM listings
       WHERE ${byPost.sql} OR ${byMatch.sql}`,
    [...byPost.params, ...byMatch.params],
  );
  return (rows || []).map((row) => normalizeRow(row, NUMERIC_KEYS.peer));
}

// db.js loadSameHousePeers(): the members of a system listing group.
export async function loadGroupMemberRows(exec, groupId) {
  const gid = String(groupId || "");
  if (!gid) return [];
  const rows = await exec(
    `SELECT ${PEER_COLUMNS_QUALIFIED}
       FROM listing_group_members m
       JOIN listings l ON l.post_id = m.post_id
       WHERE m.group_id = ?`,
    [gid],
  );
  return (rows || []).map((row) => normalizeRow(row, NUMERIC_KEYS.peer));
}

/**
 * 多個 group 的成員列，**一次查詢**取回（astra §4.3：每請求查詢數目標「一般 ≤12；通勤 ≤16」）。
 *
 * 原本是「每個 group 一筆」✗（頁面 50 列可能就有數十個 group）；PG 用 `= ANY(?::text[])`
 * 單一陣列參數 ✓，SQLite 維持 `IN (?,…)`。語意與逐個呼叫完全相同（缺 group 就是沒有成員列）。
 *
 * 回傳 `Map<groupId, rows[]>`（呼叫端可據此填入 per-gid 快取）。
 */
export async function loadGroupMemberRowsFor(exec, groupIds, driver = "sqlite") {
  const gids = [...new Set((groupIds || []).map((g) => String(g || "")).filter(Boolean))];
  const out = new Map(gids.map((g) => [g, []]));
  if (!gids.length) return out;
  const filter = driver === "postgres"
    ? { sql: "m.group_id = ANY(?::text[])", params: [gids] }
    : { sql: `m.group_id IN (${gids.map(() => "?").join(",")})`, params: gids };
  const rows = await exec(
    `SELECT m.group_id AS group_key, ${PEER_COLUMNS_QUALIFIED}
       FROM listing_group_members m
       JOIN listings l ON l.post_id = m.post_id
       WHERE ${filter.sql}`,
    filter.params,
  );
  for (const row of rows || []) {
    const gid = String(row.group_key || "");
    if (!gid || !out.has(gid)) continue;
    out.get(gid).push(normalizeRow(row, NUMERIC_KEYS.peer));
  }
  return out;
}

// db.js hpPrepFields() / housepriceNotDisplayReady(): the listing_prep row per post.
export async function loadListingPrepMap(exec, postIds, driver = "sqlite") {
  const map = new Map();
  const ids = [...new Set((postIds || []).map(normalizeId).filter(Boolean))];
  if (!ids.length) return map;
  const filter = idFilter("post_id", ids, driver);
  const rows = await exec(`SELECT * FROM listing_prep WHERE ${filter.sql}`, filter.params);
  for (const row of rows || []) map.set(Number(row.post_id), normalizeRow(row, NUMERIC_KEYS.prep));
  return map;
}

// personalSchema.js user_match_votes: db.js loadUserSplitPairSet() (the "不是同一間" votes).
export async function loadUserSplitPairSet(exec, userId) {
  const set = new Set();
  const uid = normalizeUserId(userId);
  if (!uid) return set;
  const rows = await exec(
    `SELECT post_id, peer_id FROM user_match_votes WHERE user_id = ? AND vote = 'split'`,
    [uid],
  );
  for (const row of rows || []) set.add(`${Number(row.post_id)}:${Number(row.peer_id)}`);
  return set;
}

// db.js attachSameHouseRoles(): same-house partners of the page that are NOT on the page.
const EXTRAS_COLUMNS = `post_id, source, source_id, url, price, price_num, extra_fee, extra_fees, extra_fee_text,
       price_contain_text, refresh_time, last_seen_at, hidden, offline, match_verdict, match_level`;
const EXTRAS_KEYS = EXTRAS_COLUMNS.split(",").map(key => key.trim());

export function listingExtrasSnapshot(rows) {
  return new Map((rows || []).map(row => [Number(row.post_id),
    Object.fromEntries(EXTRAS_KEYS.map(key => [key, row[key]]))]));
}

export async function loadListingExtras(exec, postIds, driver = "sqlite") {
  const map = new Map();
  const ids = [...new Set((postIds || []).map(normalizeId).filter(Boolean))];
  if (!ids.length) return map;
  const filter = idFilter("post_id", ids, driver);
  const rows = await exec(
    `SELECT ${EXTRAS_COLUMNS} FROM listings WHERE ${filter.sql}`,
    filter.params,
  );
  for (const row of rows || []) {
    map.set(Number(row.post_id), normalizeRow(row, NUMERIC_KEYS.peer));
  }
  return map;
}

function textKeyFilter(column, keys, driver) {
  return driver === "postgres"
    ? {sql: `${column} = ANY(?::text[])`, params: [keys]}
    : {sql: `${column} IN (${inList(keys, driver)})`, params: keys};
}

// db.js getCachedRoute(): route_cache rows keyed by route.js makeRouteKey(). The row is
// returned raw - the parsing/rounding stays in db.js so both drivers share one parser.
const ROUTE_CACHE_COLUMNS = "route_key, distances, min_km, min_m, rush_am_min, rush_pm_min, rush_updated_at";

export async function loadRouteCacheEntries(exec, keys, driver = "sqlite") {
  const map = new Map();
  const list = [...new Set((keys || []).map((key) => String(key || "")).filter(Boolean))];
  if (!list.length) return map;
  const filter = textKeyFilter("route_key", list, driver);
  const rows = await exec(`SELECT ${ROUTE_CACHE_COLUMNS} FROM route_cache WHERE ${filter.sql}`, filter.params);
  for (const row of rows || []) {
    map.set(String(row.route_key), normalizeRow(row, ["min_km", "min_m", "rush_am_min", "rush_pm_min"]));
  }
  return map;
}

// db.js getCachedMrt(): mrt_cache rows keyed by geo_key.
export async function loadMrtCacheEntries(exec, keys, driver = "sqlite") {
  const map = new Map();
  const list = [...new Set((keys || []).map((key) => String(key || "")).filter(Boolean))];
  if (!list.length) return map;
  const filter = textKeyFilter("geo_key", list, driver);
  const rows = await exec(`SELECT geo_key, station, walk_km, walk_min, ride_km, ride_min FROM mrt_cache WHERE ${filter.sql}`, filter.params);
  for (const row of rows || []) {
    map.set(String(row.geo_key), normalizeRow(row, ["walk_km", "walk_min", "ride_km", "ride_min"]));
  }
  return map;
}

// db.js getRouteJob(): route_jobs rows keyed by job_key.
export async function loadRouteJobs(exec, keys, driver = "sqlite") {
  const map = new Map();
  const list = [...new Set((keys || []).map((key) => String(key || "")).filter(Boolean))];
  if (!list.length) return map;
  const filter = textKeyFilter("job_key", list, driver);
  const rows = await exec(`SELECT * FROM route_jobs WHERE ${filter.sql}`, filter.params);
  for (const row of rows || []) map.set(String(row.job_key), normalizeRow(row, ["post_id", "attempts"]));
  return map;
}

// Per-request memoisation: one read per user / per id set, regardless of how many cards get
// decorated or how many of those calls happen concurrently. The cache holds the *promise*
// (not the resolved value) so two concurrent calls share one query, and a rejection is
// never cached. State lives on the returned object, never in module scope.
async function memo(map, key, factory) {
  if (!map.has(key)) {
    const promise = factory();
    map.set(key, promise);
    try {
      await promise;
    } catch (error) {
      map.delete(key);
      throw error;
    }
  }
  return map.get(key);
}

export function createDecorationDataLoader({ exec, driver = "sqlite" }) {
  if (typeof exec !== "function") throw new Error("createDecorationDataLoader requires exec");
  const cache = {
    personalFlags: new Map(),
    anyoneFlags: new Map(),
    personalIndex: new Map(),
    peers: new Map(),
    groupMembers: new Map(),
    splits: new Map(),
    routeCache: new Map(),
    mrtCache: new Map(),
    routeJobs: new Map(),
    // astra §4.3：以 **id 為單位**的列快取。原本以「整個 id 集合」為 key ✗ ⇒ 候選集合與頁面集合
    // 各查一次（prep／extras／groupIds 各 2 筆）。改成只查「缺少的 id」⇒ 集合重疊時天然不重查，
    // 語意完全不變。
    groupIdsRows: new Map(),
    prepRows: new Map(),
    extrasRows: new Map(),
    // 進行中的查詢（同一組缺少 id 的併發呼叫共用一個 promise，保留舊 memo 的併發語意）
    inflight: new Map(),
  };
  const keyOf = (ids) => [...new Set((ids || []).map(normalizeId).filter(Boolean))].sort((a, b) => a - b).join(",");

  // 只對「缺少的 id」發查詢；回傳每個請求 id 都有值（可能 null）的 Map。
  async function rowsByIds(rows, ids, fetch, label) {
    const missing = ids.filter((id) => !rows.has(id));
    if (missing.length) {
      const key = `${label}:${keyOf(missing)}`;
      if (!cache.inflight.has(key)) {
        const promise = (async () => {
          const got = await fetch(missing);
          for (const id of missing) rows.set(id, got.get(id) ?? null);
        })();
        cache.inflight.set(key, promise);
        // 失敗不留快取（與舊 memo 一致：rejection 不進快取）
        promise.then(() => cache.inflight.delete(key), () => cache.inflight.delete(key));
      }
      await cache.inflight.get(key);
    }
    return new Map(ids.map((id) => [id, rows.get(id) ?? null]));
  }

  return {
    driver,
    async personalFlagMap(userId) {
      const uid = normalizeUserId(userId);
      return memo(cache.personalFlags, uid, () => loadPersonalFlagMap(exec, uid));
    },
    async anyoneFlagMap() {
      return memo(cache.anyoneFlags, "anyone", () => loadAnyoneFlagMap(exec));
    },
    async personalIndex(userId) {
      const uid = normalizeUserId(userId);
      return memo(cache.personalIndex, uid, () => loadPersonalSameHouseIndex(exec, uid));
    },
    async groupIdsFor(postIds) {
      const ids = [...new Set((postIds || []).map(normalizeId).filter(Boolean))];
      if (!ids.length) return new Map();
      const map = await rowsByIds(cache.groupIdsRows, ids, (miss) => loadGroupIds(exec, miss, driver), "groupIds");
      return new Map(ids.map((id) => [id, map.get(id) || ""]));
    },
    async peerRowsFor(ids) {
      const wanted = [...new Set((ids || []).map(normalizeId).filter(Boolean))];
      if (!wanted.length) return [];
      const grouped = await memo(cache.peers, keyOf(wanted), async () => {
        const byKey = new Map();
        for (const row of await loadPeerRows(exec, wanted, driver)) {
          for (const key of [normalizeId(row.post_id), normalizeId(row.match_post_id)]) {
            if (!key) continue;
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(row);
          }
        }
        return byKey;
      });
      return wanted.flatMap((id) => grouped.get(id) || []);
    },
    async groupMemberRows(groupId) {
      const gid = String(groupId || "");
      if (!gid) return [];
      return memo(cache.groupMembers, gid, () => loadGroupMemberRows(exec, gid));
    },
    /**
     * astra §4.3：多個 group 的成員列**一次查詢**取回（原本每 group 一筆 ✗），
     * 並回填 per-gid 快取 ⇒ 之後的 `groupMemberRows(gid)`（供裝飾同步取用）不必再查。
     */
    async groupMemberRowsFor(groupIds) {
      const gids = [...new Set((groupIds || []).map((g) => String(g || "")).filter(Boolean))];
      const out = new Map();
      if (!gids.length) return out;
      const missing = gids.filter((g) => !cache.groupMembers.has(g));
      if (missing.length) {
        const key = `groupMembers:${missing.slice().sort().join("|")}`;
        if (!cache.inflight.has(key)) {
          const promise = (async () => {
            const got = await loadGroupMemberRowsFor(exec, missing, driver);
            for (const g of missing) cache.groupMembers.set(g, got.get(g) || []);
          })();
          cache.inflight.set(key, promise);
          promise.then(() => cache.inflight.delete(key), () => cache.inflight.delete(key));
        }
        await cache.inflight.get(key);
      }
      for (const g of gids) out.set(g, cache.groupMembers.get(g) || []);
      return out;
    },
    async prepMap(postIds) {
      const ids = [...new Set((postIds || []).map(normalizeId).filter(Boolean))];
      if (!ids.length) return new Map();
      return rowsByIds(cache.prepRows, ids, (miss) => loadListingPrepMap(exec, miss, driver), "prep");
    },
    async splitPairSet(userId) {
      const uid = normalizeUserId(userId);
      return memo(cache.splits, uid, () => loadUserSplitPairSet(exec, uid));
    },
    async extrasMap(postIds) {
      const ids = [...new Set((postIds || []).map(normalizeId).filter(Boolean))];
      if (!ids.length) return new Map();
      return rowsByIds(cache.extrasRows, ids, (miss) => loadListingExtras(exec, miss, driver), "extras");
    },
    async routeCacheMap(keys) {
      const list = [...new Set((keys || []).map((key) => String(key || "")).filter(Boolean))].sort();
      if (!list.length) return new Map();
      const map = await memo(cache.routeCache, list.join("|"), () => loadRouteCacheEntries(exec, list, driver));
      return new Map(list.map((key) => [key, map.get(key) || null]));
    },
    async mrtCacheMap(keys) {
      const list = [...new Set((keys || []).map((key) => String(key || "")).filter(Boolean))].sort();
      if (!list.length) return new Map();
      const map = await memo(cache.mrtCache, list.join("|"), () => loadMrtCacheEntries(exec, list, driver));
      return new Map(list.map((key) => [key, map.get(key) || null]));
    },
    async routeJobsMap(keys) {
      const list = [...new Set((keys || []).map((key) => String(key || "")).filter(Boolean))].sort();
      if (!list.length) return new Map();
      const map = await memo(cache.routeJobs, list.join("|"), () => loadRouteJobs(exec, list, driver));
      return new Map(list.map((key) => [key, map.get(key) || null]));
    },
  };
}
