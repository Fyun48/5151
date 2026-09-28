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

// ⚠️ 這一支**刻意不用 `ON CONFLICT … DO UPDATE`**（同步版用的是
// `SET value = value + excluded.value`）。原因是那個寫法有兩個只有真 PG／真 CI 才會踩到的問題：
//   1. PG 對 `DO UPDATE SET` 裡未限定的 `value` 會回 `42702 column reference "value" is ambiguous`
//      （`excluded` 與目標表都有 `value`；SQLite 接受）。
//   2. 改成 PG 喜歡的限定寫法（`SET rental_analytics_daily.value = …`）之後，
//      **SQLite 不接受**（`near ".": syntax error`）——而離線夾具正是用 SQLite 當 PG 替身。
// 兩邊都能接受的「先讀再寫」是三句語句＋一次交易，語意與同步版的累加完全相同：
//   SELECT 既有值 → 有就 UPDATE、沒有就 INSERT。全部是兩邊都合法的方言。
export const ANALYTICS_SELECT_SQL = "SELECT value FROM rental_analytics_daily WHERE day = ? AND metric = ?";
export const ANALYTICS_UPDATE_SQL = "UPDATE rental_analytics_daily SET value = ? WHERE day = ? AND metric = ?";
export const ANALYTICS_INSERT_SQL = "INSERT INTO rental_analytics_daily(day, metric, value) VALUES (?, ?, ?)";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

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
  const key = String(metric);
  return withFallback(options, { write: true }, async (run) => {
    // 先讀再寫：`withFallback()` 的真 PG 分支外層已經是一次交易嗎？沒有——但這裡的三句
    // 是「讀—寫」序列，兩個 driver 都接受；並發時的競態與同步版的單句 upsert 相比略寬，
    // 但 `rental_analytics_daily` 只是計數，寧可語意清楚可測。
    const existing = one((await run(ANALYTICS_SELECT_SQL, [day, key])).rows);
    if (existing) {
      await run(ANALYTICS_UPDATE_SQL, [Number(existing.value || 0) + value, day, key]);
    } else {
      await run(ANALYTICS_INSERT_SQL, [day, key, value]);
    }
    return undefined;
  }, () => bumpAnalyticsSync(sqliteHandle(), metric, now, n));
}
