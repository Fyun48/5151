# Repo 收斂與 Gitea → GitHub 同步（2026-09-21）

Owner 決定：**版本管理回到 GitHub**（`github.com/Fyun48/5151`）。自架 Gitea
（`jgitea01.reversalplay.me`）**暫停**：只保留為可用環境，不再是權威來源、也不再當發版路徑。
**部署仍只走 GitHub Actions 的三條 manual-only workflow**（build → predeploy → deploy）。

## 1. 為什麼用「單一 snapshot commit」，而不是直接 push Gitea 的歷史

- GitHub `master` 的 `bcb6eb7`（PR #373 merge）是 Gitea `master`（`019c990`）的**祖先**：
  直接 `git push` 會 fast-forward，把 Gitea 時代的 commit 一次公開。
- 那段歷史含**明文 PostgreSQL 密碼**：`evidence/runtime-modernization/A4-HA-DRILL-20260920.md`
  的舊 blob。`8f537f8` 之後的檔案已改為指向 workspace 的 `INFRA-CREDENTIALS.md`（不在 repo 內），
  但**舊 blob 仍在 Gitea 的歷史裡**。本 repo 是公開的，所以歷史不能帶進來。
- 做法：以 Gitea `master` 的 **tree** 搭配 GitHub 既有的 `master` 當 parent，產生**一個** commit
  （`git commit-tree`），內容與 Gitea `master` 相同，因此不需要也不應該帶入中間歷史。
- 唯一偏離：`A4-HA-DRILL-20260920.md` 的密碼前後 3 碼片段在**匯入時就移除**（GitGuardian 在第一次送出的 PR 上正是把那兩個片段判成 2 個 secrets），所以本 PR 的每個 commit 都不含它。

| 項目 | 值 |
|---|---|
| 來源 | `jgitea01.reversalplay.me/JimmyGOD/5151`，`master` = `019c990` |
| 來源相對 | 比 GitHub `master`（`bcb6eb7`）**ahead 58**、behind 0 |
| snapshot commit | 本 PR 的 `sync(infra): import the Gitea-era CI/deploy/docs work as one snapshot` |
| 檔案變更 | 56 files changed, +4880 / -142 |
| 產品程式 | **無 `v3/src` 變更** |

內容範圍（56 檔）分類：

- **CI／工作流**：`.gitea/workflows/{ci,build-production-image,production-predeploy-check,deploy-v3,agent}.yml`
- **部署與環境**：`deploy/gitea/*`（dispatch、runner-config、notify、agent、migrate、smoke-diag、backfill-runs）、
  `deploy/code-server/*`、`deploy/shadow-ha/*`（含 `drill.sh`、`render-and-run.sh`、修正後的 haproxy 與備份腳本）
- **文件**：`docs/runbooks/gitea-5151-metadata-backfill.md`、`postgres-*` runbook 更新、
  `evidence/runtime-modernization/{HANDOFF,GITEA-MIGRATION,OWNER-SETUP-CHECKLIST,A4-HA-DRILL-20260920,STATUS}.md`
- **測試穩定度**：9 個 v3 測試檔的隔離子程序 timeout（`ISOLATED_TIMEOUT_MS`），無斷言變更
- **編輯器設定**：`.editorconfig`、`.vscode/settings.json`、`.gitattributes`

## 2. GitHub 端收斂（同日完成）

- **34 個 open PR 全部關閉**：它們是 OPS 包 4-37 的線性堆疊（base 指向上一支），內容已由
  PR #369 整合進 `master`（見 `OPS-INTEGRATION-MANIFEST.md`）。每支都留了說明；
  commit 仍可透過 `refs/pull/<n>/head` 取得，PR 本身也可重開。
  - 包號對應：#249(4) #251(5) #258(6) #259(7) #260(8) #261(9) #262(10) #263(11) #264(12)
    #265(13) #266(14) #267(15) #268(16) #269(17) #270(18) #271(19) #272(20) #273(21) #285(22)
    #287(23) #291(24) #292(25) #295(26) #296(27) #297(28) #298(29) #299(30) #300(31) #302(32)
    #303(33) #304(34) #305(35) #311(36) #312(37)
- **刪除 64 個舊分支**（61 個 `cursor/ops-*` + 3 個已合併的 `cursor/synology-*`），remote 之後只剩 `master`。

<details>
<summary>已刪除的分支清單（64）</summary>

```text
cursor/ops-budget-ed3f
cursor/ops-build-reuse-digest-pipefail-fix-39d3
cursor/ops-cancel-result-ed3f
cursor/ops-ci-fast-tests-39d3
cursor/ops-cmd-apply-ed3f
cursor/ops-cmd-cancel-ed3f
cursor/ops-cmd-gen-ed3f
cursor/ops-code-rollback-ed3f
cursor/ops-coding-gen-ed3f
cursor/ops-complete-ed3f
cursor/ops-crm-ed3f
cursor/ops-db-restore-ed3f
cursor/ops-delivery-confirm-ed3f
cursor/ops-deploy-v3-remote-syntax-fix-39d3
cursor/ops-deploy-v3-ssh-case-39d3
cursor/ops-design-ed3f
cursor/ops-dev-cancel-ed3f
cursor/ops-eval-cancel-ed3f
cursor/ops-existing-candidate-adoption-0ca3
cursor/ops-exit-retry-ed3f
cursor/ops-final-integration
cursor/ops-gate1-pending-ed3f
cursor/ops-gate2-pending-ed3f
cursor/ops-handoff-unknown-ed3f
cursor/ops-insight-ed3f
cursor/ops-late-ai-ed3f
cursor/ops-live-ed3f
cursor/ops-notify-cancel-ed3f
cursor/ops-phase1-foundation-b879
cursor/ops-phase10-coding-task-b879
cursor/ops-phase11-independent-qa-b879
cursor/ops-phase12-isolated-staging-b879
cursor/ops-phase13-release-gate2-b879
cursor/ops-phase14-db-migration-safety-bae1
cursor/ops-phase15-production-release-rollback-949c
cursor/ops-phase2-async-ingestion-b879
cursor/ops-phase3-5-deploy-safety-b879
cursor/ops-phase3-attachments-b879
cursor/ops-phase4-ai-classification-b879
cursor/ops-phase5-clustering-b879
cursor/ops-phase6-impact-b879
cursor/ops-phase7-evaluation-b879
cursor/ops-phase8-proposal-gate-b879
cursor/ops-phase9-reevaluation-b879
cursor/ops-phash-ed3f
cursor/ops-predeploy-backup-verify-39d3
cursor/ops-predeploy-backup-verify-node18-fix-39d3
cursor/ops-predeploy-smoke-sql-fix-39d3
cursor/ops-prod-cancel-ed3f
cursor/ops-qa-cancel-ed3f
cursor/ops-reeval-gen-ed3f
cursor/ops-reeval-pending-ed3f
cursor/ops-remote-cs-ed3f
cursor/ops-rollback-record-ed3f
cursor/ops-runner-cancel-ed3f
cursor/ops-stage-gen-ed3f
cursor/ops-staging-ed3f
cursor/ops-stale-gen-ed3f
cursor/ops-stats-ed3f
cursor/ops-unknown-confirm-ed3f
cursor/ops-v3-digest-deploy-39d3
cursor/synology-deploy-gate
cursor/synology-docker-path
cursor/synology-legacy-scp
```

</details>

## 3. 未動到的東西

- Gitea 上的 `JimmyGOD/5151`、runner、code-server、Cloudflare Access 政策、NAS 容器**都沒有改動**，只是不再當權威來源與發版路徑。
- `master` 上的 `docker-compose.yml` / `casaos-compose.yml` 仍寫 `:latest`（正式站靠 deploy 的 digest override），與本次收斂無關。
- 正式站仍是 CasaOS 的 `591-tracker-v3`（image `sha256:76e43cc1...`，即 `bcb6eb7` 的 build，並 bind mount `/mnt/Storage1/apps/5151/v3/src`）；本次同步**沒有**部署、沒有改 flag、沒有動 DB。

## 4. 建議的後續（尚未執行）

1. **輪替 PostgreSQL 密碼**：`PG_SUPER_PASSWORD` / `PG_REPLICATION_PASSWORD` 曾在 Gitea 歷史以明文存在（shadow 叢集；Synology `5151-postgres-B` = primary、CasaOS `5151-postgres-A` = hot standby）。輪替要同步更新兩台的 `.env`、primary 的 `ALTER ROLE` 與 standby 的 `primary_conninfo`，最後驗證複寫；步驟見 `docs/runbooks/postgres-manual-failover.md`，健康檢查用 `deploy/shadow-ha/drill.sh preflight`。
2. 重新檢視 Gitea 是否降級為「選用鏡像／選用 CI」：若確定不用，可停 `gitea-runner-ci` 與 `.gitea/workflows/*`（對 GitHub 無影響），但保留 `deploy/gitea/` 的 dispatch／runner 文件。
3. `evidence/runtime-modernization/STATUS.md` 的「EXTERNAL_SETUP_REQUIRED / 尚未開始」段落已過時（shadow HA、Gitea 都已上線），現況以 `HANDOFF.md` 的「還沒做的」為準。
