// Driver-aware notification queue (the flush loop's read + writes).
//
// watcher.js drains `user_events`: `pendingNotifyEvents(400)` gives it the batch, then every channel
// outcome goes back through `updateEventNotify(id, …)` / `markEventNotified(id)`. Those are
// synchronous SQLite statements, so with DB_DRIVER=postgres the loop read an empty queue while the
// site read PostgreSQL - this module gives them one async entry point:
//
//   • sqlite   - the existing db.js functions, unchanged (production default)
//   • postgres - repository/notifyQueue.js over the shared pool
//
// Fail-open: a PostgreSQL failure falls back to the SQLite call, exactly like crawlerReads.js, so a
// hiccup cannot stop the loop from draining what it can.
//
// Still SQLite-shaped (POSTGRES_SWITCH_PLAN ③): enqueueListingEvent()'s decision chain decides *what*
// enters the queue (users / settings / search profiles / listing groups) and has not been ported yet.
import { markEventNotified as markEventNotifiedSync, notifyBuildContext, pendingNotifyEvents, updateEventNotify as updateEventNotifySync } from "./db.js";
import { markEventNotified as markEventNotifiedRepo, selectPendingEvents, updateEventNotify as updateEventNotifyRepo } from "./repository/notifyQueue.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";

// `db.js recentEvents()` 的 PG 版（`GET /api/state` 的事件清單）。
//
// 同步版是 `SELECT * FROM user_events WHERE user_id = ? ORDER BY id DESC LIMIT ?`，而且會先
// `resolveUserId()`（那條路會 `ensureUser()` 讀本機 `users`）。PG 模式下兩個都在本機 ⇒
// **會員在畫面上看不到自己的通知事件**（別台節點送出的更看不到）。這裡直接吃呼叫端已經
// 解析好的 uid（`readSession` 的身分來自 PG），所以不需要再碰 `users`。
export const RECENT_EVENTS_SQL =
  "SELECT * FROM user_events WHERE user_id = ? ORDER BY id DESC LIMIT ?";

export async function recentEventsAsync(userId, limit = 40, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  const cap = Math.max(1, Number(limit) || 40);
  return withFallback(options, async (exec) => {
    const rows = await exec(RECENT_EVENTS_SQL, [uid, cap]);
    return Array.isArray(rows) ? rows : (rows?.rows || []);
  }, async () => {
    const { recentEvents } = await import("./db.js");
    return recentEvents(cap, uid);
  });
}

async function postgresExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

async function withFallback(options, runPostgres, runSqlite) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  try {
    const exec = await postgresExec(options);
    const deps = options.deps || notifyBuildContext();
    return await runPostgres(exec, deps);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: options.write === true })) throw error;
    return runSqlite();
  }
}

// db.js pendingNotifyEvents(): the batch the flush loop works through (order is the contract).
export function pendingNotifyEventsAsync({ limit = 80, now } = {}, options = {}) {
  return withFallback(
    options,
    (exec, deps) => selectPendingEvents(exec, { deps, limit, now }),
    () => pendingNotifyEvents(limit, now),
  );
}

// db.js updateEventNotify(): the channel outcome of one event.
export function updateEventNotifyAsync(id, patch = {}, options = {}) {
  return withFallback(
    { ...options, write: true },
    (exec, deps) => updateEventNotifyRepo(exec, { deps, id, patch }),
    () => updateEventNotifySync(id, patch),
  );
}

// db.js markEventNotified(): the "every needed channel is done" flag.
export function markEventNotifiedAsync(id, options = {}) {
  return withFallback(
    { ...options, write: true },
    (exec, deps) => markEventNotifiedRepo(exec, { deps, id }),
    () => markEventNotifiedSync(id),
  );
}

// Exposed for tests/diagnostics: the bundle the PostgreSQL queue reads/writes need.
export function notifyContext() {
  return notifyBuildContext();
}
