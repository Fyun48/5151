/** 特別關注筆數上限。管理員不限，說明文字不要寫管理員。 */

export const MEMBER_MAX_WATCHED = 6;
export const SPONSOR_MAX_WATCHED = 15;

export function watchLimitForActor({ role, plan } = {}) {
  if (String(role || "") === "admin") return 0;
  if (String(plan || "") === "sponsor") return SPONSOR_MAX_WATCHED;
  return MEMBER_MAX_WATCHED;
}

export function watchLimitMessage(limit) {
  const n = Number(limit) || MEMBER_MAX_WATCHED;
  if (n === SPONSOR_MAX_WATCHED) return `贊助會員最多特別關注 ${SPONSOR_MAX_WATCHED} 筆。請先取消一筆再加。`;
  return `一般會員最多特別關注 ${MEMBER_MAX_WATCHED} 筆，贊助會員可到 ${SPONSOR_MAX_WATCHED} 筆。請先取消一筆再加。`;
}

// Statement text kept as a constant: the PostgreSQL stats path
// (repository/listingStats.js) runs the same predicate through its executor, so the quota
// count and the list-page `watchedTotal` cannot drift apart. A watch only occupies quota
// while its listing is not confirmed-offline; orphan flags never count.
//
// Owner 2026-10-14（使用量口徑）：**被判定疑似同屋源的物件群，整群算 1 次**
// （同屋源 2 筆 ⇒ 1 次；不同屋源 2 筆 ⇒ 2 次）。分組鍵＝`listings.fold_component_root`
// （fold 工作線的固化欄；NULL ⇒ 自己一群，用 `post_id` 當鍵，與 db.js:3721 的分組語意相同）。
// 只讀這一欄，不動 fold 的任何程式碼。
export const WATCHED_COUNT_SQL = `SELECT COUNT(DISTINCT COALESCE(l.fold_component_root, f.post_id)) AS n
         FROM user_listing_flags f
         JOIN listings l ON l.post_id = f.post_id
         WHERE f.user_id = ? AND f.watched = 1
           AND IFNULL(l.offline_confirmed, 0) = 0`;

// SQLite 一向沒有 `fold_component_root` 這一欄（db.js:3696：只有 PG 有；SQLite 的折疊走
// union-find，不固化），所以同步版在 `no such column` 時退回**沒有分組鍵可用的退化口徑**：
// 「只有未確認下架佔配額、孤兒旗標不計」的語意逐字不變，差別只在無法按群去重。
// 這不是第二份規則，是同一條規則在缺少分組鍵時的形狀。
export const WATCHED_COUNT_SQL_LEGACY = `SELECT COUNT(*) AS n
         FROM user_listing_flags f
         WHERE f.user_id = ? AND f.watched = 1
           AND EXISTS (
             SELECT 1 FROM listings l
             WHERE l.post_id = f.post_id
               AND IFNULL(l.offline_confirmed, 0) = 0
           )`;

// 「這個新列所屬的群是否已經在特別關注裡」：同群已計 ⇒ 這次加入不增量。
// NULL root ⇒ 自己一群 ⇒ 不可能與別的列同群（同一列已在特別關注則由 `alreadyWatched` 短路）。
export const WATCHED_GROUP_HIT_SQL = `SELECT 1 AS hit
         FROM user_listing_flags f
         JOIN listings l ON l.post_id = f.post_id
         JOIN listings t ON t.post_id = ?
         WHERE f.user_id = ? AND f.watched = 1
           AND IFNULL(l.offline_confirmed, 0) = 0
           AND l.fold_component_root IS NOT NULL
           AND l.fold_component_root = t.fold_component_root
         LIMIT 1`;

// 配額規則的**唯一一份**純函式：SQLite（`canAddWatch`）與 PG（`personalFlagsAsync`）都呼叫它，
// 兩邊只差在「怎麼把 count／groupHit 查出來」，規則本身不會漂移。
export function watchGateVerdict({ limit = 0, count = 0, alreadyWatched = false, groupHit = false } = {}) {
  if (alreadyWatched) return { ok: true, limit, count };
  if (!limit) return { ok: true, limit: 0, count };
  // 同群已佔一格 ⇒ 不增量，直接放行（群數不變）。
  if (groupHit) return { ok: true, limit, count };
  if (count >= limit) return { ok: false, limit, count, error: watchLimitMessage(limit) };
  return { ok: true, limit, count };
}

export function countWatched(conn, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return 0;
  try {
    return Number(
      conn.prepare(WATCHED_COUNT_SQL).get(uid)?.n,
    ) || 0;
  } catch {
    try {
      return Number(
        conn.prepare(WATCHED_COUNT_SQL_LEGACY).get(uid)?.n,
      ) || 0;
    } catch {
      return 0;
    }
  }
}

// 「這個 post 所屬的群是否已在特別關注裡」。SQLite 沒有 `fold_component_root` ⇒ 查詢失敗時
// 回 `false`（＝當成新群），與 `countWatched()` 的退化口徑一致：沒有分組鍵就無法判同群。
export function watchedGroupHit(conn, userId, postId) {
  const uid = Number(userId) || 0;
  const pid = Number(postId) || 0;
  if (!uid || !pid) return false;
  try {
    return Boolean(conn.prepare(WATCHED_GROUP_HIT_SQL).get(pid, uid)?.hit);
  } catch {
    return false;
  }
}

export function canAddWatch(conn, userId, actor = {}, { alreadyWatched = false, postId = 0 } = {}) {
  return watchGateVerdict({
    limit: watchLimitForActor(actor),
    count: countWatched(conn, userId),
    alreadyWatched,
    groupHit: watchedGroupHit(conn, userId, postId),
  });
}
