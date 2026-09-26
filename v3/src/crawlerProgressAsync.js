// 爬蟲進度狀態的 driver-aware 入口（樂屋抓取游標）。
//
// sqlite   - db.js 的同步函式（行為不變）。
// postgres - repository/crawlerProgress.js 的同一份語句文字，交易內讀-改-寫。
//
// 與其他島嶼的差別：這裡**不做 SQLite fallback**。抓取游標是業務進度狀態，PG 失敗時回退讀本機
// SQLite 會拿到別台節點的舊進度（重抓或跳頁），所以讀寫都直接往上丟錯誤。這符合
// 2026-09-26 指令「PG 模式不以 SQLite 作為業務讀取、寫入或故障回退來源」。
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import * as repo from "./repository/crawlerProgress.js";
import {
  getRakuyaPageCursors as getRakuyaPageCursorsSync,
  saveRakuyaPageCursors as saveRakuyaPageCursorsSync,
} from "./db.js";

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

async function runInTransaction(options, fn) {
  if (options.exec) return fn(options.exec);
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return pgDriver.withTransaction(async (client) => {
    const tx = (sql, params = []) => client.query(toPostgresSql(sql), params).then((res) => res.rows);
    return fn(tx);
  });
}

// db.js settingKey() 的解析：壞資料回空物件，不要把整個抓取週期打斷。
export function parseRakuyaPageCursors(value) {
  if (value == null) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// db.js saveRakuyaPageCursors() 的價值判斷，逐字沿用：只收 regionId > 0 且 nextPage 有限的列，
// 每個 region 取 max(2, floor(nextPage))。兩個 driver 必須得到同一個結果。
export function mergeRakuyaPageCursors(current, progress) {
  const next = { ...(current || {}) };
  for (const row of progress || []) {
    if (Number(row.regionId) > 0 && Number.isFinite(Number(row.nextPage))) {
      next[Number(row.regionId)] = Math.max(2, Math.floor(Number(row.nextPage)));
    }
  }
  return next;
}

export async function getRakuyaPageCursorsAsync(options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") return getRakuyaPageCursorsSync();
  const exec = await pgExec(options);
  const rows = await exec(repo.READ_SETTING_SQL, [repo.RAKUYA_CURSORS_KEY]);
  return parseRakuyaPageCursors(rows[0]?.value);
}

export async function saveRakuyaPageCursorsAsync(progress, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") return saveRakuyaPageCursorsSync(progress);
  return runInTransaction(options, async (tx) => {
    const rows = await tx(repo.READ_SETTING_SQL, [repo.RAKUYA_CURSORS_KEY]);
    const next = mergeRakuyaPageCursors(parseRakuyaPageCursors(rows[0]?.value), progress);
    await tx(repo.UPSERT_SETTING_SQL, [repo.RAKUYA_CURSORS_KEY, JSON.stringify(next)]);
    return next;
  });
}
