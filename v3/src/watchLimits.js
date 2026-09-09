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

export function countWatched(conn, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return 0;
  try {
    return Number(
      conn.prepare(
        "SELECT COUNT(*) AS n FROM user_listing_flags WHERE user_id = ? AND watched = 1",
      ).get(uid)?.n,
    ) || 0;
  } catch {
    return 0;
  }
}

export function canAddWatch(conn, userId, actor = {}, { alreadyWatched = false } = {}) {
  if (alreadyWatched) return { ok: true, limit: watchLimitForActor(actor), count: countWatched(conn, userId) };
  const limit = watchLimitForActor(actor);
  const count = countWatched(conn, userId);
  if (!limit) return { ok: true, limit: 0, count };
  if (count >= limit) return { ok: false, limit, count, error: watchLimitMessage(limit) };
  return { ok: true, limit, count };
}
