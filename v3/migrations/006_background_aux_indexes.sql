-- 006_background_aux_indexes.sql
--
-- 目的：把**背景迴圈**的兩條集合式輔助查詢所需的索引收進可重跑的遷移路徑
--       （2026-10-12，背景輔助查詢瘦身第二包；第一包是 PR #719 的會員列表路徑）。
--
-- ⚠️ 這一支**不要**接進 `SCHEMA_MIGRATIONS`（`v3/src/migrate.js:73` 每支包在一個交易區塊裡，
--    而 `CREATE INDEX CONCURRENTLY` 在交易區塊內會 `PreventInTransactionBlock`）。
--    由 planner 手動套正式庫，檔內不得有交易控制語句，psql 不要加 `--single-transaction`：
--
--      psql "$PG_URL" -v ON_ERROR_STOP=1 -f v3/migrations/006_background_aux_indexes.sql
--
-- 背景（隔離量測庫 repro＝正式庫凍結快照，`EXPLAIN (ANALYZE, BUFFERS)`、`SET jit = off`，
-- 2026-10-12 實測；索引以「開一個交易區塊建立、量完就回滾」的方式量，不留在庫裡）：
--
--   1) `listing_enrich_jobs` 在 PostgreSQL **沒有** post_id 索引（SQLite 的
--      `post_id INTEGER NOT NULL UNIQUE` 沒有被鏡射過來；`pg_indexes` 只有 pkey 與
--      `idx_enrich_jobs_claim`）。所以 seed 的一輪：
--        SELECT * FROM listing_enrich_jobs WHERE post_id = ANY($1::bigint[])
--      舊計畫：Seq Scan，Rows Removed by Filter: 11116，Buffers: shared hit=656，5.277 ms
--      新計畫：Bitmap Index Scan on idx_enrich_jobs_post_id → 0.343 ms
--   2) `user_events` 只有 `idx_user_events_user (user_id, notified)`，通知入列的去重讀取
--      要再過濾 post_id／type 並排序：
--        SELECT user_id, detail FROM user_events
--         WHERE user_id = ANY($1::bigint[]) AND post_id = $2 AND type = $3
--         ORDER BY user_id, id DESC
--      舊計畫：Seq Scan on user_events，Rows Removed by Filter: 9491，Buffers: shared hit=408，3.372 ms
--        （逐會員版的單筆查詢是 2.864 ms／位，22 位＝63 ms／事件）
--      新計畫：Index Scan using idx_user_events_user_post_type → 0.228 ms（22 位一起）
--
-- 兩顆都是**非唯一**索引：`listing_enrich_jobs.post_id` 在正式庫沒有唯一約束，
-- 不在這裡順手加上（CONCURRENTLY 建唯一索引會在遇到重複值時失敗，而正式庫現況無從事先保證；
-- repro 快照 11,156 列／11,156 個相異 post_id，但那只代表快照）。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_enrich_jobs_post_id
  ON listing_enrich_jobs (post_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_events_user_post_type
  ON user_events (user_id, post_id, type, id);
