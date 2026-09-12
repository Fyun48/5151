# Agent notes

## 專案來源（唯一權威來源）

本專案的原始碼、開發、PR、CI 與部署都在 GitHub：**`github.com/Fyun48/5151`**。
請一律以這個 GitHub repo 為唯一權威來源；不要另開新專案或第二條 tunnel（同一 repo、同一張 Docker 映像、同一條 Cloudflare Tunnel）。

## 開發範圍：只做 v3

新功能與變更**只做 v3**。畫面產品名是「吉比租房物件追蹤」。

- **v3**：容器聽 `5153`，程式在 `v3/src`、`v3/public`，資料 `data-v3/v3.db`。
- **公開站**（同一條 Cloudflare Tunnel、同一台 v3 容器）：
  - `https://c5151.reversalplay.me` → `http://127.0.0.1:5153`
  - `https://jibbyrenth.reversalplay.me` → `http://127.0.0.1:5155`
- **OPS Console**：`https://jibbyrentops.reversalplay.me` → `http://127.0.0.1:5154`（獨立容器，不是 v3）。
- 規劃見 `v3/ARCHITECTURE.md` 與 `v3/DESIGN.md`。
- **v1 已停用**（root 的 `src/`、`public/` 只留作歷史，只讀匯入）；**v2 只維護、不再加功能**。

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
