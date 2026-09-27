-- 002_pg_reconcile_indexes.sql
--
-- 目的：讓 same-house reconcile 的候選查詢能在 PostgreSQL 上走索引。
--
-- 背景（2026-09-26 上線失敗的根因）：
--   `public.listings` 在生產 PG 上原本只有 3 個索引（post_id 主鍵、match_verdict、
--   (offline, offline_confirmed)），而 v3/src/sameHouseReconcile.js 的候選查詢
--   三個 OR 分支全部無法使用索引，導致每次執行都是 127k 筆全表掃描（實測 ~300ms）。
--   該查詢位於 crawler 逐筆熱路徑（watcher.js 明細增強後呼叫），
--   因此 crawl 週期永遠跑不完 —— 實測 5 分鐘內執行 993 次（≈3.31/s）。
--
--   PostgreSQL 只有在 **每一個 OR 分支都可索引** 時才會使用 BitmapOr；
--   只要有一個分支不可索引，整個 OR 就退回全表掃描。所以下面三個索引缺一不可。
--
-- 為什麼需要 pg_trgm：
--   地址比對是 `... LIKE '%街名%'`（前導萬用字元），btree 完全無用，必須用 trigram GIN。
--   已確認生產 primary 可用：pg_available_extensions 有 pg_trgm 1.6（PG 16.14，未安裝）。
--
-- 套用方式（生產 primary，一次）：
--   docker exec -i 5151-postgres-B psql -X -w -U postgres -d 5151_shadow -v ON_ERROR_STOP=1 \
--     < v3/migrations/002_pg_reconcile_indexes.sql
--
-- 本檔可重複執行（全部 IF NOT EXISTS），不需要明確交易。
-- 刻意使用 CONCURRENTLY：建立期間不阻擋 crawler 的寫入。
-- 注意：CONCURRENTLY 不能在 BEGIN/COMMIT 區塊內執行，psql 請勿加 --single-transaction。

-- 1) trigram 擴充（地址的 '%…%' 比對需要）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2) 正規化地址的 trigram GIN。
--    運算式必須與查詢端逐字相同（經 toPostgresSql 轉換後）：
--      replace(replace(COALESCE(address, ''), ' ', ''), '-', '')
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_addr_norm_trgm
  ON listings USING gin (
    (replace(replace(COALESCE(address, ''), ' ', ''), '-', '')) gin_trgm_ops
  );

-- 3) 正規化 community_name 的 btree（查詢端是等號比對）。
--      replace(COALESCE(community_name, ''), ' ', '')
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_community_norm
  ON listings ((replace(COALESCE(community_name, ''), ' ', '')));

-- 4) 座標 btree。查詢端已由 ABS(lat - ?) < 0.002 改寫為
--      lat > ? AND lat < ? AND lng > ? AND lng < ?
--    這是嚴格的範圍條件，可走此複合索引。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_lat_lng
  ON listings (lat, lng);

-- 驗證（套用後請確認三個索引都存在**且有效**）：
--   ⚠️ CONCURRENTLY 的陷阱：建置失敗會留下 INVALID 索引，而 `IF NOT EXISTS` 之後不會重建它
--   （名字已存在）。所以不能只看 pg_indexes，一定要檢查 indisvalid。
--   若有 INVALID，必須先 DROP INDEX 再重跑本檔（例如 DROP INDEX IF EXISTS idx_listings_addr_norm_trgm;）。
--   SELECT c.relname, i.indisvalid
--     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('idx_listings_addr_norm_trgm','idx_listings_community_norm','idx_listings_lat_lng')
--    ORDER BY c.relname;
--   三個都必須是 indisvalid = true。
--
-- 驗證計畫真的走索引（必須看到 BitmapOr / Bitmap Index Scan，不可出現 Seq Scan on listings）：
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT * FROM listings
--    WHERE post_id != 1
--      AND ( (replace(replace(COALESCE(address,''),' ',''),'-','') LIKE '%中山路%')
--         OR (replace(COALESCE(community_name,''),' ','') = '某社區')
--         OR (lat > 25.033 AND lat < 25.037 AND lng > 121.55 AND lng < 121.554) )
--      AND (fixture_namespace IS NULL OR fixture_namespace = '')
--    ORDER BY COALESCE(offline,0) DESC, last_seen_at DESC
--    LIMIT 80;
--
-- 注意：建立索引後務必跑 ANALYZE，讓 planner 有最新統計值。
ANALYZE listings;
