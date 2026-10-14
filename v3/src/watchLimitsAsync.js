// 特別關注額度（`countWatched`）的 driver-aware 入口（PG 島嶼，2026-09-28，第五十四批）。
//
// 為什麼需要：`countWatched()` 是 **12 條路由**的卡點（後台會員列表、`/api/listings`、
// `/api/settings`、`/api/state` 的 `watchedTotal`…），它只是「這個人目前佔用幾筆額度」。
// 同步版讀節點本機的 `user_listing_flags` ＋ `listings`；PG 模式下那是別的節點的資料
// ⇒ 額度判斷會用錯的數字（會員可能被擋下、或超額加入）。
//
// ⚠️ `WATCHED_COUNT_SQL` 裡有 `IFNULL`（SQLite 語法）：PG 路徑一定要經過 `toPostgresSql()`
// 轉成 `COALESCE`（`sqlDialect.js` 有這條規則），不要自己再抄一份 SQL——抄了就會漂移，
// 而 `repository/listingStats.js` 的 `watchedTotal` 用的正是同一句。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { WATCHED_COUNT_SQL, WATCHED_COUNT_SQL_LEGACY, WATCHED_GROUP_HIT_SQL, countWatched as countWatchedSync, foldColumnDeployed, watchedGroupHit as watchedGroupHitSync } from "./watchLimits.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

async function run(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = options.exec;
      return await runPostgres(async (sql, params = []) => rowsOf(await injected(sql, params)));
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    return await runPostgres(async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return runSqlite();
  }
}

// `watchLimits.countWatched(conn, userId)` 的 PG 版。
// ⚠️ 同步版在查詢失敗時會退回「不算離線確認」的簡化版；PG 版刻意**不**退那一版
// （那只會讓額度算得更鬆），失敗就照 fail-open 政策回本機。
//
// Owner 2026-10-14 的群去重需要 `listings.fold_component_root`。那一欄只跟著 migration 007
// （PG；SQLite 一向沒有、CI 的拋棄式 PG 也沒有、正式庫目前亦尚未部署）⇒ **先用目錄探測問
// 「欄位在不在」再決定送哪一句**（`foldColumnDeployed()`；理由見 `watchLimits.js` 的說明：
// 在 PG 交易裡「先失敗再退回」會把整條交易 abort，連舊口徑都送不出去）。
// 沒有這一欄時退回不去重的舊口徑（`WATCHED_COUNT_SQL_LEGACY`，也就是改動前的那一句），
// 而不是讓額度變成 0 筆（那會 fail-open 成「無限關注」）。
async function countWatchedVia(exec, uid) {
  if (await foldColumnDeployed(exec)) {
    return Number(one(await exec(WATCHED_COUNT_SQL, [uid]))?.n) || 0;
  }
  return Number(one(await exec(WATCHED_COUNT_SQL_LEGACY, [uid]))?.n) || 0;
}

export async function countWatchedAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return 0;
  // 批次預取（2026-10-11 後台會員列表事故）：呼叫端已經用 `countWatchedBatchAsync()` 把整頁算完，
  // 這裡直接取用，**不再一個人發一條查詢**。沒帶 `memberBatch` 的既有呼叫端行為完全不變。
  const prefetched = options.memberBatch?.watchCount?.get(uid);
  if (prefetched !== undefined) return prefetched;
  // ⚠️ 這裡的 `exec` 是**裸陣列**（本模組的 runner 約定，與 `usersAsync` 的 `{rows}` 不同）；
  // 寫成 `(...).rows` 會拿到 undefined ⇒ 永遠回 0（實測中過一次，靠對照組才看出來）。
  return run(options, (exec) => countWatchedVia(exec, uid),
    () => countWatchedSync(sqliteHandle(), uid));
}

// `watchLimits.watchedGroupHit(conn, userId, postId)` 的 PG 版：這一個 post 所屬的疑似同屋源群
// 是否已在特別關注裡（Owner 2026-10-14 的群去重規則；SQL 文字共用 `watchLimits.js` 那一句）。
// SQLite 分支沿用同步版——沒有 `fold_component_root` 時它會回 `false`（＝當成新群）；
// PG 分支同理：探測說欄位不在 ⇒ 沒有分組鍵 ⇒ 一律當新群（維持改動前的行為）。
export async function watchedGroupHitAsync(userId, postId, options = {}) {
  const uid = Number(userId) || 0;
  const pid = Number(postId) || 0;
  if (!uid || !pid) return false;
  return run(options, async (exec) => {
    if (!(await foldColumnDeployed(exec))) return false;
    return Boolean(one(await exec(WATCHED_GROUP_HIT_SQL, [pid, uid]))?.hit);
  }, () => watchedGroupHitSync(sqliteHandle(), uid, pid));
}

// ---------------------------------------------------------------------------
// 批次版（2026-10-11 事故）：整頁會員的關注數一次算完。
//
// 事故：後台「會員管理」原本是「每位會員各一條 COUNT」並發送出（28 人 ⇒ 84 條），把 app 端
// PG 連線池抽乾，5 秒後 `timeout exceeded when trying to connect`。這裡把「N 條」收成「1 條」
// （`GROUP BY user_id`），查詢數與人數脫鉤。
//
// ⚠️ 批次 SQL 由**同一份** `WATCHED_COUNT_SQL` 推導（`watchLimits.js` 的那一句），不另抄一份：
// 抄一份就會漂移，而 `repository/listingStats.js` 的 `watchedTotal` 用的也是同一句。
// Owner 2026-10-14：使用量改成「疑似同屋源的群整群算 1 次」⇒ 批次版的 select 也必須是
// `COUNT(DISTINCT COALESCE(l.fold_component_root, f.post_id))`（後台每會員的使用量欄同一口徑）。
// `?` 佔位符由 runner 的 `toPostgresSql()` 轉成 `$1..$n`（SQLite 直接吃）。
const marks = (count) => Array.from({ length: count }, () => "?").join(",");
export const WATCHED_COUNT_GROUP_EXPR = "COUNT(DISTINCT COALESCE(l.fold_component_root, f.post_id)) AS n";
const WATCHED_COUNT_ONE_SELECT = `SELECT ${WATCHED_COUNT_GROUP_EXPR}`;
const WATCHED_COUNT_ONE_WHERE = "f.user_id = ?";

export function watchedCountBatchSql(count) {
  const size = Math.max(0, Number(count) || 0);
  if (!size || !WATCHED_COUNT_SQL.includes(WATCHED_COUNT_ONE_SELECT) || !WATCHED_COUNT_SQL.includes(WATCHED_COUNT_ONE_WHERE)) {
    throw new Error(
      "watchedCountBatchSql：WATCHED_COUNT_SQL 的形狀變了，批次版必須跟著改（不要另外抄一份 SQL）",
    );
  }
  return `${WATCHED_COUNT_SQL
    .replace(WATCHED_COUNT_ONE_SELECT, `SELECT f.user_id AS user_id, ${WATCHED_COUNT_GROUP_EXPR}`)
    .replace(WATCHED_COUNT_ONE_WHERE, `f.user_id IN (${marks(size)})`)}
         GROUP BY f.user_id`;
}

// 欄位未部署時的批次版（同樣由 `WATCHED_COUNT_SQL_LEGACY` 推導，不另抄一份）：
// 一整頁仍然只有一條查詢（2026-10-11 連線池事故的回歸條件不因為退化路徑而放寬）。
const LEGACY_ONE_SELECT = "SELECT COUNT(*) AS n";
export function watchedCountBatchSqlLegacy(count) {
  const size = Math.max(0, Number(count) || 0);
  if (!size || !WATCHED_COUNT_SQL_LEGACY.includes(LEGACY_ONE_SELECT) || !WATCHED_COUNT_SQL_LEGACY.includes(WATCHED_COUNT_ONE_WHERE)) {
    throw new Error(
      "watchedCountBatchSqlLegacy：WATCHED_COUNT_SQL_LEGACY 的形狀變了，批次版必須跟著改（不要另外抄一份 SQL）",
    );
  }
  return `${WATCHED_COUNT_SQL_LEGACY
    .replace(LEGACY_ONE_SELECT, "SELECT f.user_id AS user_id, COUNT(*) AS n")
    .replace(WATCHED_COUNT_ONE_WHERE, `f.user_id IN (${marks(size)})`)}
         GROUP BY f.user_id`;
}

// 回傳 `Map<userId, count>`（沒查到的會員 = 0 筆）。空清單**不發查詢**。
// 非 PG 分支逐人走同步版（後台列表在 SQLite 站根本不走這條，留著是為了讓這個函式自己站得住）。
export async function countWatchedBatchAsync(userIds, options = {}) {
  const ids = [...new Set((userIds || []).map((id) => Number(id) || 0).filter(Boolean))];
  const counts = new Map();
  if (!ids.length) return counts;
  await run(options, async (exec) => {
    // 探測結果決定送哪一句（見 `countWatchedVia()`）；一整頁仍然只有一條查詢，退化路徑也一樣。
    const sql = (await foldColumnDeployed(exec))
      ? watchedCountBatchSql(ids.length)
      : watchedCountBatchSqlLegacy(ids.length);
    for (const row of await exec(sql, ids)) {
      counts.set(Number(row.user_id), Number(row.n) || 0);
    }
  }, () => {
    for (const id of ids) counts.set(id, countWatchedSync(sqliteHandle(), id));
    return null;
  });
  // 沒被查到的會員（0 筆額度）也要**明確**留在 Map 裡：預取端用 `undefined` 當「沒有預取」，
  // 漏掉的話那個人又會退回一人一條查詢，查詢數就隨人數成長（這裡就是修正前的病）。
  for (const id of ids) if (!counts.has(id)) counts.set(id, 0);
  return counts;
}
