/** 使用者手動併入同房源：只改自己的列表，不寫進全站共享判斷。 */

import { scoreMatch } from "./match.js";

export function ensureUserSameHouseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_same_house_members (
      user_id INTEGER NOT NULL,
      group_key TEXT NOT NULL,
      post_id INTEGER NOT NULL,
      system_agrees INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, post_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_same_house_group
      ON user_same_house_members(user_id, group_key);
  `);
}

function newGroupKey(now = new Date()) {
  return `ush_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeMergeIds(ids) {
  return [...new Set((ids || []).map((id) => Number(id) || 0).filter((id) => id > 0))];
}

export function systemJudgesSameHouse(a, b) {
  if (!a || !b) return false;
  if (Number(a.post_id) === Number(b.post_id)) return false;
  if (a.source_key && a.source_key === b.source_key) return true;
  const aMatch = Number(a.match_post_id) || 0;
  const bMatch = Number(b.match_post_id) || 0;
  if (
    (aMatch === Number(b.post_id) || bMatch === Number(a.post_id))
    && String(a.match_verdict || "") !== "no"
    && String(b.match_verdict || "") !== "no"
  ) {
    return true;
  }
  const hit = scoreMatch(a, b);
  return Boolean(hit && (hit.level === "high" || hit.level === "medium"));
}

export function judgeMergeSet(listings) {
  const rows = (listings || []).filter(Boolean);
  if (rows.length < 2) return { systemAgrees: false, disagreed: [] };
  const disagreed = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (!systemJudgesSameHouse(rows[i], rows[j])) {
        disagreed.push([Number(rows[i].post_id), Number(rows[j].post_id)]);
      }
    }
  }
  return { systemAgrees: disagreed.length === 0, disagreed };
}

export function personalGroupKeyFor(db, userId, postId) {
  const uid = Number(userId) || 0;
  const pid = Number(postId) || 0;
  if (!uid || !pid) return "";
  try {
    return String(db.prepare(
      `SELECT group_key FROM user_same_house_members WHERE user_id = ? AND post_id = ?`,
    ).get(uid, pid)?.group_key || "");
  } catch {
    return "";
  }
}

export function loadPersonalSameHouseIds(db, userId, postId) {
  const key = personalGroupKeyFor(db, userId, postId);
  if (!key) return [];
  try {
    return db.prepare(
      `SELECT post_id FROM user_same_house_members WHERE user_id = ? AND group_key = ?`,
    ).all(Number(userId), key).map((row) => Number(row.post_id)).filter((id) => id && id !== Number(postId));
  } catch {
    return [];
  }
}

/** Request-local index: one read for the viewer, never one query per candidate. */
export function loadPersonalSameHouseIndex(db, userId) {
  const byPost = new Map();
  const groups = new Map();
  const uid = Number(userId) || 0;
  if (uid) {
    for (const row of db.prepare(
      "SELECT post_id, group_key FROM user_same_house_members WHERE user_id = ?",
    ).all(uid)) {
      const id = Number(row.post_id);
      byPost.set(id, row.group_key);
      if (!groups.has(row.group_key)) groups.set(row.group_key, []);
      groups.get(row.group_key).push(id);
    }
  }
  return {
    groupKey: (id) => byPost.get(Number(id)) || "",
    peers: (id) => (groups.get(byPost.get(Number(id))) || []).filter(peer => peer !== Number(id)),
  };
}

export function personalGroupAgrees(db, userId, postId) {
  const key = personalGroupKeyFor(db, userId, postId);
  if (!key) return true;
  try {
    const row = db.prepare(
      `SELECT MIN(system_agrees) AS ok FROM user_same_house_members WHERE user_id = ? AND group_key = ?`,
    ).get(Number(userId), key);
    return Number(row?.ok) !== 0;
  } catch {
    return true;
  }
}

export function splitPersonalSameHouse(db, userId, postId, peerId) {
  const uid = Number(userId) || 0;
  const a = Number(postId) || 0;
  const b = Number(peerId) || 0;
  if (!uid || !a || !b) return false;
  const keyA = personalGroupKeyFor(db, uid, a);
  const keyB = personalGroupKeyFor(db, uid, b);
  if (!keyA || keyA !== keyB) return false;
  const now = new Date().toISOString();
  const members = db.prepare(
    `SELECT post_id FROM user_same_house_members WHERE user_id = ? AND group_key = ?`,
  ).all(uid, keyA).map((row) => Number(row.post_id));
  db.prepare(
    `DELETE FROM user_same_house_members WHERE user_id = ? AND post_id IN (?, ?)`,
  ).run(uid, a, b);
  const remain = members.filter((id) => id !== a && id !== b);
  if (remain.length === 1) {
    db.prepare(`DELETE FROM user_same_house_members WHERE user_id = ? AND post_id = ?`).run(uid, remain[0]);
  } else if (remain.length > 1) {
    const next = newGroupKey();
    for (const id of remain) {
      db.prepare(
        `UPDATE user_same_house_members SET group_key = ?, created_at = ? WHERE user_id = ? AND post_id = ?`,
      ).run(next, now, uid, id);
    }
  }
  return true;
}

export function mergePersonalSameHouse(db, userId, listings, { now = new Date() } = {}) {
  const uid = Number(userId) || 0;
  const rows = (listings || []).filter((row) => Number(row?.post_id) > 0);
  const ids = normalizeMergeIds(rows.map((row) => row.post_id));
  if (!uid) {
    return { ok: false, code: "guest", error: "請先登入才能併入同房源", systemAgrees: false };
  }
  if (ids.length < 2) {
    return { ok: false, code: "need_two", error: "請至少選 2 筆才能併入同房源", systemAgrees: false };
  }
  const judge = judgeMergeSet(rows);
  const stamp = now instanceof Date ? now.toISOString() : String(now);
  const keys = [...new Set(ids.map((id) => personalGroupKeyFor(db, uid, id)).filter(Boolean))];
  const groupKey = keys[0] || newGroupKey(now instanceof Date ? now : new Date(stamp));
  const extraIds = [];
  for (const key of keys) {
    extraIds.push(...db.prepare(
      `SELECT post_id FROM user_same_house_members WHERE user_id = ? AND group_key = ?`,
    ).all(uid, key).map((row) => Number(row.post_id)));
  }
  const allIds = normalizeMergeIds([...ids, ...extraIds]);
  const agrees = judge.systemAgrees ? 1 : 0;
  db.exec("BEGIN");
  try {
    for (const key of keys.slice(1)) {
      db.prepare(
        `UPDATE user_same_house_members SET group_key = ? WHERE user_id = ? AND group_key = ?`,
      ).run(groupKey, uid, key);
    }
    for (const id of allIds) {
      db.prepare(
        `INSERT INTO user_same_house_members (user_id, group_key, post_id, system_agrees, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, post_id) DO UPDATE SET
           group_key = excluded.group_key,
           system_agrees = MIN(user_same_house_members.system_agrees, excluded.system_agrees),
           created_at = user_same_house_members.created_at`,
      ).run(uid, groupKey, id, agrees, stamp);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    ok: true,
    personal: true,
    shared: false,
    post_ids: allIds,
    group_key: groupKey,
    systemAgrees: judge.systemAgrees,
    message: judge.systemAgrees
      ? `已為你併入 ${allIds.length} 筆同房源（只改你的列表）`
      : `已為你併入 ${allIds.length} 筆同房源。系統判定不是同屋源，此筆記錄只留在你的帳號，不會分享給其他使用者。`,
  };
}

/** webhook：同房源多筆只留主物件那一則。 */
export function collapseSameHouseNotifyEvents(events, resolvePrimaryId) {
  const list = Array.isArray(events) ? events : [];
  if (list.length < 2) return list;
  const buckets = new Map();
  const leftovers = [];
  for (const event of list) {
    const primaryId = Number(resolvePrimaryId?.(event) || 0);
    const selfId = Number(event?.post_id) || 0;
    if (!primaryId || !selfId) {
      leftovers.push(event);
      continue;
    }
    const key = `${event.type || ""}:${primaryId}`;
    const prev = buckets.get(key);
    if (!prev) {
      buckets.set(key, event);
      continue;
    }
    if (selfId === primaryId) buckets.set(key, event);
  }
  return [...buckets.values(), ...leftovers];
}
