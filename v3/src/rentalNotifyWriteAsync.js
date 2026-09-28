// 租屋通知**寫入**的 driver-aware 入口（PG 島嶼，2026-09-28）。
//
// 這是第三十六批那份順序的第 2 步主體：`emitRentalNotifyEvent()` ＋ `queueDeliveries()` ＋
// `insertDelivery()`。`accept`／`block` 兩條路由之後要靠它（它們成功後會發通知）。
//
// 重用（不重寫）：
//   - `preferenceAllows()`／`channelAllowed()`：**政策**判斷，與 driver 無關（本輪匯出）
//   - `safePayload()`：payload 的 PII 過濾（同一支）
//   - `currentRentalNotifyFlags()`：旗標快取（同一份）
//   - `isRentalDigestEnabled()`／`isRentalNotificationsEnabled()`：純函式
//   - `getRentalNotifyPrefsAsync()`：prefs 讀取（上一輪完成）
//   - `bumpAnalyticsAsync()`：計數（上上輪完成）
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import {
  RENTAL_NOTIFY_CHANNELS,
  RENTAL_NOTIFY_EVENT_TYPES,
  channelAllowed,
  currentRentalNotifyFlags,
  preferenceAllows,
  safePayload,
} from "./rentalNotify.js";
import { isRentalDigestEnabled, isRentalNotificationsEnabled } from "./rentalMarketplaceFlags.js";
import { BUMP_ANALYTICS_PG_SQL, bumpAnalyticsAsync } from "./rentalAnalyticsAsync.js";
import { getRentalNotifyPrefsAsync } from "./rentalNotifyReadsAsync.js";

export const RENTAL_NOTIFY_TABLES = ["rental_notify_events", "rental_notify_deliveries", "rental_notify_prefs"];

// ⚠️ `UNIQUE(event_id, channel)` 與 `event_key` UNIQUE 是 **SQLite 的表約束／索引**：
// `pgSchema` 鏡射 `sqlite_master.sql` 時，**表約束那種隱式索引抓不到**（本系列已中過四次）。
// 所以除了鏡射建表，還要自己補這兩條 unique index——沒有它們，PG 上的去重語意會整個失效
// （同一事件會重複發通知，而且不會有任何錯誤）。
// 已先查過正式影子庫：兩張表在 PG 上都只有 pkey，
// 且 `(event_id, channel)` 目前 **0 筆重複** ⇒ 補索引不會失敗。
export const RENTAL_NOTIFY_UNIQUE_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS rental_notify_events_event_key_key ON rental_notify_events(event_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS rental_notify_deliveries_event_channel_key ON rental_notify_deliveries(event_id, channel)",
];

export const EVENT_INSERT_SQL = `INSERT INTO rental_notify_events(event_key, event_type, user_id, subject_type, subject_ref, listing_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
// `emitRentalNotifyEventAsync()` 專用：去重靠 ON CONFLICT，不靠例外。
export const EVENT_INSERT_IGNORE_SQL = `INSERT INTO rental_notify_events(event_key, event_type, user_id, subject_type, subject_ref, listing_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING`;
export const EVENT_BY_KEY_SQL = "SELECT * FROM rental_notify_events WHERE event_key = ?";
export const EVENT_BY_ID_SQL = "SELECT * FROM rental_notify_events WHERE id = ?";
// 同理：`(event_id, channel)` 撞唯一鍵時要忽略（同步版靠 UNIQUE 例外吞掉）。
export const DELIVERY_INSERT_SQL = `INSERT INTO rental_notify_deliveries(event_id, user_id, channel, status, attempt, next_retry_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, '', ?, ?) ON CONFLICT(event_id, channel) DO NOTHING`;

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
const iso = (now = new Date()) => (now instanceof Date ? now : new Date(now || Date.now())).toISOString();

const schemaReady = new WeakMap();
export async function ensureRentalNotifyWriteOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = (async () => {
    await ensurePgSchema(pgDriver, sqliteHandle(), { tables: RENTAL_NOTIFY_TABLES });
    for (const sql of RENTAL_NOTIFY_UNIQUE_INDEXES) await pgDriver.exec(sql);
  })();
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

  // ⚠️ 巢狀的 analytics 呼叫也要挑對語句：這一條路徑**沒有注入 exec**（真 PG），
  // 所以要用限定表名的那一句；用錯會得到
  // `column reference "value" is ambiguous`（CI 實測）。
  // 沒有指定時由 `withFallback()` 依路徑選，所以只在真 PG 這條補上。
  const nested = options.exec ? options : { ...options, sql: BUMP_ANALYTICS_PG_SQL };
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureRentalNotifyWriteOnce(pgDriver);
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

// `insertDelivery()` 的 PG 版：狀態與重試時間的規則與同步版逐字相同
// （`queued` 才給 next_retry_at；`(event_id, channel)` 重複就忽略）。
export async function insertDeliveryAsync(run, event, channel, status, now) {
  const stamp = iso(now);
  const res = await run(DELIVERY_INSERT_SQL, [
    event.id, event.user_id, channel, status, status === "queued" ? stamp : null, stamp, stamp,
  ]);
  // PG 用 `ON CONFLICT DO NOTHING` 等價於 SQLite 的 UNIQUE 例外吞掉：
  // 這裡靠 rowCount 判斷是否真的寫入，不依賴例外訊息。
  return Number(res?.rowCount) > 0;
}

// `queueDeliveries()` 的 PG 版：政策判斷全部重用同步版的純函式。
export async function queueDeliveriesAsync(run, event, now = new Date(), options = {}) {
  // 同 `emitRentalNotifyEventAsync()`：真 PG 路徑要帶限定語句給巢狀的 analytics 呼叫。
  const nested = options.exec ? options : { ...options, sql: BUMP_ANALYTICS_PG_SQL };
  const flags = currentRentalNotifyFlags();
  const prefs = await getRentalNotifyPrefsAsync(event.user_id, { ...options, exec: options.exec, driver: "postgres" });
  if (!preferenceAllows(prefs, event.event_type)) {
    await insertDeliveryAsync(run, event, "dock", "suppressed", now);
    await bumpAnalyticsAsync("notify_suppressed", now, 1, { ...nested, driver: "postgres" });
    return;
  }
  for (const channel of RENTAL_NOTIFY_CHANNELS) {
    if (!channelAllowed(prefs, channel, flags)) {
      await insertDeliveryAsync(run, event, channel, "suppressed", now);
      await bumpAnalyticsAsync("notify_suppressed", now, 1, { ...nested, driver: "postgres" });
      continue;
    }
    if (event.event_type === "owner_new_match_available" && channel !== "dock" && !isRentalDigestEnabled(flags)) {
      await insertDeliveryAsync(run, event, channel, "suppressed", now);
      await bumpAnalyticsAsync("notify_suppressed", now, 1, { ...nested, driver: "postgres" });
      continue;
    }
    await insertDeliveryAsync(run, event, channel, "queued", now);
    await bumpAnalyticsAsync("notify_queued", now, 1, { ...nested, driver: "postgres" });
  }
}

// `emitRentalNotifyEvent()` 的 PG 版：旗標／事件白名單／去重／發送佇列，規則逐條相同。
export async function emitRentalNotifyEventAsync({
  eventType,
  userId,
  eventKey,
  subjectType = "",
  subjectRef = "",
  listingId = null,
  payload = {},
  now = new Date(),
  queue = true,
} = {}, options = {}) {
  const flags = currentRentalNotifyFlags();
  if (!isRentalNotificationsEnabled(flags)) return { emitted: false, reason: "flag_off" };
  if (!RENTAL_NOTIFY_EVENT_TYPES.includes(eventType)) return { emitted: false, reason: "unknown_type" };
  const uid = Number(userId) || 0;
  if (!uid) return { emitted: false, reason: "no_user" };
  const key = String(eventKey || `${eventType}:${uid}:${subjectRef}`).slice(0, 240);
  const stamp = iso(now);
  // 真 PG 路徑的巢狀 analytics 呼叫要帶限定語句（見檔頭說明）。
  const nested = options.exec ? options : { ...options, sql: BUMP_ANALYTICS_PG_SQL };

  return withFallback(options, { write: true }, async (run) => {
    // ⚠️ PG 版**不能**靠捕捉 UNIQUE 例外（同步版是那樣做）：PG 一撞唯一鍵整筆交易就進
    // aborted 狀態，後續語句全部失敗。所以用 `ON CONFLICT(event_key) DO NOTHING`，
    // 再以 `rowCount === 0` 判斷是去重。效果與同步版相同，但不依賴例外。
    const res = await run(EVENT_INSERT_IGNORE_SQL, [
      key, eventType, uid, subjectType, String(subjectRef || ""), listingId,
      JSON.stringify(safePayload(payload)), stamp,
    ]);
    const inserted = Number(res?.rowCount) > 0;
    if (!inserted) {
      // 去重（event_key 已存在）：同步版會記一筆 notify_deduped 並回 deduped。
      await bumpAnalyticsAsync("notify_deduped", now, 1, { ...nested, driver: "postgres" });
      const existing = one((await run(EVENT_BY_KEY_SQL, [key])).rows);
      return { emitted: false, reason: "deduped", event_key: key, event_id: existing?.id || 0 };
    }
    const event = one((await run(EVENT_BY_KEY_SQL, [key])).rows);
    await bumpAnalyticsAsync("notify_generated", now, 1, { ...nested, driver: "postgres" });
    if (queue !== false) await queueDeliveriesAsync(run, event, now, options);
    return { emitted: true, event_id: event?.id, event_key: key };
  }, async () => (await import("./rentalNotify.js")).emitRentalNotifyEvent(sqliteHandle(), {
    eventType, userId, eventKey, subjectType, subjectRef, listingId, payload, now, queue,
  }));
}
