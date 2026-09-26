# NAS 唯讀採證（既有 GitHub Actions secrets）

用途：讓沒有 NAS 私鑰的審查端取得兩台主機的白名單狀態，不搬出 secrets、不新增 tunnel。
通道與 ED25519 指紋由 Owner 於 2026-09-26 提供的 DeepSeek 實查確認。

## 啟動

本 workflow 納入 master 後，由既有允許的 Actions 身分執行一次：

```bash
gh workflow run nas-readiness-readonly.yml --repo Fyun48/5151 --ref master \
  -f confirmation=INSPECT-NAS-READONLY
```

或 Actions → NAS readiness inventory (read-only) → Run workflow，選 master，
confirmation 填 `INSPECT-NAS-READONLY`。沿用 production environment 與 actor 檢查，不能繞過。
目前 ChatGPT GitHub 連接器沒有 workflow_dispatch 操作，因此此啟動步驟需有該能力的現有執行端完成；
後續 job logs／artifacts 可由 ChatGPT 自行讀取，不需轉貼機密或逐項轉述結果。

## 邊界

- 僅 workflow_dispatch，無 push／PR 自動執行，contents: read；與正式部署共用互斥群組。
- 兩台各用既有 secrets。cloudflared 使用既有 Access hostname，版本固定 2026.9.3，無公網 fallback。
- 不啟用舊 bridge 的未驗主機金鑰 SSH smoke；先取得 ED25519 公鑰、比對已提供的 SHA256 指紋，
  符合後才以 StrictHostKeyChecking=yes、固定 ED25519 連線。指紋本身不是 known_hosts 公鑰，不能直接當公鑰使用。
- 遠端只輸出主機／Docker 版本、固定容器的映像及狀態、DB_DRIVER 與指定程式檔 hash、PG 唯讀角色／複寫／封存統計。
  不輸出完整 env、inspect、PG URL、client address、密碼、使用者資料或備份內容。
- 不部署、不改正式資料、不執行 migration／ANALYZE、不重啟、不 promotion、不刪備份，不執行 NAS 效能 benchmark。
- PG 使用現有容器本地 psql、-w 與 READ ONLY；無法讀取時記 NOT_RUN。容器缺少時明示 absent。
- artifact 為 nas-readiness-casa-*、nas-readiness-syn-*，保留 14 天；含 workflow SHA／run ID／採證時間。
  這是現況盤點，**不是**跨節點 CRUD、還原、failover 或 HA PASS 證據。

Secrets 已存在時無須更新。NAS 區網別名／本地憑證路徑對外部執行環境無效；不索取 OTP。
公開 54722／58722 是否仍轉發不作連線前提，也不由區網內探測結果推斷路由器狀態。
