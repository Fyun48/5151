# PR-B 執行狀態

更新：2026-09-26。接手人：Codex。狀態：**IN_PROGRESS / NOT_READY_FOR_REVIEW**。
PR [#497](https://github.com/Fyun48/5151/pull/497) 保持未合併、未部署。

## 可接續位置

- 分支：`fix/pr-b-persist-listing-transaction`；精確版號以 GitHub PR HEAD 為準。
- 接手基準：`ad5310e6a70de3b694869b2fefedefabc688a292`。
- `1c43b7f`：請求時間、PG 設定與來源、清單及統計共用快照、503、queue clock、固定 fixture。
- `dfe78ee`：訪客 PG 入口、async cache、MRT 設定同源、舊 fixture 必要 schema。
- 本檔之前的增量紀錄保留在 Git 歷史；過去的 CI 綠燈不代表目前 HEAD 已驗收。
- 詳細接手範圍：`PRB_CODEX_TAKEOVER_20260926.md`。

## 已確認的修正

1. `asOf` 傳入可見性、primary、排序、same-house bundle；原交接所稱第四個 public 呼叫其實屬於 stats，不照舊行號盲改。
2. PG 搜尋 context 使用必要 PG tables；不吞缺表錯誤，不使用跨請求 search-key TTL 或全域表存在快取。
3. 清單／統計在同一個 Repeatable Read 唯讀交易；初始 `/api/state` 也使用完整 page 入口。
4. PG 的來源啟用與 MRT 顯示設定不讀 SQLite。測試攔截的是 I/O 嘗試，不只未捕捉例外。
5. 訪客原先仍直接讀 SQLite，現已接 async PG pipeline。其候選、群組、卡片均由 PG 供料；不接受會員身份／私人旗標作為訪客條件。
6. PG public cache 暫不跨請求重用：現有 revision 屬 best-effort，不能保證其涵蓋所有變更。SQLite 繼續既有 TTL cache；async 失敗不快取。
7. 正式 PG 入口固定 `node_pg`，SQL PG 實驗另放診斷模組；沒有 SQLite 逃生參數。
8. Queue 預設 availableAt 使用注入的 now；live fixture 隔離 schema 並建立實際需要的唯一索引。
9. 會員前端 HTTP 失敗先拋錯，保留清單、統計、篩選、分頁，不把 503 當成零筆結果。

## 證據狀態

- 本機第一批完整套件：2,621 tests / 2,590 pass / 0 fail / 31 skip。
- 第一批 CI（`1c43b7f`，run `36219022055`）：一般 Tests 成功；PG 110 pass / 13 fail / 1 skip。
  失敗根因：MRT 裝飾漏讀 SQLite；舊 fixture 缺 settings；新的隔離 queue fixture 缺唯一索引。均依實際錯誤修正。
- 第二批 CI（`dfe78ee`，run `36219436279`）：PG 122 pass / 3 fail / 1 skip。價格上限仍用 SQLite typeof；PG 測試程序中的 SQLite 啟動回填 timer 干擾 I/O spy；兩者已修正。
- 同批規模量測：單區 C1 p95 2,414.79ms（超標）、C4 6,961.32ms；全區 C1 2,703.46ms、C4 8,293.12ms；lag 全部超標，最高 RSS 2,150,023,168 bytes，0 error。原始證據 `evidence/prb-codex-20260926/baseline-dfe78ee.json`。
- 下一批移除統計無用裝飾查詢、重用同快照候選 extras（包含被 profile filter 排除的 partner），保持寬候選欄位。須等新量測，未宣稱效能已通過。
- 本機第二批完整套件：2,625 tests / 2,592 pass / 1 fail / 32 skip；失敗是 MRT 原始碼斷言未隨來源抽換更新，已修正並通過定向測試。
- `v3/test/listing-search-parity.test.js`：會員兩頁、正式 SQLite projection dispatcher、個人旗標與投票者分離、通勤、固定時間、缺表／空結果、跨請求更新、訪客 PG-only sentinel。
- `v3/test/listing-search-client-error.test.js`：以實際前端 loadList 函式注入 HTTP 503，確認既有狀態保持。
- `v3/test/listing-search-http.test.js`：使用正式 page loader 與錯誤回應 helper 的 HTTP 整合；不是完整 production/auth E2E。
- lint：NOT_RUN。正式資料雙節點 HTTP E2E：NOT_RUN。

## 效能驗收

`v3/scripts/prb-search-benchmark.mjs` 在自行建立的 PG schema 執行並自行清除。
120,000 筆固定資料／36,000 筆查詢範圍／1,024 節點跨區關係鏈。
單區及全區各跑 C1、C4；每案至少 5 輪暖機、50 個完整清單回應，含統計及 JSON 序列化。
Actions artifact：`prb-search-performance`。記錄精確 SHA、模組 hash、硬體、PG/Node、p95、lag、RSS、查詢數與錯誤。
CI 的 smoke 與 NAS gate 分開，不能互相替代。

## 存取阻礙及正式環境界線

已讀 `Fyun48/cline-server` 的 infra／credentials／remote-access 文件。
目前工作環境沒有文件指定的 `~/.secrets/INDEX.md`、`~/.ssh/nas_cline` 或 `~/.ssh/5151-v3-syn-nas`。
現有 VS Code 遠端入口顯示未登入、沒有可用 host。沒有改驗證設定或建立新 tunnel。
因此 NAS 同級實機效能目前 **BLOCKED**，需要把既有可用遠端執行通道提供給本次工作環境，或在既有 NAS 開發環境執行同 SHA 的拋棄式驗收。
正式庫名 `5151_shadow` 不代表測試庫；禁止把 CI setup／fixture import 指向它。

## 後續

等待目前 CI 完成，讀取所有失敗與效能證據；修正後一次推送並等同 SHA CI。
NAS gate、完整正式 HTTP E2E 及原始 C～F 架構工作仍分開列明；不能宣稱整站已離開 SQLite。
