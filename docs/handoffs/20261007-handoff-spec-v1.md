# 5151 結構化交辦規格 v1（P/Σ/O ＋ 數據契約）
> 依據：2026-10-07 SKILL.state 微觀實驗（lab/m8-research/skillstate-exp/，L-0226）。
> 結論一句話：表示法有效、載體必須是 DB——精確值住 PG/DBOS，prompt 只住指針。

## 一、三種角色
- **Planner**（我）：開交辦單、驗收、決定升級時機。
- **Worker**（執行代理，預設 qwen3.8-flash）：照單執行，不自行擴大範圍。
- **DBOS/PG**（qdsh-dbos＋業務表）：進度與真值的唯一權威載體。

## 二、交辦單結構（每單四段）

### P＝不可變規格（開單時寫死）
- 目標：一句話，可判定完成與否
- 範圍白名單：只准碰的檔案/表/路徑（逐條列）
- 禁止清單：不准動的東西（例：不准改測試期望值、不准碰正式站）
- 驗收指令：**可重跑**的指令（bash/SQL），不是「測過了」
- 退路預算：同一失敗路徑最多 3 次 → 交結構化失敗報告（症狀/試過的路/假設/需 planner 裁決什麼）

### Σ＝進度狀態（只准指針型欄位）
```json
{ "task_id": "hd-20261007-01",
  "stage": "ingest",                    // 枚舉：read|ingest|verify|report
  "counters": { "done": 12, "total": 32 },
  "pointer": "select id from crm_staging where status='pending' limit 50",  // 真值从这里取
  "next_action": "跑批次 3 入庫",
  "blockers": [] }
```
**硬規則**：Σ 內出現價格/地址/座標等精確值＝違規。要引用資料就放 SQL/路徑/workflow_uuid。

### O＝最新觀察（每步只附這個）
- 僅上一步的原始輸出，截斷 2000 字元。
- 歷史不重附——需要舊結果就查 pointer（這正是省 token 且不丟失的機制）。

### 數據契約（每單必填）
- 寫入目標表／路徑
- 讀取來源查詢
- 完整性校驗：行數＋md5/checksum（交辦單只引用校驗和，不抄內容）

## 三、防捏造三道保險（實驗教訓直譯）
1. **值域抽檢**：驗收指令含範圍檢查（例 `where price not between 4000 and 100000`），不是只查 shape——flash 的「合理但錯」值能過 schema、過不了值域。
2. **先 echo 後執行**：資料刪除／正式寫入前，worker 必須先回報將影響的行數與 id 清單，planner 核准才跑。
3. **判斷不給 worker**：需要裁決的步驟（比對結論、異常要不要放行）由 planner 做，或交辦單標 `[model: qwen3.8-max]` 請 Owner 手動升級該回合。max 實測會誠實回報「state 缺資料」，flash 會捏造合規——這就是分工依據。

## 四、DBOS 接線（基礎設施已就緒，phase-2 用）
- `handoffTask(task_id, P, pointer)` 註冊為 workflow：task_id 即 workflowID → 天然冪等（實測過 getWorkflowStatus 判重）。
- Σ 的每次更新＝journal 一列 → 崩潰自動重放（recovery_attempts 實證）、Owner 可 SQL 查任何任務進度。
- session-keeper（選項 2）即建在此上：偵測 worker session 中斷 → 自動用同一張單的 `(P, Σ指針, 最新 O)` 重遞。

## 五、舊交辦迁移（三件事）
1. 長散文 → P/Σ/O 四段（模板見下）。
2. 內嵌資料（貼表格/貼數字）→ 改為「查詢指針＋校驗和」。
3. 「完成後告訴我」→ 改為「驗收指令」（可重跑，planner 自己跑）。

## 六、填好的示例（價格覆核爬蟲）
```
P: 目標＝比對 3 個來源站共 32 筆與 crm_outbox 現價差異。
   範圍＝只准寫 crm_staging；禁止碰 crm_outbox／正式表。
   驗收＝node v3/test/price-diff.test.mjs 綠燈 ＋ select count(*) from crm_staging where diff_flag and status='pending' = 預期 32。
   預算＝同頁連續 3 次抓取失敗 → 停，交結構化失敗報告。
Σ: {"task_id":"hd-price-07","stage":"read","counters":{"done":0,"total":32},
    "pointer":"select url from crawl_sources where batch='2026-10-07'","next_action":"抓來源 A 第 1 頁","blockers":[]}
數據契約: 寫入 crm_staging(batch='2026-10-07')；讀 crawl_sources；校驗＝行數 32＋md5(urls)
保險: 值域抽檢 price between 4000 and 100000；diff_flag 的放行判斷＝planner 做
```

## 七、成本模型
- 全程 flash 執行；實驗同條件對決 NEW/OLD token 比 0.64–0.79，加上「數據查庫不進 prompt」，交辦越長效益越大。
- 代價（誠實列）：查庫工具呼叫變多；延遲在 worker 層不可比（實驗的 5 倍延遲源自「每步回显 prompt state」，本規格不要求回显，無此問題）。

— 2026-10-07 v1，planner 起草（Owner 核准入庫）。本檔為文件，不動任何程式碼/測試/部署；實驗證據在 qdsh 端 lab/m8-research/skillstate-exp/。
