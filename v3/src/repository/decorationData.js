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

const PEER_COLUMNS_QUALIFIED = PEER_COLUMNS.split(",\n").map((part) => `l.${part.trim()}`).join(", ");

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

// listingGroups.groupIdForPost for a whole page in one round trip.
export async function loadGroupIds(exec, postIds, driver = "sqlite") {
  const map = new Map();
  const ids = [...new Set((postIds || []).map(normalizeId).filter(Boolean))];
  if (!ids.length) return map;
  const rows = await exec(
    `SELECT post_id, group_id FROM listing_group_members WHERE post_id IN (${inList(ids, driver)})`,
    ids,
  );
  for (const row of rows || []) map.set(Number(row.post_id), String(row.group_id || ""));
  return map;
}

// db.js loadSameHousePeers(): the direct listings neighbours (post_id / match_post_id).
// The id list appears twice, so the PostgreSQL placeholders must keep counting
// ($1..$n for the first IN list, then $n+1.. for the second) while SQLite just repeats `?`.
export async function loadPeerRows(exec, ids, driver = "sqlite", { limit = 8 } = {}) {
  const list = [...new Set((ids || []).map(normalizeId).filter(Boolean))];
  if (!list.length) return [];
  const first = inList(list, driver, 0);
  const second = inList(list, driver, list.length);
  const rows = await exec(
    `SELECT ${PEER_COLUMNS}
       FROM listings
       WHERE post_id IN (${first}) OR match_post_id IN (${second})
       LIMIT ${Number(limit) || 8}`,
    [...list, ...list],
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

// db.js hpPrepFields() / housepriceNotDisplayReady(): the listing_prep row per post.
export async function loadListingPrepMap(exec, postIds, driver = "sqlite") {
  const map = new Map();
  const ids = [...new Set((postIds || []).map(normalizeId).filter(Boolean))];
  if (!ids.length) return map;
  const rows = await exec(`SELECT * FROM listing_prep WHERE post_id IN (${inList(ids, driver)})`, ids);
  for (const row of rows || []) map.set(Number(row.post_id), normalizeRow(row, NUMERIC_KEYS.prep));
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
    groupIds: new Map(),
    peers: new Map(),
    groupMembers: new Map(),
    prep: new Map(),
  };
  const keyOf = (ids) => [...new Set((ids || []).map(normalizeId).filter(Boolean))].sort((a, b) => a - b).join(",");

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
      const map = await memo(cache.groupIds, keyOf(ids), () => loadGroupIds(exec, ids, driver));
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
    async prepMap(postIds) {
      const ids = [...new Set((postIds || []).map(normalizeId).filter(Boolean))];
      if (!ids.length) return new Map();
      const map = await memo(cache.prep, keyOf(ids), () => loadListingPrepMap(exec, ids, driver));
      return new Map(ids.map((id) => [id, map.get(id) || null]));
    },
  };
}
