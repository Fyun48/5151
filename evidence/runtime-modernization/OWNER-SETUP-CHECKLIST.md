# Owner Setup Checklist — EXTERNAL_SETUP_REQUIRED

> 這些是「HA 真正上線」仍需 Owner 提供 / 授權的項目。config、runbook、腳本、code 都已備好，
> 只差 credential / token / 執行授權。填好後逐項勾選，交回即可開始對應的部署演練。

## A1. shadow HA 容器上線

現況：config 已備好（`deploy/shadow-ha/haproxy/`、`postgres-primary/`、`postgres-standby/`、
`web/web-a/`、`web/web-b/`），未起容器。

- [ ] 授權在 CasaOS(`192.168.0.140`) 與 Synology(`192.168.0.220`) 起 shadow 容器
      （或提供 SSH 存取讓我代為執行）
- [ ] 提供 `SESSION_SECRET`（Web-A / Web-B 共用，任意隨機字串即可）
- [ ] 提供 `TUNNEL_TOKEN`（Cloudflare tunnel token，兩個 cloudflared connector 共用）
- [ ] 提供 `PG_SUPER_PASSWORD`（PostgreSQL primary 超級使用者密碼）
- [ ] 提供 `PG_REPLICATION_PASSWORD`（replication 角色 `replicator` 密碼）

## A2. Object storage（S3/R2）

現況：`v3/src/storage.js` 的 S3 driver 已寫好，未給 credentials 時 fail-closed。

- [ ] S3-compatible endpoint URL（例：`https://<account>.r2.cloudflarestorage.com`）
- [ ] access key ID
- [ ] secret access key
- [ ] bucket 名稱

## A3. Gitea token + migration rehearsal

現況：`deploy/gitea/docker-compose.yml` 已備好（Gitea + PostgreSQL + 隔離 DinD runner）；
hostname 已知（`jgitea01.reversalplay.me` → `127.0.0.1:5251`）。

- [x] 授權在 Synology 執行 `docker compose up`（起 Gitea stack）
- [x] 提供 `GITEA_DB_PASSWORD` / `GITEA_RUNNER_TOKEN` / `GITEA_WEBHOOK_SECRET` / admin 帳號
      ✅ 2026-09-20：Gitea stack 已在 Synology 運作，Actions CI 連續多次綠燈
- [x] Gitea migration rehearsal
      ✅ 2026-09-20：9 個 GitHub repo（含 5151）全部遷到 `JimmyGOD/*`；見
      `evidence/runtime-modernization/GITEA-MIGRATION.md`

## A4. backup / failover / Gitea drill（實際演練授權）

現況：runbook + 腳本已就緒
（`deploy/shadow-ha/backup/{backup,restore,basebackup}.sh`、
`docs/runbooks/postgres-backup-restore.md`、`docs/runbooks/postgres-manual-failover.md`）。

- [x] 授權執行 **backup drill**（唯讀備份 + manifest + 隔離還原，不碰 live DB）
      ✅ 2026-09-20 完成（備份/sha256/隔離還原/異地副本全通過；並修正 `restore.sh` 兩個真 bug）
- [x] 授權執行 **manual failover drill**（Primary→Standby 手動切換演練）
      ✅ 2026-09-20 完成（A→B→A 來回，RPO 0、RTO ≈5–17s；修正 runbook／腳本 6 處）
      → `evidence/runtime-modernization/A4-HA-DRILL-20260920.md`
- [x] 授權執行 **Gitea migration rehearsal**
      ✅ 2026-09-20 完成（GitHub `Fyun48/5151` → Gitea `JimmyGOD/5151`，30 分支完整匯入、
      Gitea Actions CI 連續 4 次綠燈：2358 tests / 0 fail）

## A6. Gitea Actions 部署 workflow（已移植，缺一個 token）

現況：`.gitea/workflows/{build-production-image,production-predeploy-check,deploy-v3}.yml` 已移植自
`.github/workflows/`（manual-only，push 不會自動部署），repo secrets 已建立
（`PRODUCTION_DEPLOY_ALLOWED_ACTOR` / `GHCR_REPO` / `SOURCE_REPO_URL` / `GHCR_USER` / `NAS_*`）。

- [ ] **先升級 Gitea**（A7）：在 1.22.6 上這三個 workflow 被 parser 忽略，UI 不會出現 `Run workflow`
      按鈕（`GITEA-MIGRATION.md` §2.6）

- [ ] 提供 **GitHub PAT（scope 需 `write:packages`）** → 在 Gitea repo settings 存成 secret
      `GHCR_TOKEN`。在那之前 `build-production-image` 會在 docker login 步驟失敗（其餘步驟可跑）；
      `deploy-v3` / `production-predeploy-check` 不受影響（用 NAS secrets）。
- [ ] （可選，建議）改推 **Gitea 自己的 container registry**：把 `GHCR_REPO` 改成
      `jgitea01.reversalplay.me/JimmyGOD/5151`，並用 Gitea PAT（scope `write:package`）當
      `GHCR_TOKEN` / `GHCR_USER` → 完全不需要 GitHub。

## A7. Gitea 版本升級（1.22.6 → 1.27.3）— 部署 workflow 的前置條件

現況：Gitea 1.22.6 的 act parser 會**完全忽略**含 `workflow_dispatch.inputs` 的 workflow
（根因、程式碼位置、實測對照表見 `evidence/runtime-modernization/GITEA-MIGRATION.md` §2.6）。
已在 NAS 上的 throwaway `gitea/gitea:1.27.3`（port 5299，已刪除）用 **5151 真實的 4 個 workflow 檔**
驗證：**全部解析成功**，且新版提供 dispatch API → 升級後由 agent 直接觸發 build/deploy，
不需要 Owner 手動按按鈕。

- [ ] 決定目標版本：**`1.27.3`（已逐項實測）**；替代 `1.26.4` / `1.25.5`（皆在維護中）
- [ ] 授權升級窗口（Gitea 會短暫中斷；建議先清空 runner 佇列）
- [ ] （建議先做）**升級乾跑**：把 `gitea-db` 的 pg_dump 還原到臨時 PostgreSQL + 用目標版本起臨時 Gitea，
      確認 migration 與 4 條 workflow 都正常，再動正式站
- [ ] 執行升級：備份 `gitea-db` → 改 `deploy/gitea/docker-compose.yml` 的 image tag → `docker compose up -d` →
      驗收：`docker logs gitea 2>&1 | grep -a 'ignore invalid workflow'` **無輸出**、
      `GET /api/v1/repos/JimmyGOD/5151/actions/workflows` 回報 4 條、
      `POST .../actions/workflows/{id}/dispatches` 可用


## A5.（optional）OpenAI Reviewer API key

- [ ] 提供 `OPENAI_API_KEY`（僅 Final Review flow 用，非必要）

### A7 執行結果（已完成，2026-09-20）

- 版本決策：**1.27.3**（Owner 指示直接升級，不做 DB 複本乾跑；改用 throwaway 容器 + 5151 真實 workflow 檔
  先驗證解析 ✓，見 `GITEA-MIGRATION.md` §2.6）。
- 備份：`~/gitea-backups/20260920T044702Z`（pg_dump + gitea-data/gitea-db volume tar + compose/env/
  runner-config 快照，sha256 記在 §2.8）。
- 執行：compose image → `gitea/gitea:1.27.3`、`docker compose up -d --no-deps gitea`；
  DB schema **299 → 343**、readiness 15s、9 repos 與全部 secrets 保留、公開網址 200 ✓。
- 驗收：`ignore invalid workflow` 無新警告 ✓、`GET /actions/workflows` 回報 4 條且名稱正確 ✓、
  swagger 有 `.../workflows/{id}/dispatches` ✓、已用該 API 觸發 build（run 26）✓。
- 附帶修掉 2 個移植缺陷（`upload-artifact` 不支援、step 名稱的 colon+space）與 Gitea 端
  `deploy/gitea/docker-compose.yml` 對齊實況（runner 用 host docker socket + `1.27.3`）。
- 已知未解（僅記錄）：build 的 OCI label `org.opencontainers.image.source` 仍是字面
  `${SOURCE_REPO_URL}`（GitHub 版原本就這樣，非本次改動）；要修就把 label 改成 `${{ secrets.SOURCE_REPO_URL }}`。

