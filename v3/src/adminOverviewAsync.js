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
import { getCrawlSourcesAsync } from "./siteContentAsync.js";

const LAST_SEEN_SQL =
  `SELECT COALESCE(source, '591') AS source, MAX(last_seen_at) AS last_seen
   FROM listings GROUP BY COALESCE(source, '591')`;

const TODAY_NEW_SQL =
  `SELECT COALESCE(source, '591') AS source, COUNT(*) AS n
   FROM listings WHERE first_seen_at >= ? GROUP BY COALESCE(source, '591')`;

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
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
export async function crawlSourceHealthAsync(options = {}) {
  const items = (await getCrawlSourcesAsync(options)).items || [];
  const { lastSeen, todayNew } = await sourceListingStatsAsync(options);
  return items.map((row) => sourceHealthFromRow(row, {
    lastSeen: lastSeen.get(row.id) || "",
    todayNew: todayNew.get(row.id) || 0,
  }));
}
