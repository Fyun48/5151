// 許願房生命週期 tick 的 driver-aware 入口（PG 島嶼，2026-10）。
//
// `runWishLifecycleTick(db=本機)` 同步讀寫節點 SQLite ⇒ PG 的 `demand_posts` 不會被標記
// 逾期／休眠，且 cursor 與 PG 無關。這裡補 async 路徑：規劃與「寫入前重讀」的純函式
// （`planLifecycleTick`／`shouldApplyLifecyclePlan`）重用 `wishLifecycle.js`，只把 SQL 換成
// 注入式 runner。cursor 表 `rental_notify_cursors` 與租屋通知 worker 共用同一張表。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import { planLifecycleTick, shouldApplyLifecyclePlan } from "./wishLifecycle.js";
import { isWishLifecycleEnabled } from "./rentalMarketplaceFlags.js";
import { runWishLifecycleTick, WISH_LIFECYCLE_CURSOR_JOB } from "./wishLifecycleLoop.js";
import { ensureRentalNotifyWorkerOnce, getNotifyCursorAsync, setNotifyCursorAsync } from "./rentalNotifyWorkerAsync.js";

const DEFAULT_LIMIT = 80;

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

async function withFallback(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureRentalNotifyWorkerOnce(pgDriver);
    return await pgDriver.withTransaction(async (client) => {
      const exec = async (sql, params = []) => {
        const res = await client.query(toPostgresSql(sql), params);
        return normalizeResult(res);
      };
      return await runPostgres(exec);
    });
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    return runSqlite();
  }
}

const SELECT_ROWS_SQL = `SELECT * FROM demand_posts
  WHERE status IN ('open', 'expired') AND id > ?
  ORDER BY id ASC LIMIT ?`;

const UPDATE_ROW_SQL = `UPDATE demand_posts
  SET lifecycle = ?, status = ?, expires_at = COALESCE(?, expires_at),
      last_confirmed_at = COALESCE(?, last_confirmed_at),
      last_active_at = COALESCE(?, last_active_at),
      closed_at = COALESCE(?, closed_at),
      closed_reason = COALESCE(?, closed_reason),
      updated_at = ?
  WHERE id = ?`;

async function selectLifecycleRowsAfterAsync(run, afterId, cap) {
  return (await run(SELECT_ROWS_SQL, [afterId, cap])).rows;
}

export async function runWishLifecycleTickAsync(now = new Date(), { limit = DEFAULT_LIMIT, flags, cursor = null } = {}, options = {}) {
  if (!isWishLifecycleEnabled(flags)) {
    return { changed: 0, scanned: 0, skipped: true, after_id: null, next_id: null, wrapped: false };
  }
  return withFallback(options, async (run) => {
    const cur = cursor || {
      get: () => getNotifyCursorAsync(run, WISH_LIFECYCLE_CURSOR_JOB),
      set: (lastId) => setNotifyCursorAsync(run, WISH_LIFECYCLE_CURSOR_JOB, lastId, now),
    };
    const cap = Math.max(1, Number(limit) || DEFAULT_LIMIT);
    const afterId = Math.max(0, Number((await cur.get?.()) ?? 0) || 0);
    let rows = await selectLifecycleRowsAfterAsync(run, afterId, cap);
    let wrapped = false;
    if (!rows.length && afterId > 0) {
      rows = await selectLifecycleRowsAfterAsync(run, 0, cap);
      wrapped = true;
    }
    let changed = 0;
    for (const row of rows) {
      const planned = planLifecycleTick(row, now);
      const fresh = one((await run("SELECT * FROM demand_posts WHERE id = ?", [row.id])).rows);
      if (!shouldApplyLifecyclePlan(fresh, planned, now)) continue;
      await run(UPDATE_ROW_SQL, [
        planned.lifecycle,
        planned.status,
        planned.expires_at || null,
        planned.last_confirmed_at || null,
        planned.last_active_at || null,
        planned.closed_at || null,
        planned.closed_reason || null,
        planned.updated_at,
        row.id,
      ]);
      changed += 1;
    }
    const nextId = rows.length ? Number(rows[rows.length - 1].id) || 0 : afterId;
    if (typeof cur.set === "function" && nextId !== afterId) await cur.set(nextId);
    return { changed, scanned: rows.length, skipped: false, after_id: afterId, next_id: nextId, wrapped };
  }, () => runWishLifecycleTick(sqliteHandle(), now, { limit, flags, cursor }));
}
