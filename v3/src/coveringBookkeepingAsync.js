// 抓取紀錄（lastCoveringAt／lastSystemCoveringAt／crawl_covers.last_run_at）的 driver-aware 入口。
//
// 為什麼需要：db.js 的 writeSettingKey()／settingKey() 與 crawlCovers.touchCrawlCoversRun() 只有同步
// SQLite 版本。DB_DRIVER=postgres 時，整輪抓取完成的時間只會寫進該節點自己的 SQLite，而
// isSystemCoveringDue() 讀到的仍是 PG 裡凍結的舊值（2026-09-24 實測：PG 的 lastSystemCoveringAt 停在
// 2026-09-22T05:35Z）→ 系統每一分鐘都判定「該抓了」，爬蟲背對背連續全速跑（約 570 筆/分鐘），
// 對 591 的請求量偏高，也讓每組覆蓋條件的完成時間永遠不會更新。
//
// 設計與 settingsAsync.js／notifyEnqueueAsync.js 相同：純判斷留在 db.js，PG 只換「跑語句的人」。
//   - SQLite 分支：直接呼叫 db.js／crawlCovers.js 的同步函式（行為完全不變）
//   - PostgreSQL 分支：settings 表的 site 鍵 upsert ＋ crawl_covers 的 last_run_at update
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { GLOBAL_SETTINGS_SQL, SITE_SETTING_UPSERT_SQL } from "./repository/memberSettings.js";
import { touchCrawlCoversRun } from "./crawlCovers.js";
import {
  armMemberExternalFetch,
  coveringBookkeeping,
  crawlIntervalMinutes,
  markCoveringCompleted,
  sqliteHandle,
} from "./db.js";

const KEYS = ["lastCoveringAt", "lastSystemCoveringAt"];

// 注入式 exec（測試）優先；否則借用共用 PG pool。
async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

function parseKeyValue(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? "" : String(parsed);
  } catch {
    return String(raw ?? "");
  }
}

// db.js coveringBookkeeping()（PG 分支）。
export async function coveringBookkeepingAsync(options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") return coveringBookkeeping();
  const exec = await pgExec(options);
  const rows = (await exec(GLOBAL_SETTINGS_SQL, [])) || [];
  const out = { lastCoveringAt: "", lastSystemCoveringAt: "" };
  for (const row of rows) {
    const key = String(row?.key || "");
    if (!KEYS.includes(key)) continue;
    out[key] = parseKeyValue(row.value);
  }
  return out;
}

// db.js isSystemCoveringDue()（PG 分支）：同一條算式，只換讀的地方。
export async function isSystemCoveringDueAsync(now = Date.now(), options = {}) {
  const { lastSystemCoveringAt } = await coveringBookkeepingAsync(options);
  const last = Date.parse(lastSystemCoveringAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= crawlIntervalMinutes() * 60 * 1000;
}

// db.js markCoveringCompleted() ＋ crawlCovers.touchCrawlCoversRun()（PG 分支）。
// 兩個都是「整輪抓取完成」的紀錄，一起寫才不會出現「時間更新了、覆蓋條件沒更新」的半套狀態。
export async function markCoveringCompletedAsync({
  includedUserIds = [],
  includeSystem = false,
  at = new Date().toISOString(),
} = {}, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    touchCrawlCoversRun(sqliteHandle());
    return markCoveringCompleted({ includedUserIds, includeSystem, at });
  }
  const exec = await pgExec(options);
  await exec(SITE_SETTING_UPSERT_SQL, ["lastCoveringAt", JSON.stringify(at)]);
  if (includeSystem) await exec(SITE_SETTING_UPSERT_SQL, ["lastSystemCoveringAt", JSON.stringify(at)]);
  await exec("UPDATE crawl_covers SET last_run_at = ?", [at]);
  const from = Date.parse(at) || Date.now();
  for (const id of includedUserIds) {
    // 與 SQLite 分支的 armMemberExternalFetch() 同一件事：把該會員的下次抓取時間往後推。
    const { armMemberExternalFetchAsync } = await import("./settingsAsync.js");
    await armMemberExternalFetchAsync(id, { from }, options);
  }
  return { lastCoveringAt: at, lastSystemCoveringAt: includeSystem ? at : "", coversTouched: true };
}
