# 5151 Engineering Plane — Gitea（Phase 22/23/24）

部署於 Synology（NAS）。Gitea 用 PostgreSQL；**runner 是 host docker socket 拓撲**
（Synology kernel 4.4 不支援 nested overlayfs，DinD 不可用）——因此 job 容器內的路徑不能
bind-mount 進其他容器、也不能用 `127.0.0.1:<host_port>` 連其他容器（見
`evidence/runtime-modernization/GITEA-MIGRATION.md`）。
**Gitea 現在是主場（authoritative）**：GitHub 上的 18 個 repo 都已遷入（9 public + 9 private，見 §1），
`github` remote 只留作唯讀參考（**不要把 master 推回去**，歷史含明文憑證，見 `HANDOFF.md`）。

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
- **Cloudflare Access（2026-09-20 起）**：`jgitea01.reversalplay.me` 由 Zero Trust Access app `gitea` 保護
  （`owner-only`：allow Owner email + require **One-time PIN**；session 24h）。
  **機器（git／API）走 service token**（policy `machine-service-token`，decision `non_identity`）——
  請求要帶 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 兩個標頭，例如：
  ```bash
  git config --local http.extraheader "CF-Access-Client-Id: <client_id>"
  git config --local --add http.extraheader "CF-Access-Client-Secret: <client_secret>"
  ```
  沒帶的機器會拿到 302 到 `toriace.cloudflareaccess.com`（`git` 的症狀是
  `unable to update url base from redirection`）。內部路徑（NAS 的 `127.0.0.1:5251`、
  容器內的 `gitea:3000`）不受影響——CI／runner／agent／`dispatch.sh` 都走那裡。
  值在 workspace 的 `INFRA-CREDENTIALS.md`（不在 repo 內）。
- 首次設定時資料庫選 PostgreSQL，連 `gitea-db:5432`。
- GitHub → Gitea migration rehearsal：驗證 branches/tags/commits/releases/issues/labels/LFS，
  source-of-truth cutover 留給 Owner 決定（不自動切換）。
