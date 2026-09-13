/** 後台總覽／資料健康度／物件搜尋。只讀，不啟動 crawler、geo、route、reconciliation。 */

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

const RAKUYA_OWNER_OFF = "Owner 手動停用";

function countSql(sql, ...params) {
  try {
    return Number(db.prepare(sql).get(...params)?.n) || 0;
  } catch {
    return 0;
  }
}

function todayStartIso(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function sourceHealthFromRow(row, stats = {}) {
  const enabled = row.enabled === true;
  const lastSuccess = stats.lastSeen || "";
  const todayNew = Number(stats.todayNew) || 0;
  const lastError = stats.lastError || "";
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
  };
}

function sourceListingStats() {
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

function oauthServiceStatus(oauth, id) {
  const row = oauth?.[id] || {};
  if (row.enabled && row.configured) return { id, status: "unchecked", statusLabel: "已設定／未檢查" };
  if (row.configured && !row.enabled) return { id, status: "off", statusLabel: "已關閉" };
  return { id, status: "unset", statusLabel: "未設定" };
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

export function getAdminOverview() {
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
    crawl: {
      intervalMinutes: getSystemCrawl().intervalMinutes,
      districtCount: (getSystemCrawl().watchDistricts || []).length,
    },
  };
}

export function getAdminDataHealth() {
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
  };
}

export function searchAdminListings(q, limit = 20) {
  const needle = String(q || "").trim();
  const cap = Math.max(1, Math.min(40, Number(limit) || 20));
  if (!needle) return [];
  if (/^\d+$/.test(needle)) {
    const row = db.prepare(
      `SELECT post_id, title, address, source, price, url
       FROM listings WHERE post_id = ?`,
    ).get(Number(needle));
    return row ? [row] : [];
  }
  const like = `%${needle.replace(/[%_]/g, "")}%`;
  return db.prepare(
    `SELECT post_id, title, address, source, price, url
     FROM listings
     WHERE title LIKE ? OR IFNULL(address, '') LIKE ?
     ORDER BY last_seen_at DESC
     LIMIT ?`,
  ).all(like, like, cap);
}

export { RAKUYA_OWNER_OFF };
