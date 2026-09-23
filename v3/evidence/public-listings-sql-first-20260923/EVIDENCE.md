# 訪客搜尋 SQL-first：一次失敗的加速與回退紀錄（2026-09-23）

> 結論先寫：**效能改善是真的（26～28.6s → 1.2～3.2s），但列集等價性沒有達成（SQL 端比 Node 端多 28%），
> 所以預設關閉、維持原本（慢但正確）的 Node 路徑。** 這份文件記錄量測、三個 PR、踩到的兩個坑，
> 以及要再開啟前必須補的事。

## 1. 問題（使用者感受）

正式站（訪客）`GET /api/public/listings` 冷快取 26～28.6s；查詢進行中連 `/support.html`（純靜態檔）
也要 26.2s → 伺服器（單執行緒 + 同步 SQLite）被那條查詢整條卡住，不只是 API 慢。預設查詢候選數
`totalMatched = 65,342`。

根因：`db.js listPublicListings()` 是同步函式、SQL 沒有 LIMIT，把 6.5 萬筆候選全部撈進記憶體後跑
6 輪 JS 過濾與排序，最後才切 20 筆。

## 2. 三個 PR

| PR | 內容 | 結果 |
| --- | --- | --- |
| #452 | 新增 guest SQL-first：共用 builder 支援「行政區可留空」、`listPublicListingsSqlFirst()`（COUNT + LIMIT/OFFSET 或 keyset，只 hydrate 一頁）、`listPublicListingsFast()` 分派、路由改走它 | 效能 ✅ 26～28.6s → 1.7～3.2s；**列集 ✗ 50,846 vs 65,341（少 22%）** |
| #454 | 補建 `listing_search_projection` 缺列 + 守門「projection 與 listings 筆數一致才走 SQL-first」 | 補回缺列 → 65,342 ✅；**卻變成 83,287 vs 65,341（多 28%）** |
| #457 | guest SQL-first 改為**預設關閉**（`PUBLIC_LISTINGS_SQL_FIRST=1` 才開）＋補建加 120ms 時間預算 | 列集回到 65,342／65,341／65,342／士林區 1,155＝與改動前基準一致 ✅；速度回到 26s ✗ |

部署紀錄（`manual_owner`，皆 success）：

```text
#452  sha e345c9f  digest sha256:1d25c5b0cdb5f901576b36289518fcf91a1a41b400800c91e39c726fb35f2793
      build 35823392913 / predeploy 35823492547 / deploy 35823590112
#454  sha 004728f  digest sha256:1dd04e358331acd60fdbae5cff3fae06f27c540be6d80063b2afa4e7c2b0a47c
      build 35824169487 / predeploy 35824270636 / deploy 35824367521
#457  sha 9e79b23  digest sha256:43bd376ccea8506dbfefa878c1b74a4a0f6e76f5caf58b15fd39fb7896b81b6f
      build 35826058138 / predeploy 35826165525 / deploy 35826268408
```

## 3. A/B 方法（可重現）

同一個 build 內叫回兩條路徑，用「逃出 envelope 的參數」強制走 Node：

```bash
B=https://jibbyrenth.reversalplay.me
curl -s "$B/api/public/listings?limit=1&offset=0&probe=$RANDOM"                         # SQL-first
curl -s "$B/api/public/listings?limit=1&offset=0&priceMax=99999999&probe=$RANDOM"      # Node 路徑
```

| 時間點 | SQL-first | Node 路徑 | 判讀 |
| --- | --- | --- | --- |
| #452 後（13:47） | 50,846 | 65,341 | projection 缺列（少 22%） |
| #454 後（14:15） | 83,287 | 65,341 | 語意不等價（多 28%） |
| #457 後（14:26） | 65,342（走 Node） | 65,341 | 一致 ✅ |

## 4. 踩到的兩個坑

1. **補建用 `db.exec("BEGIN")` 開交易**：正式站隨時有請求正在交易中 → `BEGIN` 直接拋錯，
   而 catch 又靜默吞掉 → 補建從未生效。改成「一列一個 statement（autocommit）、單列失敗不影響其他列」
   並回報進度。
2. **一批 200 列仍然會長時間阻塞**：正式站每列約 30ms（網路磁碟 fsync），一批約 6 秒；
   container 重啟後要補 1 萬多列 → 整站數分鐘幾乎沒有回應（實測靜態檔 30s timeout、listings 125s）。
   改成每步最多阻塞 `budgetMs = 120ms`（並記錄 2026-09-23 那次實測恢復曲線：54.6s → 29.8s → 2.4s）。

## 5. 目前狀態

- guest 搜尋：**走 Node 路徑**（慢但列集正確）；`PUBLIC_LISTINGS_SQL_FIRST=1` 可開啟 SQL-first。
- projection 補建與 `projectionCounts()` 留在程式裡（member 路徑本來就讀這張表）。
- 列集差異的成因還沒定位：SQL 子句沒有覆蓋只有 Node 端才有的條件，最可能是
  `listings.hidden`、pending offline（`offline=1 AND offline_confirmed=0`）之類。
- ⚠️ 補建把約 1～3 萬列補進 projection（依 A/B 推估），member 的 SQL-first 路徑也讀同一張表 →
  下次要一併確認 member 端是否因此多顯示列。

## 6. 要再開啟 SQL-first 前必須完成

1. 找出 Node 端獨有、SQL 缺的每個條件（先查 `listings.hidden`、pending offline、self listing），
   把需要的欄位補進 `listing_search_projection`（`computeListingProjection` 用同一組 helper 計算）
   或補進 WHERE。
2. parity 測試要涵蓋這些資料形狀（`hidden=1`、`offline=1&offline_confirmed=0`、`match_verdict`、
   self listing、租金 0、同屋 primary、相同 `updated_at`）。
3. 上線前後各跑一次第 3 節的 A/B，且多跑幾組查詢（排序 × 行政區 × 顯示篩選 × 分頁），
   全部一致才設 `PUBLIC_LISTINGS_SQL_FIRST=1`。
4. 效能目標：冷查詢 < 2s、且查詢進行中靜態檔不被阻塞。
