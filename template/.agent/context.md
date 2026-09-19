# Agent Context（.agent/context.md）

給 coding agent 的專案脈絡。新專案請替換成實際內容。

## 架構要點

- 資料存取走 **repository interface**（不綁死特定 driver）：`DB_DRIVER=sqlite|postgres`。
- Schema 變更走 **ordered migration**（`schema_migrations`），不要靠 `ALTER TABLE try/catch`。
- 背景工作走 **durable job queue**（claim 用 `FOR UPDATE SKIP LOCKED`，跨多 worker 不重複執行）。
- 媒體/檔案走 **storage abstraction**（`STORAGE_DRIVER=local|s3`）。

## 慣例

- 每個 commit 獨立可讀、可回退；不 squash 掉結構。
- 測試必須全綠；不因要過 CI 而刪除或放寬 assertion。
- 效能判斷以實測為準（baseline vs after + p50/p95/p99），不寫「已優化」。

## 交付

- 完成後回報：BASE_SHA / FINAL_HEAD / branch / tests 數 / before-after 效能 /
  各 phase 狀態 / EXTERNAL_SETUP_REQUIRED 清單 / NOT_COMPLETED 清單。
- 不自行 merge、不自行 production deploy。
