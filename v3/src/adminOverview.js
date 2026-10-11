/** 後台總覽／資料健康度／物件搜尋。
 *
 * 分工（2026-10-11 整理，SQLite 退場 P2）：
 *   - 這一支只留**純函式**（`todayStartIso`／`sourceHealthFromRow`／`oauthServiceStatus`／
 *     `adminSearchNeedle`）、共用的 SQL 常數，以及兩個 **async 入口**。
 *   - 同步、只走節點本機 SQLite 的聚合讀取搬到 `adminOverviewSqlite.js`（原封不動，行為不變）；
 *     它們只在 `DB_DRIVER` 不是 postgres 時被走到，這次一併從本檔的 db.js 同步 import 中拆出去，
 *     所以 `pg-island-inventory.mjs` 不再把本檔列為「仍直接呼叫同步 DB 函式」。
 *   - PG 原生的 async 聚合讀取在 `adminOverviewAsync.js`：**不准吞錯**（讀不到就把錯誤往上丟，
 *     讓端點明確 500），因為「靜默顯示 0」正是這次要修的缺陷。
 *
 * 對外匯出（`getAdminOverview`／`getAdminDataHealth`／`crawlSourceHealth`／
 * `sourceListingStats`／`remainingSameHouseBackfill`）原樣保留：`server.js` 仍 import 同步的
 * `crawlSourceHealth`，而這個 PR 不准改 `server.js`。
 */
import { db } from "./db.js";
import { resolveDbDriver } from "./dbDriver.js";
import { listingPrepAdminStatsAsync } from "./listingEnrichQueueAsync.js";
import {
  getAdminDataHealth as getAdminDataHealthSqlite,
  getAdminOverview as getAdminOverviewSqlite,
} from "./adminOverviewSqlite.js";
import {
  SOURCE_FAILURE_ROUNDS_BEFORE_TOLERATED,
  normalizeSourceStreak,
} from "./crawlSourceStreaks.js";

const RAKUYA_OWNER_OFF = "Owner 手動停用";

export function todayStartIso(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function sourceHealthFromRow(row, stats = {}) {
  const enabled = row.enabled === true;
  const lastSuccess = stats.lastSeen || "";
  const todayNew = Number(stats.todayNew) || 0;
  const lastError = stats.lastError || "";
  // 第九十二批：輪次層級的連續失敗（`crawlScheduleV1.sourceStreaks`）。
  // ⚠️ `lastSuccess` 是「底庫最近寫入時間」＝曾經成功過，不代表這一輪成功；
  // 連續失敗要看 `fails`，而 `fails >= 門檻` 的來源已經被放行（不再阻擋完成紀錄）。
  const streak = normalizeSourceStreak(stats.streak || {});
  const fails = streak.fails;
  let status = "disabled";
  let statusLabel = "已關閉";
  let reason = "";
  if (row.id === "rakuya" && !enabled) {
    reason = RAKUYA_OWNER_OFF;
  } else if (!enabled) {
    reason = "";
  } else if (stats.blocked) {
    status = "blocked";
    statusLabel = "來源封鎖";
    reason = lastError || "來源封鎖";
  } else if (stats.parseFailed) {
    status = "parse_failed";
    statusLabel = "解析失敗";
    reason = lastError || "解析失敗";
  } else if (fails >= SOURCE_FAILURE_ROUNDS_BEFORE_TOLERATED) {
    // 這一輪起不再阻擋完成紀錄，但一定要在後台看得見（否則就是靜默漏抓）。
    status = "failing";
    statusLabel = `連續失敗 ${fails} 輪（已放行完成紀錄）`;
    reason = [
      `已連續 ${fails} 輪沒有完整覆蓋，這一輪起不再阻擋覆蓋完成紀錄`,
      streak.lastFailureAt ? `最後失敗：${streak.lastFailureAt}` : "",
      streak.lastError ? `最後錯誤樣本：${streak.lastError}` : "",
      "請檢查來源是否改版或被封鎖",
    ].filter(Boolean).join("；");
  } else if (fails > 0) {
    status = "retrying";
    statusLabel = `連續失敗 ${fails} 輪（還在阻擋完成紀錄）`;
    reason = [
      `連續失敗 ${fails} 輪，滿 ${SOURCE_FAILURE_ROUNDS_BEFORE_TOLERATED} 輪後會先放行完成紀錄並持續告警`,
      streak.lastFailureAt ? `最後失敗：${streak.lastFailureAt}` : "",
      streak.lastError ? `最後錯誤樣本：${streak.lastError}` : "",
    ].filter(Boolean).join("；");
  } else {
    // last_seen 只代表「曾經寫入底庫」，不是現在健康。沒有 runtime probe 就不要標綠色正常。
    status = "unchecked";
    statusLabel = "已啟用／未檢查";
    reason = lastError || "";
  }
  return {
    id: row.id,
    label: row.label,
    enabled,
    status,
    statusLabel,
    reason,
    lastSuccess,
    lastError,
    todayNew,
    consecutiveFailures: fails,
    tolerated: fails >= SOURCE_FAILURE_ROUNDS_BEFORE_TOLERATED,
    lastFailureAt: streak.lastFailureAt,
    lastRoundSuccessAt: streak.lastSuccessAt,
  };
}

export function oauthServiceStatus(oauth, id) {
  const row = oauth?.[id] || {};
  if (row.enabled && row.configured) return { id, status: "unchecked", statusLabel: "已設定／未檢查" };
  if (row.configured && !row.enabled) return { id, status: "off", statusLabel: "已關閉" };
  return { id, status: "unset", statusLabel: "未設定" };
}

// `DB_DRIVER=postgres` 時的入口（`GET /api/admin/overview`）：聚合讀取全部走 PG 原生 async。
//
// 為什麼把 `strict: true` 傳下去：補抓統計（`listingPrepAdminStatsAsync`）原本在 PG 失敗時會
// 回退本機 SQLite（讀取預設 fail-open）。後台總覽回退到節點本機的舊數字，正是這次要修的
// 「靜默顯示 0／舊值」；這裡一律往上丟，讓端點明確 500。
export async function getAdminOverviewAsync(options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") return getAdminOverviewSqlite();
  const listingPrep = await listingPrepAdminStatsAsync(db, { ...options, strict: true });
  const { buildAdminOverviewAsync } = await import("./adminOverviewAsync.js");
  return buildAdminOverviewAsync(listingPrep, options);
}

// `DB_DRIVER=postgres` 時的入口（`GET /api/admin/data-health`）；理由同上。
export async function getAdminDataHealthAsync(options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") return getAdminDataHealthSqlite();
  const listingPrep = await listingPrepAdminStatsAsync(db, { ...options, strict: true });
  const { buildAdminDataHealthAsync } = await import("./adminOverviewAsync.js");
  return buildAdminDataHealthAsync(listingPrep, options);
}

// 後台搜尋的兩個查詢與「needle／上限」的規則抽成共用零件（PG 版逐字共用）。
// ⚠️ `IFNULL` 是 SQLite 專屬、PG 沒有 ⇒ 這裡用兩邊都有的 `COALESCE`（行為相同）。
export const ADMIN_LISTING_SEARCH_BY_ID_SQL = `SELECT post_id, title, address, source, price, url
       FROM listings WHERE post_id = ?`;
export const ADMIN_LISTING_SEARCH_LIKE_SQL = `SELECT post_id, title, address, source, price, url
     FROM listings
     WHERE title LIKE ? OR COALESCE(address, '') LIKE ?
     ORDER BY last_seen_at DESC, post_id DESC
     LIMIT ?`;

export function adminSearchNeedle(q, limit = 20) {
  const needle = String(q || "").trim();
  const cap = Math.max(1, Math.min(40, Number(limit) || 20));
  return { needle, cap };
}

export function searchAdminListings(q, limit = 20) {
  const { needle, cap } = adminSearchNeedle(q, limit);
  if (!needle) return [];
  if (/^\d+$/.test(needle)) {
    const row = db.prepare(ADMIN_LISTING_SEARCH_BY_ID_SQL).get(Number(needle));
    return row ? [row] : [];
  }
  const like = `%${needle.replace(/[%_]/g, "")}%`;
  return db.prepare(ADMIN_LISTING_SEARCH_LIKE_SQL).all(like, like, cap);
}

// 同步、只走 SQLite 的實作已搬到 `adminOverviewSqlite.js`；匯出保持不變（`server.js` 在用）。
export {
  crawlSourceHealth,
  getAdminDataHealth,
  getAdminOverview,
  remainingSameHouseBackfill,
  sourceListingStats,
} from "./adminOverviewSqlite.js";

export { RAKUYA_OWNER_OFF };
