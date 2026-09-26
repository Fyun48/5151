# 給 ChatGPT astra6 的完整報告：SQLite → PostgreSQL 退出計畫（PR-B 階段）

> 產生者：cline agent（2026-09-24）。目的：把目前狀態、**已量測的阻塞**、候選方案與需要共同決定的問題，
> 以可稽核的證據一次講清楚。所有數字都有可重跑指令；所有主張都標明來源程式位置。

## 0. 一句話現況

PR-A（盤點／存取矩陣）與 PR-B（一致性＋查詢能力下推）已完成大部分並有強證據；
**但實測發現一個既有的嚴重語意缺口：SQL-first 路徑與 Node 路徑的結果不一致（同源配對列多 41%）**，
而它的精確修正在 SQL 端需要跨表與衍生鍵，故**停在此處請求共同規畫**。

## 1. 環境事實（皆為實測）

| 項目 | 值 |
|---|---|
| 節點 | casa-nas：`5151-web-A`、`591-tracker-v3`（crawler）、`5151-haproxy`、`5151-postgres-A`；syn-nas：`5151-web-B`、`5151-haproxy-B`、`5151-postgres-B`、`5151-ops`、`cline-dev`（agent）|
| 應用 driver | 三個應用實例（web-A／web-B／crawler）皆 `DB_DRIVER=postgres`、`DATA_DIR=/data` |
| 生產 DB | `5151_shadow`（schema `public`，user `postgres`）@ `192.168.0.140:25433`；名稱易誤導，它就是正式庫 |
| PG | 16.14、`wal_level=replica`、**`archive_mode=off`（無 PITR）**、`pg_is_in_recovery()=false`（primary）、恰一個 standby `sync_state=async`（⇒ **RPO>0**）|
| 規模 | `listings` 約 12 萬列、DB 549 MB、WAL 目錄 80 MB |

## 2. PR-B 已完成（皆有證據）

1. **寫入一致性**：`persistListing` PG 路徑收斂為單一交易 ＋ change-log 以 **SAVEPOINT** 隔離
   （沒有 SAVEPOINT 時，失敗語句會毒化交易 ⇒ `COMMIT` 變 `ROLLBACK`＝靜默資料遺失）。
2. **投影完整性歸零**：回填 86,522 列、失敗 0，`missing=0 orphan=0 dup=0 nulls=0`（三條獨立證據：
   回填摘要／唯讀複查／每 15 分鐘的監控 timer 歷史）。
3. **`kind` 下推（四層證據）**：述詞探針 14 查詢×2,000 列 `mismatch=0`；單元測試；
   生產資料抽樣 `kind_keys` vs 重算 **5,000/5,000 相同**；端到端（正式 builder SQL × 真實 PG）12 案一致。
   過程中修掉「手寫 key 全集漏 `apartment_huaxia`」的靜默漏列缺陷。
4. **`q` 下推（三層證據）**：兩 driver 量測（原始 `LIKE` 6 案 4 案不一致 → `lower(x) LIKE lower(?)`
   6 案全一致）；單元測試；端到端 8 案一致。
5. **其他下推**：`sources`、`areaMax`（NULL 語意）、`wholeFloorOnly`（含 Node 的 `skipWholeFloor: Boolean(kind)` 規則）。
6. **F2（可用性半）**：PG 失效 → **503 ＋ 穩定錯誤碼**，不再回退 SQLite（無環境變數逃生門）。
7. 基礎建設知識庫與**變更自動記載**：`github.com/Fyun48/cline-server`（地圖層，零憑證值）＋
   每 6 小時 Cloudflare Access 進容器跑漂移檢查、自動開 GitHub issue（已實測抓到真實漂移）。

## 3. 🚨 阻塞（本次請求協助的核心）：SQL-first 與 Node 的結果不一致

### 3.1 量測（生產資料、唯讀、可重跑）

```
同一組 args：filter=all、districts=[西屯區]、limit=300、settings={}
  Node  listListings(args)          → totalMatched = 4,259
  SQL   listListingsSqlFirst(args)  → totalMatched = 6,023     （+41%）
  第一頁 300 列中「SQL 有、Node 沒有」= 91 列（約 30%）
  差異列的 match_post_id 全部非空（22053796→22012203、22053892→22037800 …）
腳本：v3/scripts/node-vs-sql-diff.mjs（搭配 v3/scripts/run-in-container.sh，會先同步 src）
文件：docs/handoffs/pr-b-sql-node-divergence-measured-20260924.md
```

### 3.2 根因（程式位置）

Node 在 SQL 之後還有兩個後處理（`db.js:6472-6475`）：

```js
rows = attachSameHouseRoles(rows, voteUid);                        // 成對配對並指派 primary/affiliate
rows = rows.filter((row) => listingMatchesListFilter(row, filter)); // 第一個條件就是排除 affiliate
```

- `listingMatchesListFilter`（`personalFlags.js:299`）→ `listingIsMainListAffiliate`（`:291`）：
  排除「非 primary 的那一側」（`same_house_split` 不適用；`same_house_primary_offline && offline!==1` 不適用）。
- `attachSameHouseRoles`（`db.js:3353`）以 `match_post_id` 成對；`preferPrimaryListing`
  （`match.js:363`）決定誰是 primary，優先序：**rent → `listingRefreshAt` → `last_seen_at` →
  `listingTieBreakKey` → post_id**。
- **`listingSearchSql.js` 產生的 SQL 完全沒有對應條件** ⇒ SQL-first 多回傳同源配對列（用戶看到同一物件兩次）。
- 額外限制：角色只在「兩側都在候選集合或可由 provider extras 取得」時指派；
  且受 `housepriceNotDisplayReady`（需 `listing_prep`／provider 查詢，`db.js:2889`）與
  **per-user 的 `splitPairSet`（`db.js:3167`）** 影響。

### 3.3 為什麼我沒有直接修（拒絕近似）

精確 SQL 化需要：跨表（`listing_prep`、split pairs）、衍生鍵（`listingRefreshAt`／`listingTieBreakKey`／
`comparableRent`）、以及 per-user 輸入。**任何近似都會造成新的靜默差異**，
違反本案已建立的規則（先量測 → 證明等價 → 才下推）。因此我停在「已量測、未修改行為」。

## 4. 候選方案（需要決策）

| 方案 | 內容 | 優點 | 風險／成本 |
|---|---|---|---|
| **(A) 精確 SQL 化** | 在 builder 加入 self-join，完整實作 `preferPrimaryListing` ＋ `listing_prep` ＋ split pairs 條件 | 保持 SQL-first 效能且結果等價 | 工作量大；需把衍生鍵在 SQL 端重算並以等價性測試證明；per-user split pairs 需進 SQL |
| **(B) 保守回退** | 讓含同源風險的查詢留在 Node 路徑（或整條暫時停用 SQL-first） | 立即恢復正確性 | 效能回退（Node 掃描）；需決定觸發條件（例如該行政區存在 match_post_id 就回退 ⇒ 幾乎全面回退）|
| **(C) 投影層預算** | 在投影新增 `same_house_affiliate`／`same_house_split`／`primary_offline` 等欄位（由 Node 產生，回填），SQL 只讀 | SQL 端保持簡單；語意由同一支 Node 函式決定 ⇒ 等價性好證明 | 需新增欄位＋回填（本案已有兩次回填經驗：8.6 萬列約 48 分鐘、12 萬列約 70 分鐘）；`preferPrimaryListing` 依賴 peer 資料，投影需成對計算 |
| **(D) 只修最常見情形** | 以 rent／refresh／post_id 三者決定 primary（忽略罕見條件） | 成本低 | **仍屬近似**，會留下未量測的差異 ⇒ 我建議不採用 |

我的傾向：**(C) → 若不可行則 (A)**；**(B) 作為必要時的緊急處置**。但這需要你（Owner／astra6）確認
「正確性優先於效能」的容忍度，以及是否接受再一次投影回填。

## 5. 其他已知缺口（非阻塞，依序處理）

1. `filter≠all`（`hidden`／`offline`／`suspected`／`unseen`／`viewed`）：Node 端同樣要過上述兩段後處理
   ⇒ 是第 3 節的共同前置條件。`watched` 另有完全不同的管線（`applyBrowseIsolation`，跳過行政區／價格／顯示篩選）。
2. 評分類（`sort=fit_desc`、`priceMin`、`minBuildingFloors`）與 per-user 類（`commuteKm`）、
   需新欄位類（`excludeKeywords`／`excludeAgents`／`excludeAgentIds`／`excludeBoxes`）。
3. **PG WAL 封存／PITR 未啟用**（`archive_mode=off`）⇒ 無時間點還原能力；runbook 已寫
   （`docs/handoffs/pg-wal-pitr-runbook-20260924.md`），**執行前需要 Owner 提供封存路徑**（且需重啟）。
4. GATE-12 **FAIL**：CI 目前 20 個 PG 依賴測試因缺 PG 而 skip ⇒ 需在 CI 起真實獨立 PG service。
5. PR-C（排程／擁有權／AbortSignal）、PR-D（`listing_match_evaluations` → PG）、PR-E（網域／媒體／認證）、
   PR-F（PG 模式無業務 SQLite）尚未開始。

## 6. 需要 astra6 協助的具體問題

1. 第 4 節應選 (A)／(B)／(C)？若選 (C)，投影欄位設計建議為何（一次算好成對角色 vs 存 peer 比較所需欄位）？
2. 「等價性驗收」的標準是否同意：**同一量測腳本的 `sqlOnlyCount=0` 且兩邊 `totalMatched` 相等**，
   並把它固化成測試（含 fixture）？
3. 是否接受「先做 (B) 緊急處置、再排 (A)/(C)」？若接受，回退的觸發條件建議為何？
4. GATE-12 的 CI PG service 建議做法（GH Actions service container？自架 runner？），
   以及是否允許把測試 PG 的連線字串放 GitHub Secrets。
5. PITR 的封存路徑與保留策略（需 Owner 決定），以及是否同意 runbook 內的重啟窗口安排。

## 7. 可重跑指令（全部唯讀）

```bash
bash /workspace/repos/cline-server/bootstrap.sh                    # 環境自我檢查
bash v3/scripts/run-in-container.sh v3/scripts/kind-e2e-parity.mjs # kind 端到端等價（12 案）
bash v3/scripts/run-in-container.sh v3/scripts/q-e2e-parity.mjs    # q 端到端等價（8 案）
bash v3/scripts/run-in-container.sh v3/scripts/node-vs-sql-diff.mjs# ← 第 3 節差異量測
git -C /workspace/repos/5151 show --stat HEAD | head -20
```
