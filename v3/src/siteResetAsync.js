// 「清除物件紀錄／清除全部資料」的 driver-aware 入口（PG 島嶼，2026-09-29 第七十三批）。
//
// 涵蓋兩條管理員路由（都要 `confirm: true`）：
//   POST /api/reset-listings  → `resetListingsAsync()`
//   POST /api/reset-all       → `resetAllDataAsync()`
//
// 為什麼一定要有 PG 分支：同步版把 DELETE 全部下在**本機 SQLite**，PG 模式下管理員按下核彈按鈕後
// 站上（讀 PG）**什麼都沒清掉**，而畫面回「已清除」——最糟的是後台看起來成功了。
//
// 語句與設定補丁逐字沿用 `db.js` 的常數／純函式（`RESET_*_SQLS`／`RESET_LISTINGS_SETTINGS`／
// `resetAllSettingsPatch()`）：刪哪些表、刪的順序、設定要寫什麼都只有一份。
// SQLite 分支延遲載入 `db.js` 的同步版（行為完全不變）。
import { sqliteHandle } from "./db.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { ensurePgSchema } from "./pgSchema.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import {
  RESET_ALL_SQLS,
  RESET_LISTINGS_SETTINGS,
  RESET_LISTINGS_SQLS,
  resetAllSettingsPatch,
} from "./db.js";
import { saveSettingsAsync } from "./settingsAsync.js";
import { defaultUserIdAsync } from "./usersAsync.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// 這幾張表必須先存在才刪得掉（PG 端由這裡確保；SQLite 端是 schemaMigrations 的責任）。
const RESET_TABLES = Object.freeze([
  "events", "user_events", "user_listing_flags", "user_settings", "crawl_covers",
  "listings", "settings", "geo_cache", "route_cache", "community_cache",
]);

const schemaReady = new WeakMap();
async function ensureResetStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  // `indexes: false`：這裡只需要「表存在」，而且 SQLite 的表達式索引可能用了 PG 沒有的函式
  // （`instr(...)` 之類，`pg-integration-setup` 也是這樣跳過的）——建立索引失敗會讓整個清除失敗。
  const ready = ensurePgSchema(pgDriver, sqliteHandle(), { tables: RESET_TABLES, indexes: false });
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
  return ready;
}

// 刪除必須在**同一個交易**：同步版是 BEGIN/COMMIT，半途失敗要整批回滾（不然會留下
// 「 listings 清掉了、user_events 還在」這種半殘狀態）。
async function wipeInTransaction(options, statements) {
  // 注入式 exec（離線夾具）沒有交易：照同一條連線的順序跑——與其他島嶼同一個處置。
  if (options.exec) {
    for (const sql of statements) await options.exec(sql, []);
    return statements.length;
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  await ensureResetStoreOnce(pgDriver);
  return pgDriver.withTransaction(async (client) => {
    for (const sql of statements) await client.query(toPostgresSql(sql));
    return statements.length;
  });
}

async function runReset(options, { statements, settingsPatch, syncName }) {
  if (!isPg(options)) {
    const sync = await import("./db.js");
    return sync[syncName]();
  }
  try {
    await wipeInTransaction(options, statements);
    // 設定在刪除**之後**寫回（`settings` 本身也在刪除清單裡）。
    const uid = await defaultUserIdAsync({ ...options, driver: "postgres" });
    // 同步版 `saveSettings(partial)` 沒給 uid ⇒ 用預設使用者；`forceAdmin: true` 是因為
    // 這個補丁含站台層級的鍵（`dataEpoch`／`hasBaseline`…），而呼叫端已經驗過管理員身分。
    return await saveSettingsAsync({ ...settingsPatch }, uid, { forceAdmin: true, ...options });
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    const sync = await import("./db.js");
    return sync[syncName]();
  }
}

/** `db.js:resetListings()` 的 PG 版。 */
export async function resetListingsAsync(options = {}) {
  return runReset(options, {
    statements: RESET_LISTINGS_SQLS,
    settingsPatch: RESET_LISTINGS_SETTINGS,
    syncName: "resetListings",
  });
}

/** `db.js:resetAllData()` 的 PG 版。 */
export async function resetAllDataAsync(options = {}) {
  return runReset(options, {
    statements: RESET_ALL_SQLS,
    settingsPatch: resetAllSettingsPatch(),
    syncName: "resetAllData",
  });
}
