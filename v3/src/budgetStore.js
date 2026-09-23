// provider／budget 這個 store 的統一入口（形狀同 jobQueue.createJobQueue：async 介面、兩個 driver）。
//
// 為什麼需要它：這個 store 的**讀與寫必須一起換 driver**——`saveProviderConfig`（寫）與
// `loadEnabledProvider`（讀）是同一個 store，只換一半會變成「管理介面寫本機 SQLite、判斷讀 PG」，
// LLM／爬蟲洞察會被**靜默**判定成未啟用（沒有錯誤訊息，功能就是不跑）。
//
//   sqlite   - budgetGuard.js 的同步函式，行為完全不變（正式站預設）
//   postgres - budgetGuardAsync.js（語句來自 repository/budgetGuard.js，交易走 withTransaction）
import * as pg from "./budgetGuardAsync.js";
import * as sync from "./budgetGuard.js";
import { resolveDbDriver } from "./dbDriver.js";

export function sqliteBudgetStore(sqliteDb) {
  return {
    driver: "sqlite",
    config: async (category) => sync.getProviderConfig(sqliteDb, category),
    loadEnabled: async (category) => sync.loadEnabledProvider(sqliteDb, category),
    hasCredentials: async (cfg) => sync.hasCredentials(sqliteDb, cfg),
    readCredential: async (cfg) => sync.readCredential(sqliteDb, cfg),
    publicConfig: async (category) => sync.publicProviderConfig(sqliteDb, category),
    listAdmin: async (args = {}) => sync.listProviderAdmin(sqliteDb, args),
    reserve: async (args) => sync.reserveBudget(sqliteDb, args),
    settle: async (reservation, usageMinor, args) => sync.settleBudget(sqliteDb, reservation, usageMinor, args),
    release: async (reservation, args) => sync.releaseBudget(sqliteDb, reservation, args),
    hold: async (reservation, args) => sync.holdBudget(sqliteDb, reservation, args),
    usageLog: async (row) => sync.writeUsageLog(sqliteDb, row),
    saveConfig: async (input, args) => sync.saveProviderConfig(sqliteDb, input, args),
    saveSiteBudget: async (input) => sync.saveSiteBudget(sqliteDb, input),
  };
}

export function postgresBudgetStore({ sqliteDb = null, options = {} } = {}) {
  return {
    driver: "postgres",
    config: (category) => pg.getProviderConfigAsync(sqliteDb, category, options),
    loadEnabled: (category) => pg.loadEnabledProviderAsync(sqliteDb, category, options),
    hasCredentials: (cfg) => pg.hasCredentialsAsync(sqliteDb, cfg, options),
    readCredential: (cfg) => pg.readCredentialAsync(sqliteDb, cfg, options),
    publicConfig: (category) => pg.publicProviderConfigAsync(sqliteDb, category, options),
    listAdmin: (args = {}) => pg.listProviderAdminAsync(sqliteDb, args, options),
    reserve: (args) => pg.reserveBudgetAsync(sqliteDb, args, options),
    settle: (reservation, usageMinor, args) => pg.settleBudgetAsync(sqliteDb, reservation, usageMinor, args, options),
    release: (reservation, args) => pg.releaseBudgetAsync(sqliteDb, reservation, args, options),
    hold: (reservation, args) => pg.holdBudgetAsync(sqliteDb, reservation, args, options),
    usageLog: (row) => pg.writeUsageLogAsync(sqliteDb, row, options),
    saveConfig: (input, args) => pg.saveProviderConfigAsync(sqliteDb, input, args, options),
    saveSiteBudget: (input) => pg.saveSiteBudgetAsync(sqliteDb, input, options),
    ensure: () => pg.ensureBudgetSchemaAsync(sqliteDb, options),
  };
}

// 依 driver 取得 store；沒給 sqliteDb 時用 bindBudgetDb() 綁定的那一個（db.js 開機時綁）。
export function budgetStore({ sqliteDb = null, options = {} } = {}) {
  const handle = sqliteDb || sync.getBoundBudgetDb();
  const driver = options.driver || resolveDbDriver();
  if (driver === "postgres") return postgresBudgetStore({ sqliteDb: handle, options });
  return sqliteBudgetStore(handle);
}