// 維運／CI 一次性腳本的「store 安全閥」（2026-09-30，第八十八批）。
//
// 背景（非路由入口盤點 §88.3）：這一類腳本原本假設「本機 SQLite 就是正式資料」。
// 正式站在 2026-09-29 切到 PostgreSQL（`DB_DRIVER=postgres`）之後：
//
//   1. **只吃 SQLite handle 的工具**會靜默寫進容器本機 `/data/v3.db`
//      （站上讀 PG ⇒ 等於沒生效），而 workflow 照樣回報成功。實例：
//      `activate-rental-marketplace-*-domain.mjs` 用 `mod.saveRentalMarketplaceFlags`，
//      它最後走到 `db.js:writeSettingKey()`，那支**沒有任何 driver 分支**。
//   2. **會寫 PG 的工具**（`pg-import`／`cutover-*`／`test:pg`／`pg-columns-ab`…）目標完全由
//      `PG_URL` 決定，指到正式庫就會寫正式庫（`pg-columns-ab` 甚至會插 500 筆假房源）。
//
// 這一支提供兩個 fail-closed 檢查，把「跑錯地方」變成看得見的錯誤；正式站既然已是 PG，
// 寧可拒絕執行也不要靜默寫錯 store。
//
// ⚠️ `.github/scripts/**` 內的同名檢查是**刻意內嵌**的複本：那些腳本是 `docker cp` 進
// 「目前已部署」的容器執行，而本檔要等下一次部署才會進到 `/app/src`，
// 直接 import 會讓現行部署的 workflow 以 ERR_MODULE_NOT_FOUND 失敗（那是更糟的錯誤訊息）。
// 兩邊的判定條件必須一致：`DB_DRIVER` 為 postgres／postgresql／pg。
import { resolveDbDriver } from "./dbDriver.js";

/** 允許 CLI 工具直接寫入的資料庫名稱（與 live PG 測試同一組）。 */
export const ALLOWED_PG_TARGET_DBS = Object.freeze(["repro", "tracker_test", "repro2"]);

/** 要對清單外的資料庫動手時，必須明確設定這個環境變數。 */
export const PG_TARGET_OVERRIDE_ENV = "ALLOW_PRODUCTION_PG_TARGET";

export function driverOf(env = process.env) {
  return resolveDbDriver(env);
}

/** 從 PG 連線字串取出資料庫名稱（取不到就回空字串，呼叫端一律 fail-closed）。 */
export function databaseNameFromUrl(url) {
  try {
    return new URL(String(url || "")).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

/**
 * 「只支援 SQLite 模式」的工具守衛：PG 模式下直接拒絕執行。
 *
 * @param {string} tool 工具名稱（會出現在錯誤訊息裡）
 * @param {{env?: NodeJS.ProcessEnv, hint?: string}} [opts] `hint` 是給操作者的替代做法
 */
export function assertSynchronousDomainTool(tool, { env = process.env, hint = "" } = {}) {
  if (driverOf(env) !== "postgres") return;
  const extra = hint ? ` 替代做法：${hint}` : "";
  throw new Error(
    `${tool}：只支援 SQLite 模式（目前 DB_DRIVER=postgres）。這個工具用同步 SQLite handle 讀寫，`
    + `在 PG 模式下只會寫進容器本機 v3.db（站上讀 PG ⇒ 等於沒生效，但流程會回報成功）。`
    + `${extra}`,
  );
}

/**
 * 「會寫 PG」的工具守衛：目標資料庫必須在允許清單內。
 *
 * @param {string} tool 工具名稱
 * @param {string} url PG 連線字串（通常是 PG_URL／PG_TEST_URL／PG_LIVE_REPRO_URL）
 * @param {{env?: NodeJS.ProcessEnv, allow?: readonly string[]}} [opts]
 * @returns {string} 解析出來的資料庫名稱（方便呼叫端寫進 log）
 */
export function assertPgTargetAllowed(tool, url, { env = process.env, allow = ALLOWED_PG_TARGET_DBS } = {}) {
  const db = databaseNameFromUrl(url);
  if (!db) {
    throw new Error(`${tool}：PG_URL 看不出資料庫名稱，拒絕執行（不猜目標）`);
  }
  if (allow.includes(db)) return db;
  if (String(env[PG_TARGET_OVERRIDE_ENV] || "").trim() === "1") return db;
  throw new Error(
    `${tool}：目標資料庫 "${db}" 不在允許清單（${allow.join("／")}）。`
    + `這個工具會直接寫入目標庫；確定要對 "${db}" 執行請設 ${PG_TARGET_OVERRIDE_ENV}=1。`,
  );
}
