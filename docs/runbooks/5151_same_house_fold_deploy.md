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
#    期望：{"mismatch":0,"ok":true,"stamped":true,"dataVersion":{...}}
#    非零 ⇒ **停**：把 mismatchIds 歸因後重跑 2)，不要往下。

# 3b) 抽樣面（輔助，不能代替 3）
node v3/scripts/projection-freshness-check.mjs   # foldRoot.mismatch = 0
node v3/scripts/fold-freshness-check.mjs         # fold_* 四欄

# 3c) 戳記的離線複核（升級層 2026-10-12 21:24：「僅有 stamp 不足」）：把 3) 寫進戳記的
#     dataVersion 與資料重算一次逐項比對（rows／maxPostId／rootsMd5 三者都要相同）。
node v3/scripts/fold-gate-stamp-verify.mjs

# 4) 部署程式（讀取端開始讀 fold_component_root）
# 5) Owner 開閘：PUBLIC_LISTINGS_SQL_FIRST=1（**只有 Owner 做**）
```

- 3) 沒有 `mismatch = 0` 就**不要**進 4)：讀取端會用「舊／空 root」分組。
- **開閘前檢（fail-closed）**：`PUBLIC_LISTINGS_SQL_FIRST=1` 時，每個請求會先驗三項
  ——①欄位存在 ②`settings.foldRootDriftStamp` 零差 ③**戳記綁的資料版本＝線上實測值**；
  任一不成立 ⇒ **HTTP 503 ＋ `[fold-gate]` 告警，不降級**（語意見 spec §6.9／§6.10）。
- 回填／戳記只跑隔離庫（`assertPgTargetAllowed` 白名單）或由 Owner 對正式庫執行；
  正式庫的其他查詢一律唯讀。

### 1.1 開閘前必須全部成立的清單（逐條都有可跑指令）

| # | 條件 | 可跑指令 | 期望 |
|---|---|---|---|
| 1 | `fold_component_root` 欄位存在（**跟著 search_path**） | `PG_URL=… node v3/scripts/fold-gate-stamp-verify.mjs`（用 `pg_attribute` ＋ `to_regclass('listings')`；**不用 `information_schema`**，跨 schema 會誤判，L-0869） | `checks.column_present=true` |
| 2 | 全量 drift＝0（**不寫戳記**的唯讀版） | `PG_URL=… node v3/scripts/fold-root-drift-check.mjs` | `{"mismatch":0,"ok":true,"stamped":false}`、rc=0 |
| 3 | 戳記存在且 `mismatches=0` | `PG_URL=… node v3/scripts/fold-gate-stamp-verify.mjs` | `stamp.mismatches=0` |
| 4 | **戳記綁當前資料版本**（`rows`／`maxPostId`／`rootsMd5` 三者都比對） | 同上（`fold-gate-stamp-verify.mjs`） | `dataVersion_match=true`（三者逐項相同） |
| 5 | 線上開閘前檢會放行（同一條判定的真實呼叫） | `PG_URL=… node v3/scripts/fold-gate-stamp-verify.mjs`（它用**真 PG exec** 呼叫 `foldSqlGateReady`） | `{ok:true, detail:{rows,maxPostId,rootsMd5}}` |
| 6 | 告警管道可見（`[fold-gate]` 行） | `docker logs --since 15m <v3 容器> 2>&1 \| grep -c "\[fold-gate\]"`（正式站容器 `591-tracker-v3`；隔離站用該站的容器名） | 開閘後有 503 時看得到那行；平常 0 |
| 7 | 關閘程序就緒（誰按、怎麼退、退後驗什麼） | 見 §5.1 | — |

> 怪異行為一律 fail-closed：上面任一條拿不到「期望」值 ⇒ **不開閘**（維持
> `PUBLIC_LISTINGS_SQL_FIRST` 未設＝off）。

### 1.2 戳記如何綁定資料版本（已實裝 / 未實裝，逐項講清楚）

- **已實裝**：`fold-root-drift-check.mjs --stamp` 在零差時寫入
  `dataVersion = { rows, maxPostId, rootsMd5 }`（`rootsMd5 = md5(string_agg(post_id||'|'||coalesce(fold_component_root::text,'-'),'' ORDER BY post_id))`）。
  線上 `foldSqlGateReady()` 每一請求（成功的判定有 **60 秒 TTL**，失敗永久記憶）比對
  `SELECT count(*) AS n, max(post_id) AS max_post_id FROM listings` 與戳記的 `rows`／`maxPostId`
  ——不符 ⇒ `reason=fold_root_drift_stamp_stale`（503）。
- **未實裝（明文列為開閘前待辦）**：
  1. **原地更新抓不到**：只改 `fold_component_root`、卻沒改列數也沒改 `max(post_id)` 的更新
     （刷新鏈的原地 UPDATE），線上那兩個值不會變 ⇒ 這條靠「髒事件後重跑 `--stamp`」（§2）與
     離線 `rootsMd5` 複核，不是靠線上檢查。**待辦**：刷新鏈寫入 root 時 bump 一個世代鍵
     （`settings.foldRootWriteGen`），線上再比對該世代。
  2. `rootsMd5` 沒有進線上檢查（全表聚合太貴）；它只在 §1.1 第 4 條的離線指令裡比對。
  3. 沒有排程（Owner 2026-10-12 裁示：**先人工**、排程另行提案）⇒ 資料一變，閘門會關到
     有人重跑 `--stamp` 為止；這是已被接受的取捨（fail-closed 優先）。

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
node v3/scripts/fold-shape-fixtures.mjs           # ⑨ 等合成列 fixture（可寫隔離庫）
node v3/scripts/fold-gate-stamp-verify.mjs        # 開閘前檢四項（§1.1 第 1/3/4/5 條）
```

> `repro2` 是**凍結基準**（不得覆寫）；要在「drift=0 的乾淨資料」上量測就用第二顆
> `prb-repro3-pg`（`/home/cline/lab/5151-fold-parity-20261012/repro3-gen.sh` 可重建，指紋見
> `…/results/repro3/fingerprint.txt`）。

## 5. 回復（rollback）

- 程式回滾即可：欄位留著無害（舊程式不讀它）。
- 讀取端換回 Node 路徑時，`fold_component_root` 不必清空（只是不再被讀）。

### 5.1 關閘程序（誰按、怎麼退、退後驗什麼）

1. **誰按**：只有 Owner（`PUBLIC_LISTINGS_SQL_FIRST` 是部署層環境變數；代理人不碰）。
2. **怎麼退**：把該容器的 `PUBLIC_LISTINGS_SQL_FIRST` 移除或設成非 `1`，重啟／重佈該容器
   ——`tryPublicListingsSqlFirst()` 第一行 `!== "1"` 就 return null，舊（Node）路徑完全不受影響
   （`v3/test/fold-sql-gate.test.js` 用原始碼位置釘住這個順序）。
   指令（正式站 `591-tracker-v3`；隔離站換容器名）：
   `ssh casa-nas "docker inspect 591-tracker-v3 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep PUBLIC_LISTINGS_SQL_FIRST"` 先看現值，
   再由 Owner 依發版流程改 env 並重建（**不要**用 `docker exec` 改環境，行程環境改不了）。
3. **退後驗什麼**（三條，缺一不可）：
   - `curl -s -o /dev/null -w '%{http_code}' https://<站台>/api/listings`（或站內對應的公開列表端點）
     回 200，且**與關閘前**的 `totalMatched` 同一個值（`node v3/scripts/fold-lists-totalmatched.mjs`
     在隔離庫上對照，或直接比對回應的 total）。
   - `docker logs --since 5m 591-tracker-v3 2>&1 | grep -c "\[fold-gate\]"` 必須是 **0**
     （關閘後不該再有閘門告警；還有就代表還有人在走 SQL 路徑）。
   - `docker logs --since 5m 591-tracker-v3 2>&1 | grep -c "42703"` 必須是 **0**（缺欄錯誤不該出現）。
