-- 004_member_listing_stats_indexes.sql
--
-- 目的：把會員列表路徑（`GET /api/listings`）在第二包（stats／prepare）追出來的兩顆索引
--       收進可重跑的遷移路徑。缺少它們時，即使程式碼正確，`prepare` 與 `stats` 仍會出現
--       無法從 Node 端消除的成本。
--
-- 背景（2026-10-11 第二刀；隔離量測庫 repro 實測）：
--   1) 行政區前綴的**表達式索引**。
--      `listings` 沒有 `district` 欄，行政區判定只能用
--        `split_part(source_key,'|',1) || '|' || split_part(source_key,'|',2)`
--      （見 `v3/src/listDistrictSql.js` 的 `districtKeyPrefixExpression('pg')`）。
--      SQLite 端**早就有**對應的 `idx_listings_district_prefix`
--      （`listDistrictSql.js` 的 `ensureDistrictCandidateIndex`），PG 端一直沒有 ⇒
--      每次請求都要對 184,245 列做 `Seq Scan` 來取得「直接相符的行政區列（種子）」。
--
--      這一步是 `prepare` 的主成本（`districtClosureIds` 的第一步）：
--        repro 實測 seed scan `289–352ms → 131–142ms`（同參數、同資料）。
--      `prepare;dur` 因此從 `0.43–0.60s` 降到 `0.25–0.30s`（見 PR 內的矩陣證據）。
--
--      注意：索引運算式必須與查詢**逐字相同**（含 `COALESCE(source_key,'')` 與 `||`），
--      否則 planner 不會採用。改動 `districtKeyPrefixExpression('pg')` 時要一起改這顆索引。
--
--   2) `route_jobs(job_state)` 的部分索引。
--      `stats` 每個請求都會讀「失敗的路由工作」：
--        `SELECT job_key FROM route_jobs WHERE job_state = 'failed'`
--      repro 實測 29–51ms（3,668 列；既有索引是 `(post_id, job_state, next_retry_at)`，
--      前導欄是 post_id ⇒ 這個查詢用不到）。`failed` 只佔全表極小比例，用**部分索引**即可。
--
-- 套用方式（單一環境一次，可在連線中的庫上跑）：
--   docker exec -i <pg 容器> psql -X -w -U postgres -d <db> -v ON_ERROR_STOP=1 \
--     < v3/migrations/004_member_listing_stats_indexes.sql
--
-- 本檔可重複執行（全部 IF NOT EXISTS），不需要明確交易。
-- 刻意使用 CONCURRENTLY：建立期間不阻擋 crawler 的寫入。
-- 注意：CONCURRENTLY 不能在 BEGIN/COMMIT 區塊內執行，psql 請勿加 --single-transaction。
--
-- ⚠️ CONCURRENTLY 的陷阱（與 002 同）：建置失敗會留下 INVALID 索引，而 `IF NOT EXISTS`
--    之後不會重建它（名字已存在）。套用後必須檢查 `indisvalid`：
--      SELECT c.relname, i.indisvalid
--        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--       WHERE c.relname IN ('idx_listings_district_prefix_pg','idx_route_jobs_failed','idx_listings_unknown_district_prefix_pg')
--       ORDER BY c.relname;
--    三個都必須是 `indisvalid = true`；若為 false，先 DROP INDEX 再重跑本檔。

-- 1) 行政區前綴（與 `districtKeyPrefixExpression('pg')` 逐字相同）。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_district_prefix_pg
  ON listings ((split_part(COALESCE(source_key, ''), '|', 1) || '|' || split_part(COALESCE(source_key, ''), '|', 2)));

-- 2) 失敗的路由工作（`stats.loadInputs` 的 auxiliary 讀取）。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_route_jobs_failed
  ON route_jobs (job_state) WHERE job_state = 'failed';

-- 3) 未知／legacy 前綴的種子列（部分索引）。
--    `districtClosureIds` 的第二個種子述詞是 `NOT (prefix = ANY(allKeys))`：**全表掃描**
--    （repro 實測 186ms／5,659 列），一般表達式索引幫不上忙（`NOT IN` 不是索引可尋訪的條件）。
--    `allKeys` 由 `v3/src/regions.js` 決定（本檔建立時 367 個），是**有界且罕變**的清單，
--    所以用「把清單烘進謂詞」的**部分索引**：索引只含 5,659 列（56 kB），查詢變成
--    index scan（repro 實測 186ms → 4.5ms）。
--
--    ⚠️ 維護規則（重要）：這一顆索引的謂詞**逐字包含** `regions.js` 展開後的 367 個行政區鍵，
--    而且**順序也要相同**（planner 用常數陣列相等來判斷能否採用）。`regions.js` 一旦變動
--    （新增／移除／重排行政區），這顆索引就不再被採用 ⇒ 退化為全表掃描（**結果仍然正確**：
--    planner 無法證明蘊含時不會用它，程式端仍會套用真正的述詞；只是變慢）。
--    偵測方式有兩層：
--      1. `v3/test/member-district-prefix-index.test.js`（離線，不需要 DB）比對本檔烘進的
--         陣列與 `districtKeyLists([])` 產生的清單；不一致就紅。
--      2. 下面的 EXPLAIN 驗證指令必須看到 `Index Scan using idx_listings_unknown_district_prefix_pg`。
--    重建方式：`node v3/scripts/member-district-prefix-index.mjs --print` 產生新的陣列。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_unknown_district_prefix_pg
  ON listings (((split_part(COALESCE(source_key, ''), '|', 1) || '|' || split_part(COALESCE(source_key, ''), '|', 2))))
  WHERE NOT (((split_part(COALESCE(source_key, ''), '|', 1) || '|' || split_part(COALESCE(source_key, ''), '|', 2))) = ANY('{1|8,1|9,1|2,1|3,1|4,1|5,1|7,1|10,1|11,1|1,1|6,1|12,3|48,3|47,3|49,3|50,3|26,3|43,3|38,3|37,3|44,3|34,3|39,3|27,3|46,3|45,3|41,3|40,3|42,3|51,3|20,3|21,3|28,3|29,3|30,3|31,3|32,3|33,3|35,3|36,3|52,2|13,2|14,2|15,2|16,2|17,2|18,2|19,6|73,6|67,6|74,6|79,6|75,6|68,6|70,6|69,6|78,6|72,6|71,6|76,6|77,4|371,4|372,4|370,5|54,5|61,5|57,5|58,5|55,5|56,5|59,5|60,5|63,5|65,5|66,5|62,5|64,7|88,7|80,7|81,7|85,7|86,7|87,7|97,7|82,7|83,7|84,7|89,7|90,7|91,7|92,7|94,7|95,7|96,7|93,8|104,8|103,8|105,8|102,8|101,8|100,8|99,8|98,8|107,8|106,8|116,8|117,8|110,8|109,8|108,8|118,8|120,8|123,8|121,8|119,8|122,8|124,8|111,8|125,8|126,8|115,8|112,8|113,8|114,10|127,10|136,10|134,10|131,10|140,10|143,10|144,10|149,10|129,10|128,10|130,10|132,10|133,10|135,10|137,10|138,10|139,10|141,10|142,10|145,10|146,10|147,10|148,10|150,10|151,10|152,11|153,11|155,11|157,11|164,11|160,11|154,11|156,11|158,11|159,11|161,11|162,11|163,11|165,14|194,14|185,14|187,14|200,14|188,14|198,14|186,14|189,14|190,14|191,14|192,14|193,14|195,14|196,14|197,14|199,14|201,14|202,14|203,14|204,12|373,12|374,13|175,13|176,13|181,13|180,13|173,13|171,13|169,13|168,13|167,13|170,13|172,13|174,13|177,13|178,13|179,13|182,13|183,15|212,15|206,15|209,15|207,15|208,15|210,15|211,15|219,15|213,15|241,15|238,15|230,15|214,15|223,15|224,15|220,15|234,15|235,15|222,15|236,15|237,15|232,15|231,15|233,15|239,15|240,15|242,15|215,15|216,15|217,15|218,15|221,15|225,15|226,15|227,15|228,15|229,17|250,17|253,17|247,17|245,17|268,17|251,17|249,17|244,17|243,17|246,17|248,17|252,17|254,17|255,17|271,17|258,17|263,17|262,17|259,17|267,17|282,17|264,17|265,17|266,17|260,17|261,17|269,17|270,17|272,17|273,17|274,17|275,17|276,17|277,17|278,17|279,17|280,17|281,19|295,19|308,19|316,19|326,19|307,19|306,19|299,19|300,19|303,19|304,19|305,19|311,19|301,19|302,19|312,19|313,19|314,19|315,19|318,19|319,19|320,19|321,19|317,19|324,19|327,19|296,19|297,19|298,19|309,19|310,19|322,19|323,19|325,21|328,21|333,21|338,21|329,21|330,21|331,21|332,21|336,21|337,21|334,21|335,21|339,23|357,23|360,23|358,23|361,23|362,23|367,23|359,23|363,23|364,23|365,23|369,23|366,23|368,22|341,22|345,22|346,22|347,22|349,22|351,22|350,22|352,22|353,22|355,22|344,22|348,22|354,22|356,22|342,22|343,24|283,24|288,24|287,24|284,24|285,24|286,25|292,25|290,25|289,25|291,25|293,25|294,26|22,26|23,26|24,26|25}'::text[]));

-- 驗證計畫真的走索引（`idx_listings_district_prefix_pg` 應看到 Bitmap Index Scan／Index Scan，
-- 不可出現 `Seq Scan on listings`）：
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT post_id FROM listings
--    WHERE ((split_part(COALESCE(source_key,''),'|',1) || '|' || split_part(COALESCE(source_key,''),'|',2))
--              IN ('1|1','1|2'))
--       OR ((split_part(COALESCE(source_key,''),'|',1) || '|' || split_part(COALESCE(source_key,''),'|',2))
--              NOT IN ('1|1','2|2'));
--
-- 建立索引後務必跑 ANALYZE，讓 planner 有最新統計值。
-- 驗證第 3 顆索引真的被採用（必須看到 Index Scan，不可出現 Seq Scan on listings）：
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT post_id FROM listings
--    WHERE NOT (((split_part(COALESCE(source_key,''),'|',1) || '|' || split_part(COALESCE(source_key,''),'|',2)))
--                  = ANY('{...367 個鍵，逐字同本檔...}'::text[]));

ANALYZE listings;
ANALYZE route_jobs;
