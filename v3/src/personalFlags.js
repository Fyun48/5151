/** 個人刊登標記。只接受 db 連線，避免和 db.js 循環 import。 */
import { nextWatchNote } from "./watchFlags.js";

const MIGRATED_KEY = "personalFlagsMigrated";

export function emptyFlags() {
  return {
    viewed: 0,
    watched: 0,
    hidden: 0,
    watch_note: "",
    viewed_at: null,
    watched_at: null,
    hidden_at: null,
  };
}

export function adminEmailForUser() {
  return String(process.env.AUTH_EMAIL || "").trim().toLowerCase() || "admin@local";
}

export function ensureUser(conn, email, { role } = {}) {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return 0;
  const existing = conn.prepare("SELECT id FROM users WHERE email = ?").get(key);
  if (existing) return Number(existing.id);
  const now = new Date().toISOString();
  const isAdmin = role === "admin" || key === adminEmailForUser();
  const result = conn.prepare(
    `INSERT INTO users(email, password_hash, role, plan, created_at)
     VALUES (?, '', ?, 'free', ?)`,
  ).run(key, isAdmin ? "admin" : "member", now);
  return Number(result.lastInsertRowid);
}

export function overlayPersonal(listing, flags) {
  if (!listing) return listing;
  const f = flags && typeof flags === "object" ? flags : emptyFlags();
  const systemDup = String(listing.match_verdict || "") === "yes";
  return {
    ...listing,
    viewed: Number(f.viewed) || 0,
    watched: Number(f.watched) || 0,
    hidden: systemDup ? 1 : Number(f.hidden) || 0,
    watch_note: String(f.watch_note || ""),
    viewed_at: f.viewed_at || null,
    watched_at: f.watched_at || null,
    hidden_at: systemDup ? listing.hidden_at || f.hidden_at || null : f.hidden_at || null,
  };
}

export function loadFlags(conn, userId, postId) {
  const uid = Number(userId) || 0;
  const pid = Number(postId) || 0;
  if (!uid || !pid) return emptyFlags();
  return conn.prepare(
    "SELECT * FROM user_listing_flags WHERE user_id = ? AND post_id = ?",
  ).get(uid, pid) || emptyFlags();
}

export function loadFlagMap(conn, userId) {
  const map = new Map();
  const uid = Number(userId) || 0;
  if (!uid) return map;
  const rows = conn.prepare("SELECT * FROM user_listing_flags WHERE user_id = ?").all(uid);
  for (const row of rows) map.set(Number(row.post_id), row);
  return map;
}

/** 任何人曾瀏覽／關注／隱藏：給同屋源比對當訊號，不是個人列表。 */
export function loadAnyoneFlagMap(conn) {
  const map = new Map();
  const rows = conn
    .prepare(
      `SELECT post_id,
              MAX(viewed) AS viewed,
              MAX(watched) AS watched,
              MAX(hidden) AS hidden
       FROM user_listing_flags
       GROUP BY post_id`,
    )
    .all();
  for (const row of rows) map.set(Number(row.post_id), row);
  return map;
}

export function overlayRowsPersonal(rows, flagMap) {
  return (rows || []).map((row) => overlayPersonal(row, flagMap?.get(Number(row.post_id))));
}

export function anyoneWatched(conn, postId) {
  const pid = Number(postId) || 0;
  if (!pid) return false;
  return Boolean(
    conn.prepare(
      "SELECT 1 AS ok FROM user_listing_flags WHERE post_id = ? AND watched = 1 LIMIT 1",
    ).get(pid),
  );
}

function stampFlags(prev, flags, now) {
  const current = { ...emptyFlags(), ...prev };
  const viewed = flags.viewed === undefined ? Number(Boolean(current.viewed)) : Number(Boolean(flags.viewed));
  const watched = flags.watched === undefined ? Number(Boolean(current.watched)) : Number(Boolean(flags.watched));
  const hidden = flags.hidden === undefined ? Number(Boolean(current.hidden)) : Number(Boolean(flags.hidden));
  const watchNote = nextWatchNote(current, flags);
  let viewedAt = current.viewed_at || null;
  if (viewed === 1) viewedAt = viewedAt || now;
  let watchedAt = current.watched_at || null;
  if (watched === 1 && !Number(current.watched)) watchedAt = now;
  else if (watched === 1) watchedAt = watchedAt || now;
  let hiddenAt = current.hidden_at || null;
  if (hidden === 1) hiddenAt = hiddenAt || now;
  return { viewed, watched, hidden, watchNote, viewedAt, watchedAt, hiddenAt };
}

export function setUserListingFlags(conn, userId, postId, flags = {}, current = {}) {
  const uid = Number(userId) || 0;
  const pid = Number(postId) || 0;
  if (!uid || !pid) return null;
  const prev = conn.prepare(
    "SELECT * FROM user_listing_flags WHERE user_id = ? AND post_id = ?",
  ).get(uid, pid) || current || emptyFlags();
  const now = new Date().toISOString();
  const next = stampFlags(prev, flags, now);
  conn.prepare(
    `INSERT INTO user_listing_flags (
       user_id, post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, post_id) DO UPDATE SET
       viewed = excluded.viewed,
       watched = excluded.watched,
       hidden = excluded.hidden,
       watch_note = excluded.watch_note,
       viewed_at = CASE
         WHEN excluded.viewed = 1 THEN COALESCE(user_listing_flags.viewed_at, excluded.viewed_at)
         ELSE user_listing_flags.viewed_at
       END,
       watched_at = CASE
         WHEN excluded.watched = 1 AND IFNULL(user_listing_flags.watched, 0) = 0 THEN excluded.watched_at
         WHEN excluded.watched = 1 THEN COALESCE(user_listing_flags.watched_at, excluded.watched_at)
         ELSE user_listing_flags.watched_at
       END,
       hidden_at = CASE
         WHEN excluded.hidden = 1 THEN COALESCE(user_listing_flags.hidden_at, excluded.hidden_at)
         ELSE user_listing_flags.hidden_at
       END`,
  ).run(
    uid,
    pid,
    next.viewed,
    next.watched,
    next.hidden,
    next.watchNote,
    next.viewedAt,
    next.watchedAt,
    next.hiddenAt,
  );
  return loadFlags(conn, uid, pid);
}

/**
 * 重刊：沿用各會員對舊 post_id 的標記。
 * 與舊版 setFlags 相同：曾瀏覽或隱藏 → 新刊登也標已瀏覽＋不再顯示；只關注則只帶關注／備註。
 */
export function copyUserFlagsForRelist(conn, fromPostId, toPostId) {
  const fromId = Number(fromPostId) || 0;
  const toId = Number(toPostId) || 0;
  if (!fromId || !toId || fromId === toId) return 0;
  const rows = conn.prepare("SELECT * FROM user_listing_flags WHERE post_id = ?").all(fromId);
  let copied = 0;
  for (const row of rows) {
    if (Number(row.hidden) || Number(row.viewed)) {
      setUserListingFlags(conn, row.user_id, toId, {
        hidden: true,
        viewed: true,
        watched: Boolean(Number(row.watched)),
        watch_note: row.watch_note || "",
      }, emptyFlags());
      copied += 1;
    } else if (Number(row.watched) || String(row.watch_note || "").trim()) {
      setUserListingFlags(conn, row.user_id, toId, {
        watched: Boolean(Number(row.watched)),
        watch_note: row.watch_note || "",
      }, emptyFlags());
      copied += 1;
    }
  }
  return copied;
}

/** 確認同一間：把重複刊登上的關注／備註合併到保留刊登，不把「不再顯示」帶到主刊登。 */
export function mergeFlagsOnConfirm(conn, primaryId, duplicateId) {
  const keep = Number(primaryId) || 0;
  const drop = Number(duplicateId) || 0;
  if (!keep || !drop || keep === drop) return 0;
  const userIds = conn
    .prepare("SELECT DISTINCT user_id FROM user_listing_flags WHERE post_id IN (?, ?)")
    .all(keep, drop)
    .map((row) => Number(row.user_id));
  for (const userId of userIds) {
    const a = loadFlags(conn, userId, keep);
    const b = loadFlags(conn, userId, drop);
    setUserListingFlags(conn, userId, keep, {
      viewed: Boolean(Number(a.viewed) || Number(b.viewed)),
      watched: Boolean(Number(a.watched) || Number(b.watched)),
      hidden: Boolean(Number(a.hidden)),
      watch_note: String(a.watch_note || "").trim() || String(b.watch_note || "").trim(),
    }, a);
  }
  return userIds.length;
}

function readMigrated(conn) {
  try {
    const row = conn.prepare("SELECT value FROM settings WHERE key = ?").get(MIGRATED_KEY);
    if (!row) return false;
    return JSON.parse(row.value) === true;
  } catch {
    return false;
  }
}

function writeMigrated(conn) {
  conn.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(MIGRATED_KEY, JSON.stringify(true));
}

/**
 * 把 listings 列上的舊標記拷到指定會員，並清掉個人欄位。
 * match_verdict=yes 的 hidden 仍留在 listings（全站重複刊登）。
 */
export function migrateListingFlagsIfNeeded(conn, userId) {
  const uid = Number(userId) || 0;
  if (!uid || readMigrated(conn)) return { migrated: false, copied: 0 };
  const rows = conn
    .prepare(
      `SELECT post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at, match_verdict
       FROM listings
       WHERE IFNULL(viewed, 0) = 1
          OR IFNULL(watched, 0) = 1
          OR IFNULL(hidden, 0) = 1
          OR IFNULL(watch_note, '') != ''`,
    )
    .all();
  let copied = 0;
  conn.exec("BEGIN");
  try {
    for (const row of rows) {
      const systemDup = String(row.match_verdict || "") === "yes";
      const personalHidden = systemDup ? 0 : Number(row.hidden) || 0;
      if (!Number(row.viewed) && !Number(row.watched) && !personalHidden && !String(row.watch_note || "").trim()) {
        continue;
      }
      conn.prepare(
        `INSERT INTO user_listing_flags (
           user_id, post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, post_id) DO NOTHING`,
      ).run(
        uid,
        row.post_id,
        Number(row.viewed) || 0,
        Number(row.watched) || 0,
        personalHidden,
        String(row.watch_note || ""),
        row.viewed_at || null,
        row.watched_at || null,
        personalHidden ? row.hidden_at || null : null,
      );
      copied += 1;
    }
    conn.prepare(
      `UPDATE listings
       SET viewed = 0, watched = 0, watch_note = '', viewed_at = NULL, watched_at = NULL`,
    ).run();
    conn.prepare(
      `UPDATE listings
       SET hidden = 0, hidden_at = NULL
       WHERE IFNULL(match_verdict, '') != 'yes'`,
    ).run();
    writeMigrated(conn);
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
  return { migrated: true, copied };
}

export function listingIsMainListAffiliate(row, filter) {
  if (filter === "hidden") return false;
  if (row?.same_house_split) return false;
  if (row?.same_house_role !== "affiliate") return false;
  if (row?.same_house_primary_offline && Number(row.offline) !== 1) {
    return row?.same_house_live_standin !== true;
  }
  return true;
}

export function listingMatchesListFilter(row, filter) {
  if (listingIsMainListAffiliate(row, filter)) return false;
  const hidden = Number(row?.hidden) === 1;
  const watched = Number(row?.watched) === 1;
  const viewed = Number(row?.viewed) === 1;
  const offline = Number(row?.offline) === 1;
  const confirmed = Number(row?.offline_confirmed) === 1;
  const dup = String(row?.match_verdict || "") === "yes";
  if (filter === "hidden") return hidden || dup;
  if (filter === "offline") return offline && !confirmed;
  if (filter === "suspected") return Boolean(row?.match_level) && !offline && !dup && !hidden;
  if (dup || offline || hidden) return false;
  if (filter === "all") return !watched;
  if (filter === "unseen") return !viewed;
  if (filter === "viewed") return viewed === true || viewed === 1;
  if (filter === "watched") return watched;
  if (filter === "same_source") {
    return ["same_source", "update", "price_drop", "title_update"].includes(row?.last_event);
  }
  return true;
}
