# PR-B 接手狀態（2026-09-26）

狀態：**IN_PROGRESS，尚未驗收、未合併、未部署**。

接手基準：PR #497，`fix/pr-b-persist-listing-transaction`，
`ad5310e6a70de3b694869b2fefedefabc688a292`。

## 本批修正

- 清單可見性、主副卡判定、排序與卡片群組共用請求 `asOf`。
- PG 搜尋所需設定、來源啟用狀態、搜尋範圍由同一 PG 快照取得；必要表缺失拋錯。
- 完整清單回應的搜尋及統計共用一個 Repeatable Read 唯讀交易。
- PG 統計失敗不再回讀 SQLite；HTTP 回傳 503 / `SEARCH_UNAVAILABLE`。
- 將 SQL PG 實驗入口移至獨立診斷模組，正式入口維持 `node_pg`。
- Queue 注入 `now` 時，預設 `availableAt` 使用同一時間；測試使用獨立 schema。
- 部署失敗測試的 mock 改用暫存目錄及子程序函式，不覆寫系統執行檔。

## 驗證與證據

新增真 PG 測試：正式 dispatcher 的欄位、兩頁結果、來源及條件篩選、觀看者／投票者分離、
通勤、固定時間、必要表失效、空結果，以及同一回應期間發生外部寫入時的快照一致性。
測試記錄 SQLite I/O **嘗試**，即使例外遭捕捉也不能偽裝成零讀取。

效能入口：`node v3/scripts/prb-search-benchmark.mjs`，僅能連拋棄式 PG。
固定 120,000 筆，其中 36,000 筆屬查詢範圍，兩行政區及 1,024 節點關係鏈。
每案先暖機至少 5 輪，再量 50 個完整清單回應（含統計、裝飾及 JSON 序列化）；
單區／全部 × C1／C4，記錄 p95、事件迴圈延遲、RSS、查詢數與交易 SQL、錯誤數。
Actions artifact `prb-search-performance` 保存 SHA、模組 hash、環境及結果。

本文件建立時，真 PG 與效能尚待本批 CI 執行，不能引用接手前綠燈當成本批通過。
CI 效能僅是 CI smoke；NAS 驗收獨立標示，未執行不得宣稱通過。
一般測試未設定 PG 時的 skip，須與 PG integration job 的必要功能覆蓋對照。
未執行 lint，不以測試結果取代 lint。

## 範圍界線與剩餘工作

本批為 PR-B，並不代表整體 PostgreSQL 遷移或架構更新全部完成。
Scheduler（C）、match/eval（D）、media/auth 等 domain（E）、全業務 SQLite 退出及 PITR（F）
仍需逐項另驗。HTTP 的授權及其他 domain 尚有 SQLite，不能把搜尋核心零 SQLite
宣稱為整個應用程式零 SQLite。正式環境維持 manual-only。

本批終點：正確性與 CI 通過、可重現效能證據、NAS 必要驗收、更新 PR 本文後供審查。
