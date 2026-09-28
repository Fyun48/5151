// 使用者讀取的 driver-aware 入口（PG 島嶼，2026-09-28）。
//
// 為什麼挑 `getUserById()`：它是目前缺口的**頭號卡點（25 條路由）**。它本身只是一句
// `SELECT * FROM users WHERE id = ?`，但 `db.js` 裡有 8 處私有呼叫，而且那些呼叫端
// 幾乎都是同步函式——所以這一支是「成組批次」的第一步（見計畫文件第三十八批）。
//
// ⚠️ `users` 是**已經在 PG 上的表**（`ensurePgSchema` 早就鏡射過：`users` 在主鍵、
// `idx_*` 上都有索引，且 `getSelfRowAsync`／`readSessionAsync` 都在讀它），
// 所以這裡不需要新的 schema 工作，也不需要補建索引。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { getUserById as getUserByIdSync } from "./members.js";

export const USER_BY_ID_SQL = "SELECT * FROM users WHERE id = ?";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
// `one()` **保證**查不到時回 `null`（不是 `undefined`）⇒ 外面不需要再 `|| null`。
// 那一句原本存在，但拿掉它測試照樣過（等價變異），所以移除以免留下「看起來有守衛、
// 其實沒有作用」的程式碼。
const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

async function run(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return runSqlite();
  }
}

// `getUserById(userId)`（db.js 的包裝）的 PG 版。
// 沒有這個 id 時回 null（同步版同義），不是 undefined——`adminPatchMember` 那類呼叫端
// 靠 `if (!user)` 判斷，回傳形狀不能變。
export async function getUserByIdAsync(userId, options = {}) {
  const id = Number(userId) || 0;
  if (!id) return null;
  return run(options, async (exec) => one((await exec(USER_BY_ID_SQL, [id])).rows),
    () => getUserByIdSync(sqliteHandle(), id) || null);
}
