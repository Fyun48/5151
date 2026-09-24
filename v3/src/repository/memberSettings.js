// 會員設定／搜尋設定檔的語句文字（settingsAsync.js 的 PG 分支用；SQLite 分支跑 db.js 的同步函式）。
//
// 只放「文字與參數順序」，判斷全部留在 db.js／settingsState.js／searchProfiles.js，
// 所以兩個 driver 的結果不可能不同。`?` 佔位符由 sqlDialect.toPostgresSql() 轉成 `$n`。
//
// PG 端的唯一鍵（2026-09-24 實查）：`settings(key)`、`user_settings(user_id, key)`、
// `user_search_profiles(user_id, id)` —— ON CONFLICT 直接對得上，不需要額外索引。
// 讀取用的三條（ACTIVE_PROFILE_SQL 等）在 searchProfiles.js，兩邊共用同一份文字。
export const GLOBAL_SETTINGS_SQL = "SELECT key, value FROM settings";
export const USER_SETTINGS_SQL = "SELECT key, value FROM user_settings WHERE user_id = ?";
export const SITE_SETTING_UPSERT_SQL =
  "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
export const USER_SETTING_UPSERT_SQL =
  "INSERT INTO user_settings(user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value";
export const USER_BY_ID_SQL = "SELECT * FROM users WHERE id = ?";

export const PROFILE_DEACTIVATE_ALL_SQL =
  "UPDATE user_search_profiles SET active = 0, updated_at = ? WHERE user_id = ? AND active = 1";
export const PROFILE_VERSION_SQL = "SELECT version FROM user_search_profiles WHERE user_id = ? AND id = ?";
export const PROFILE_UPDATE_SQL = `UPDATE user_search_profiles
        SET active = 1, version = version + 1, last_used_at = ?, updated_at = ?,
            name = COALESCE(?, name),
            data_json = COALESCE(?, data_json)
        WHERE user_id = ? AND id = ?`;
export const PROFILE_INSERT_SQL = `INSERT INTO user_search_profiles(id, user_id, name, data_json, active, version, last_used_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`;
export const PROFILE_BY_ID_SQL = "SELECT * FROM user_search_profiles WHERE user_id = ? AND id = ?";
