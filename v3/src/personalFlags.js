/** 個人刊登標記。只接受 db 連線，避免和 db.js 循環 import。 */
import { nextWatchNote } from "./watchFlags.js";
import { candidateRowWithPersonal } from "./listingCandidateRow.js";

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

export function overlayPersonal(listing, flags, { inPlace = false, candidateShape = false } = {}) {
  if (!listing) return listing;
  const f = flags && typeof flags === "object" ? flags : emptyFlags();
  const systemDup = String(listing.match_verdict || "") === "yes";
  const personal = {
    viewed: Number(f.viewed) || 0,
    watched: Number(f.watched) || 0,
    hidden: systemDup ? 1 : Number(f.hidden) || 0,
    watch_note: String(f.watch_note || ""),
    viewed_at: f.viewed_at || null,
    watched_at: f.watched_at || null,
    hidden_at: systemDup ? listing.hidden_at || f.hidden_at || null : f.hidden_at || null,
  };
  // Create the complete shape at once. Adding seven fields to a wide PG row
  // with Object.assign converts V8's fast properties into a larger dictionary.
  if (inPlace) return Object.assign(listing, personal);
  return candidateShape ? candidateRowWithPersonal(listing, personal) : { ...listing, ...personal };
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

export function overlayRowsPersonal(rows, flagMap, options) {
  return (rows || []).map((row) => overlayPersonal(row, flagMap?.get(Number(row.post_id)), options));
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

// 個人旗標「下一個值」的計算（純函式）。同步版 setUserListingFlags() 與 PG 分支
// （personalFlagsAsync.js）共用同一份規則，兩個 driver 才會算出同樣的時間戳與覆寫順序。
export function stampFlags(prev, flags, now) {
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

// Owner 2026-10-12：「特別關注／已隱藏」不再豁免折疊 —— 三個清單的呈現規則完全一致，
// 同屋源次卡在三個清單都只出一列（逐則操作改由展開面板提供，見 public/index.html 的
// sameHousePanel）。**沒有 `filter` 參數**：折疊判定與清單無關，所以不需要（先前
// 「`filter` 參數保留只為相容」的註解與簽名不一致，2026-10-12 一併對齊成現在的形狀）。
//
// Owner 2026-10-16 裁示（本函式移除「補償條款」）：**同一個同屋源群在清單上只顯示 1 列＝代表列**。
// 代表列就是「這次篩選的候選列裡按 `preferPrimaryListing` 選出的那一列」；它即使是「暫離」
// （`offline=1` 且 `offline_confirmed=0`），依 2026-10-12 定案 3b 照樣可以當代表、也照樣顯示
// （見 v3/src/db.js 的 eligible：只排除 `offline_confirmed=1`）。
// 舊的補償條款（`primary_offline=1` 且本列 `offline<>1` ⇒ 本列仍留列表）是在 3b 之前寫的：
// 當時假設「主卡暫離就看不到主卡」，所以留次卡墊檔；3b 之後主卡自己就會顯示 ⇒ 補償條款變成
// 「主卡與次卡同時出現」的重覆顯示（正式庫 2026-10-16 實測：8 群／27 列會多顯示）。
// 線上仍存在的次卡改由展開面板觸達（前端 sameHousePanel 的 peers；資料面 `same_house.peers`
// 仍帶著它們，只是不進清單列）。
export function listingIsMainListAffiliate(row) {
  if (row?.same_house_split) return false;
  if (row?.same_house_role !== "affiliate") return false;
  return true;
}

// Owner 2026-10-12 裁示③「次卡要跟著主卡走」：群級聚合旗標，由 db.js 的
// attachSameHouseRoleSteps 依「這次候選集內的所有成員」算好。沒有折疊的單列回 null＝看自己的旗標。
function groupAggregate(row, kind) {
  const role = row?.same_house_role;
  if (role !== "primary" && role !== "affiliate") return null;
  return Number(row?.[kind === "watched" ? "same_house_group_watched" : "same_house_group_hidden"]) === 1;
}

export function listingMatchesListFilter(row, filter) {
  // 任何清單都不顯示同屋源次卡（逐則處理請用展開面板）⇒「一般」的判斷永遠只有代表列
  // （＝主卡）參與，不會變成「逐則自判」。
  if (listingIsMainListAffiliate(row)) return false;
  const hidden = Number(row?.hidden) === 1;
  const watched = Number(row?.watched) === 1;
  const viewed = Number(row?.viewed) === 1;
  const offline = Number(row?.offline) === 1;
  const confirmed = Number(row?.offline_confirmed) === 1;
  // Owner 2026-10-12：確認下架（offline_confirmed=1）完全不顯示，三個清單都不例外，
  // 也不再參與選主（選主的排除在 db.js／listingSearchSql.js 的折疊段）。
  if (confirmed) return false;
  const dup = String(row?.match_verdict || "") === "yes";
  // 已隱藏：群內任一成員被隱藏 ⇒ 該群以主卡列示（次卡已在上面被排除）。
  if (filter === "hidden") return hidden || dup || groupAggregate(row, "hidden") === true;
  if (filter === "offline") return offline && !confirmed;
  if (filter === "suspected") return Boolean(row?.match_level) && !confirmed && !dup && !hidden;
  // 特別關注是配額管理清單：已下架（未確認）與同屋源次要刊登都要看得見才能取消／逐則處理。
  // 群內任一成員被特別關注 ⇒ 該群出現，出現的那一列是主卡（即使主卡自己沒被關注）。
  if (filter === "watched") return watched || groupAggregate(row, "watched") === true;
  // 「下架確認中」（pending）留在一般列表（灰階）；只有「確認已下架」才排除。
  if (dup || hidden) return false;
  // Owner 2026-10-12：一般清單（原「全部」）不得顯示已被特別關注或已被隱藏的物件，
  // 除非使用者先解除該狀態。
  // ── 這一條的裁決沿革（舊痕跡刻意保留，不要刪）──────────────────────────────
  // Owner 2026-10-07（舊）：「全部」＝未看過且未特別關注；看過的物件改由「已瀏覽」清單查。
  // Owner 2026-10-14（新，只改掉舊裁決的一半）：「一般」＝排除特別關注（watched）、
  //   隱藏（hidden）、確認下架（confirmed）、重複（dup）；**已瀏覽（viewed）照常顯示**
  //   ⇒ 舊裁決的「未看過」那一半作廢，「未特別關注」那一半保留。
  //   hidden／confirmed／dup 在上面已經 return false，所以這裡只剩 watched。
  //   已瀏覽標籤本來就會畫；`viewed` 專用 chip 與 server 的 `unseen` filter 都不動。
  // 這一條讀的是「代表列自己的旗標」（次卡已折疊）⇒ 整群去留由主卡決定。
  if (filter === "all") return !watched;
  if (filter === "unseen") return !viewed;
  if (filter === "viewed") return viewed === true || viewed === 1;
  if (filter === "same_source") {
    return ["same_source", "update", "price_drop", "title_update"].includes(row?.last_event);
  }
  return true;
}

// 「全部清除」特別關注／已隱藏的核心（吃 db handle，方便用記憶體夾具單測）。
// 只歸零指定欄位與它的時間戳；另一欄若仍有值，那一列會保留（與 setUserListingFlags 的語意一致）。
// kind 只接受 watched／hidden，欄位名一律走白名單，不從外部字串拼進 SQL。
export const CLEARABLE_FLAG_COLUMNS = Object.freeze({ watched: "watched_at", hidden: "hidden_at" });

export function clearUserListingFlags(conn, kind, userId) {
  const column = CLEARABLE_FLAG_COLUMNS[String(kind)];
  if (!column) {
    const err = new Error("不支援的清除類型");
    err.status = 400;
    err.code = "BAD_FLAG_KIND";
    throw err;
  }
  const uid = Number(userId) || 0;
  if (!uid) return 0;
  const info = conn.prepare(
    `UPDATE user_listing_flags SET ${kind} = 0, ${column} = NULL WHERE user_id = ? AND ${kind} = 1`,
  ).run(uid);
  return Number(info?.changes) || 0;
}
