-- 003_admin_members_indexes.sql
--
-- 目的：把 2026-10-11 後台「會員管理」連線逾時事故需要的三顆索引入庫，並補上
--       `users(lower(email))`（登入／session 驗證路徑）。
--
-- 背景（2026-10-11 14:08–14:11 正式站事故，Owner 實測）：
--   1. 後台會員列表是 `Promise.all(users.map(adminMemberViewAsync))`，每位會員各 3 條查詢
--      ⇒ 28 個會員約 84 條同時打出去，app 端 PG 連線池拿不到連線，5 秒後整頁失敗：
--      `[pg] failed query after 5008ms :: timeout exceeded when trying to connect :: SELECT * FROM users WHERE email=…`
--      （PG 本身沒有爆：`max_connections=100`，實測只用了 21 條連線。）
--   2. 放大器是**缺索引**。`countOpenSelfListings()` 的
--        SELECT COUNT(*) AS n FROM listings
--         WHERE listed_by_user_id = ? AND COALESCE(source,'591')='self' AND COALESCE(self_status,'open')='open'
--      在生產走 `Seq Scan on listings`：186,187 列／42,359 頁、`Rows Removed by Filter: 186,161`，
--      單筆實測 508ms～8,625ms。這條查詢在後台每一列都會被叫到。
--
--   修正後（同一條 COUNT、同一份資料）：
--     • `idx_listings_listed_by_user_id` ⇒ `Index Scan`，508ms → **0.33ms**。
--     • 程式端同時把 3N 條查詢批次化成常數條（`v3/src/adminMembersAsync.js` 的
--       `loadAdminMemberBatchAsync()`），兩邊一起修；本檔只負責索引那一半。
--
-- ⚠️ 索引名稱必須與生產既有的一致（`idx_listings_listed_by_user_id`／`idx_user_settings_user_id`／
--    `idx_users_email_lower`），否則之後會**重複建**一份同義索引。
--
-- 套用方式（生產 primary／任何既有 PG 環境，一次）：
--   docker exec -i 5151-postgres-B psql -X -w -U postgres -d 5151_shadow -v ON_ERROR_STOP=1 \
--     < v3/migrations/003_admin_members_indexes.sql
--
-- ⚠️ 一定要**逐句**送出（psql 讀檔就是逐句送）。實測踩過：把整份檔案當**一個** query 送出
--   （例如 node-pg 的 `driver.exec(<整檔>)`，multi-statement simple query）會被 PostgreSQL 包進
--   隱含交易，`CREATE INDEX CONCURRENTLY` 當場失敗：
--   `CREATE INDEX CONCURRENTLY cannot run inside a transaction block ... Routine: PreventInTransactionBlock`。
--   用 node script 套用時請先按 `;` 切句再逐句執行。
--
-- 本檔可重複執行（全部 IF NOT EXISTS），**而且刻意不使用交易**：
--   `CREATE INDEX CONCURRENTLY` 不能在 BEGIN/COMMIT 區塊內執行（psql 請勿加 --single-transaction），
--   這是為了建立期間不阻擋 crawler／寫入路徑。這就是它與 `ensureXxxSchema()`／`ensurePgSchema()`
--   那條「開站時鏡射 SQLite DDL」的路徑分家的原因：那條路徑跑在交易裡、且對既有熱庫會用一般
--   `CREATE INDEX`（186k 列的 listings 會取 ACCESS EXCLUSIVE 鎖並擋住寫入）⇒ 熱庫走本檔，
--   全新環境（repro／CI／沙盒）由鏡射路徑自己建（見 PR 描述）。
--
-- 補充（2026-10-11 在隔離庫 `repro` 的實測觀察，正式站接續處理）：
--   SQLite 的 DDL 早就宣告了 `idx_listings_self_owner_open (listed_by_user_id, self_status, post_id)
--   WHERE COALESCE(source, '591') = 'self'`，PG 的鏡射環境（repro／CI）也有它，同一條 COUNT 在那裡
--   走 `Index Only Scan` 0.07ms；**只有正式站 PG 沒有它**（PG 端沒有任何索引可用 ⇒ Seq Scan）。
--   本次以正式站既有名稱 `idx_listings_listed_by_user_id` 收斂這個缺口；要不要一併把
--   `idx_listings_self_owner_open` 補進正式站 PG 屬於 Owner 決定（見 PR 描述）。

--
-- 為什麼 user_settings 那顆價值有限仍要收：
--   `user_settings_pkey (user_id, key)` 的前綴已經是 `user_id`，單查／批次 IN 都吃得到它。
--   這一顆保留下來是為了與生產既有索引名稱一致（避免之後重複建），成本可忽略（表很小）。

-- 1) 後台「開放中自我刊登數」與 `/api/me` 的 COUNT：等值查詢用的部分索引。
--    `WHERE listed_by_user_id IS NOT NULL` 與查詢的 `= ?`／`IN (…)` 相容（等值集合蘊含 NOT NULL）。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_listed_by_user_id
  ON listings (listed_by_user_id)
  WHERE listed_by_user_id IS NOT NULL;

-- 2) 會員設定（通知間隔）：單人與批次（`user_id IN (…)`）兩條路徑共用的等值索引。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_settings_user_id
  ON user_settings (user_id);

-- 3) 登入／session 驗證路徑的 `lower(email)` 等值查詢（`normalizeEmail()` 之後比對）。
--    表只有 28 列，這顆的價值在「與生產名稱一致」＋查詢計畫穩定。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_lower
  ON users (lower(email));

-- 驗證（套用後請確認三顆都存在**且有效**）：
--   ⚠️ CONCURRENTLY 的陷阱：建置失敗會留下 INVALID 索引，而 `IF NOT EXISTS` 之後不會重建它
--   （名字已存在）。所以不能只看 pg_indexes，一定要檢查 indisvalid。
--   若有 INVALID，必須先 DROP INDEX 再重跑本檔（例如 DROP INDEX IF EXISTS idx_listings_listed_by_user_id;）。
--   SELECT c.relname, i.indisvalid
--     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('idx_listings_listed_by_user_id','idx_user_settings_user_id','idx_users_email_lower')
--    ORDER BY c.relname;
--   三個都必須是 indisvalid = true。
--
-- 驗證計畫真的走索引（必須看到 Index Scan／Bitmap Index Scan，不可出現 Seq Scan on listings）：
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT COUNT(*) AS n FROM listings
--    WHERE listed_by_user_id = <某個會員 id>
--      AND COALESCE(source, '591') = 'self'
--      AND COALESCE(self_status, 'open') = 'open';
--
-- 注意：建立索引後務必跑 ANALYZE，讓 planner 有最新統計值。
ANALYZE listings;
ANALYZE user_settings;
ANALYZE users;
