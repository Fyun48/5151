# PostgreSQL 升級規劃（尚未開工）

目前 v3 資料在單機 SQLite：`data-v3/v3.db`，程式用 `better-sqlite3` 與 SQLite 語法（`IFNULL`、`ON CONFLICT`、`datetime('now')`）。CasaOS 上一份檔、一條程序就夠跑。

## 這次不開雙節點 cluster

在 CasaOS 與 Synology NAS 各開一個 PostgreSQL、一次做成 cluster，現在不適合：

- 應用還沒有連線池、遷移層或 Postgres 方言，直接換引擎會先打断爬蟲與列表。
- 兩台家用 NAS 之間做同步寫入（Patroni／repmgr／多主）沒有穩定仲裁，容易腦裂。
- 這個開發環境碰不到你的 CasaOS／NAS，無法在這裡真正把容器掛上去驗證 failover。
- 現在的流量與資料量，SQLite 單檔仍是較單純、可備份的選擇。

## 建議分階段

1. **先抽象資料存取**  
   把 `v3/src/db.js` 的 SQL 收成可換驅動的查詢層，SQLite 繼續是預設。

2. **CasaOS 先跑一台 Postgres**  
   同一個 Docker 網路、單一 primary、每日備份到 NAS。先做一次性匯入與雙寫驗證，確認列表／爬蟲／通知都過，再切主庫。

3. **NAS 當備援，不要當第二個寫入點**  
   Synology 上用串流 replica 或邏輯備份還原，做災難備援。讀寫仍只打 CasaOS。

4. **真的需要寫入高可用再談 cluster**  
   那時才用 Patroni + etcd／witness，而且兩節點要有穩定內網與自動 failover 演練。兩台家用 NAS 互相同步寫入不是第一步。

若之後要開工，另開任務做第 1、2 階段，不要跟物件欄位修正綁在同一張 PR。
