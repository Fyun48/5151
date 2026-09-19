# OPERATIONS

## 資源保護優先級

Production Web → Production DB → Production worker/crawler → OPS → Gitea → CI → AI agent。

CPU/RAM pressure 過高時：AI agent pause/throttle、CI throttle、crawler throttle。Web 不應被餓死。

## Backups

- PostgreSQL：`pg_basebackup` / WAL / logical dump + **restore drill**（只 backup 不算完成）。
- 至少執行一次 restore drill 才算數。

## 監控

- 關鍵路徑 p50/p95/p99；replication lag；queue backlog/dead-letter；event-loop lag。
