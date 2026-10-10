// 後台總覽的 driver-aware 入口（PG 島嶼，2026-09-27；後台聚合讀取在 2026-10-11 一併搬進來）。
//
// 為什麼需要：`sourceListingStats()` 與 `crawlSourceHealth()` 原本是 `adminOverview.js` 裡
// 對 `listings` 的**原始 db.prepare**，沒有 async 版。所以 `/api/admin/crawl-sources` 的
// handler 即使在設定讀寫搬到 PG 之後，仍然會從節點本機 SQLite 讀來源健康度——
// 對照表上就是那兩條一直停在 MIXED 的原因。
//
// 這裡只換「跑語句的人」：聚合查詢的 SQL 與同步版逐字相同（`IFNULL` 一律改用兩個 driver
// 都合法的 `COALESCE`），回傳形狀也相同（Map<source, lastSeen> 與 Map<source, count>），
// 純判斷留在 `adminOverview.js`。
//
// SQLite 退場 P2（2026-10-11）再補上 `GET /api/admin/overview` 與 `GET /api/admin/data-health`
// 的**全部**聚合讀取（`buildAdminOverviewAsync`／`buildAdminDataHealthAsync`）：那些原本是同步
// `db.prepare`，開閘時要嘛 500、要嘛被 `catch { return 0 }` 吞成假的 0。這一邊的原則是
// **不吞錯**——取不到就往上丟；SQLite 模式（非 postgres）則交給
// `adminOverviewSqlite.js` 的同步版，行為完全不變。
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { SITE_CATALOG_STATS_KEY } from "./db.js";
import { getSiteSettingAsync } from "./settingsKvAsync.js";
import {
  getAdminMailSettingsAsync,
  getAdminMapsSettingsAsync,
  getAdminOauthSettingsAsync,
} from "./adminSettingsAsync.js";
import { getSystemCrawlAsync } from "./siteContentAsync.js";
import { feedbackStatsAsync } from "./feedbackAsync.js";
import { lastAuditActionAsync } from "./adminAuditAsync.js";
import { sameHouseBackfillStatusAsync } from "./sameHouseAsync.js";
import { CONFIRM_ADMIN, CONFIRM_AUTO, CONFIRM_SUSPECTED } from "./listingGroups.js";
import { IMPORT_STATUSES } from "./listingImport.js";
import {
  buildAdminDataHealth as buildAdminDataHealthSqlite,
  buildAdminOverview as buildAdminOverviewSqlite,
} from "./adminOverviewSqlite.js";
import { oauthServiceStatus, sourceHealthFromRow, todayStartIso } from "./adminOverview.js";
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
  } catch (error) {
    // 預設與同步版相同：讀不到就當作沒有資料，`/api/admin/crawl-sources` 的既有容忍度不變。
    // `strict: true`（後台總覽的 PG 路徑在用）改成把錯誤往上丟：來源健康度顯示假的 0
    // 與總覽顯示假的 0 是同一種缺陷。
    if (options.strict === true) throw error;
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
  } catch (error) {
    if (options.strict === true) throw error;
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

// ---- 後台總覽／資料健康度：PG 原生聚合（SQLite 退場 P2，2026-10-11）-----------------
//
// 背景：`GET /api/admin/overview`（server.js:3162）與 `GET /api/admin/data-health`（server.js:3174）
// 原本靠 `adminOverview.js` 的**同步** `db.prepare` 聚合讀取。開閘（`PG_NO_SQLITE_OPEN=1`）時
// 要嘛直接拋（Express 5 → 500），要嘛被 `countSql()`／`sameHouseCounts()` 的 `catch { return 0 }`
// 吞掉 ⇒ 後台**靜默顯示 0**。那正是 Owner 追的「少了什麼沒顯示」的機制。
//
// 這裡把同一批查詢搬到 PG，並刻意**不吞錯**：數字取不到就把錯誤往上丟，讓端點明確失敗
// （寧可看到 500，也不要看到一個看起來很正常、其實是假的 0）。整份程式碼沒有任何
// `catch { return 0 }`。唯一允許「沒有值」的是 `catalog`：settings 還沒有快照時，
// 同步的 `readSiteCatalogStats()` 本來就回 `null`，這裡維持同一個語意。
//
// SQL 一律寫成「兩個 driver 都合法」的形式（`COALESCE`、`?`）：注入式 exec（測試 stub）
// **不會**經過 `toPostgresSql()`，只有兩邊都合法，測試看到的語句才等於正式站送出的語句。
const LISTINGS_TOTAL_SQL = "SELECT COUNT(*) AS n FROM listings";
const LISTINGS_TODAY_NEW_SQL = "SELECT COUNT(*) AS n FROM listings WHERE first_seen_at >= ?";
const LISTINGS_OFFLINE_CONFIRMED_SQL =
  "SELECT COUNT(*) AS n FROM listings WHERE COALESCE(offline_confirmed, 0) = 1";
const SAME_HOUSE_GROUPS_SQL =
  "SELECT confirmation_level AS level, COUNT(*) AS n FROM listing_groups GROUP BY confirmation_level";
const SAME_HOUSE_UNGROUPED_SQL = `SELECT COUNT(*) AS n FROM listings l
 WHERE COALESCE(l.hidden, 0) = 0
   AND NOT EXISTS (SELECT 1 FROM listing_group_members m WHERE m.post_id = l.post_id)`;
const SAME_HOUSE_PENDING_SQL = `SELECT COUNT(*) AS n FROM listings
 WHERE post_id > ? AND COALESCE(offline_confirmed, 0) = 0`;
const IMPORT_PENDING_SQL = "SELECT COUNT(*) AS n FROM listing_import WHERE status IN (?, ?, ?)";
const ANNOUNCEMENT_DRAFTS_SQL =
  "SELECT COUNT(*) AS n FROM system_announcements WHERE status = 'draft'";
const DATA_HEALTH_SQL = `SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN COALESCE(address, '') = '' THEN 1 ELSE 0 END) AS missing_address,
  SUM(CASE WHEN lat IS NULL OR lng IS NULL THEN 1 ELSE 0 END) AS missing_coords,
  SUM(CASE WHEN COALESCE(floor_name, '') = '' THEN 1 ELSE 0 END) AS missing_floor,
  SUM(CASE WHEN COALESCE(area_name, '') = '' THEN 1 ELSE 0 END) AS missing_area,
  SUM(CASE WHEN COALESCE(layout, '') = '' THEN 1 ELSE 0 END) AS missing_layout,
  SUM(CASE WHEN COALESCE(extra_fees, '') IN ('', '[]', 'null')
             AND COALESCE(extra_fee, '') = ''
             AND COALESCE(extra_fee_text, '') = '' THEN 1 ELSE 0 END) AS missing_fees,
  SUM(CASE WHEN COALESCE(furnish_items, '') IN ('', '[]') THEN 1 ELSE 0 END) AS missing_furnish
 FROM listings WHERE COALESCE(hidden, 0) = 0`;
const DATA_HEALTH_SUSPECTED_GROUPS_SQL =
  "SELECT COUNT(*) AS n FROM listing_groups WHERE confirmation_level = ?";
const DATA_HEALTH_SUSPECTED_LISTINGS_SQL = `SELECT COUNT(*) AS n FROM listings
 WHERE COALESCE(match_post_id, 0) > 0 AND COALESCE(match_verdict, '') != 'yes'
   AND COALESCE(hidden, 0) = 0`;

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// 後台總覽／資料健康度是**唯讀**：PG 讀不到時不要回退本機 SQLite（讀取預設 fail-open）。
// 回退會讓後台顯示節點本機的舊數字，看起來正常、其實不是站上的資料；一律往上丟。
export const strictAdminReadOptions = (options = {}) => ({ ...options, strict: true });

// 聚合查詢一定要有一列、而且要有一個可用的 `n`：形狀不對就丟，不要變成 0。
async function countRows(exec, sql, params = []) {
  const rows = await exec(sql, params);
  const row = (Array.isArray(rows) ? rows[0] : rows?.rows?.[0]) || null;
  if (!row) throw new Error(`後台總覽：聚合查詢沒有回傳資料列（${sql}）`);
  const n = Number(row.n);
  if (!Number.isFinite(n)) throw new Error(`後台總覽：聚合查詢沒有回傳可用的 n（${sql}）`);
  return n;
}

// `db.js readSiteCatalogStats()` 的 PG 版：站台目錄快照存在 `settings` 表的
// `SITE_CATALOG_STATS_KEY`（寫入端 `siteContentAsync.js` 已寫 PG）。同步版是「讀整張 settings
// 再挑 key」，這裡用通用存取器讀**同一個鍵**，語意相同（沒有快照 ⇒ null）。
export async function readSiteCatalogStatsAsync(options = {}) {
  const snapshot = await getSiteSettingAsync(SITE_CATALOG_STATS_KEY, strictAdminReadOptions(options));
  return snapshot && typeof snapshot === "object" ? snapshot : null;
}

// `adminOverviewSqlite.js sameHouseCounts()` 的 PG 版（群組、未分組、待對帳）。
async function sameHouseCountsAsync(exec, options = {}) {
  const opts = strictAdminReadOptions(options);
  const groups = { suspected: 0, auto_confirmed: 0, admin_confirmed: 0 };
  for (const row of await exec(SAME_HOUSE_GROUPS_SQL, [])) {
    groups[String(row.level || "")] = Number(row.n) || 0;
  }
  const ungrouped = await countRows(exec, SAME_HOUSE_UNGROUPED_SQL);
  const backfill = await sameHouseBackfillStatusAsync(opts);
  const pendingReconcile = await countRows(exec, SAME_HOUSE_PENDING_SQL, [Number(backfill?.cursor) || 0]);
  return {
    ungrouped,
    suspected: groups[CONFIRM_SUSPECTED] || groups.suspected || 0,
    autoConfirmed: groups[CONFIRM_AUTO] || groups.auto_confirmed || 0,
    adminConfirmed: groups[CONFIRM_ADMIN] || groups.admin_confirmed || 0,
    pendingReconcile,
    backfill,
  };
}

// `adminOverviewSqlite.js buildAdminOverview()` 的 PG 版：輸出形狀逐欄相同。
export async function buildAdminOverviewAsync(listingPrep, options = {}) {
  // 非 PG 模式走同步版：SQLite 站不該去碰 PG runner（與其他島嶼模組同一個紀律）。
  if (!isPg(options)) return buildAdminOverviewSqlite(listingPrep);
  const opts = strictAdminReadOptions(options);
  const exec = await pgExec(options);
  const [
    catalog,
    listingsTotal,
    todayNew,
    offlineConfirmed,
    sameHouse,
    maps,
    mail,
    oauthSettings,
    feedback,
    importPending,
    announcementDrafts,
    smtpTest,
    systemCrawl,
    sources,
  ] = await Promise.all([
    readSiteCatalogStatsAsync(opts),
    countRows(exec, LISTINGS_TOTAL_SQL),
    countRows(exec, LISTINGS_TODAY_NEW_SQL, [todayStartIso()]),
    countRows(exec, LISTINGS_OFFLINE_CONFIRMED_SQL),
    sameHouseCountsAsync(exec, opts),
    getAdminMapsSettingsAsync(opts),
    getAdminMailSettingsAsync(opts),
    getAdminOauthSettingsAsync(opts),
    feedbackStatsAsync(opts),
    countRows(exec, IMPORT_PENDING_SQL, [
      IMPORT_STATUSES.PENDING,
      IMPORT_STATUSES.FETCHING,
      IMPORT_STATUSES.READY_FOR_REVIEW,
    ]),
    countRows(exec, ANNOUNCEMENT_DRAFTS_SQL),
    lastAuditActionAsync("smtp_test", opts),
    getSystemCrawlAsync(opts),
    crawlSourceHealthAsync(opts),
  ]);
  const oauth = oauthSettings?.oauth || {};
  const usage = maps.usage || {};
  return {
    readOnly: true,
    listings: {
      total: listingsTotal,
      todayNew,
      offlineConfirmed,
      suspectedSameHouse: sameHouse.suspected,
      sameHouseGroups: sameHouse.autoConfirmed + sameHouse.adminConfirmed,
      pendingReconcile: sameHouse.pendingReconcile,
    },
    catalog,
    sources,
    services: {
      osrm: { status: "unchecked", statusLabel: "未檢查" },
      googleDirections: {
        status: maps.googleEnabled ? (maps.hasKey ? "unchecked" : "unset") : "off",
        statusLabel: maps.googleEnabled ? (maps.hasKey ? "已啟用／未檢查" : "未設定") : "關閉",
        hasKey: Boolean(maps.hasKey),
        todayRequests: Number(usage.todayEssentials || 0) + Number(usage.todayAdvanced || 0),
        monthRequests: Number(usage.monthEssentials || 0) + Number(usage.monthAdvanced || 0),
      },
      smtp: {
        status: mail.configured ? (smtpTest?.at ? "tested" : "unchecked") : "unset",
        statusLabel: mail.configured ? (smtpTest?.at ? "已測試" : "已設定／未檢查") : "未設定",
        from: mail.smtp?.from || "",
        lastTestAt: smtpTest?.at || "",
      },
      oauth: {
        google: oauthServiceStatus(oauth, "google"),
        line: oauthServiceStatus(oauth, "line"),
        facebook: oauthServiceStatus(oauth, "facebook"),
      },
    },
    inbox: {
      feedbackNew: Number(feedback?.byStatus?.new) || 0,
      importPending,
      suspectedSameHouse: sameHouse.suspected,
      announcementDrafts,
    },
    sameHouse,
    listingPrep,
    crawl: {
      intervalMinutes: systemCrawl.intervalMinutes,
      districtCount: (systemCrawl.watchDistricts || []).length,
    },
  };
}

// `adminOverviewSqlite.js buildAdminDataHealth()` 的 PG 版：輸出形狀逐欄相同。
export async function buildAdminDataHealthAsync(listingPrep, options = {}) {
  if (!isPg(options)) return buildAdminDataHealthSqlite(listingPrep);
  const exec = await pgExec(options);
  const rows = await exec(DATA_HEALTH_SQL, []);
  const row = (Array.isArray(rows) ? rows[0] : rows?.rows?.[0]) || null;
  if (!row) throw new Error("後台資料健康度：聚合查詢沒有回傳資料列");
  // 與同步版相同的語意：`listing_groups` 那一支為 0 時才用 `listings` 的近似計數。
  const suspected = (await countRows(exec, DATA_HEALTH_SUSPECTED_GROUPS_SQL, [CONFIRM_SUSPECTED]))
    || (await countRows(exec, DATA_HEALTH_SUSPECTED_LISTINGS_SQL));
  return {
    total: Number(row.total) || 0,
    missingAddress: Number(row.missing_address) || 0,
    missingCoords: Number(row.missing_coords) || 0,
    missingFloor: Number(row.missing_floor) || 0,
    missingArea: Number(row.missing_area) || 0,
    missingLayout: Number(row.missing_layout) || 0,
    missingFees: Number(row.missing_fees) || 0,
    missingFurnish: Number(row.missing_furnish) || 0,
    suspectedDuplicate: suspected,
    listingPrep,
  };
}
