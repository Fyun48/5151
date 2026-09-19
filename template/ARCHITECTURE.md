# ARCHITECTURE

## 目標架構

- **Runtime role**（`APP_ROLE`）：`web` / `crawler` / `worker` / `all`。web 只跑 HTTP，
  crawler 只跑來源抓取，worker 只跑背景工作；`all` 僅本地開發。
- **資料層**：`DB_DRIVER=sqlite|postgres`，repository interface 隔離 domain 與 driver。
- **Search**：SQL-first（indexed filter → indexed ORDER BY → LIMIT/OFFSET → page hydrate）。
- **Durable queue**：共用 job queue，claim 用 `FOR UPDATE SKIP LOCKED`。
- **Storage**：`STORAGE_DRIVER=local|s3`，Web active/active 不依賴本機 DATA_DIR。
- **HA**：PostgreSQL Primary/Hot Standby（無 Witness 不自動 failover）；Web active/active；
  Cloudflare Tunnel 雙 connector。

## 原則

- 重大架構變更先以 **parallel / shadow** 建立並驗證，不直接動 production。
- 不順便改產品語意；SQL 化如需調整，semantic parity test 證明結果一致。
- 以實測判斷效能，不以文字宣稱。
