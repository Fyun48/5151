// 爬蟲進度狀態（樂屋抓取游標、source-kit 重試）與房源配對寫入的 PostgreSQL 語句。
//
// 為什麼需要：`DB_DRIVER=postgres` 時，`getRakuyaPageCursors／saveRakuyaPageCursors`、
// `markSourceKitRetry`、`setListingMatch` 仍走 db.js 的同步 SQLite handle，所以兩個 web 節點
// 各自在自己的 SQLite 累積進度與配對結果。實測（2026-09-26）兩台的
// `listing_match_evaluations`（961,406／891,503）、`listing_groups`（14,508／14,497）、
// `listing_group_members`（45,247／45,213）已經不一致，且仍在持續寫入。
//
// 語句文字沿用 db.js 既有的字串（`settings` 的 upsert 與 crawlScheduleAsync 相同），
// 讓兩個 driver 的行為可以逐字對照。

// db.js settingKey()／writeSettingKey() 用的鍵。
export const RAKUYA_CURSORS_KEY = "rakuyaPageCursors";

export const READ_SETTING_SQL = "SELECT value FROM settings WHERE key = ?";

export const UPSERT_SETTING_SQL =
  "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

// db.js markSourceKitRetry()：重試排程與錯誤訊息。
export const MARK_SOURCE_KIT_RETRY_SQL = `UPDATE listings
   SET kit_error = ?, kit_next_retry_at = ?
 WHERE post_id = ?`;

// db.js setListingMatch()：配對結果欄位（群組副作用另由 bindListingsToGroup 處理）。
export const SET_LISTING_MATCH_SQL = `UPDATE listings
   SET match_post_id = ?, match_level = ?, match_detail = ?, match_rejected = 0
 WHERE post_id = ?`;
