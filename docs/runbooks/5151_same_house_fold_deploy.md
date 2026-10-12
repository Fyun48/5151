# 同屋源折疊（`fold_component_root`）部署 runbook

> 對象：Owner／發版執行者。語意權威是 `docs/same-house-fold-spec.md`（§1.4／§1.5／§6）。
> 本檔只講**順序、指令、以及什麼事件會讓已回填的值失效**。
> 2026-10-12 群內代表裁決（零容差）之後，讀取端**硬依賴** `listings.fold_component_root`：
> 候選載體（`listingCandidateRow.js`）含此欄 ⇒ 欄位不存在時列表查詢會 `42703`。

## 0. 兩個開關（互相獨立，別搞混）

| 開關 | 預設 | 語意 |
|---|---|---|
| `PUBLIC_LISTINGS_SQL_FIRST`（`publicListingSearchAsync.js`） | **off（不准改）** | 訪客公開列表是否走 SQL-first 折疊路徑。**先合、不開閘**：這包不開。 |
| `listings.fold_component_root` 欄位 | 不存在 | 兩條讀取路徑的分組鍵。欄位未部署 ⇒ SQL 讀取端 42703、Node 讀取端走 legacy union-find（SQLite 一直如此）。 |

## 1. 部署順序（L-0595／L-0571，**不可跳步、不可換序**）

```bash
# 1) ALTER（CONCURRENTLY ⇒ 不接 SCHEMA_MIGRATIONS）
psql "$PG_URL" -v ON_ERROR_STOP=1 -f v3/migrations/007_listings_fold_component_root.sql

# 2) 回填（冪等；分批 2,000／批、每批一個交易；中斷直接重跑）
node v3/scripts/fold-root-backfill.mjs --label=<日期>-prod

# 3) 逐欄抽樣 diff＝0 才能往下（L-0571）
node v3/scripts/projection-freshness-check.mjs          # 輸出含 foldRoot.sampled / foldRoot.mismatch
#    期望：foldRoot.mismatch = 0（逐欄抽樣，預設 200 列、決定性抽樣）
node v3/scripts/fold-freshness-check.mjs                # fold_* 四欄的獨立過時檢查

# 4) 才切讀取（部署含本 PR 的程式）
```

- 3) 沒有 `columnMismatch = 0` 就**不要**進 4)：讀取端會用「舊／空 root」分組。
- 回填只跑隔離庫（`assertPgTargetAllowed` 白名單）或由 Owner 對正式庫執行；正式庫的查詢一律唯讀。

## 2. 髒事件 ⇒ 必須重跑回填（`fold-root-backfill.mjs`）

下列任一變更都會讓**已固化的 root 過期**，必須重跑回填（可先跑 §3 的檢查確認）：

1. `crawlSources` 啟停（來源啟停會改變 `display_ready` 的判定 ⇒ 分量邊的「兩端 display-ready」閘改變）。
2. `listing_prep.display_ready` 變更。
3. `listings.source` 變更。
4. `listings.match_post_id` 變更（新增／撤銷 match 邊）。
5. `listings.match_verdict` 變更（變 `no` 會撤銷邊）。
6. `listings.offline_confirmed` 變更（確認下架不參與選主，也會影響 `display_ready` 閘）。
7. `listing_group_members` 任何成員進出（系統同屋源群組是分量的第二種邊）。

> 註：`user_same_house_members`／`user_match_votes(split)` 是**個人輸入、不固化**（§6.5），
> 不需要重跑回填。

## 3. 回填後的自檢（唯讀）

```bash
export PG_URL="$PG_SNAPSHOT_REPRO2_URL"        # 隔離／凍結快照；正式庫唯讀查詢
node v3/scripts/fold-freshness-check.mjs        # 髒事件／抽樣漂移檢查
node v3/scripts/fold-root-mutation-check.mjs    # root 對邊變更的敏感度（突變測試）
node v3/scripts/fold-role-sql-parity.mjs --roots=column
#    期望：roleMatch = total、pct = 100.0000%
```

## 4. 兩層防線

1. **CI（自動）**：合成種子（含線狀鏈、橋式／非橋式、代表列隨篩選變動）跑
   `fold-role-sql-parity`／端點 parity ⇒ 語意分歧在 PR 就紅。**不使用正式資料**。
2. **人工（merge 前）**：全量凍結快照（`repro2`）跑

```bash
node v3/scripts/fold-endpoint-parity.mjs          # 35/35 totalMatched ＋ 前 20 筆順序
node v3/scripts/fold-endpoint-symmetric-diff.mjs  # 逐列對稱差（只有 Node／只有 SQL）皆為空
node v3/scripts/fold-endpoint-pagination.mjs      # 分頁合併＝完整有序集合，無重複無遺漏
node v3/scripts/fold-shape-fixtures.mjs           # ⑥⑦⑧ 合成列 fixture（可寫隔離庫）
```

## 5. 回復（rollback）

- 程式回滾即可：欄位留著無害（舊程式不讀它）。
- 讀取端換回 Node 路徑時，`fold_component_root` 不必清空（只是不再被讀）。
