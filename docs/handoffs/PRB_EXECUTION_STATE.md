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

## 第三批真實結果與目前修正

`3a716ec30621107f60b60720caa05c957036fb3a`：Tests run `36220337010` 全部完成。
一般 2,627 tests / 2,594 pass / 0 fail / 33 skip；PG 127 tests / 126 pass / 0 fail / 1 optional shadow skip。
固定 120k fixture：單區 C1 p95 1,703.15ms、C4 4,668.29ms；全區 C1 1,750.99ms、C4 5,638.95ms。
C1 CI smoke 通過，但 lag p99 168–404ms、max 242–814ms 均未達標；RSS 最高 2,583,490,560 bytes。
原始 Actions artifact：`evidence/prb-codex-20260926/after-3a716ec.json`。不能因 CI 綠燈宣稱完整效能驗收通過。

本批針對量到的主執行緒阻塞：候選／統計用同快照 cursor 每批 512 列完整讀取；
共享 Node pipeline 加入可協作排程，保留全域配對及穩定排序；extras 僅保留實際關係 partner 的原值。
新增跨 256 列邊界的角色、各排序及 counters parity、cursor 多批／參數／錯誤清理测试。
每個 FETCH 都計入實際查詢數，不將批次傳輸冒充單一 SQL。必須等本批真 PG 與規模測量後決定是否保留。

## 第四批結果與下一批依據

`1c5115e4171db81326b325cb14170341a004ece6`，run `36221210476`：一般 2,597 pass／0 fail／34 skip；
真 PG 128 pass／0 fail／1 optional shadow skip。cursor 參數、多批、故障清理與跨 chunk parity 均通過。
效能仍 FAIL：單區 C1 p95 2,023.56ms；全區 C1 2,005.09ms；C4 5,283.01／5,718.38ms。
lag 單區 C1 30.61／42.30ms、全區 C1 36.34／50.20ms（p99／max）已 PASS；
C4 尚有單區 max 116.65ms、全區 p99 53.05ms 超標。所有量測零 error／timeout。

EXPLAIN 實證：單區候選 execution 894.58ms，其中 JIT 814.72ms；全區候選 JIT 824.06ms。
下一批對搜尋快照使用 `SET LOCAL jit = off`，隨 ROLLBACK 恢復，不改伺服器或 pool 設定。
此外，實際 pg.Result 產生的寬 row 經 Object.assign 添加旗標會變成 V8 dictionary properties；
改以完整物件展開建立旗標後，離線同資料 CPU／heap 有實測改善，仍需真 PG 規模驗證。
所有候選欄位與個人標記語意保留；stats／搜尋參考管線共用相同轉換。

已備好 NAS 拋棄式 container runner 與 runbook；只通過 bash 語法檢查，沒有宣稱本機實跑 Docker。
benchmark 的 NAS 模式檢查四案 p95 及 lag；CI 模式仍使用原 smoke 門檻。

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
