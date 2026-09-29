// 變更紀錄（data revision change-log）讀取的 driver-aware 入口（PG 島嶼，2026-09-28，第四十九批）。
//
// 涵蓋的路由：`GET /api/events/revision`。
//
// 這一支特別乾淨的原因是**寫入端已經是 driver-aware 的**：
//   - SQLite 模式：`db.js:4551` 直接 `bumpRevision(db, …)` 寫本機。
//   - PG 模式：`db.js:4627` 走 `createWritePath({ driver: "postgres" })` 的
//     `writer.bumpRevision()`，而且包在 SAVEPOINT 裡（失敗不會毒化整個交易）。
// 所以缺少的只有**讀取**這一半；把讀取搬到 PG 之後，寫／讀才同源
// （在那之前 PG 站的 revision 會永遠是 0——這也是為什麼這條路由值得單獨做）。
//
// ⚠️ `data_revision.id` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`（＝PG 上的 identity），
// 而寫入端本來就不指定 id ⇒ 沒有「identity 假象」的問題（與 wish_room_example 不同）。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import {
  CHANGES_SINCE_MAX,
  changesSince as changesSinceSync,
  currentRevision as currentRevisionSync,
} from "./dataRevision.js";

export const DATA_REVISION_TABLES = ["data_revision"];
export const CURRENT_REVISION_SQL = "SELECT MAX(id) AS n FROM data_revision";
export const CHANGES_SINCE_SQL =
  "SELECT id, entity_type, entity_id, event_type, created_at FROM data_revision WHERE id > ? ORDER BY id ASC LIMIT ?";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

const schemaReady = new WeakMap();
export async function ensureDataRevisionStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = ensurePgSchema(pgDriver, sqliteHandle(), { tables: DATA_REVISION_TABLES });
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
}

async function withFallback(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureDataRevisionStoreOnce(pgDriver);
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return runSqlite();
  }
}

// `dataRevision.currentRevision()` 的 PG 版。
export async function currentRevisionAsync(options = {}) {
  return withFallback(options, async (run) => {
    const row = one((await run(CURRENT_REVISION_SQL, [])).rows);
    return Number(row?.n) || 0;
  }, () => currentRevisionSync(sqliteHandle()));
}

// `dataRevision.changesSince()` 的 PG 版（上限與同步版同一個算法）。
export async function changesSinceAsync(revision, { limit = 500 } = {}, options = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 500, CHANGES_SINCE_MAX));
  return withFallback(options, async (run) => {
    return (await run(CHANGES_SINCE_SQL, [Number(revision) || 0, cap])).rows || [];
  }, () => changesSinceSync(sqliteHandle(), revision, { limit }));
}
