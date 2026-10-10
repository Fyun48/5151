// 後台總覽／資料健康度的「SQLite 模式」同步讀取（2026-10-11 由 adminOverview.js 原封不動移出）。
//
// 為什麼獨立成檔：PG 島嶼把 `/api/admin/overview` 與 `/api/admin/data-health` 的聚合讀取
// 改成 PG 原生 async（`adminOverviewAsync.js`）。剩下這幾支是**同步、只走節點本機 SQLite**，
// 只在 `DB_DRIVER` 不是 postgres 時被走到：
//   - `adminOverview.js` 的 async 入口在 PG 模式下不會呼叫它們；
//   - `server.js` 仍 `import { crawlSourceHealth }`（同步版，目前其實沒有使用）⇒ 匯出必須留著，
//     否則 ESM 連結期就會失敗，而這個 PR 不准改 `server.js`。
// 也就是說：這裡的每一行都是「PG 模式絕不會執行、但 SQLite 模式仍需要」的路徑。
//
// ⚠️ 這一支是本檔的核心：它仍然是「讀不到就當 0」的容忍度（`countSql` 的 catch），
// 因為那是 SQLite 模式的既有行為。PG 模式走的是 `adminOverviewAsync.js`，那一邊**不准**吞錯。
import {
  db,
  getAdminMailSettings,
  getAdminMapsSettings,
  getAdminOauthSettings,
  getCrawlSources,
  getFeedbackStats,
  getSystemCrawl,
  readSiteCatalogStats,
  sameHouseBackfillStatus,
} from "./db.js";
import { lastAuditAction } from "./adminAudit.js";
import { CONFIRM_ADMIN, CONFIRM_AUTO, CONFIRM_SUSPECTED } from "./listingGroups.js";
import { IMPORT_STATUSES } from "./listingImport.js";
import { listingPrepAdminStats } from "./listingEnrichQueue.js";
import { oauthServiceStatus, sourceHealthFromRow, todayStartIso } from "./adminOverview.js";

function countSql(sql, ...params) {
  try {
    return Number(db.prepare(sql).get(...params)?.n) || 0;
  } catch {
    return 0;
  }
}

export function sourceListingStats() {
  const today = todayStartIso();
  const lastSeen = new Map();
  const todayNew = new Map();
  try {
    for (const row of db.prepare(
      `SELECT COALESCE(source, '591') AS source, MAX(last_seen_at) AS last_seen
       FROM listings GROUP BY COALESCE(source, '591')`,
    ).all()) {
      lastSeen.set(row.source, row.last_seen || "");
    }
    for (const row of db.prepare(
      `SELECT COALESCE(source, '591') AS source, COUNT(*) AS n
       FROM listings WHERE first_seen_at >= ? GROUP BY COALESCE(source, '591')`,
    ).all(today)) {
      todayNew.set(row.source, Number(row.n) || 0);
    }
  } catch {
    // listings table always exists after boot; ignore if a column is missing
  }
  return { lastSeen, todayNew };
}

export function remainingSameHouseBackfill(cursor) {
  return countSql(
    `SELECT COUNT(*) AS n FROM listings
     WHERE post_id > ?
       AND IFNULL(offline_confirmed, 0) = 0`,
    Number(cursor) || 0,
  );
}

export function crawlSourceHealth() {
  const items = getCrawlSources().items || [];
  const { lastSeen, todayNew } = sourceListingStats();
  return items.map((row) => sourceHealthFromRow(row, {
    lastSeen: lastSeen.get(row.id) || "",
    todayNew: todayNew.get(row.id) || 0,
  }));
}

function sameHouseCounts() {
  const groups = { suspected: 0, auto_confirmed: 0, admin_confirmed: 0 };
  try {
    for (const row of db.prepare(
      `SELECT confirmation_level AS level, COUNT(*) AS n FROM listing_groups GROUP BY confirmation_level`,
    ).all()) {
      groups[String(row.level || "")] = Number(row.n) || 0;
    }
  } catch {
    // schema may be fresh
  }
  const ungrouped = countSql(`
    SELECT COUNT(*) AS n FROM listings l
    WHERE IFNULL(l.hidden, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM listing_group_members m WHERE m.post_id = l.post_id)
  `);
  const backfill = sameHouseBackfillStatus();
  const pending = remainingSameHouseBackfill(backfill.cursor);
  return {
    ungrouped,
    suspected: groups[CONFIRM_SUSPECTED] || groups.suspected || 0,
    autoConfirmed: groups[CONFIRM_AUTO] || groups.auto_confirmed || 0,
    adminConfirmed: groups[CONFIRM_ADMIN] || groups.admin_confirmed || 0,
    pendingReconcile: pending,
    backfill,
  };
}

// listingPrep 由呼叫端帶入（同步入口沿用 SQLite，PG 模式走 adminOverviewAsync.buildAdminOverviewAsync）。
export function buildAdminOverview(listingPrep) {
  const catalog = readSiteCatalogStats();
  const listingsTotal = countSql("SELECT COUNT(*) AS n FROM listings");
  const todayNew = countSql("SELECT COUNT(*) AS n FROM listings WHERE first_seen_at >= ?", todayStartIso());
  const offlineConfirmed = countSql(
    "SELECT COUNT(*) AS n FROM listings WHERE IFNULL(offline_confirmed, 0) = 1",
  );
  const sameHouse = sameHouseCounts();
  const maps = getAdminMapsSettings();
  const mail = getAdminMailSettings();
  const oauth = getAdminOauthSettings().oauth || {};
  const feedback = getFeedbackStats();
  const importPending = countSql(
    `SELECT COUNT(*) AS n FROM listing_import WHERE status IN (?, ?, ?)`,
    IMPORT_STATUSES.PENDING,
    IMPORT_STATUSES.FETCHING,
    IMPORT_STATUSES.READY_FOR_REVIEW,
  );
  const announcementDrafts = countSql(
    "SELECT COUNT(*) AS n FROM system_announcements WHERE status = 'draft'",
  );
  const smtpTest = lastAuditAction("smtp_test");
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
    catalog: catalog && typeof catalog === "object" ? catalog : null,
    sources: crawlSourceHealth(),
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
      intervalMinutes: getSystemCrawl().intervalMinutes,
      districtCount: (getSystemCrawl().watchDistricts || []).length,
    },
  };
}

export function buildAdminDataHealth(listingPrep) {
  const safe = (sql) => {
    try {
      return db.prepare(sql).get() || {};
    } catch {
      return {};
    }
  };
  const row = safe(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN IFNULL(address, '') = '' THEN 1 ELSE 0 END) AS missing_address,
      SUM(CASE WHEN lat IS NULL OR lng IS NULL THEN 1 ELSE 0 END) AS missing_coords,
      SUM(CASE WHEN IFNULL(floor_name, '') = '' THEN 1 ELSE 0 END) AS missing_floor,
      SUM(CASE WHEN IFNULL(area_name, '') = '' THEN 1 ELSE 0 END) AS missing_area,
      SUM(CASE WHEN IFNULL(layout, '') = '' THEN 1 ELSE 0 END) AS missing_layout,
      SUM(CASE WHEN IFNULL(extra_fees, '') IN ('', '[]', 'null')
                 AND IFNULL(extra_fee, '') = ''
                 AND IFNULL(extra_fee_text, '') = '' THEN 1 ELSE 0 END) AS missing_fees,
      SUM(CASE WHEN IFNULL(furnish_items, '') IN ('', '[]') THEN 1 ELSE 0 END) AS missing_furnish
    FROM listings
    WHERE IFNULL(hidden, 0) = 0
  `);
  const suspected = countSql(
    `SELECT COUNT(*) AS n FROM listing_groups WHERE confirmation_level = ?`,
    CONFIRM_SUSPECTED,
  ) || countSql(
    `SELECT COUNT(*) AS n FROM listings
     WHERE IFNULL(match_post_id, 0) > 0 AND IFNULL(match_verdict, '') != 'yes' AND IFNULL(hidden, 0) = 0`,
  );
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

export function getAdminOverview() {
  return buildAdminOverview(listingPrepAdminStats(db));
}

export function getAdminDataHealth() {
  return buildAdminDataHealth(listingPrepAdminStats(db));
}
