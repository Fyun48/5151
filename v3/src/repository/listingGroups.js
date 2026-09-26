// 同物件群組（listing_groups／listing_group_members）與配對評估
// （listing_match_evaluations）的 PostgreSQL 語句。
//
// 為什麼需要：PG 模式的**讀取**路徑已經在 `repository/decorationData.js` 用
// `listing_group_members`（loadGroupIds／loadGroupMemberRows／loadGroupMemberRowsFor），
// 但**寫入**仍走 db.js→listingGroups.js 的同步 SQLite handle。讀 PG、寫 SQLite 的結果是：
// 新配對只落在「產生它的那台節點」的 SQLite，站上讀 PG 永遠看不到，而且兩台各自累積
// （2026-09-26 實測 listing_group_members 45,247／45,213、listing_match_evaluations
// 961,406／891,503，且仍在寫入）。
//
// 語句文字與 listingGroups.js 的同步版本逐字相同；`?` 佔位符與 IFNULL 由
// sqlDialect.translateSqliteToPg() 在執行時轉換，所以兩個 driver 跑的是同一份文字
// （與 listings-pg-parity / settings-driver-parity 同一條規則）。

export const GROUP_ID_FOR_POST_SQL = "SELECT group_id FROM listing_group_members WHERE post_id = ?";

export const GROUP_RECORD_SQL = "SELECT * FROM listing_groups WHERE group_id = ?";

// `IN (?,?,…)` 由呼叫端依 id 數量組出，與 listingGroups.pickCanonicalGroupId 相同。
export function pickCanonicalGroupIdSql(count) {
  return `SELECT group_id, created_at FROM listing_groups WHERE group_id IN (${Array.from({ length: count }, () => "?").join(",")})`;
}

export const LIST_GROUP_MEMBERS_SQL = `SELECT l.*, m.group_id, m.match_confidence, m.match_evidence
    FROM listing_group_members m
    JOIN listings l ON l.post_id = m.post_id
    WHERE m.group_id = ?`;

export const INSERT_GROUP_MEMBER_SQL = `INSERT INTO listing_group_members(post_id, group_id, source, match_confidence, match_evidence, joined_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(post_id) DO UPDATE SET
        group_id = excluded.group_id,
        source = CASE WHEN excluded.source != '' THEN excluded.source ELSE listing_group_members.source END,
        match_confidence = COALESCE(excluded.match_confidence, listing_group_members.match_confidence),
        match_evidence = excluded.match_evidence`;

export const TOUCH_GROUP_SQL = "UPDATE listing_groups SET updated_at = ? WHERE group_id = ?";

export const DELETE_GROUP_SQL = "DELETE FROM listing_groups WHERE group_id = ?";

export const MOVE_GROUP_MEMBERS_SQL = "UPDATE listing_group_members SET group_id = ? WHERE group_id = ?";

export const DELETE_GROUP_MEMBERS_SQL = "DELETE FROM listing_group_members WHERE group_id = ?";

export const DELETE_MEMBER_SQL = "DELETE FROM listing_group_members WHERE post_id = ?";

export const COUNT_GROUP_MEMBERS_SQL = "SELECT COUNT(*) AS n FROM listing_group_members WHERE group_id = ?";

export const SET_PRIMARY_SQL = "UPDATE listing_groups SET primary_post_id = ?, updated_at = ? WHERE group_id = ?";

// 群組合併時把作用中的關注與事件綁到 canonical id；未關注的 watch_group_id 不搬。
export function migrateWatchFlagsSql(count) {
  return `UPDATE user_listing_flags SET watch_group_id = ? WHERE watched = 1 AND watch_group_id IN (${Array.from({ length: count }, () => "?").join(",")})`;
}

export function migrateUserEventsSql(count) {
  return `UPDATE user_events SET group_id = ? WHERE group_id IN (${Array.from({ length: count }, () => "?").join(",")})`;
}

export const GROUP_AUDIT_INSERT_SQL = `INSERT INTO listing_group_audits(action, admin_user_id, post_ids, previous_group_ids, resulting_group_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`;

export const MATCH_EVALUATION_INSERT_SQL = `INSERT INTO listing_match_evaluations(
        post_id, candidate_post_id, candidate_source, confidence, level,
        signals, veto_reasons, matcher_version, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// 配對結果欄位（db.js setListingMatch）。
export const SET_LISTING_MATCH_SQL = `UPDATE listings
     SET match_post_id = ?, match_level = ?, match_detail = ?, match_rejected = 0
     WHERE post_id = ?`;

// db.js setListingMatch／reconcileListingById 讀單列房源（配對與評估都要完整列）。
export const LISTING_BY_POST_SQL = "SELECT * FROM listings WHERE post_id = ?";

// listing_groups upsert：confirmation_level 只升不降、admin 只能由 admin 覆寫。
// 這一段的 CASE 直接沿用 listingGroups.js 的同步版本（含常數展開），避免兩份規則分歧。
export function insertGroupSql({ confirmAdmin, confirmAuto, confirmSuspected }) {
  return `INSERT INTO listing_groups(group_id, primary_post_id, created_at, updated_at, confirmation_level, confirmed_by, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        confirmation_level = CASE
          WHEN listing_groups.confirmation_level = '${confirmAdmin}' THEN listing_groups.confirmation_level
          WHEN excluded.confirmation_level = '${confirmAdmin}' THEN excluded.confirmation_level
          WHEN listing_groups.confirmation_level = '${confirmAuto}' AND excluded.confirmation_level = '${confirmSuspected}'
            THEN listing_groups.confirmation_level
          ELSE excluded.confirmation_level
        END,
        confirmed_by = CASE
          WHEN excluded.confirmation_level = '${confirmAdmin}' THEN excluded.confirmed_by
          ELSE listing_groups.confirmed_by
        END,
        confirmed_at = CASE
          WHEN excluded.confirmation_level = '${confirmAdmin}' THEN excluded.confirmed_at
          ELSE listing_groups.confirmed_at
        END`;
}
