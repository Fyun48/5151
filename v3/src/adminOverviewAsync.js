// 後台總覽的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼需要：`sourceListingStats()` 與 `crawlSourceHealth()` 原本是 `adminOverview.js` 裡
// 對 `listings` 的**原始 db.prepare**，沒有 async 版。所以 `/api/admin/crawl-sources` 的
// handler 即使在設定讀寫搬到 PG 之後，仍然會從節點本機 SQLite 讀來源健康度——
// 對照表上就是那兩條一直停在 MIXED 的原因。
//
// 這裡只換「跑語句的人」：兩個聚合查詢的 SQL 與同步版逐字相同，回傳形狀也相同
// （Map<source, lastSeen> 與 Map<source, count>），純判斷留在 adminOverview.js。
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sourceHealthFromRow, todayStartIso } from "./adminOverview.js";
import {
  ADMIN_LISTING_SEARCH_BY_ID_SQL,
  ADMIN_LISTING_SEARCH_LIKE_SQL,
  adminSearchNeedle,
  searchAdminListings as searchAdminListingsSync,
} from "./adminOverview.js";
import { getCrawlSourcesAsync } from "./siteContentAsync.js";
import { readCrawlSourceStreaksAsync } from "./crawlScheduleAsync.js";

const LAST_SEEN_SQL =
  `SELECT COALESCE(source, '591') AS source, MAX(last_seen_at) AS last_seen
   FROM listings GROUP BY COALESCE(source, '591')`;

const TODAY_NEW_SQL =
  `SELECT COALESCE(source, '591') AS source, COUNT(*) AS n
   FROM listings WHERE first_seen_at >= ? GROUP BY COALESCE(source, '591')`;

async function pgExec(options = {}) {
  if (options.exec) {
    // ⚠️ 與 `siteContentAsync.js` 同一個理由：注入式 exec 可能是 `{ rows, rowCount }` 形狀，
    // 而這裡的呼叫端是 `for…of` 或 `[0]`，所以統一成裸陣列。
    const injected = options.exec;
    return async (sql, params = []) => {
      const raw = await injected(sql, params);
      return Array.isArray(raw) ? raw : (raw?.rows || []);
    };
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// db.js / adminOverview.js sourceListingStats() 的 PG 分支。
// 同步版把整段包在 try/catch 裡（欄位不存在就當作沒有資料），這裡照抄同樣的容忍度。
export async function sourceListingStatsAsync(options = {}) {
  const today = todayStartIso();
  const lastSeen = new Map();
  const todayNew = new Map();
  try {
    const exec = await pgExec(options);
    for (const row of await exec(LAST_SEEN_SQL, [])) {
      lastSeen.set(row.source, row.last_seen || "");
    }
    for (const row of await exec(TODAY_NEW_SQL, [today])) {
      todayNew.set(row.source, Number(row.n) || 0);
    }
  } catch {
    // 與同步版相同：讀不到就當作沒有資料，不讓後台總覽整個壞掉。
  }
  return { lastSeen, todayNew };
}

// adminOverview.js crawlSourceHealth() 的 PG 分支。
//
// 第九十二批：除了底庫的 lastSeen／todayNew，再帶上輪次層級的來源狀態
// （`crawlScheduleV1.sourceStreaks`：連續失敗輪數、最後錯誤樣本、最後成功時間），
// 這樣「連續失敗達門檻 ⇒ 不再阻擋完成紀錄」這個政策放寬在後台看得見。
// 讀不到 streak 時一律當作沒有（與 lastSeen 同樣的容忍度）：後台總覽不該因為診斷資訊而壞掉。
export async function crawlSourceHealthAsync(options = {}) {
  const items = (await getCrawlSourcesAsync(options)).items || [];
  const { lastSeen, todayNew } = await sourceListingStatsAsync(options);
  let streaks = {};
  try {
    ({ streaks } = await readCrawlSourceStreaksAsync(options));
  } catch {
    streaks = {};
  }
  return items.map((row) => sourceHealthFromRow(row, {
    lastSeen: lastSeen.get(row.id) || "",
    todayNew: todayNew.get(row.id) || 0,
    streak: streaks?.[row.id],
  }));
}

// `adminOverview.searchAdminListings()` 的 PG 版（`GET /api/admin/listings/search`）。
//
// ⚠️ 同步版的 LIKE 那一段用 `IFNULL(address, '')`——**PG 沒有 `IFNULL`**。共用常數改成
// `COALESCE`（SQLite 也有），兩個 driver 才會跑同一句；`%`／`_` 的過濾與 limit 上限
// 都在 `adminSearchNeedle()` 裡（純函式，兩個 driver 共用）。
export async function searchAdminListingsAsync(q, limit = 20, options = {}) {
  const { needle, cap } = adminSearchNeedle(q, limit);
  if (!needle) return [];
  // 非 PG 模式走同步版：SQLite 站不該去碰 PG runner（與其他島嶼模組同一個紀律）。
  if ((options.driver || resolveDbDriver()) !== "postgres") return searchAdminListingsSync(q, limit);
  const exec = await pgExec(options);
  if (/^\d+$/.test(needle)) {
    const row = (await exec(ADMIN_LISTING_SEARCH_BY_ID_SQL, [Number(needle)]))[0];
    return row ? [row] : [];
  }
  const like = `%${needle.replace(/[%_]/g, "")}%`;
  return exec(ADMIN_LISTING_SEARCH_LIKE_SQL, [like, like, cap]);
}
