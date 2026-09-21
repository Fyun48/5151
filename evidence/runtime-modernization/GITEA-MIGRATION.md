# Gitea 遷移總覽（2026-09-20）

> Owner 指示：Gitea 為正式主場。本檔記錄「GitHub → Gitea」的完整遷移：
> repo 搬遷（含 issues/PRs/releases 等 metadata）、Actions workflow 移植、以及 Gitea 的相容性限制。
> 授權：Owner 已給永久授權，本檔所有操作皆已實際執行。

## 1. Repo 遷移（github.com/Fyun48/* → jgitea01.reversalplay.me/JimmyGOD/*）

以 Gitea 的 migration API（`POST /api/v1/repos/migrate`，`service=github`）搬遷，含
issues / pull_requests / labels / milestones / releases / wiki。

> **2026-09-20 更正（Owner 指出「我在 GitHub 上的專案不止這些」）**：`github.com/Fyun48` 底下共
> **18 個 repo**，第一輪只搬了 **9 個 public**（§1.1），另有 **9 個 private** 在第一輪完全沒被提到
> （§1.2，已於同日補完）。§1.1 原本的「合計 9 個 repo 全部在 Gitea」是**範圍錯誤**的敘述 —— 正確說法是
> 「9 個 public 全部在 Gitea」。

### 1.1 第一輪：Public（9 個，已遷移）

| GitHub repo | Gitea repo | 預設分支 | 備註 |
|---|---|---|---|
| `Fyun48/5151` | `JimmyGOD/5151` | master | 先前已遷移（30 分支、CI 已運作） |
| `Fyun48/your-remit-01` | `JimmyGOD/your-remit-01` | main | 58 MB。GitHub 端 **0 issues、無 wiki**；Gitea API 經 Cloudflare 會 524，改從 NAS 內部呼叫；首次失敗為 DNS 暫時錯誤，重試成功 |
| `Fyun48/your-remit-erpdev` | `JimmyGOD/your-remit-erpdev` | master | 615 檔 |
| `Fyun48/ForumSeeksDLer` | `JimmyGOD/ForumSeeksDLer` | master | releases 已匯入（Gitea 顯示 release_counter=18） |
| `Fyun48/your-remit-erp01` | `JimmyGOD/your-remit-erp01` | main | |
| `Fyun48/yourremit-accounting-system` | `JimmyGOD/yourremit-accounting-system` | main | |
| `Fyun48/hsihung_php` | `JimmyGOD/hsihung_php` | main | |
| `Fyun48/Fyun48` | `JimmyGOD/Fyun48` | main | GitHub 端是空 repo（無 commit）→ Gitea 亦為空 |
| `Fyun48/HeyWorld` | `JimmyGOD/HeyWorld` | master | 同上 |

**9 個 public 全部在 Gitea。**

### 1.2 第二輪：Private（9 個，2026-09-20 補完）

工具：`deploy/gitea/migrate-github-repos.sh`（NAS 上放 `~/migrate-github-repos.sh`；
`plan` / `apply` / `verify` 三個子命令，token 用 env 帶且不留在 argv）。

```bash
# 在 NAS 上；token 放 env 檔再 source（不要留在 command line）
GITEA_TOKEN=<pat> GH_TOKEN=<github-token> bash ~/migrate-github-repos.sh plan   <repo>...
GITEA_TOKEN=<pat> GH_TOKEN=<github-token> bash ~/migrate-github-repos.sh apply  <repo>...   # 已存在會跳過 → 自動驗收
GITEA_TOKEN=<pat> GH_TOKEN=<github-token> bash ~/migrate-github-repos.sh verify <repo>...
```

| GitHub repo | 大小 | 分支 | PRs | 預設分支 | 備註 |
|---|---|---|---|---|---|
| `Fyun48/yourfavorestore` | 7.1 MB | 99 | 96 | main | 最大的一顆；**Gitea 是伺服器端遷移**，客戶端斷線不影響（PR 數 49→96 一路爬到完） |
| `Fyun48/your-remit-erp02` | 2.7 MB | 2 | 2 | master | |
| `Fyun48/my-erp-mobile` | 246 KB | 1 | 0 | master | |
| `Fyun48/bnplloan` | 206 KB | 1 | 0 | main | BNPL 跨境收款 |
| `Fyun48/MBRIAPI` | 61 KB | 1 | 0 | master | Mock BRIAPI BRIfast Incoming Remittance |
| `Fyun48/ECPAPI` | 36 KB | 2 | 1 | main | Mock ECPay API server（截圖上的「ECRAPI」是誤讀）|
| `Fyun48/cnndemo` | 1 KB | 1 | 0 | main | |
| `Fyun48/hsihung_php2` | 0 | 0 | 0 | main | **空 repo**：migration API 會回 409 `Git Repository is empty` → 改用 `POST /user/repos` 建空 repo |
| `Fyun48/tori` | 0 | 0 | 0 | main | 同上 |

**驗收（9 個全 `ALL OK`）**：分支數與預設分支 tip sha 兩邊**完全相等**，issues/PRs/releases 不少於 GitHub，
且 `private=true` 與 GitHub 端一致。例：`yourfavorestore 99/99 branches、96/96 PRs、head b422e8bd`。

### 1.3 累積踩到的坑

1. **Cloudflare 100 秒上限**：大型 repo 的 migration 請求經 `jgitea01.reversalplay.me` 會 **HTTP 524**，
   而且會留下一個**空的** repo（必須先刪再重跑）。改從 NAS 內部 `curl http://127.0.0.1:5251` 就正常。
2. **GitHub 匿名 API 速率限制**（60/h per IP）：連續遷移多個 repo 後出現
   `Remote visit addressed rate limitation`。第一輪只有 `your-remit-01` 受影響，而它 GitHub 端沒有任何
   issue/wiki，故改用 `service=git`（純 clone）完成，未損失 metadata。（第二輪全部用 token，沒再遇到。）
3. PowerShell 5.1 傳 JSON 給 ssh 時會吃掉雙引號 → 一律把 JSON 寫成檔案再 `--data-binary @file`；
   遠端複雜指令也用同一招（本機寫檔 → `scp -O` → 執行），不要硬塞 inline quoting。
4. **`gho_` token 可以當 `auth_token`**：gh CLI 的 OAuth token（scopes 含 `repo`）直接餵給
   migration API 的 `auth_token` 就能搬 private repo（實測 201，PR metadata 也一起來），不必另開 classic PAT。
5. **兩邊的 JSON 格式不同**：GitHub 是**縮排多行 + 冒號後有空白**（`"default_branch": "main"`），
   Gitea 是緊湊格式（`"size":7129`）。自己 parse 時沒處理那個空白，會把 ` main` 當成 branch 名塞進
   URL → `curl: (3) Error`（malformed URL），而且驗收表只會「空白」不會報錯。
6. **精確計數的來源**：Gitea 的 list 端點回 `X-Total-Count`，實測**就是真總數**
   （5151 `branches?limit=1` → 65，與 `git ls-remote` 一致）；GitHub 不回這個 header，要讀
   Link header 的 `rel="last"`（帶 `?per_page=1`，最後一頁頁碼＝總數）。解析務必用 `[?&]page=`——
   只寫 `page=` 會先命中 URL 裡的 `per**page**=1` → 永遠得到 1（實測踩過）。
7. **Synology 上沒有 `git`**（`command -v git` → MISSING）→ 驗收不能用 `git ls-remote`，一律走 API。
8. **遷移是 Gitea 伺服器端的事**：`nohup … &` 之後客戶端 curl 早斷了，Gitea 仍在搬（PR 數持續爬升）。
   判斷「搬完沒」要看 Gitea 端的計數，不是看本機 log（那行 `migrated (HTTP 201)` 不會出現）。
9. **`set -euo pipefail` 下 helper 必須永遠回 0**：`x="$(helper)"` 的退出碼直接決定腳本生死。
   空 repo 取不到 branch sha（grep 沒命中 → 回 1）會讓整張驗收表在那一列**中斷且不報錯** —— 已全部加 `|| true`。

### 1.4 已知落差：`JimmyGOD/5151` 只有 git 內容，沒有 issues/PRs

第一輪的 5151 是**純 git 遷移**（沒帶 metadata）：Gitea `JimmyGOD/5151` 的 issues / pulls
`X-Total-Count` 都是 **0**，而 GitHub `Fyun48/5151` 有 **19 issues + 354 PRs**。
程式碼本身沒有落差（分支 65/65、master tip sha 一致）。
要補只能「刪掉 Gitea 5151 再重新 migrate」（migration API **不支援**對既有 repo 補 metadata），
代價是失去 Gitea 上既有的 Actions run 歷史與 repo secrets/variables（值有留存、可重建）。
**本輪未執行** —— 等 Owner 決定。

## 2. Actions workflow 移植

### 2.1 現況

| 檔案 | 狀態 |
|---|---|
| `.gitea/workflows/ci.yml` | 既有（測試；push/PR 觸發），已連續多次綠燈 |
| `.gitea/workflows/build-production-image.yml` | **新增**（移植自 `.github/workflows/`）|
| `.gitea/workflows/production-predeploy-check.yml` | **新增**（移植）|
| `.gitea/workflows/deploy-v3.yml` | **新增**（移植）|
| ⚠️ 上列 3 個移植檔在 **Gitea 1.22.6 被 parser 判 invalid 而完全忽略** | ⛔ 見 §2.6（升級 Gitea 才能觸發）|


三個移植檔全部維持 **manual-only**（`workflow_dispatch`，需 40 碼 sha + 精確 confirmation 字串），
push 不會自動部署。

### 2.2 Gitea 相容性調整（依官方 Compared to GitHub Actions）

| 項目 | GitHub 原版 | Gitea 版 | 原因 |
|---|---|---|---|
| `jobs.<job_id>.environment` | `environment: production` | 移除（留註解） | Gitea **不支援** environments → 原 environment 保護規則無對應物；授權仍靠 workflow 內的 fail-closed 檢查（actor + confirmation） |
| 允許的觸發者 | `vars.PRODUCTION_DEPLOY_ALLOWED_ACTOR` | `secrets.PRODUCTION_DEPLOY_ALLOWED_ACTOR` | 用 repo secret 最穩（Gitea 的 vars 支援不保證） |
| docker login | `secrets.GITHUB_TOKEN` | `secrets.GHCR_USER` / `secrets.GHCR_TOKEN` | Gitea 的 job token 是 **GITEA_TOKEN**，且**不能用來推 OCI**（未實作 package 授權）→ 推 ghcr.io 需 GitHub PAT |
| `permissions.packages` | `write` / `read` | 移除 | GitHub-only scope |
| registry path | `ghcr.io/${GITHUB_REPOSITORY,,}` | `${GHCR_REPO}`（secret） | Gitea 的 `github.repository` = `JimmyGOD/5151`，與實際 image path `ghcr.io/fyun48/5151` 不同 |
| OCI provenance | `https://github.com/${GITHUB_REPOSITORY}` | `${SOURCE_REPO_URL}`（secret） | 同上（image label 記的是 GitHub 來源） |

### 2.3 已建立的 Gitea repo secrets（`JimmyGOD/5151`）

`PRODUCTION_DEPLOY_ALLOWED_ACTOR=JimmyGOD`、`GHCR_REPO=ghcr.io/fyun48/5151`、
`SOURCE_REPO_URL=https://github.com/fyun48/5151`、`GHCR_USER=Fyun48`、
`NAS_HOST`/`NAS_PORT`/`NAS_USER`/`NAS_SSH_KEY`（正式 NAS 的 SSH 存取，與 GitHub 版相同語意）。

**EXTERNAL_SETUP_REQUIRED**：`GHCR_TOKEN`（具 `write:packages` 的 GitHub PAT）。
在 Owner 提供前，`build-production-image` 會在 docker login 步驟失敗（其餘步驟可正常執行）；
`deploy-v3` / `production-predeploy-check` 不受影響（用 NAS secrets）。

### 2.4 驗證

- 三個檔案 YAML 解析通過（PyYAML 6.0.1；GitHub 原版一併驗過）。
- 不含 Gitea 不支援的鍵（`environment` 已移除）。
- **未觸發**這三個 workflow（production 部署是 Owner 的決定）。
- Gitea runner 是**實例級**註冊（`action_runner.owner_id=0, repo_id=0`）、`capacity=1`、
  labels `[ubuntu-latest, ubuntu-24.04, ubuntu-22.04]`。

## 2.5 Gitea Actions 相容性實測（probe repo）

為了不靠猜測，建了 throwaway repo `JimmyGOD/ci-probe`（內含 2 個 probe workflow，push 觸發；
**已於驗證後刪除**）實測 Gitea 1.22.6 + act_runner 的行為：

| 項目 | 實測結果 | 對 migration 的影響 |
|---|---|---|
| `github.actor` | ✅ `JimmyGOD` | 可用 |
| `github.triggering_actor` | ❌ **空字串** | fail-closed 檢查會一律拒絕 → 三個 port 都改成 `github.triggering_actor \|\| github.actor` |
| `github.repository` / `repository_owner` | ✅ `JimmyGOD/ci-probe` / `JimmyGOD` | 與 ghcr.io 的 `fyun48/5151` 不同 → 用 secrets 提供 registry path |
| `github.run_number` / `run_attempt` | ✅ `1` / `1` | 可用（evidence JSON 用得到） |
| `vars.<NAME>`（repo variable） | ✅ 有值 | 可用；port 仍改用 `secrets.` 以求穩定 |
| `secrets.<NAME>`（自訂） | ✅ 有值 | 可用 |
| `secrets.GITEA_TOKEN` | ✅ 40 字元 | Gitea 的 job token |
| `secrets.GITHUB_TOKEN` | ✅ 40 字元（**但那是 Gitea token**） | 不能推 OCI → 推 ghcr.io 仍需 GitHub PAT |
| `GITHUB_ENV` 傳遞到下一步 | ✅（`PROBE_TO_ENV_IN_NEXT_STEP=[ok]`） | 原 workflow 的 `>> "$GITHUB_ENV"` 可用 |
| `GITHUB_OUTPUT` / `GITHUB_STEP_SUMMARY` | ✅ 路徑存在且可寫 | 原 workflow 的寫法可用 |
| runner 內工具 | ✅ node v24.19.0 / docker 24.0.2 / git 2.55.0 | docker build / push 步驟可執行 |
| `jobs.<job_id>.environment` | ❌ 官方明列不支援 | 已移除（見 §2.2） |
| `steps.<id>.outputs.<name>`（probe2） | ✅ `hello-output` | 原 workflow 的 `steps.image.outputs.name` 可用 |
| `${{ github.triggering_actor \|\| github.actor }}`（probe2） | ✅ `JimmyGOD` | fallback 寫法有效 |
| `if:` 搭配 expression（probe2） | ✅ 條件成立才執行、`if: false` 會跳過 | 可用 |

- probe 執行紀錄：`action_run` id=14（`gitea-context-probe`）status=1（success）、
  id=17（`gitea-context-probe2`）status=1（success）。
- runner 資訊：`action_runner` owner_id=0/repo_id=0（**實例級**）、capacity=1、
  labels `[ubuntu-latest, ubuntu-24.04, ubuntu-22.04]`。
- ⚠️ 已知怪癖：`action_run.status` 對部分 run 顯示 `2`（失敗），但同一 run 的 runner log
  明確出現 `Job succeeded`（例：run 13 / 15）。判斷 CI 結果**以 runner log 為準**
  （`docker logs gitea-runner-ci`，或 `action_run_job` / `action_task` 的狀態）。

## 2.6 ⛔ Blocker（已定位）：Gitea 1.22.6 會忽略含 `workflow_dispatch.inputs` 的 workflow

**症狀（Owner 於 2026-09-20 發現）**：Gitea UI → Actions 左側看得到 4 個 workflow 檔，但點進
`build-production-image.yml` 只顯示「工作流程沒有執行過」，**沒有 `Run workflow` 按鈕**；
`production-predeploy-check.yml` / `deploy-v3.yml` 同樣。

**根因**：Gitea 1.22.6 內建 `gitea.com/gitea/act v0.259.1`（act 的 Gitea fork）解析 workflow。
`pkg/jobparser/model.go` 的 `ParseRawOn()` 處理 `on:` mapping 值時，只接受**字串 / 字串序列**這幾種
巢狀形狀，不接受 `inputs:` 這種 **map** 巢狀：

```go
case map[string]interface{}:
    for act, branches := range t {          // act = "inputs"
        switch b := branches.(type) {
        case string:      ...
        case []string:    ...
        case []interface{}: ...
        default:
            return nil, fmt.Errorf("unknown on type: %#v", branches)   // ← 我們踩到的分支
```

`workflow_dispatch: {inputs: {sha: {...}}}` → `inputs` 的值是 map → 落 `default` → 回錯 →
Gitea `modules/actions/workflows.go` 的 `DetectWorkflows()` 記下
`[W] ignore invalid workflow "<檔名>": unknown on type: map[string]interface {}{...}` 後**整個跳過該檔**
（UI 沒有按鈕，且任何事件都不會觸發它）。上游 issue：**go-gitea/gitea#30351**（2024-04 開、2024-10 關，
未 backport 進 1.22 系列；Gitea `main` 的呼叫點仍是同一個 `jobparser.ParseRawOn(&workflow.RawOn)`
→ 修正來自 Gitea 把解析器收回去自己做：1.27.3 的 module 已改名 `gitea.dev`，go.mod **完全沒有 `nektos/act`**（改用自家的 `gitea.com/gitea/runner`）；1.22.6 則是 `nektos/act v0.2.52` + `replace => gitea.com/gitea/act v0.259.1`）。

**實測（唯一差異是 Gitea 版本；同一組檔丟進 throwaway repo，以 Gitea log 當裁判）**：

| 檔案 | `on:` 形狀 | Gitea 1.22.6 | Gitea 1.27.3 |
|---|---|---|---|
| `c.yml` | `workflow_dispatch: inputs: {sha: {description, required}}` | ❌ invalid | ✅ 正常 |
| `e.yml` | 同上 + `default: ""` + 中文 description | ❌ invalid | ✅ 正常 |
| `i.yml` | 同上 + `type: boolean` / `type: choice` + `options` | ❌ invalid | ✅ 正常 |
| `f.yml` | 純 `on: workflow_dispatch` + `run-name: <字串>` | ✅ 正常 | ✅ 正常 |
| `z-broken.yml` | 故意壞 YAML（對照組） | — | ❌ invalid（證明 oracle 有效）|

再以 **5151 真實的 4 個 workflow 檔**在 Gitea 1.27.3 驗證：**4 個全部解析成功**（無任何
`ignore invalid workflow`），且 `GET /actions/workflows` 正確回報
`Build production image (no deploy)` / `Production predeploy check (no deploy)` /
`Deploy v3 to CasaOS (manual)` / `CI`。

**結論 / 待辦**：**升級 Gitea 是這三個 workflow 能上線的唯一前置**（1.22.6 → 1.27.3 已實測；
Owner 決策 + 升級窗口）。升級後「手動按 Run workflow」也不再必要：新版有 dispatch API
`POST /api/v1/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`
（實測 1.27.3 帶 `inputs` 回 **HTTP 204** 並建立 run；1.22.6 的 swagger **沒有**這個端點），
可由 agent 直接觸發並讀 run 狀態。版本選項/步驟見 `OWNER-SETUP-CHECKLIST.md` A7。
測試環境已清理（throwaway `gitea/gitea:1.27.3` 容器、`JimmyGOD/probe-on-shapes` probe repo 皆已刪除）。

### 2.6.1 判讀 oracle（升級後可重複使用）

```bash
# 沒有出現某檔名 = parser 接受它（= UI 有 Run workflow 按鈕、事件觸發有效）
docker logs --since 10m gitea 2>&1 | grep -a -F 'ignore invalid workflow'
# workflow 清單（1.23+ 才有；1.22 會 404）
curl -s -u <user>:<token> https://<host>/api/v1/repos/<owner>/<repo>/actions/workflows
```




### 2.7 操作備忘（觸發 / 讀 log / 查 DB）


- 觸發（**升級 Gitea 後才可用**，見 §2.6）：優先由 agent 打 dispatch API
  `POST /api/v1/repos/JimmyGOD/5151/actions/workflows/<file>/dispatches`（body `{"ref":"master","inputs":{...}}`）；
  也可 Gitea repo → Actions → 選 workflow → Run workflow（填 sha / confirmation）。
- ⛔ 2026-09-20 現況：Gitea 1.22.6 把這 3 個檔判成 invalid → UI 不會出現 Run workflow，dispatch API 也不存在。
- 讀 log：NAS 上 `docker logs gitea-runner-ci`（完整 job 輸出）；Gitea 端另有
  `/data/gitea/actions_log/<owner>/<repo>/<run>/<n>.log`。
- 執行紀錄（DB 可查）：`docker exec gitea-db psql -U gitea -d gitea -tAc 'SELECT id, repo_id, status, title FROM action_run ORDER BY id DESC LIMIT 10;'`
  （status：1=success、2=failure）。

## 2.8 Gitea 升級（1.22.6 → 1.27.3，已執行；2026-09-20）

Owner 指示「直接升級到 1.27.3」（備份 → 改 image tag → compose up → 驗收）。

**備份（NAS `~/gitea-backups/`，TS = `20260920T044702Z`）**

| 檔案 | 大小 | sha256 |
|---|---|---|
| `gitea-db-<TS>.sql.gz` | 1,315,381 | `1a8cf3568fe7d9d8c59b94dea8c29636b2b96e7e73eb4e03999015a825d1302c` |
| `gitea-data-<TS>.tar.gz` | 90,007,612 | `df5240f975735797df79f816b29606b125ceab58506aa7454e128bb25ad203c4` |
| `gitea-db-volume-<TS>.tar.gz` | 15,364,750 | `9784a1148d34b2cc97ff9f622d12e32e078902e588786a7c38f946bb578be5ad` |

另存 `docker-compose.yml.<TS>` / `env.<TS>` / `runner-config.yaml.<TS>` 快照。

**升級前狀態**：Gitea 1.22.6、DB schema `version = 1|299`、9 repos、19 runs；等 CI run 22 綠燈後才動手。

**執行**：`~/gitea/docker-compose.yml` 的 `image: gitea/gitea:1.22` → `gitea/gitea:1.27.3`，
`docker compose up -d --no-deps gitea`（Compose v2.20.1）→ **只有 `gitea` 容器被重建**；
`gitea-db` / `gitea-runner-ci` / `jgitea-tunnel` 未動、volume 對應不變
（`5151-gitea_gitea-data → /data`）。

**結果**：readiness 15 秒（`{"version":"1.27.3"}`）、migration **299 → 343** 全部完成
（僅 2 個無害的 default 差異警告）、無 `[E]`/`[F]`、9 repos 與 secrets 全保留
（8 個 repo 層 + `GHCR_TOKEN` 帳號層 `repo_id=0`）、公開網址 HTTP 200。

**驗收（A7 全部通過）**：
- `GET /api/v1/repos/JimmyGOD/5151/actions/workflows` → 4 條且名稱正確：
  `Build production image (no deploy)` / `CI` / `Deploy v3 to CasaOS (manual)` /
  `Production predeploy check (no deploy)`（1.22.6 時這 3 條的 name 是「檔名」= 解析失敗的徵狀）
- swagger 出現 `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`
  （另有 `/actions/runs`、`/runs/{run}/rerun`、`/workflows/{id}/enable|disable`）
- `docker logs gitea | grep 'ignore invalid workflow'` → 無新警告
- 3 條 workflow 可觸發：由 agent 用 dispatch API 直接觸發 build（見 §2.9）

**回滾**：compose tag 改回 `1.22` 再 `up -d --no-deps gitea` 只能退回程式碼；
DB schema 已前進到 343，Gitea 不支援降版 migration → 真要降版必須用上表的 dump 還原。

## 2.9 升級後首次觸發（dispatch API）與移植缺陷修正

**觸發方式**（1.22.6 沒有 dispatch API、UI 也因 §2.6 不會出現按鈕）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -u '<user>:<token>' \
  -H 'Content-Type: application/json' \
  -X POST --data '{"ref":"master","inputs":{"sha":"<40 碼 sha>","release_mode":"manual_owner","release_intent_id":""}}' \
  http://127.0.0.1:5251/api/v1/repos/JimmyGOD/5151/actions/workflows/build-production-image.yml/dispatches
# → HTTP 204（1.22.6：端點不存在，UI 也沒有按鈕）
```

**run 23（sha=b63b846，首次）**：gate 全過（`Authorize build (fail-closed)`、
`Checkout workflow-definition SHA`、`Stage trusted workflow-definition evidence writers`、
`Write Manual Owner ... evidence` 皆 Success），但 `actions/upload-artifact@v4` **在 act runner 直接失敗**：

```
::error::@actions/artifact v2.0.0+, upload-artifact@v4+ and download-artifact@v4+
are not currently supported on GHES.
```

→ 兩個 upload step `Failure` → job 失敗 → 後面的 docker login / build / push 全被跳過。
**修法**：3 個移植檔的 4 個 upload step 改成 `run:` 把 evidence 印進 run log + step summary
（GitHub 版保留 `upload-artifact@v4` 不動）。

**順手踩到的 YAML 陷阱**：改寫時把 step 命名成
`name: Publish Manual Owner run identity (Gitea: run log + step summary)` —
**YAML plain scalar 不能含 `: `** → Gitea 立刻判定
`yaml: line 163: mapping values are not allowed in this context`，3 個 workflow 全部變 invalid
（徵狀：`/actions/workflows` 的 `name` 退回檔名、UI 再度沒有 Run workflow）。
去掉冒號後即恢復（本地用 eemeli/yaml 驗證 + Gitea log 二次確認）。
**教訓：Gitea workflow 的 `name:`/label 若含冒號，一定要加引號。**

**run 26（sha=0ece500，修正後）** 步驟結果：

| step | 結果 |
|---|---|
| `Authorize build (fail-closed)` | ✅ |
| `Checkout workflow-definition SHA` / `Stage trusted ... writers` | ✅ |
| `Write Manual Owner run identity` | ✅ |
| `Publish Manual Owner run identity (Gitea run log + step summary)` | ✅（新寫法生效） |
| `Validate SHA reachable from origin/master, then check it out` | ✅ |
| `docker/setup-qemu-action@v3` / `docker/setup-buildx-action@v3` | ✅ |
| **`docker/login-action@v3`** | ✅ **`Login Succeeded!`** → Owner 的 `GHCR_TOKEN` 有效 |
| `Image name` / `Reuse existing immutable SHA tag if trustworthy` | ✅ |
| `docker/build-push-action@v6` | ❌ |

失敗原因（runner 端，非 workflow 邏輯）：

```
Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.43/containers/<id>/archive?path=%2Fvar%2Frun%2Fact%2Fworkflow%2Fpathcmd.txt":
context deadline exceeded
```

= act_runner 經 docker socket 讀回 job 容器檔案時 **timeout**（`--platform linux/amd64,linux/arm64`
的 qemu 編譯把 NAS 的 docker daemon 壓滿；buildx 進度到 `[linux/arm64 5/7] COPY v3/src` 附近即撞上）。

**後續選項（尚未決定，等 Owner 指示）**
1. 直接重跑同一個 sha（runner 空閒時成功率高；run 26 是排在 CI 後面才跑、NAS 當時負載高）。
2. Gitea 版只建 `linux/amd64`（實際 production 容器跑在 x86 的 CasaOS/Synology），arm64 留在 GitHub 版
   → 時間與負載大幅下降，但會與 GitHub 版的 manifest 不同。
3. 提高 runner 資源 / 調整 act_runner 的 Docker API timeout。

## 2.10 更正：run 26 的真正原因是 `runner.timeout: 20m`（不是 daemon 被壓滿）

§2.9 把 run 26 的失敗歸因於「qemu 把 docker daemon 壓滿」— **這個判斷是錯的**。
Owner 指示「提高 runner 資源／調 act_runner 的 Docker API timeout 後再重跑」，回查後發現：

- `~/gitea/runner-config.yaml` 裡是 **`runner.timeout: 20m`**（runner 端的 **job 層** timeout）。
- run 26 起跑 `05:15:23` → 失敗 `05:35:25` = **20 分 02 秒**，與 20m 完全吻合。
- 那句 `context deadline exceeded` 是 job timeout 到期後、act_runner 仍在讀 job 容器檔案時的
  **症狀**（context 被取消），不是 docker daemon 無回應。
- runner 容器本身**沒有任何 CPU/記憶體限制**（`Memory=0 CpuShares=0`；NAS 33.6 GB / 4 CPU），
  所以「加資源」沒有標的 —— 真正要調的是 timeout。

**已做的調整（正式站 + repo 同步）**
- NAS `~/gitea/runner-config.yaml`：`runner.timeout` 20m → **60m**、`log.level` debug → info
  （舊檔備份成 `runner-config.yaml.bak-<TS>`）；`docker compose restart gitea-runner-ci` 生效。
- repo 新增 **`deploy/gitea/runner-config.yaml`**（原本 repo 缺這個檔，只有 compose 引用它）。
- `.gitea/workflows/build-production-image.yml`：`timeout-minutes` 45 → **60**（檔頭第 8 點記錄）。
- 重跑：以 dispatch API 再觸發同一個 sha（結果後補於本節）。

### 2.10.1 重跑結果（run 29 / run 30）

**run 29（第一次重跑，失敗 — 但驗證了 fail-closed 有效）**
- 症狀：`Authorize build (fail-closed)` 在 **0 秒**內 failure，後續步驟全 skip →
  `python3: can't open file '/tmp/trusted-workflow-scripts/write-manual-owner-workflow-evidence.py'`。
- 原因：我 dispatch 時用 bash 從 API 撈 sha 的 sed 沒抓到值 → payload 的 `inputs.sha` 是**空字串** →
  workflow 的 gate 依 `^[0-9a-f]{40}$` 規則**正確拒絕**（run 的 `display_title` 是 `manual-owner:` 即空 sha 的指紋）。
- 結論：**治理機制運作正常**，空 sha 進不了 build。之後改為把 sha 寫死在 dispatch 指令裡。

**run 30（第二次重跑，修正 payload 後）**
- dispatch：`HTTP 204`，`display_title = manual-owner:176539df439d90d70f7c6c8112f52f912522f7b9`
  （sha 為含「runner timeout 60m + workflow timeout 60」修正的 master）。
- 佇列：`gitea-runner-ci` 的 `capacity: 1`，所以 run 30 需等當下的 CI run 28 跑完才輪到。
- 期間維運插曲（已修復）：我用 `timeout 90 docker compose up -d gitea-runner-ci` 想重啟 runner，
  但 compose 連帶把 `gitea` 容器重建成「Created 未啟動」，且指令被 timeout 砍在中途 →
  Gitea 服務中斷約 1 分鐘。改用 `nohup docker compose up -d &` 後全部恢復
  （`gitea` 1.27.3、`gitea-db` **全程未動**、`gitea-runner-ci` 以 `level=info` 新設定啟動、tunnel 200）。
  **教訓：遠端長指令要 nohup，且 `compose up -d <svc>` 會連帶重建 `depends_on` 的服務。**

## 2.11 工具：`deploy/gitea/dispatch.sh`（觸發 / 讀結果）

今天手打 dispatch API 的 curl 太多次，而且出過一次送空 sha 的包（§2.10.1 run 29）
→ 固化成腳本，**送出前先在本地跑一次與 workflow 相同的 fail-closed 規則**。

```bash
# 建議在 NAS 上跑（預設走內部 http://127.0.0.1:5251，避開 Cloudflare 100s 上限）
GITEA_TOKEN=<pat> bash deploy/gitea/dispatch.sh run build-production-image.yml "$(git rev-parse HEAD)" \
    --input release_mode=manual_owner --input release_intent_id=
GITEA_TOKEN=<pat> bash deploy/gitea/dispatch.sh status <run-id>
GITEA_TOKEN=<pat> bash deploy/gitea/dispatch.sh logs <run-id> [--tail N]     # tail 0 = 全部
```

- 本地防呆（與 workflow 內的 gate 一致）：sha 必須 40 碼小寫 hex；`release_mode` 只允許
  `manual_owner` / `ops_phase15`；`manual_owner` 不准帶 `release_intent_id`、`ops_phase15` 必須帶。
- 讀 log 改用 `GET /actions/jobs/{id}/logs`（Gitea 1.27 才有），不必再 `docker logs gitea-runner-ci`
  從混了兩個 run 的輸出裡撈。
- 2026-09-20 實測：`bash -n` OK；`status` / `logs` 對 run 30 正常；兩個防呆都正確擋下。
  token 一律用 `GITEA_TOKEN` 環境變數，**不寫進 repo**。
- ⚠️ 同日補修：第一版只從 `--input` 收集 inputs，**漏帶 `sha`** → workflow 的 fail-closed gate 回
  `sha must be a full 40-character commit SHA`（run 35 失敗，gate 再次證明有效）。
  已改成把第 2 個參數的 sha 自動放進 `inputs.sha`，並用「故意指向不存在的 workflow」做 dry run
  確認 payload 正確、且不會建立 run 之後，才真的 dispatch。

## 2.12 runner capacity 與 CI concurrency（2026-09-20，Owner 指示「#2」）

**問題**
- `gitea-runner-ci` 的 `capacity: 1` → build 得排在同一時間的 CI 後面（實測等約 20 分鐘才輪到）。
- `ci.yml` 的 `cancel-in-progress: true` 會把同 group 中**還在排隊**的舊 run 標成 cancelled（run 24/27）
  → 那些 commit（含 `74fcbac` 的 artifact 修正）永遠沒有 CI 結論，master 的「每個 commit 都有綠燈」出現缺口。
- 期間還看到 Gitea 的顯示怪癖：DB `action_run.status` 可能是 3（cancelled）但 runner log 是 `Job succeeded`
  → 判讀一律以 runner log / job log 為準。

**決定（repo 已改）**
- `runner.capacity` 1 → **2**、`runner.timeout` 60m → **90m**（NAS 4 vCPU / 33 GB，shadow pg/HAProxy 等容器多閒置）。
- `ci.yml`：`cancel-in-progress: false` → **master 的 run 一律不取消**（每個 commit 都要留下結論）。
- `build-production-image.yml`：`timeout-minutes` 60 → **90**（與 CI 併行時會更慢，避免被誤判成失敗）。
- **不採用 `paths-ignore: '*.md'`**：測試會讀 markdown —— `test/v3-compose.test.js` 讀 `README.md`、
  `test/cursor-rules.test.js` 讀 `design-system/property-platform/MASTER.md`、
  `v3/test/release-readiness-gate.test.js` 要求 `v3/RELEASE-READINESS.md` 存在 → 忽略 `*.md` 會漏測。

**套用順序**：repo 先改（本節）；live `~/gitea/runner-config.yaml` **等 run 30 結束後**才套用
（重啟 runner 會殺掉正在跑的 job；且遠端長指令一律 `nohup … &`，避免像 compose 那次被中斷）。

**同日實測與踩到的坑**
- live 套用方式：`docker restart gitea-runner-ci`（**不要**用 `docker compose up -d gitea-runner-ci` ——
  compose 會依 `depends_on` 連帶重建 `gitea`，上次就是這樣把 Gitea 服務弄掉約 1 分鐘）。
- 驗證：run 34（＝#2 那個 commit 的 CI）= `status 1` success；`gitea` 容器未被牽動（Up 59 分鐘）。
- ⚠️ **rerun 會沿用該 run 原本的 workflow 定義**：rerun 舊 CI run（當時 `cancel-in-progress: true`）
  會把較新的 run 取消掉（run 36 被 run 33 的 rerun 取消 ✗）。要 backfill 被取消的舊 run 只能
  **一次一個、等前一個結束**，否則就改用新 commit 重跑。
- ⚠️ **smoke 步驟「健康檢查連不到」的真因不是啟動慢，是拓撲**（2026-09-20 run 57/#54 定位）：
  job 容器掛在 `5151-gitea_default` 橋接網路上，它裡面的 `127.0.0.1:<host_port>` 指的是**它自己**；
  而 `-p 127.0.0.1::5153` 只綁 host loopback（從 bridge 連 gateway IP 也看不到）→ curl 150 次全部
  `Failed to connect to 127.0.0.1 port 32771`，但**同一時間 app 早就起來了**（NAS 上實測 4–5 秒 ready）
  → 150 秒窗只是在延後失敗。修法：smoke 容器**完全不發佈 host port**，改 `--network <job 的網路>`
  並用**容器名**當 host（`http://$NAME:5153`）；等待窗回到 60 秒，並加「容器中途死掉就立刻紅燈印 log」。
  順帶解掉固定埠撞 `5151-web-B`（run 30 的 `port is already allocated`）。完整記錄見檔頭第 10–12 點。

## 2.13 run 的兩個編號：UI `#N`（`run_number` / DB `index`）vs 內部 `id`

**規則（2026-09-20 以實機 DB + API 雙向確認）**
- **Gitea UI 顯示的是 `run_number`** —— 在資料庫就是 `action_run.index`，它是**每個 workflow 各自的流水號**。
- **API / DB 的主鍵是 `action_run.id`**（跨 workflow 遞增）；我在對話與腳本裡引用的「run N」是這個。
- 兩者不同步：**id=38 ↔ UI `#35`**（同一筆 build run）。
- `dispatch.sh status/logs` 吃的是**內部 id**；`status` 現在會同時印出 UI 編號
  （例：`run id=38 (UI #35): status=in_progress`）。

| 內部 id | UI `#`（`index`） | workflow | 結果 |
|---|---|---|---|
| 38 | 35 | build-production-image | 進行中（smoke 修正後的驗收）|
| 37 | 34 | ci | success（新 `cancel-in-progress: false` 語意）|
| 36 | 33 | ci | cancelled（被舊語意的 rerun 取消 → 待 backfill）|
| 35 | 32 | build-production-image | failure（`dispatch.sh` 漏帶 sha → 被 gate 擋下）|
| 34 | 31 | ci | success（#2 commit）|
| 33 | 30 | ci | success（rerun backfill）|
| 32 / 31 | 29 / 28 | ci | cancelled（待 backfill；舊定義必須一次一個）|
| 30 | 27 | build-production-image | failure（smoke 撞埠；**build+push 本身成功**，digest 見 §2.9）|
| 29 | 26 | build-production-image | failure（空 sha → gate 擋下）|
| 28 | 25 | ci | success |
| 27 | 24 | ci | cancelled（舊 `cancel-in-progress`）|
| 26 | 23 | build-production-image | failure（`upload-artifact@v4`）|
| 25 | 22 | ci | success |

**UI 只列「該 workflow」的 run**：點 `build-production-image.yml` 只會看到上表那 6 筆 build run；CI 的都掛在
`ci.yml` 底下。跨 workflow 對照用 **`display_title`** 最不會認錯（build 是 `manual-owner:<40 碼 sha>`、
CI 是 commit 訊息）。

**查詢指令（在 NAS 上）**

```bash
docker exec gitea-db psql -U gitea -d gitea -c \
  "SELECT id, index, workflow_id, status FROM action_run ORDER BY id DESC LIMIT 15;"
GITEA_TOKEN=<pat> bash deploy/gitea/dispatch.sh status <內部 id>     # 會一起印出 UI 編號
```





