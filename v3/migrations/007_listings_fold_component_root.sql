-- 007_listings_fold_component_root.sql
--
-- 目的：同屋源折疊的「連通分量」固化欄（Owner 2026-10-12 裁示：准 (B) 方案）。
--
--   `listings.fold_component_root` ＝ 該列所屬同屋源連通分量的 canonical label
--   （分量成員中最小 post_id）。NULL ＝ 單節點分量（沒有同屋源關係）或尚未回填。
--
-- 讀取端 `foldRoleCte`（v3/src/listingSearchSql.js）不再用 window function 逐邊算分量，
-- 改成 `WHERE fold_component_root = ANY(候選列 roots)` 的**一次索引查詢**，再在分量內排名
-- 取主卡；寫入端由 fold 刷新漏斗（match.js refreshFoldColumns → foldComponentRoot.js
-- 的同一份 union-find）與 `v3/scripts/fold-root-backfill.mjs` 維護。
--
-- ⚠️ 這一支**不要**接進 `SCHEMA_MIGRATIONS`（`v3/src/migrate.js` 每支包在一個交易區塊，
--    而 `CREATE INDEX CONCURRENTLY` 在交易區塊內會 `PreventInTransactionBlock`）。
--    由 Owner 在發版時手動套（檔內不得有交易控制語句，psql 不要加 `--single-transaction`）：
--
--      psql "$PG_URL" -v ON_ERROR_STOP=1 -f v3/migrations/007_listings_fold_component_root.sql
--
-- 順序硬規則（L-0595／L-0571）：ALTER → 全表分批冪等回填 → 逐欄抽樣 columnMismatch=0
-- → 才准切讀取。也就是說：**先跑這一支＋ fold-root-backfill.mjs 把欄位填滿，再部署含
-- 新 foldRoleCte 的程式版本**；反過來（先切讀取）會讓所有列都被當成「無分量」而少折疊。
ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_component_root bigint;

COMMENT ON COLUMN listings.fold_component_root IS
  '同屋源連通分量的 canonical label（成員中最小 post_id；NULL=單節點分量或未回填）。由 fold 刷新漏斗／fold-root-backfill.mjs 以單一份 union-find 維護，讀取端 foldRoleCte 只讀不算。';

-- 讀取端 `JOIN roots r ON r.croot = l.fold_component_root` 的起點；部分索引即可（NULL 佔多數）。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_fold_component_root
  ON listings (fold_component_root)
  WHERE fold_component_root IS NOT NULL;
