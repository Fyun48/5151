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
import { WATCHED_COUNT_SQL, countWatched as countWatchedSync } from "./watchLimits.js";

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
export async function countWatchedAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return 0;
  // ⚠️ 這裡的 `exec` 是**裸陣列**（本模組的 runner 約定，與 `usersAsync` 的 `{rows}` 不同）；
  // 寫成 `(...).rows` 會拿到 undefined ⇒ 永遠回 0（實測中過一次，靠對照組才看出來）。
  return run(options, async (exec) => Number(one(await exec(WATCHED_COUNT_SQL, [uid]))?.n) || 0,
    () => countWatchedSync(sqliteHandle(), uid));
}
