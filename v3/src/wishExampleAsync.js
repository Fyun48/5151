// 許願房範例（`wish_room_example`）的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 涵蓋的路由：`GET /api/wish-rooms/example`、`DELETE /api/wish-rooms/example`。
// 兩個都只碰一張表（`user_id` 是主鍵，一人一列），而且 `payload` 是 JSON 字串
// ——所以讀取要照抄同步版的 `try { JSON.parse } catch { 只回 updated_at }`，
// 壞掉的 payload **不能**讓端點爆掉。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { httpError } from "./demand.js";

export const WISH_EXAMPLE_SELECT_SQL = "SELECT * FROM wish_room_example WHERE user_id = ?"; // demand.js:1533
export const WISH_EXAMPLE_DELETE_SQL = "DELETE FROM wish_room_example WHERE user_id = ?"; // demand.js:1559
export const PG_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS wish_room_example (
     user_id BIGINT PRIMARY KEY,
     payload TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
];

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await (await import("./pgSharedDriver.js")).sharedPgDriver());
  const { toPostgresSql } = await import("./sqlDialect.js");
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

const schemaReady = new WeakMap();
export async function ensureWishExampleStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = (async () => {
    for (const sql of PG_SCHEMA_STATEMENTS) await pgDriver.exec(sql);
  })();
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
}

const requireUser = (userId) => {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  return uid;
};

// 純轉換：與 demand.js:1535 的 try/catch 逐字同義。
function exampleFromRow(row) {
  if (!row) return null;
  try {
    return { ...JSON.parse(row.payload || "{}"), updated_at: row.updated_at };
  } catch {
    return { updated_at: row.updated_at };
  }
}

async function run(options, { write = false }, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    return await runPostgres();
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

export async function getWishExampleAsync(userId, options = {}) {
  const uid = requireUser(userId);
  return run(options, {}, async () => {
    const exec = await pgExec(options);
    if (!options.exec) await ensureWishExampleStoreOnce(options.pgDriver || (await (await import("./pgSharedDriver.js")).sharedPgDriver()));
    const rows = await exec(WISH_EXAMPLE_SELECT_SQL, [uid]);
    return exampleFromRow(rows?.[0] || null);
  }, async () => (await import("./db.js")).getWishExampleFor(uid));
}

export async function deleteWishExampleAsync(userId, options = {}) {
  const uid = requireUser(userId);
  return run(options, { write: true }, async () => {
    const exec = await pgExec(options);
    if (!options.exec) await ensureWishExampleStoreOnce(options.pgDriver || (await (await import("./pgSharedDriver.js")).sharedPgDriver()));
    await exec(WISH_EXAMPLE_DELETE_SQL, [uid]);
    return { deleted: true };
  }, async () => (await import("./db.js")).deleteWishExampleFor(uid));
}
