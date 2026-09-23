// Driver-aware CRM outbox（2.2c）：佇列六支在 PostgreSQL 上跑 crmOutbox.js 的同一份語句文字。
//
// sqlite   - 原 crmOutbox.js 函式，行為完全不變（正式站預設）。
// postgres - repository/crmOutbox.js 的語句，經 sharedPgDriver()；表先用 pgSchema 從 SQLite 鏡射。
//
// ⚠️ 這一支的關鍵差別：**搶工作要用 rowCount**。SQLite 的 node:sqlite 回的是 `res.changes`，
// PostgreSQL 的 pg 回的是 `rowCount`；兩邊都統一由這裡的 exec 提供（離線替身也要照這個形狀回）。
import { randomUUID } from "node:crypto";
import {
  crmDeliveryControl as crmDeliveryControlSync,
  isLocalCrmSyncStopped as isLocalCrmSyncStoppedSync,
  setLocalCrmSyncStopped as setLocalCrmSyncStoppedSync,
} from "./crmDelivery.js";
import { sqliteHandle } from "./db.js";
import {
  CRM_OUTBOX_MAX_ATTEMPTS,
  CRM_OUTBOX_STALE_MS,
  claimCrmOutboxBatch as claimCrmOutboxBatchSync,
  crmOutboxStats as crmOutboxStatsSync,
  enqueueCrmOutbox as enqueueCrmOutboxSync,
  markCrmOutboxFailure as markCrmOutboxFailureSync,
  markCrmOutboxSent as markCrmOutboxSentSync,
} from "./crmOutbox.js";
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { ensurePgSchema } from "./pgSchema.js";
import * as repo from "./repository/crmOutbox.js";

function sqliteFor(options = {}) {
  return options.sqliteHandle || sqliteHandle();
}

async function ensurePgCrmOutboxSchema(pgDriver) {
  await ensurePgSchema(pgDriver, sqliteHandle(), { tables: [repo.CRM_OUTBOX_TABLE] });
}

// 統一的 exec 形狀：{ rows, rowCount }。離線替身可以只回陣列（此時 rowCount 取陣列長度）。
function normalizeResult(raw) {
  if (Array.isArray(raw)) {
    return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  }
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

async function withFallback(options, runPostgres, runSqlite) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  try {
    // 注入的 exec（測試／探針）也要正規化成 { rows, rowCount }，否則 rowCount 會拿不到。
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensurePgCrmOutboxSchema(pgDriver);
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (options.strict) throw error;
    return runSqlite();
  }
}

function iso(now) {
  return (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
}

// crmOutbox.js enqueueCrmOutbox()
export function enqueueCrmOutboxAsync(input = {}, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const contactId = Number(input.contactId) || 0;
      if (!contactId) return null;
      const deliveryId = randomUUID();
      const stamp = iso(input.now || new Date());
      const idem = `crm:${contactId}:${stamp}:${deliveryId.slice(0, 8)}`;
      const payload = JSON.stringify({
        delivery_id: deliveryId,
        idempotency_key: idem,
        source: "v3",
        external_contact_id: contactId,
        snapshot: input.data || {},
        synced_at: stamp,
      });
      const q = repo.outboxInsertQuery();
      await exec(q.sql, [deliveryId, idem, contactId, payload, CRM_OUTBOX_MAX_ATTEMPTS, stamp, stamp]);
      return { deliveryId, idempotencyKey: idem };
    },
    () => enqueueCrmOutboxSync(sqliteFor(options), input),
  );
}

// crmOutbox.js claimCrmOutboxBatch()
export function claimCrmOutboxBatchAsync(args = {}, options = {}) {
  const { limit = 20, now = new Date(), staleMs = CRM_OUTBOX_STALE_MS } = args;
  return withFallback(
    options,
    async (exec) => {
      const nowIso = iso(now);
      const staleBefore = iso(new Date((now instanceof Date ? now.getTime() : now) - staleMs));
      const cand = repo.outboxClaimCandidatesQuery(nowIso, staleBefore, limit);
      const { rows } = await exec(cand.sql, cand.params);
      const claimed = [];
      for (const row of rows || []) {
        const q = row.status === "sending"
          ? repo.outboxReclaimStaleQuery(nowIso, staleBefore, row.id)
          : repo.outboxClaimPendingQuery(nowIso, row.status, row.id);
        const { rowCount } = await exec(q.sql, q.params);
        if (rowCount === 1) claimed.push({ ...row, status: "sending", claimed_at: nowIso });
      }
      return claimed;
    },
    () => claimCrmOutboxBatchSync(sqliteFor(options), args),
  );
}

// crmOutbox.js markCrmOutboxSent()
export function markCrmOutboxSentAsync(id, args = {}, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const q = repo.outboxSentQuery(iso(args.now || new Date()), id);
      await exec(q.sql, q.params);
    },
    () => markCrmOutboxSentSync(sqliteFor(options), id, args),
  );
}

// crmOutbox.js markCrmOutboxFailure()：退避公式與 crmOutbox.js 逐字相同。
export function markCrmOutboxFailureAsync(row, errText, args = {}, options = {}) {
  const now = args.now || new Date();
  const attempts = Number(row.attempts) + 1;
  const max = Number(row.max_attempts) || CRM_OUTBOX_MAX_ATTEMPTS;
  const err = String(errText || "").slice(0, 500);
  return withFallback(
    options,
    async (exec) => {
      if (attempts >= max) {
        const q = repo.outboxDeadQuery(attempts, err, row.id);
        await exec(q.sql, q.params);
        return { status: "dead", attempts };
      }
      const next = iso(new Date((now instanceof Date ? now.getTime() : now) + Math.min(1000 * 2 ** (attempts - 1), 3600000)));
      const q = repo.outboxFailedQuery(attempts, next, err, row.id);
      await exec(q.sql, q.params);
      return { status: "failed", attempts };
    },
    () => markCrmOutboxFailureSync(sqliteFor(options), row, errText, { now }),
  );
}

// crmOutbox.js crmOutboxStats()
export function crmOutboxStatsAsync(options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const q = repo.outboxStatsQuery();
      const { rows } = await exec(q.sql, q.params);
      const out = { pending: 0, sending: 0, sent: 0, failed: 0, dead: 0, total: 0 };
      for (const row of rows || []) {
        out[row.status] = Number(row.n) || 0;
        out.total += Number(row.n) || 0;
      }
      return out;
    },
    () => crmOutboxStatsSync(sqliteFor(options)),
  );
}

// 給投遞迴圈用的 ops（依 driver 自動分派；介面一律回 Promise）。
// 只讀「本機停止旗標」（與 crmDelivery.js isLocalCrmSyncStopped 同語意）。
export function crmDeliveryStoppedAsync(env = process.env, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const q = repo.outboxSettingsStopQuery();
      const { rows } = await exec(q.sql, q.params);
      return String((rows[0] || {}).value || "") === "1";
    },
    () => isLocalCrmSyncStoppedSync(sqliteFor(options)),
  );
}

export function crmOutboxOps(options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") {
    const handle = sqliteFor(options);
    return {
      driver,
      stopped: async () => isLocalCrmSyncStoppedSync(handle),
      claim: async (args) => claimCrmOutboxBatchSync(handle, args),
      sent: async (id, args) => markCrmOutboxSentSync(handle, id, args),
      failure: async (row, errText, args) => markCrmOutboxFailureSync(handle, row, errText, args),
      stats: async () => crmOutboxStatsSync(handle),
    };
  }
  return {
    driver,
    stopped: (env = process.env) => crmDeliveryStoppedAsync(env, options),
    claim: (args) => claimCrmOutboxBatchAsync(args, options),
    sent: (id, args) => markCrmOutboxSentAsync(id, args, options),
    failure: (row, errText, args) => markCrmOutboxFailureAsync(row, errText, args, options),
    stats: () => crmOutboxStatsAsync(options),
  };
}

// Exposed for tests/diagnostics: the builders the PostgreSQL path runs.
export function crmOutboxAsyncContext() {
  return repo;
}


// crmDelivery.js crmDeliveryControl() 的 async 版（PG 模式讀 PG 的設定與統計）。
export function crmDeliveryControlAsync(env = process.env, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const stop = repo.outboxSettingsStopQuery ? repo.outboxSettingsStopQuery() : { sql: "SELECT value FROM settings WHERE key = ?", params: ["ops_crm_stop"] };
      const { rows } = await exec(stop.sql, stop.params);
      const localStopped = String((rows[0] || {}).value || "") === "1";
      const url = env.OPS_INGEST_URL || "";
      const secret = env.OPS_INGEST_SECRET || "";
      const envAllowed = env.OPS_CRM_DELIVERY === "1";
      const configured = Boolean(url && secret);
      const statQ = repo.outboxStatsQuery();
      const statRes = await exec(statQ.sql, statQ.params);
      const stats = { pending: 0, sending: 0, sent: 0, failed: 0, dead: 0, total: 0 };
      for (const row of statRes.rows || []) {
        stats[row.status] = Number(row.n) || 0;
        stats.total += Number(row.n) || 0;
      }
      return {
        env_allowed: envAllowed,
        configured,
        local_stopped: localStopped,
        product_id: env.OPS_PRODUCT_ID || "v3",
        effective: Boolean(envAllowed && configured && !localStopped),
        outbox: stats,
        note: "回饋複製授權不自動包含 CRM 同步。",
      };
    },
    () => crmDeliveryControlSync(sqliteFor(options), env),
  );
}

// crmDelivery.js setLocalCrmSyncStopped() 的 async 版。
export function setCrmDeliveryStopAsync(stopped, env = process.env, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      await exec("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [
        "ops_crm_stop",
        stopped ? "1" : "0",
      ]);
      return crmDeliveryControlAsync(env, { ...options, exec });
    },
    () => setLocalCrmSyncStoppedSync(sqliteFor(options), stopped),
  );
}

