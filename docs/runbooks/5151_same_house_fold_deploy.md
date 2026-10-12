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
Owner 2026-10-12 R5 裁定的順序（**不可跳步、不可換序**）：

```bash
# 1) 007 DDL（CONCURRENTLY ⇒ 不接 SCHEMA_MIGRATIONS）
psql "$PG_URL" -v ON_ERROR_STOP=1 -f v3/migrations/007_listings_fold_component_root.sql

# 2) 全表回填（冪等；分批 2,000／批、每批一個交易；中斷直接重跑）
node v3/scripts/fold-root-backfill.mjs

# 3) 全量 drift 零差（**必要步驟，不是抽樣**，R2）：整表重算 vs 固化欄逐列比對
node v3/scripts/fold-root-drift-check.mjs --stamp
#    期望：{"mismatch":0,"ok":true,"stamped":true}
#    非零 ⇒ **停**：把 mismatchIds 歸因後重跑 2)，不要往下。

# 3b) 抽樣面（輔助，不能代替 3）
node v3/scripts/projection-freshness-check.mjs   # foldRoot.mismatch = 0
node v3/scripts/fold-freshness-check.mjs         # fold_* 四欄

# 4) 部署程式（讀取端開始讀 fold_component_root）
# 5) Owner 開閘：PUBLIC_LISTINGS_SQL_FIRST=1（**只有 Owner 做**）
```

- 3) 沒有 `mismatch = 0` 就**不要**進 4)：讀取端會用「舊／空 root」分組。
- **開閘前檢（fail-closed）**：`PUBLIC_LISTINGS_SQL_FIRST=1` 時，每個請求會先驗「欄位存在 ＋
  `settings.foldRootDriftStamp` 零差」；任一不成立 ⇒ **HTTP 503 ＋ `[fold-gate]` 告警，不降級**
  （語意見 spec §6.9）。3) 的 `--stamp` 就是那個依賴戳記。
- 回填／戳記只跑隔離庫（`assertPgTargetAllowed` 白名單）或由 Owner 對正式庫執行；
  正式庫的其他查詢一律唯讀。

## 2. 髒事件 ⇒ 必須重跑回填（`fold-root-backfill.mjs`）＋重跑 drift（`fold-root-drift-check.mjs --stamp`）

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

### 2.1 實測過的漂移（為什麼這一步是必要的）
- 凍結快照 `repro2`（2026-10-12T08:21Z，184,754 列）：全量 drift 檢查 **mismatch = 15**
  （`21841020, 21876102, 21959307, 22033898, 22059465, 22139928, 22159871, 22160355, 22160479,
  22162147, 22162154, 22162414, 22162432, 22163272, 22164313`）——全部是**回填之後才加入
  `listing_group_members`／match 邊**的列（固化欄仍是 NULL，但重算後屬於 ≥2 的分量）。
- 同一時間的 live 隔離庫 `repro`：mismatch = **34**（快照後又累積 19 列）。
- 跑過 2) 回填後再驗：`differ=34 → written=34`，drift **mismatch = 0**，戳記已寫入。
- 結論：**抽樣抓不到這種列**（15/184,754 ≈ 0.008%），所以部署前必須跑全量，而不是抽樣。

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
2. **部署前（必要，R5 第 3 步）**：`fold-root-drift-check.mjs --stamp` 全量零差（§2.1）。
3. **人工（merge 前）**：全量凍結快照（`repro2`）跑

```bash
node v3/scripts/fold-endpoint-parity.mjs          # 35/35 totalMatched ＋ 前 20 筆順序
node v3/scripts/fold-endpoint-symmetric-diff.mjs  # 逐列對稱差（只有 Node／只有 SQL）皆為空集合
node v3/scripts/fold-endpoint-pagination.mjs      # 有條件的分頁穩定性（語意見 spec §6.7）
node v3/scripts/fold-root-drift-check.mjs         # 全量 drift（唯讀版，目標 0）
node v3/scripts/fold-shape-fixtures.mjs           # ⑥⑦⑧⑩ 合成列 fixture（可寫隔離庫）
```

## 5. 回復（rollback）

- 程式回滾即可：欄位留著無害（舊程式不讀它）。
- 讀取端換回 Node 路徑時，`fold_component_root` 不必清空（只是不再被讀）。
