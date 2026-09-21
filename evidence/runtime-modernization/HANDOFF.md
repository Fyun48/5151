# 接手說明（Handoff）— 2026-09-20

> 目的：讓**任何新的 agent session**（例如 NAS `code-server` 裡的 Cline、或 Gitea 上的 `Agent (DeepSeek)`
> workflow）不用讀完整對話就能接手。**先讀這份，再讀 `AGENTS.md` 與 `evidence/runtime-modernization/GITEA-MIGRATION.md`。**

## 一句話現況

5151 已從 GitHub 遷到**自架 Gitea**（`https://jgitea01.reversalplay.me`，**1.27.3**）：
**GitHub 上 18 個 repo（9 public + 9 private）已全部搬進 `JimmyGOD/*` 並驗收通過**；3 條移植 workflow
（build / predeploy / deploy）可在 Gitea 觸發；**build 現在又綠又快**（run 67/#64：整個 job **1 分 28 秒**、
smoke 13 秒、digest `sha256:47f808bb…`，先前要 32–38 分鐘），可多架構建置並推到 `ghcr.io/fyun48/5151`；
CI 正常；**Discord 通知鏈已接好但 webhook 是無效值**（見待辦 3）；另有一個 **DeepSeek agent**
可從 Gitea 網頁／issue 觸發、只開 PR。

## 環境

| 角色 | 位置 |
|---|---|
| Gitea | `https://jgitea01.reversalplay.me`（NAS 內部 `http://127.0.0.1:5251`；repo `JimmyGOD/5151`）|
| runner | NAS 容器 `gitea-runner-ci`（`capacity: 2`、job timeout 90m；設定見 `deploy/gitea/runner-config.yaml`）|
| 瀏覽器 IDE | `https://cocodeco.reversalplay.me`（NAS 容器 `5151-code-server`，工作區 `/workspace/5151`）|
| Shadow HA | Synology `5151-postgres-B`=primary、CasaOS `5151-postgres-A`=hot standby、HAProxy(CasaOS) |
| Gitea tunnel | `jgitea-tunnel`（cloudflared，`--network host`，dashboard 顯示 connector 名稱 `gitea`）|

## Gitea 的存取方式（2026-09-20 起加了 Cloudflare Access）

- **網頁（人）**：`https://jgitea01.reversalplay.me` → Cloudflare Access app `gitea`
  （policy `owner-only`：allow `acefengyun@gmail.com` + require **One-time PIN**，session 24h）。
  第一次會寄 6 位數驗證碼到信箱；之後 24 小時內不用再登。team domain：`toriace.cloudflareaccess.com`。
- **機器（git／API）**：同一組 Access 之下，機器走 **service token** bypass
  （policy `machine-service-token`，decision `non_identity`）→ 請求要帶兩個標頭：
  `CF-Access-Client-Id` / `CF-Access-Client-Secret`（值在 workspace 的 `INFRA-CREDENTIALS.md`）。
  本機 `5151` repo 已經設好（`.git/config` 的 `http.extraheader`，**不會進版控**）：
  ```bash
  git config --local http.extraheader "CF-Access-Client-Id: <client_id>"
  git config --local --add http.extraheader "CF-Access-Client-Secret: <client_secret>"
  ```
  **沒設的機器會拿到 302 到 `toriace.cloudflareaccess.com`**（症狀：`git` 回
  `unable to update url base from redirection`）。
- **不受影響的**：NAS 內部的 `http://127.0.0.1:5251`、容器內的 `http://gitea:3000`
  —— CI、runner、agent、`dispatch.sh`、code-server 工作區的 remote 全都走這條，**沒有動到**。
- tunnel `gitea` 的 ingress：`jgitea01` → `127.0.0.1:5251`、`cocodeco` → `localhost:8484`、catch-all 404
  （**2026-09-20 已清掉**重複的 `jgitea01 → localhost:5251`；原設定備份在執行端的
  `%TEMP%\tunnel-gitea-config-backup.json`）。
- Cloudflare 憑證：日常用 **scoped token**（Tunnel/ Access Apps+Policies / Service Tokens / DNS），
  全權限的 Global Key 只當備援——值都在 `INFRA-CREDENTIALS.md`。

## 還沒做的（2026-09-20 實際查證，不是照抄舊文件）

> ⚠️ 舊清單已經過時：`STATUS.md` 的「尚未開始」還寫 Phase 16–17（Web active/active）與
> Phase 22–27（Gitea 上線）**未上線**，`FINAL-REPORT.md` §6 也還寫「HAProxy shadow / Web-A/B 未起容器」
> ——**那些現在都在跑**。以下是今天重新查證後真正還缺的：

**架構／程式（技術債）**
1. **v3 應用還沒接 PostgreSQL**：repo 內**沒有任何 `package.json`**、沒有 `pg` 依賴；PG 叢集雖已是
   實跑中的 primary/standby（複寫驗證過），但 app 仍用 `node:sqlite`。`v3/POSTGRES_PLAN.md` 自標
   「尚未開工」，`v3/src/repository/README.md` 也只寫「PG adapter 是目標」。
2. **repository 抽離只完成 4 個 domain**（settings / flags / routeCache / users）；`listings` 等 hot path
   仍是同步 SQLite，必須先 async 化才換得動 PG。
3. **前端 client-state 只遷了 3 個欄位**：`filter`/`sort`/`district` 已在 `5151-client-state-v1`；
   `panel`（`PANEL_KEY`）、條件抽屜（`FILTER_COMPACT_KEY`）、`pagination`、`scroll` 仍是分散的舊
   localStorage key。
4. **enrich worker 沒完全收斂到 durable queue**：`v3/src/listingEnrichQueue.js` 仍有
   `request_seq`/`run_seq` supersession，production loop 還用舊表。
5. **`deploy/gitea/docker-compose.yml` 沒有 `loop-engine` 服務**（Phase 22/27 那顆沒部署），但
   `deploy/gitea/README.md` 的 Security 段還寫著它存在 → **文件待修**；功能面目前由已在跑的
   `5151-ops`（Console）承接。

**需要 Owner 提供／決定**
6. **S3/R2 credentials** → storage abstraction 的 S3 driver 沒接。
7. **OpenAI Reviewer API key**（optional Final Review flow）。
8. **Discord webhook 仍無效**（`401 Invalid Webhook Token`）→ 通知鏈接好但送不出去。
9. **`JimmyGOD/5151` 的 issues/PRs 未補**（19 + 354）→ 程序見 `docs/runbooks/gitea-5151-metadata-backfill.md`。
10. **Rental Marketplace Stage 2–4 在 production 的啟用**：程序／flag／授權在
    `v3/STAGE2-4-ACTIVATION.md`，是否已在正式站啟用需要 Owner 確認（預設應為關）。
11. **Cloudflare 端兩個殘留**：`casa_home` tunnel **down**、`casaos_bnplloan` **inactive**
    （可能只是那些專案沒跑，但值得看一眼）。

**驗證能力缺口（不是產品缺功能，是我做不到）**
12. **CasaOS（`114.34.73.76:54722`）這台沒有 SSH key**（`Permission denied (publickey,password)`）→
    Web-A／HAProxy／`5151-postgres-A` 的即時狀態我無法直接查；`drill.sh preflight` 要拿到帳密的機器才跑得動。

**已完成的（舊文件仍寫未做，這裡更正）**：Shadow HA 全上線（Web-A/B + HAProxy + cloudflared A/B +
PG primary/standby，A4 drill RPO 0、RTO 5–17 秒）；Gitea 1.27.3 + runner(capacity 2) + build pipeline
（**1 分 28 秒**、digest `sha256:47f808bb…`）+ DeepSeek agent + code-server；OPS 藍圖包 1–37
（`ops/INVENTORY.md` 幾乎全「已做」）；設計系統 13 個規格頁在 `v3/public/` 都有對應。


## 常用命令（在 NAS 上跑；Synology 的 docker 在 `/usr/local/bin`）

```bash
# 觸發 build / agent（prefer 內部網址，避開 Cloudflare 100s 上限）
GITEA_TOKEN=<pat> bash deploy/gitea/dispatch.sh run build-production-image.yml "$(git rev-parse HEAD)" \
  --input release_mode=manual_owner --input release_intent_id=
GITEA_TOKEN=<pat> bash deploy/gitea/dispatch.sh status <run id>     # 會一起印出 UI 編號 #N
GITEA_TOKEN=<pat> bash deploy/gitea/dispatch.sh logs <run id> --tail 0

# GitHub → Gitea repo 遷移 / 驗收（private repo 用；token 用 env 帶，不留在 argv）
#   （NAS 上放 ~/migrate-github-repos.sh；repo 內原始檔 deploy/gitea/migrate-github-repos.sh）
GH_TOKEN=<github-token> GITEA_TOKEN=<pat> bash ~/migrate-github-repos.sh verify <repo>...

# 看 run（UI 編號＝DB action_run.index ≠ 內部 id）
docker exec gitea-db psql -U gitea -d gitea -c \
  "SELECT id, index, workflow_id, status FROM action_run ORDER BY id DESC LIMIT 15;"

# shadow HA 現況（唯讀）
PG_CONTAINER=5151-postgres-B bash deploy/shadow-ha/drill.sh preflight --expect-role primary
```

## 憑證（**都在 repo 之外**，別 commit）

- Gitea git token / GITEA_TOKEN：見 Owner 手上的 `INFRA-CREDENTIALS.md`（工作區層級，不在本 repo）
- ⚠️ **不要把 local master 推去公開的 GitHub**：`github/master`（`bcb6eb7`＝PR #373 merge）**是本機 HEAD 的祖先**，
  `git push github master` 會 fast-forward，把 Gitea 時代的 commit 一次公開（歷史內含明文憑證，見下方坑）。
  GitHub 端只當**唯讀參考**；真要同步必須先清歷史或先換掉那些憑證。
- repo variables（Gitea → Settings → Actions → Variables）：`DEEPSEEK_API_KEY`（已設）、`DISCORD_WEBHOOK_URL`（已設）
- code-server 密碼：NAS `~/code-server/.env`
- PG：`PG_SUPER_PASSWORD = PG_REPLICATION_PASSWORD`（已與文件對齊，見 `A4-HA-DRILL-20260920.md` §4.1）

## 待辦（2026-09-20 更新）

1. **CI 積壓補跑（正在背景跑）**：`deploy/gitea/backfill-runs.sh` 已經在 NAS 上用 nohup 跑
   `--ids 42,43,44,46,47,50,51,52,55,59,64`（一次一個、等閒置才 rerun），log 在 `~/backfill.log`。
   進度查詢：`bash ~/backfill-runs.sh status`。**它跑的時候不要期待新推的 CI 一定綠** ——
   舊定義的 `cancel-in-progress: true` 會把在跑的 run 取消（工具已用「等閒置」把風險壓到最小）。
   更早的 4 個 cancelled（`24, 27, 39, 41`）**刻意不補**：它們的舊定義早於當時的修正，補了也只會再紅。
2. **Discord webhook 需要換成有效的**：repo variable `DISCORD_WEBHOOK_URL` 目前的值用 `notify.sh`
   實測是 `401 Invalid Webhook Token, code 50027` → 通知不會進頻道（但**不會讓 job 紅燈**，`notify.sh`
   的設計就是 fail-open）。拿到有效 URL 後用 API 更新即可：
   `PUT /api/v1/repos/JimmyGOD/5151/actions/variables/DISCORD_WEBHOOK_URL`（body `{"name":...,"value":...}`）。
3. **Cloudflare Access（已完成 2026-09-20）**：`jgitea01.reversalplay.me` 已加上 Access app `gitea`
   （`owner-only`＝allow 你的 email + require One-time PIN；機器走 service token 的 `non_identity` bypass）。
   做法與「沒設標頭的機器會怎樣」見上面〈Gitea 的存取方式〉。
   `cocodeco.reversalplay.me` 早就有 Access app（同一個 policy 形狀）。
   **關鍵：scoped token `cfut_…` 確實唯讀，但 `INFRA-CREDENTIALS.md` 裡的 Global API Key 是全權限**
   （`X-Auth-Email` + `X-Auth-Key`）→ 兩者都能用 API 管 Access／Tunnel；team domain = `toriace.cloudflareaccess.com`。
   剩下可選：~~清掉 `001` 殘留 app、tunnel 重複 ingress~~ → **2026-09-20 已完成**（用新建的 scoped token；
   也順手把日常 CF 操作從全權限 Global Key 換成 scoped token，Global Key 留作備援）。
4. 選項 1（issue 當對話串）與選項 3（自製 Agent Console）尚未做。
5. P3 護欄文件化（agent 的最大步數/成本上限、只能開 PR）。
6. **決定 `JimmyGOD/5151` 的 issues/PRs 要不要補**：它是第一輪的純 git 遷移 → Gitea 端 issues/pulls 都是 0
   （GitHub 有 19 issues + 354 PRs）。程序已寫成 `docs/runbooks/gitea-5151-metadata-backfill.md`
   （刪掉重建、要還原 8 個 secrets + 2 個 variables、run 歷史不可還原）。**未執行**。

## 踩過的坑（別重犯）

- **compose 會插值整個檔案**：`docker compose up -d <svc>` 會連帶重建 `depends_on` 的服務（曾把 `gitea` 弄掉約 1 分鐘）。
- **rerun 沿用舊 workflow 定義** → 舊 `cancel-in-progress: true` 會取消較新的 run。
- **runner 是 host docker socket 拓撲**（不是 DinD）：job 容器內的路徑**不能** bind-mount 進其他容器；host port 也可能撞到既有容器。
- **compose 檔內的 `${VAR:?}`** 會讓不帶變數的 `compose up -d` 直接失敗 → 一律給預設值。
- **`setup-buildx-action` 預設 `cleanup: true`**＝每次 job 結束刪 builder → 每次重拉/重解壓 base image（~170–1000 秒）。
- 遠端長指令一律 `nohup … &`；Cloudflare 有 100s 上限，長流程走內部 `127.0.0.1`。
- **不要把密碼寫進 repo**：`A4-HA-DRILL-20260920.md` 曾把 PG 密碼明文寫進表格（已改為指向
  workspace 的 `INFRA-CREDENTIALS.md`）。但**舊 blob 還在歷史裡** → 推到任何公開 repo 前必須先清歷史
  或先換掉那組憑證。同理：做任何 `git push` 到公開 remote 前，先 `git grep -F` 一次已知機密字串。
- **Synology 沒有 `git`、`docker` 也不在 PATH**（tori 在 `docker` 群組，要用 `/usr/local/bin/docker`）；
  遠端指令的 quoting 一律用「本機寫檔 → `scp -O` → 執行」。
- **smoke 的兩個致命拓撲誤解**（都花了好幾輪才定位）：job 容器在 `5151-gitea_default` 橋接網路上
  → ① 它裡面的 `127.0.0.1:<host_port>` 是**它自己**，`-p 127.0.0.1::5153` 只綁 host loopback
  （bridge 連 gateway IP 也看不到）→ smoke 改成「同網路 + 容器名」且**不發佈任何埠**；
  ② job 容器內的路徑 daemon 看不到 → 不能 bind-mount `$PWD`。
- **SQLite WAL**：`/data/v3.db` 可能只有 4 KB、資料在 `v3.db-wal`（實測 2.5 MB）
  → **只 `docker cp v3.db` / 只複製主檔＝0 張表**（連續三次讓 smoke 紅燈就是這個），
  取 DB 一律 `docker exec` 在容器內讀，或連 `-wal`/`-shm` 一起拿、或用 `sqlite3 .backup`。
