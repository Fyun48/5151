// 租屋通知**讀取**的 driver-aware 入口（PG 島嶼，2026-09-28）。
//
// 這是第三十六批那份順序裡「第 2 步（通知寫入端）」的第一塊零件：`queueDeliveries()` 一開始
// 就要讀 `getRentalNotifyPrefs()`，所以先把它搬過來，寫入端才有東西可接。
//
// ⚠️ 這一支刻意**只做讀取**（prefs 的 SELECT）。通知事件與 delivery 的寫入是另一包，
// 混在一起做會讓這一包沒辦法單獨驗證。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import {
  RENTAL_SITE_TZ,
  defaultRentalNotifyPrefs,
  getRentalNotifyPrefs as getRentalNotifyPrefsSync,
} from "./rentalNotify.js";

// `rental_notify_prefs` 的主鍵是 `user_id`（單欄），所以鏡射沒有複合鍵的顧慮。
export const RENTAL_NOTIFY_PREFS_TABLES = ["rental_notify_prefs"];

export const PREFS_BY_USER_SQL = "SELECT * FROM rental_notify_prefs WHERE user_id = ?";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

const schemaReady = new WeakMap();
export async function ensureRentalNotifyPrefsOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = ensurePgSchema(pgDriver, sqliteHandle(), { tables: RENTAL_NOTIFY_PREFS_TABLES });
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
    await ensureRentalNotifyPrefsOnce(pgDriver);
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

// 列 → prefs 的轉換抽成純函式：兩個 driver 共用，布林轉換與預設值不可能漂移。
// （同步版是 `getRentalNotifyPrefs()` 內的那段；沒有列時回 `defaultRentalNotifyPrefs()`。）
export function prefsFromRow(row) {
  if (!row) return defaultRentalNotifyPrefs();
  return {
    lifecycle_reminder: Number(row.lifecycle_reminder) === 1,
    new_match: Number(row.new_match) === 1,
    offer_transactional: Number(row.offer_transactional) === 1,
    daily_digest: Number(row.daily_digest) === 1,
    channel_dock: Number(row.channel_dock) === 1,
    channel_mail: Number(row.channel_mail) === 1,
    channel_push: Number(row.channel_push) === 1,
    timezone: row.timezone || RENTAL_SITE_TZ,
  };
}

// `getRentalNotifyPrefs()` 的 PG 版：沒有設定列時回預設（與同步版同義）。
export async function getRentalNotifyPrefsAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  return withFallback(options, {}, async (run) => {
    const row = one((await run(PREFS_BY_USER_SQL, [uid])).rows);
    return prefsFromRow(row);
  }, () => getRentalNotifyPrefsSync(sqliteHandle(), uid));
}
