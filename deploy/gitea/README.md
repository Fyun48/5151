# 5151 Engineering Plane — Gitea（Phase 22/23/24）

部署於 Synology。Gitea 用 PostgreSQL；CI runner 走**隔離 DinD**，**不把 host
`/var/run/docker.sock` 掛給一般 CI job**。GitHub 仍是 authoritative，Gitea 為
migration/shadow（第一階段只做 migration rehearsal）。

## Security（Phase 23）

- 一般 CI runner：`DOCKER_HOST=tcp://dind:2376`（DinD container），無 host Docker root。
- Production deployment runner：獨立 capability boundary（manual-only / Owner 授權），
  **不在這個 compose 內**。
- Loop Engine：獨立 container，用 Gitea webhook（驗證 signature）+ API。

## 套用

```bash
cd deploy/gitea
GITEA_DB_PASSWORD='<pg password>' \
GITEA_WEBHOOK_SECRET='<loop-engine webhook secret>' \
docker compose up -d
```

- Gitea UI：Cloudflare Tunnel `https://jgitea01.reversalplay.me` → `http://127.0.0.1:5251`（loopback）。
- 首次設定時資料庫選 PostgreSQL，連 `gitea-db:5432`。
- GitHub → Gitea migration rehearsal：驗證 branches/tags/commits/releases/issues/labels/LFS，
  source-of-truth cutover 留給 Owner 決定（不自動切換）。
