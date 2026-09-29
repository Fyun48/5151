// 物件來源歷史（`GET /api/listings/:id/history`）的 driver-aware 入口
// （PG 島嶼，2026-09-29，第六十一批）。
//
// 這一條做的事很小：把「同一個 source_key 的其他刊登」列出來，再疊上**這個人的旗標**
// （已看過／關注／隱藏／備註）。同步版 `db.js sourceHistory()` 兩個 store 都讀本機
// ⇒ PG 模式下會列出別的節點看不到的舊資料，而且旗標是**本機那一份**（個人化欄位全錯）。
import { resolveDbDriver } from "./dbDriver.js";
import { sourceHistory as sourceHistorySync, sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { overlayRowsPersonal } from "./personalFlags.js";
import { loadFlagMapAsync } from "./personalFlagsAsync.js";

export const SOURCE_HISTORY_SQL = `SELECT post_id, title, price, url, first_seen_at, last_seen_at, last_event, viewed, watched, hidden, watch_note
   FROM listings WHERE source_key = ? ORDER BY last_seen_at DESC`;

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

// `db.js sourceHistory()` 的 PG 版：查詢與旗標疊加都換成 PG，但疊加的**規則**共用
// `overlayRowsPersonal()`（與同步版同一份，個人化欄位的形狀才不會漂移）。
export async function sourceHistoryAsync(sourceKey, userId, options = {}) {
  const key = String(sourceKey || "");
  if (!key) return [];
  if (!isPg(options)) return sourceHistorySync(key, userId);
  try {
    const exec = options.exec
      ? async (sql, params = []) => rowsOf(await options.exec(sql, params))
      : async (sql, params = []) => (await (options.pgDriver || (await sharedPgDriver()))
        .query(toPostgresSql(sql), params)).rows;
    const rows = await exec(SOURCE_HISTORY_SQL, [key]);
    const flagMap = await loadFlagMapAsync(userId, options);
    return overlayRowsPersonal(rows, flagMap);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return sourceHistorySync(key, userId);
  }
}
