// 租屋通知／分析的 driver-aware 入口（PG 島嶼，2026-09-28）。
//
// 為什麼從 `bumpAnalytics()` 開始：它是**9 條缺口路由**的卡點（`POST /api/demand`、
// `POST /api/wish-rooms`、`POST /api/self-listings`、`/verify-email`、
// `/auth/:provider/callback`、分享事件、問卷…），而本體只是**一句 upsert**。
// 這是「先搬投報率最高的那一支」的實例，也是狀態機那包的前置工作之一
// （見計畫文件第三十六批的依賴圖）。
//
// ⚠️ 這一支刻意**只做 `rental_analytics_daily`**。`rentalNotify.js` 整支 1199 行、
// 59 處 `db.prepare`，其餘（`emitRentalNotifyEvent`／`queueDeliveries`／`insertDelivery`）
// 是另一包；混在一起做會讓這一包沒辦法單獨驗證。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import { bumpAnalytics as bumpAnalyticsSync, taipeiDay } from "./rentalNotify.js";

// `rental_analytics_daily` 的主鍵是 `PRIMARY KEY (day, metric)`（複合）。
// 已實測 `pgSchema.createTableStatement()` 會逐字鏡射這一句（不是靠 `CREATE TABLE` 欄位
// 層級的 UNIQUE），所以 `ON CONFLICT(day, metric)` 在 PG 上有索引可用。
export const RENTAL_ANALYTICS_TABLES = ["rental_analytics_daily"];

// 語句與 `rentalNotify.js:491` 逐字相同；`ON CONFLICT(day, metric)` 兩邊都合法。
export const BUMP_ANALYTICS_SQL = `INSERT INTO rental_analytics_daily(day, metric, value) VALUES (?, ?, ?)
    ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value`;

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const schemaReady = new WeakMap();
export async function ensureRentalAnalyticsOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = ensurePgSchema(pgDriver, sqliteHandle(), { tables: RENTAL_ANALYTICS_TABLES });
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
}

async function withFallback(options, { write = false }, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureRentalAnalyticsOnce(pgDriver);
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

// `bumpAnalytics()` 的 PG 版：同一天同一指標累加，回傳值刻意與同步版一致（undefined）。
// 日界線用**同一支** `taipeiDay()`——時區規則不能有第二份實作。
export async function bumpAnalyticsAsync(metric, now = new Date(), n = 1, options = {}) {
  const day = taipeiDay(now);
  const value = Number(n) || 1;
  return withFallback(options, { write: true }, async (run) => {
    await run(BUMP_ANALYTICS_SQL, [day, String(metric), value]);
    return undefined;
  }, () => bumpAnalyticsSync(sqliteHandle(), metric, now, n));
}
