// `community_cache`（591 社區座標釘點快取）**讀取**的 driver-aware 入口（SQLite 退場 P1）。
//
// 為什麼要補這一支：寫入端 `setCommunityCacheAsync()`（`crawlerWrites.js`）早就存在，
// **讀取端卻只有同步版**（`db.js:getCommunityCache()`）⇒ 讀寫遷移不對稱。唯二的呼叫者是
// watcher 的 591 座標補齊路徑：
//   • `ingestListingGeo()`（`watcher.js:375`）—— 每一筆 591 物件都會問一次「這個社區釘過沒」；
//   • 591 詳情的 `detailOptions().getCommunity`（`watcher.js:316` → `client591.js:424`）。
//
// PG 模式下那兩個地方讀的是**節點本機** SQLite（站上讀的是 PG），開閘
// （`PG_NO_SQLITE_OPEN=1`）時直接拋 `business SQLite is closed`；`ingestListingGeo()` 那條
// 是**未捕捉的 rejection，會把 worker 打掛**（正式站 `591-tracker-v3` 2026-10-10 實測，
// 24 小時 1 次，stack 為 `db.js:8724 → watcher.js:375 → pool.js worker`）。
//
// 形狀照既有島嶼（`geoCacheAsync.js`／`dataRevisionAsync.js`）：driver 判斷 ＋ 注入式 `exec`
// ／共用連線；SQLite 分支走同步版。
//
// 快取政策與其他島嶼相同：**讀取 fail-open**（回舊資料勝過整個站 500），但開閘後沒有可用的
// 本機 handle 時**不回退**——回退只會丟出更難懂的「business SQLite is closed」，把真正的
// PG 錯誤蓋掉（`demandAsync.js:188`／`dataRevisionAsync.js:96` 同一個慣例）。
//
// ⚠️ 語句與回傳形狀都共用 `db.js` 的那一份（`COMMUNITY_CACHE_SELECT_SQL`／
// `communityCacheFromRow()`），所以兩個 driver 不可能漂移：`id`／`name`／`address` 是原值，
// `lat`／`lng` 一定是 `Number` 或 `null`（0 與非數字＝沒有座標）。
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { sqliteHandleIsUsable } from "./sqliteHandle.js";
import {
  COMMUNITY_CACHE_SELECT_SQL,
  communityCacheFromRow,
  getCommunityCache as getCommunityCacheSync,
  sqliteHandle,
} from "./db.js";

export { COMMUNITY_CACHE_SELECT_SQL, communityCacheFromRow };

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// 注入式 `exec` 的形狀正規化（`settingsAsync.js`／`geoCacheAsync.js` 同一個坑）。
function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

async function withFallback(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    // 開閘（沒有可用的 SQLite handle）時不回退同步版：把 PG 的原始錯誤往上丟。
    if (!sqliteHandleIsUsable(sqliteHandle())) throw error;
    return runSqlite();
  }
}

// `db.js:getCommunityCache()` 的 PG 版。沒有這個 id／查不到都回 `null`（同步版同義）。
export async function getCommunityCacheAsync(communityId, options = {}) {
  const id = Number(communityId);
  if (!id) return null;
  return withFallback(
    options,
    async (run) => communityCacheFromRow(one((await run(COMMUNITY_CACHE_SELECT_SQL, [id])).rows)),
    () => getCommunityCacheSync(id),
  );
}
