#!/usr/bin/env bash
# 5151 正式庫索引落地腳本（隔離庫 crawl_sandbox 實測後產生，2026-10-10）
# 證據與完整結論：evidence/sqlite-exit/perf-index-findings.md
#
# ⚠️ 預設「不跑任何索引」。實測結論：
#    - match_post_id partial、search_key、複合排序索引：**實測無效／低價值，本腳本不建**。
#    - trigram title/address：**僅在代碼把 `CAST(post_id AS TEXT) LIKE` 項拆出後才有用**，
#      且只對 ≥3 字關鍵字有效。放在條件式區塊，需先設 RUN_TRIGRAM=1 且完成 §6.2 拆 post_id。
# ⚠️ 本腳本**不執行任何 ALTER TABLE ADD COLUMN／UPDATE**（那是折疊包的事）。
#
# 用法（正式庫由 Owner 手動執行；先跑第一支再繼續）：
#   export PATH=/usr/local/bin:/bin:/usr/bin:$PATH
#   PGHOST=... PGPORT=... PGDATABASE=5151_shadow PGUSER=... bash evidence/sqlite-exit/index-landing-script.sh
set -euo pipefail

DB="${PGDATABASE:-5151_shadow}"
echo "== 目標庫：$DB =="
echo "== 跑前基線：listings / projection 列數 =="
psql -v ON_ERROR_STOP=1 -X -c "SELECT (SELECT count(*) FROM listings) AS listings, (SELECT count(*) FROM listing_search_projection) AS projection;"

# ---------------------------------------------------------------------------
# 區塊 A：建議時段（避開抓取輪次）
# ---------------------------------------------------------------------------
cat <<'NOTE'
抓取輪次節奏判讀（casa-nas host）：
  ssh casa-nas "docker logs --since 30m 591-tracker-v3 2>&1 | grep -c '輪'"
建議挑「無輪次、active writer=0」的窗口跑；每條 CONCURRENTLY 都會等舊 snapshot 結束，
若剛好有長查詢（公開列表 27s）會卡在 phase 2（waiting for snapshots）。
NOTE

# ---------------------------------------------------------------------------
# 區塊 B：條件式 trigram 索引（預設不跑）
# ---------------------------------------------------------------------------
if [ "${RUN_TRIGRAM:-0}" = "1" ]; then
  echo "== 條件式：trigram 索引（僅在代碼已拆出 post_id OR 項後才有用）=="
  echo "-- 觀察：另開 psql session 每 1s 執行下方 SELECT 看進度 --"
  echo 'psql -c "SELECT phase, lockers_total, lockers_done, blocks_total, blocks_done, tuples_total, tuples_done FROM pg_stat_progress_create_index;"'

  # B1. lower(title) GIN；預估 ~5.5s／~41MB（由 71,726 列/16MB/2.15s ×2.56 外推）
  psql -v ON_ERROR_STOP=1 -X -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_title_lower_trgm ON listings USING gin (lower(title) gin_trgm_ops);"

  # B2. lower(address) GIN；預估 ~2.2s／~13.5MB
  psql -v ON_ERROR_STOP=1 -X -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_address_lower_trgm ON listings USING gin (lower(address) gin_trgm_ops);"

  echo "-- 每條建完後確認有效（CONCURRENTLY 失敗會留 INVALID 必須清掉）--"
  psql -v ON_ERROR_STOP=1 -X -c "SELECT indexrelid::regclass AS idx, indisvalid FROM pg_index WHERE indexrelid::regclass::text LIKE 'idx_listings_%_lower_trgm';"
else
  echo "== 跳過 trigram（RUN_TRIGRAM 未設為 1；實測現行代碼下 0 收益）=="
fi

# ---------------------------------------------------------------------------
# 區塊 C：跑完要看的三個數字
# ---------------------------------------------------------------------------
cat <<'NOTE'
跑完驗證的三個數字：
1. 三組查詢毫秒（EXPLAIN ANALYZE 或 app 容器內直連）：
   - 無關鍵字整表候選（36 欄 ORDER BY post_id）、q=套房、districts+priceMax
   （預期：本腳本不建 match/search_key/複合索引 ⇒ 這三組不應有顯著變化；trigram 只動 ≥3 字關鍵字）
2. pg_stat_user_indexes.idx_scan 是否開始增長：
   SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE indexrelname LIKE '%lower_trgm';
3. pg_stat_activity 有無被卡在 creating index（phase 2 等 snapshot）：
   SELECT state, wait_event_type, wait_event, left(query,60) FROM pg_stat_activity
   WHERE query LIKE '%CREATE INDEX%' OR wait_event_type IS NOT NULL;
NOTE

# ---------------------------------------------------------------------------
# 區塊 D：回退（逐條）
# ---------------------------------------------------------------------------
cat <<'NOTE'
回退指令（正式庫，逐條）：
  DROP INDEX CONCURRENTLY IF EXISTS idx_listings_title_lower_trgm;
  DROP INDEX CONCURRENTLY IF EXISTS idx_listings_address_lower_trgm;
NOTE
