// 個人旗標（收藏／隱藏／已看過）的 driver-aware 入口。
//
// sqlite   - db.js setFlags()（行為完全不變）。
// postgres - 同一條規則（personalFlags.stampFlags）與同一段語句
//            （repository/writePath.js 的 upsertPersonalFlags），改寫進 PG。
//
// 為什麼需要：站上顯示收藏／隱藏狀態時讀的是 PG 的 `user_listing_flags`
// （repository/decorationData.js 的 loadPersonalFlagMap），但會員按「收藏／隱藏」走的是
// db.js setFlags() → personalFlags.setUserListingFlags(db, …)，只寫回答那台節點的本機 SQLite。
// 讀 PG、寫 SQLite 的結果是：會員在 A 收藏的物件，輪到 B 回答時看不到；`watched` 額度
// （watchLimits）也是各台自己算。2026-09-26 實測 user_listing_flags 為 705／736／711。
import {
  adminEmailForUser,
  emptyFlags,
  stampFlags,
} from "./personalFlags.js";
// setFlags() 在 db.js（personalFlags.js 只有 setUserListingFlags 等底層函式）。
// 2026-09-26 這裡曾誤寫成從 personalFlags.js 匯入，離線測試沒涵蓋本模組所以 CI 沒抓到，
// 是 build-production-image 的隔離 smoke 測試擋下來的（模組匯入錯誤會讓服務起不來）。
import { setFlags as setFlagsSync } from "./db.js";
import { WRITE_PATH_SQL } from "./repository/writePath.js";
import { watchLimitForActor, watchLimitMessage } from "./watchLimits.js";
import { groupIdForPost } from "./listingGroupsAsync.js";
import { getListingAsync } from "./listingDetailAsync.js";
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";

// 語句文字與 personalFlags.setUserListingFlags()／watchLimits.countWatched()／
// listingGroups.bindWatchToGroup() 逐字相同。
const FLAGS_BY_USER_POST_SQL = "SELECT * FROM user_listing_flags WHERE user_id = ? AND post_id = ?";
const COUNT_WATCHED_SQL = "SELECT COUNT(*) AS n FROM user_listing_flags WHERE user_id = ? AND watched = 1";
const SET_WATCH_GROUP_SQL = "UPDATE user_listing_flags SET watch_group_id = ? WHERE user_id = ? AND post_id = ?";
const USER_BY_EMAIL_SQL = "SELECT id, role, plan FROM users WHERE email = ? LIMIT 1";
const USER_BY_ID_SQL = "SELECT id, role, plan FROM users WHERE id = ? LIMIT 1";

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

async function runInTransaction(options, fn) {
  if (options.exec) return fn(options.exec);
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return pgDriver.withTransaction(async (client) => {
    const tx = (sql, params = []) => client.query(toPostgresSql(sql), params).then((res) => res.rows);
    return fn(tx);
  });
}

function one(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

const int = (value) => (Number(value) ? 1 : 0);
const text = (value) => (value == null ? null : String(value));

// db.js resolveUserId() 的 PG 版：沒有傳 userId 時以同一個管理者 email 找預設使用者。
// 刻意**不**在 PG 模式建立使用者（同步版的 ensureUser 會寫入），找不到就明確失敗，
// 免得像 sync 版一樣偷偷在本機 SQLite 建一個 admin。
async function resolveUserId(exec, userId) {
  if (userId != null && Number(userId)) return Number(userId);
  const row = one(await exec(USER_BY_EMAIL_SQL, [adminEmailForUser()]));
  if (!row) throw new Error("PG 模式找不到預設管理者帳號，無法解析 userId");
  return Number(row.id) || 0;
}

async function countWatched(exec, uid) {
  try {
    return Number(one(await exec(COUNT_WATCHED_SQL, [uid]))?.n) || 0;
  } catch {
    // 與 watchLimits.countWatched() 相同：查詢失敗視為 0 筆，不讓收藏動作整個掛掉。
    return 0;
  }
}

// watchLimits.canAddWatch() 的 PG 版，規則完全相同。
function canAddWatch(limit, count, alreadyWatched) {
  if (alreadyWatched) return { ok: true, limit, count };
  if (!limit) return { ok: true, limit: 0, count };
  if (count >= limit) return { ok: false, limit, count, error: watchLimitMessage(limit) };
  return { ok: true, limit, count };
}

// db.js setFlags() 的 PG 分支。
export async function setFlags(postId, flags, userId, options = {}) {
  const uid = await resolveUserId(options.exec || (await pgExec(options)), userId);
  const listing = await getListingAsync(postId, uid, { ...options, driver: "postgres" });
  if (!listing) return null;

  const turningOn = flags && (flags.watched === true || flags.watched === 1);
  if (turningOn && !Number(listing.watched)) {
    const exec = await pgExec(options);
    const actor = one(await exec(USER_BY_ID_SQL, [uid])) || {};
    const limit = watchLimitForActor(actor);
    const gate = canAddWatch(limit, await countWatched(exec, uid), false);
    if (!gate.ok) {
      const err = new Error(gate.error);
      err.status = 409;
      err.code = "WATCH_LIMIT";
      err.limit = gate.limit;
      err.count = gate.count;
      throw err;
    }
  }

  return runInTransaction(options, async (exec) => {
    const prev = one(await exec(FLAGS_BY_USER_POST_SQL, [uid, Number(postId) || 0])) || emptyFlags();
    const next = stampFlags(prev, flags || {}, new Date().toISOString());
    await exec(WRITE_PATH_SQL.upsertPersonalFlags, [
      uid,
      Number(postId) || 0,
      int(next.viewed),
      int(next.watched),
      int(next.hidden),
      String(next.watchNote || ""),
      text(next.viewedAt),
      text(next.watchedAt),
      text(next.hiddenAt),
    ]);
    if (turningOn) {
      // listingGroups.bindWatchToGroup() 的 PG 版：把這一筆的關注綁到所屬群組。
      try {
        const gid = await groupIdForPost(exec, postId);
        if (gid) await exec(SET_WATCH_GROUP_SQL, [gid, uid, Number(postId) || 0]);
      } catch {
        // 與同步版相同：群組欄位不存在時不讓收藏失敗。
      }
    }
    return getListingAsync(postId, uid, { ...options, driver: "postgres" });
  });
}

// ---- driver-aware 入口 ----

export async function setFlagsAsync(postId, flags, userId, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") return setFlagsSync(postId, flags, userId);
  return setFlags(postId, flags, userId, options);
}
