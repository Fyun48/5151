# Agent notes

## 專案來源（唯一權威來源）

本專案的原始碼、開發、PR、CI 與部署都以 GitHub 為唯一權威來源：**`github.com/Fyun48/5151`**。

**2026-09-21 Owner 決定**：版本管理回到 GitHub；自架 Gitea（`jgitea01.reversalplay.me`）**暫停** ——
只保留為可用環境，不再是權威來源、也不再當發版路徑。發版一律走 GitHub Actions 的三條 manual-only
workflow（build → predeploy → deploy）。Gitea 時代的內容已在同日以**單一 snapshot commit** 併入 `master`
（刻意不帶 Gitea 的 commit 歷史，因為那段歷史含明文憑證），收尾紀錄見
`evidence/repo-hygiene-20260921.md`。

> **新的 agent session 先讀這份**：`evidence/runtime-modernization/HANDOFF.md`
> （現況、常用命令、待辦、踩過的坑）。它是在 NAS 的瀏覽器 IDE（code-server）裡寫的，內容仍適用；
> 但「權威來源」一律以本節的 2026-09-21 決定為準。

請一律以這個 GitHub repo 為唯一權威來源；不要另開新專案或第二條 tunnel（同一 repo、同一張 Docker 映像、同一條 Cloudflare Tunnel）。

## 開發範圍：只做 v3

新功能與變更**只做 v3**。畫面產品名是「吉比租房物件追蹤」。

- **v3**：容器聽 `5153`，程式在 `v3/src`、`v3/public`，資料 `data-v3/v3.db`。
- **公開站**（同一條 Cloudflare Tunnel、同一台 v3 容器）：
  - `https://jibbyrenth.reversalplay.me` → `http://127.0.0.1:5153`（5155 是同一容器別名）
- **OPS Console**：`https://jibbyrentops.reversalplay.me` → `http://127.0.0.1:5154`（獨立容器，不是 v3）。
- 規劃見 `v3/ARCHITECTURE.md` 與 `v3/DESIGN.md`。
- **v1／v2 已拆除**（不再啟動容器）。歷史庫仍可只讀掛給 v3 匯入。不要再用 `https://c5151.reversalplay.me/`。

## 共享基礎設施存取（跨專案）

NAS、Cloudflare Tunnel／Access、SSH 走法、PG 連線、機密位置與代理人可操作範圍一律看
`docs/runbooks/shared-infra-access.md`，並遵守 `.cursor/rules/infra-access.mdc`。
禁止另開 tunnel／第二條通道；公網 SSH 埠（54722／58722）在自動化改走 CF 前不得關閉。

## 本機開發

Cloud Agent 環境由 `.cursor/environment.json` 自動 `npm ci` 並啟動 v3 開發伺服器（`npm run dev:v3`，埠 5153，預設管理員 `demo@example.com` / `demopass123`，可用 `AUTH_EMAIL` / `AUTH_PASSWORD` secrets 覆寫）。

- 啟動 v3：`npm run dev:v3`（開 http://localhost:5153 ）
- 測試：`npm test`

## 開發工具（務必使用專案自訂的 rules / skills / plugins / agents）

進行任何開發前，請優先套用本專案自訂的工具，不要繞過：

- **Rules（`.cursor/rules/`）**：`agent-routing.mdc`（一律套用）、`ui-ux-workflow.mdc`、`frontend-design-compliance.mdc`。
- **Skills（`.cursor/skills/`）**：UI/UX 相關一律先用 `ui-ux-pro-max`；其餘 `design`、`design-system`、`brand`、`banner-design`、`slides`、`ui-styling` 視需要使用。
- **Plugins / MCP**：`Figma`（設計規格）、`Playwright`（實機操作與 RWD 驗證）、`Mobbin`（設計參考）、`Shadcn`（元件）。
- **Agents（依 `agent-routing.mdc`）**：Design Research Agent 先研究 → Figma 建立／更新規格 → Builder Agent 才實作前端 → Playwright 實機操作並分別檢查 375px / 768px / 1440px → UX Reviewer 與 Security Reviewer 審查。Reviewer 不得批准自己實作的修改；禁止只以「看起來更漂亮」作為完成標準。

## 外部來源抓取：第一線就要 fail-soft（Owner 指定，2026-09-30 起）

任何打外部站台的抓取程式碼（`v3/src/client591.js`、`houseprice.js`、`hbhousing.js`、`sinyi.js`、
`ddroom.js`、`housefun.js`、`rakuya.js` …）**每一頁／每一筆都要各自 try/catch**，
一個失敗只損失那一頁：

1. 失敗要記進該批次的 `errors[]`（帶 `code`、行政區、頁碼、**出事的網址**），往上回報；
   已經抓到的房源必須照樣回傳、照樣落地。
2. 被擋／限速（401／403／429／503）⇒ 這一輪**暫停這一家**（`sourcePaused`），不要繼續打。
3. `catch` 的第一行必須是 `if (isCrawlCancelled()) throw error;`：
   整輪被取消（預算用盡／被新的一輪取代）要立刻停手，逐頁 fail-soft **不可以吞掉取消**。
4. 只有「連第一頁都沒成功」才維持整個 job 失敗的語意（watcher 的逾時政策靠它），
   而且要丟**原本的錯誤物件**（保留 `code`／`name`）。

反面教材（2026-09-30 事故）：5168 一個間歇性 403 就讓整批歸零，表面上卻是「來源連續失敗」，
4 天沒有新資料也查不出原因。**不要只加測試來補這種缺陷，第一線就要擋。**

### 開 PR 前先跑沙盒（Owner 指定，2026-09-30 起）

抓取邏輯**不准再拿正式站當白老鼠**。沙盒容器 `5151-crawl-sandbox`（casa-nas，寫隔離庫
`crawl_sandbox`）用真程式、真來源、同一顆映像跑完整輪次：

```bash
SANDBOX_ROUNDS=1 bash v3/scripts/crawl-sandbox-sync.sh   # 同步目前 checkout 並跑一輪
SANDBOX_ROUNDS=3 bash v3/scripts/crawl-sandbox-sync.sh   # 時間相關政策（連續 N 輪）要跑滿 N 輪
ssh casa-nas "docker exec 5151-crawl-sandbox tail -3 /data/crawl-sandbox.jsonl"   # 報告
```

- 動到 fetch／頁碼／重試／暫停／政策／預算的 PR，**必須附上沙盒報告**（哪一輪、耗時、
  每來源 covered/total、`completed` 與 `covers_max_last_run_at` 有沒有前進）。沒有報告不算測過。
- 沙盒只寫隔離庫（程式啟動時會用 `assertPgTargetAllowed()` 再檢查一次）；
  它**不會**自動跟著部署更新——同步時機由人決定，這樣才能測「還沒上線的候選版本」。

## Pull requests 與部署（Owner 覆寫，2026-09-10 起強制）

做完工作後請開**非草稿** PR（`draft: false`）。

**當使用者要求合併、部署、或「改完就上 v3」時，必須立刻合併並部署，不要再問、不要等 Ops、不要等已刪除的 `test.yml` 自動 squash。** 這條已重覆交代，寫在 `.cursor/rules/owner-merge-deploy.mdc`。

1. 合併目前的 PR 進 `master`（squash 即可）。
2. 部署 v3 **只走這三個** workflow，依序從 `master` 做 `workflow_dispatch`：
   - `.github/workflows/build-production-image.yml`
   - `.github/workflows/production-predeploy-check.yml`
   - `.github/workflows/deploy-v3.yml`
3. 確認字串（`DEPLOY-PRODUCTION` / `PREDEPLOY-PRODUCTION`）由代理人代填。Cursor 雲端身分可以觸發這三條。
4. Ops Phase 15「不 merge、不部署」只約束 Ops 機器人自己的任務，**不約束**使用者直接交代 Cursor Agent 的改碼＋合併部署。
5. 不要另開 tunnel、不要改 v1/v2、不要發明第四條部署路徑。

## 跨專案共用憑證庫（2026-09-23 起）

所有系統容器、NAS、Cloudflare、API 的帳號密碼／token 一律集中在共享目錄：

- NAS：`~/code-server/workspace/cline-server/home/.secrets`
- code-server 與 cline-dev 容器：`/home/cline/.secrets`（目錄 700／檔案 600，不在任何 workspace root 內）

清單看 `INDEX.md`、用法與鐵則看 `README.md`、要重抓跑 `sync.sh`。
**不要把值寫進 repo／PR／對話**；要引用時只寫檔名與鍵名。
詳見 `docs/runbooks/shared-infra-access.md` §5.1。


## 回覆風格與用語（Owner 指定，所有專案適用）

回覆請用**台灣的繁體中文與台灣慣用語**，不要用中國大陸的用詞；句子要通順、要能一次看懂。
完整規範與對照表放在跨專案共用的 `/home/cline/USER-STYLE.md`，請先讀它再回覆。

