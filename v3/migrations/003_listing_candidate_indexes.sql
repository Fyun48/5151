-- 003_listing_candidate_indexes.sql
--
-- 目的：把「今天已經在正式庫補上、但 repo 沒有正規 DDL」的兩顆索引收進可重跑的
--       遷移路徑，讓下一個環境（隔離庫／新 primary／standby 重建）不會只有正式庫有。
--
-- 背景（2026-10-11 會員列表路徑 15～19 秒的追查）：
--   1) `listings (match_post_id, post_id) WHERE match_post_id IS NOT NULL AND match_post_id <> 0`
--      行政區候選的「關係 closure」（v3/src/listingSearchNodePg.js 的 districtClosureIds）
--      第一步就是 `WHERE match_post_id > 0 OR match_post_id < 0` 的雙向鄰居展開。
--      既有的 `idx_listings_match_peer(match_post_id)` 只涵蓋單欄，關聯取列仍要回表；
--      帶 post_id 的複合索引讓該步變成 index-only。
--      **刻意做成部分索引**：`match_post_id` 絕大多數列是 NULL 或 0，部分索引把索引大小
--      壓到只含真正有配對關係的列（本檔建立時 repro 為 74,363 列／184,245 列）。
--   2) `listing_group_members (group_id)`
--      個人同屋源群組的展開（同一個 closure，以及 decorationData 的 groupMembers 讀取）
--      以 group_id 過濾。`listing_group_members` 的主鍵是 `post_id`，group_id 上沒有索引時
--      每次都要全表掃描。
--
-- 套用方式（單一環境一次，可在連線中的庫上跑）：
--   docker exec -i <pg 容器> psql -X -w -U postgres -d <db> -v ON_ERROR_STOP=1 \
--     < v3/migrations/003_listing_candidate_indexes.sql
--
-- 本檔可重複執行（全部 IF NOT EXISTS），不需要明確交易。
-- 刻意使用 CONCURRENTLY：建立期間不阻擋 crawler 的寫入。
-- 注意：CONCURRENTLY 不能在 BEGIN/COMMIT 區塊內執行，psql 請勿加 --single-transaction。
--      若執行環境一定要在交易內（例如某些 migration runner），就改用一般
--      `CREATE INDEX IF NOT EXISTS`，代價是建立期間會持有 SHARE 鎖、阻擋該表的寫入
--      （184k 列、80MB 規模下約數秒）。

-- 1) 配對關係（雙向鄰居展開）的部分複合索引。
--    索引定義必須與正式庫現存的完全一致（名字與欄位順序）。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_match_post_id
  ON listings (match_post_id, post_id)
  WHERE match_post_id IS NOT NULL AND match_post_id <> 0;

-- 2) 個人同屋源群組以 group_id 過濾。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lgm_group_id
  ON listing_group_members (group_id);
