// Ops 遞送 worker 與後台控制項的 driver-aware 入口（PG 島嶼，2026-09-28，第五十七批）。
//
// 涵蓋的路由：`GET /api/admin/ops-delivery`、`PUT /api/admin/ops-delivery`、
// `POST /api/admin/ops-delivery/compact-outbox`，以及**伺服器啟動時的遞送 worker**。
//
// 🚨 **這一支要修的是整個遷移案最嚴重的靜默失效**：worker 讀寫的是節點本機的
// `feedback_outbox`，而 PG 模式下 `POST /api/feedback` 會把事件寫進 PG
// ⇒ **PG 的佇列永遠沒有人送**（事件躺在 pending，沒有任何錯誤）。
//
// 🚨 **`ops_feedback_stop` 是「原生字串」鍵**（交接紀律第 11 條）：`isLocalDeliveryStopped()`
// 比對的是原始文字 `"1"`，不是 JSON。所以這裡**不能**用 `settingsKvAsync`
// （它會 `JSON.stringify` ⇒ 存成 `"\"1\""` ⇒ 開關永遠失效而且沒有錯誤）。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import {
  OPS_DELIVERY_STOP_KEY,
  deliveryControl as deliveryControlSync,
  isLocalDeliveryStopped as isLocalDeliveryStoppedSync,
  setLocalDeliveryStopped as setLocalDeliveryStoppedSync,
  startDeliveryLoopWithStore,
} from "./opsDelivery.js";
import {
  claimOutboxBatchAsync,
  markOutboxFailureAsync,
  markOutboxSentAsync,
  outboxCapacityAlertAsync,
  outboxStatsAsync,
} from "./feedbackOutboxAsync.js";

export const STOP_SELECT_SQL = "SELECT value FROM settings WHERE key = ?";
export const STOP_UPSERT_SQL =
  "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

async function withFallback(options, runPostgres, runSqlite, { write = false } = {}) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = options.exec;
      return await runPostgres(async (sql, params = []) => rowsOf(await injected(sql, params)));
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    return await runPostgres(async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, write ? { write: true } : {})) throw error;
    return runSqlite();
  }
}

// `opsDelivery.isLocalDeliveryStopped(db)` 的 PG 版：**原始文字**比對 `"1"`。
export async function isLocalDeliveryStoppedAsync(options = {}) {
  return withFallback(options, async (exec) => {
    const row = one(await exec(STOP_SELECT_SQL, [OPS_DELIVERY_STOP_KEY]));
    return String(row?.value || "") === "1";
  }, () => isLocalDeliveryStoppedSync(sqliteHandle()));
}

// `setLocalDeliveryStopped(db, stopped)` 的 PG 版：存**原始字串** `"1"`／`"0"`，
// 而且在本機鏡射一份（還沒移植的同步讀者 `deliveryControl(db)` 還在讀本機）。
export async function setLocalDeliveryStoppedAsync(stopped, options = {}) {
  const value = stopped ? "1" : "0";
  const result = await withFallback(options, async (exec) => {
    await exec(STOP_UPSERT_SQL, [OPS_DELIVERY_STOP_KEY, value]);
    return value === "1";
  }, () => setLocalDeliveryStoppedSync(sqliteHandle(), Boolean(stopped)), { write: true });
  if (isPg(options)) {
    try { setLocalDeliveryStoppedSync(sqliteHandle(), Boolean(stopped)); } catch { /* 本機鏡射失敗不擋 */ }
  }
  return result;
}

// `opsDelivery.deliveryControl(db, env)` 的 PG 版（欄位與同步版逐欄相同）。
export async function deliveryControlAsync(options = {}, env = process.env) {
  if (!isPg(options)) return deliveryControlSync(sqliteHandle(), env);
  const url = env.OPS_INGEST_URL || "";
  const secret = env.OPS_INGEST_SECRET || "";
  const envAllowed = env.OPS_FEEDBACK_DELIVERY === "1";
  const configured = Boolean(url && secret);
  const localStopped = await isLocalDeliveryStoppedAsync(options);
  let outbox = { warn: false, backlog: 0, pending: 0, dead: 0, total: 0 };
  try { outbox = await outboxCapacityAlertAsync({}, options); } catch { /* 測試庫可能還沒建 outbox */ }
  return {
    env_allowed: envAllowed,
    configured,
    local_stopped: localStopped,
    product_id: env.OPS_PRODUCT_ID || "v3",
    effective: Boolean(envAllowed && configured && !localStopped),
    outbox,
  };
}

// 給 worker 用的 store 介面（`opsDelivery.deliverWithStore()`／`startDeliveryLoopWithStore()` 吃這個形狀）。
// 放在這一支（而不是 `feedbackOutboxAsync`）是因為 `isStopped` 要用到這裡的停止鍵讀取，
// 反過來放會形成循環匯入。
export function feedbackOutboxStoreAsync(options = {}) {
  return {
    isStopped: () => isLocalDeliveryStoppedAsync(options),
    claim: (claimOptions) => claimOutboxBatchAsync(claimOptions, options),
    markSent: (id, markOptions) => markOutboxSentAsync(id, markOptions, options),
    markFailure: (row, errText, markOptions) => markOutboxFailureAsync(row, errText, markOptions, options),
    stats: () => outboxStatsAsync(options),
  };
}

// 由 server 呼叫（PG 模式）：週期性把 **PG** 的佇列送出去。
export function startDeliveryLoopAsync(config, { fetchImpl = globalThis.fetch, log = () => {}, options = {} } = {}) {
  return startDeliveryLoopWithStore(feedbackOutboxStoreAsync(options), config, { fetchImpl, log });
}
