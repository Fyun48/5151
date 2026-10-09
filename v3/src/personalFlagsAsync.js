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
  copyUserFlagsForRelist,
  emptyFlags,
  loadFlagMap as loadFlagMapSync,
  loadFlags as loadFlagsSync,
  stampFlags,
} from "./personalFlags.js";
// setFlags() 在 db.js（personalFlags.js 只有 setUserListingFlags 等底層函式）。
// 2026-09-26 這裡曾誤寫成從 personalFlags.js 匯入，離線測試沒涵蓋本模組所以 CI 沒抓到，
// 是 build-production-image 的隔離 smoke 測試擋下來的（模組匯入錯誤會讓服務起不來）。
import {
  CLEARABLE_FLAG_COLUMNS,
  clearListingFlagsByUser as clearListingFlagsByUserDb,
  hideMany as hideManySync,
  setFlags as setFlagsSync,
} from "./db.js";
import { listingStatsAsync } from "./listingStatsAsync.js";
import { WRITE_PATH_SQL } from "./repository/writePath.js";
import { watchLimitForActor, watchLimitMessage } from "./watchLimits.js";
import { groupIdForPost } from "./listingGroupsAsync.js";
import { getListingAsync } from "./listingDetailAsync.js";
import { resolveDbDriver } from "./dbDriver.js";
// SQLite 分支需要 handle（同步版那些函式吃 `(conn, …)`）；與 `selfListingsAsync.js` 同一模式。
import { sqliteHandle } from "./db.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";

// 語句文字與 personalFlags.setUserListingFlags()／watchLimits.countWatched()／
// listingGroups.bindWatchToGroup() 逐字相同。
// `loadFlags()` 的語句（同步版逐字相同）。
export const FLAGS_BY_USER_POST_SQL = "SELECT * FROM user_listing_flags WHERE user_id = ? AND post_id = ?";
// `loadFlagMap()` 的語句（同步版逐字相同）。
export const FLAGS_BY_USER_SQL = "SELECT * FROM user_listing_flags WHERE user_id = ?";
// `copyUserFlagsForRelist()` 的來源查詢（同步版逐字相同）：讀某個 post_id 的所有會員旗標。
const FLAGS_BY_POST_SQL = "SELECT * FROM user_listing_flags WHERE post_id = ?";
const COUNT_WATCHED_SQL = "SELECT COUNT(*) AS n FROM user_listing_flags WHERE user_id = ? AND watched = 1";
const SET_WATCH_GROUP_SQL = "UPDATE user_listing_flags SET watch_group_id = ? WHERE user_id = ? AND post_id = ?";
const USER_BY_EMAIL_SQL = "SELECT id, role, plan FROM users WHERE email = ? LIMIT 1";
const USER_BY_ID_SQL = "SELECT id, role, plan FROM users WHERE id = ? LIMIT 1";

// 🚨 注入式 `exec` 的形狀要正規化成**裸陣列**（這個模組的 runner 約定），
// 否則呼叫端傳 `{ rows, rowCount }` 時 `for (const row of rows)` 會炸成
// `object is not iterable`——第八次踩到「exec 形狀」，這次是 `sourceHistoryAsync` 的夾具抓到的。
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

async function pgExec(options = {}) {
  if (options.exec) {
    const injected = options.exec;
    return async (sql, params = []) => rowsOf(await injected(sql, params));
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

async function runInTransaction(options, fn) {
  if (options.exec) {
    const injected = options.exec;
    return fn(async (sql, params = []) => rowsOf(await injected(sql, params)));
  }
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

// db.js hideMany() 的 PG 分支。與同步版逐條對應：去重、過濾無效 id、
// **在單一交易內**逐筆設為 hidden，最後回傳 { count, stats }。
// 注意：setFlags() 內部也會呼叫 runInTransaction，但這裡把 exec 傳進去，
// 所以它會沿用同一個交易，不會另外開一層。
// id 正規化（與 db.js hideMany() 內的規則相同）：去重、只留 > 0 的有限數字。
// 抽成純函式是為了能單獨測試——交易與 stats 那段需要較重的夾具。
export function normalizeHideIds(ids) {
  return [...new Set((ids || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))];
}

export async function hideMany(ids, userId, options = {}) {
  const list = normalizeHideIds(ids);
  const uid = await resolveUserId(options.exec || (await pgExec(options)), userId);
  await runInTransaction(options, async (exec) => {
    for (const id of list) {
      await setFlags(id, { hidden: true }, uid, { ...options, exec });
    }
  });
  // stats 要在交易之外算：交易提交後原本的 tx 已經不能再用。
  return { count: list.length, stats: await listingStatsAsync({ userId: uid }, options) };
}

export async function hideManyAsync(ids, userId, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") return hideManySync(ids, userId);
  return hideMany(ids, userId, options);
}

// db.js clearListingFlagsByUser() 的 PG 分支：整批歸零 watched／hidden 與其時間戳。
// 欄位名一律由白名單決定（不從外部字串拼進 SQL），與同步版共用 CLEARABLE_FLAG_COLUMNS。
export async function clearListingFlagsByUser(kind, userId, options = {}) {
  const column = CLEARABLE_FLAG_COLUMNS[String(kind)];
  if (!column) {
    const err = new Error("不支援的清除類型");
    err.status = 400;
    err.code = "BAD_FLAG_KIND";
    throw err;
  }
  const exec = options.exec || (await pgExec(options));
  const uid = await resolveUserId(exec, userId);
  const rows = await exec(
    `UPDATE user_listing_flags SET ${kind} = 0, ${column} = NULL WHERE user_id = $1 AND ${kind} = 1`,
    [uid],
  );
  const count = Array.isArray(rows) ? Number(rows[0]?.changes ?? rows.rowCount ?? 0) || 0 : 0;
  return { count, stats: await listingStatsAsync({ userId: uid }, options) };
}

export async function clearListingFlagsByUserAsync(kind, userId, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    // 同步路徑沿用 db.js 的入口（會自己解析預設使用者並附帶 stats），避免兩份 SQL。
    return clearListingFlagsByUserDb(kind, userId);
  }
  return clearListingFlagsByUser(kind, userId, options);
}

// ── 重刊旗標複製（`copyUserFlagsForRelist()`）────────────────────────────────
//
// db.js copyUserFlags() 的 driver-aware 版。原本只寫 `db`（節點本機 SQLite），
// 正式站 DB_DRIVER=postgres 時讀的是 PG ⇒ 這筆寫入落在沒人讀的本機庫（無聲孤島寫入）。
// PG 模式下：來源旗標從 PG 讀、目標也寫進 PG（同一份規則與語句）。**PG 失敗就往上丟**
// （fail-closed），不落回本機 SQLite——寫本機等於重現同一個 bug。
export async function copyUserFlagsAsync(fromPostId, toPostId, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return copyUserFlagsForRelist(sqliteHandle(), fromPostId, toPostId);
  }
  const fromId = Number(fromPostId) || 0;
  const toId = Number(toPostId) || 0;
  if (!fromId || !toId || fromId === toId) return 0;
  const exec = await pgExec(options);
  const rows = await exec(FLAGS_BY_POST_SQL, [fromId]);
  let copied = 0;
  for (const row of rows || []) {
    let flags;
    if (Number(row.hidden) || Number(row.viewed)) {
      flags = {
        hidden: true,
        viewed: true,
        watched: Boolean(Number(row.watched)),
        watch_note: row.watch_note || "",
      };
    } else if (Number(row.watched) || String(row.watch_note || "").trim()) {
      flags = { watched: Boolean(Number(row.watched)), watch_note: row.watch_note || "" };
    } else {
      continue;
    }
    const uid = Number(row.user_id) || 0;
    // 與同步版 setUserListingFlags() 同義：目標若已有這一列，就沿用它的時間戳再覆寫。
    const prev = one(await exec(FLAGS_BY_USER_POST_SQL, [uid, toId])) || emptyFlags();
    const next = stampFlags(prev, flags, new Date().toISOString());
    await exec(WRITE_PATH_SQL.upsertPersonalFlags, [
      uid,
      toId,
      int(next.viewed),
      int(next.watched),
      int(next.hidden),
      String(next.watchNote || ""),
      text(next.viewedAt),
      text(next.watchedAt),
      text(next.hiddenAt),
    ]);
    copied += 1;
  }
  return copied;
}

// ── 讀取（`loadFlags()`／`loadFlagMap()`）────────────────────────────────────
//
// 為什麼挑這兩支：它們各自只是一個 SELECT，卻是**13 條缺口路由**的共同卡點
// （`loadFlags` 9 條、`loadFlagMap` 8 條，重疊後 13 條）——以「卡點數 ÷ 影響路由數」
// 算是目前投報率最高的一組。
//
// ⚠️ `emptyFlags()` 是**純物件工廠**（同步版在查不到時回它），PG 版必須回同一個形狀，
// 否則 `overlayPersonal()` 那類呼叫端會拿到 undefined 欄位。

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// ⚠️ 這個模組的 `pgExec()` 回的是 **rows 陣列**（不是 `{ rows, rowCount }`）——
// 與 `demandAsync.js`／`wishOffersAsync.js` 的契約不同，所以 `one()` 直接吃它即可。

// `loadFlags()` 的 PG 版：查不到（或 uid／pid 為 0）回 `emptyFlags()`。
// 讀取維持 fail-open（與其他 PG 島嶼同政策）：PG 讀不到時退回本機 SQLite，
// 免得「PG 抖一下」被放大成「個人標記全部消失」。`strict` 可讓它往上丟（驗證用）。
export async function loadFlagsAsync(userId, postId, options = {}) {
  const uid = Number(userId) || 0;
  const pid = Number(postId) || 0;
  if (!uid || !pid) return emptyFlags();
  if (!isPg(options)) return loadFlagsSync(sqliteHandle(), uid, pid) || emptyFlags();
  try {
    const exec = await pgExec(options);
    return one(await exec(FLAGS_BY_USER_POST_SQL, [uid, pid])) || emptyFlags();
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return loadFlagsSync(sqliteHandle(), uid, pid) || emptyFlags();
  }
}

// `loadFlagMap()` 的 PG 版：回 `Map(post_id -> row)`，與同步版同一個形狀。
export async function loadFlagMapAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return new Map();
  if (!isPg(options)) return loadFlagMapSync(sqliteHandle(), uid);
  try {
    const exec = await pgExec(options);
    const map = new Map();
    for (const row of (await exec(FLAGS_BY_USER_SQL, [uid])) || []) map.set(Number(row.post_id), row);
    return map;
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return loadFlagMapSync(sqliteHandle(), uid);
  }
}
