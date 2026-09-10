# OPS 維運自動化

給 **Owner** 用的內網系統：把各站使用者回饋累積成議題，評估後再決定要不要開發。  
**Owner 直接下令改程式並部署，不必走這條線。**

目標藍圖（可換 AI、測試站、Gate #2、退回、多站、分家退出、CRM、設計模組）見 [`PLAN.md`](PLAN.md)。  
v3 外掛／預算熔斷／進階比對見 [`../v3/PLAN-integrations.md`](../v3/PLAN-integrations.md)。

Console：本機 `http://127.0.0.1:5154`；正式機走同一條 Tunnel → `https://jibbyrentops.reversalplay.me`（容器只綁 `127.0.0.1:5154`）。

## 一般使用者怎麼回饋

1. 登入 https://c5151.reversalplay.me
2. 點頁尾「意見回饋」或手機左下「意見」
3. 選類型（錯誤／想法／其他），送出
4. 資料先寫進 v3 資料庫；只有開啟遞送時才會進 OPS

## 回饋如何進 OPS

在跑 v3 的環境設定：

```
OPS_FEEDBACK_DELIVERY=1
OPS_INGEST_URL=http://127.0.0.1:5154/ops/api/ingest/feedback
OPS_INGEST_SECRET=<與 OPS 相同的密鑰>
```

正式 v3 映像預設 `OPS_FEEDBACK_DELIVERY=0`，避免未就緒的 OPS 吃正式流量。要接到正式回饋時，在 NAS／CasaOS 的 v3 環境變數打開上述三項，並讓容器能連到 OPS。

## Owner 怎麼用 Console

1. `npm run dev:ops`（或正式機跑 `npm run start:ops`）
2. 用 `AUTH_EMAIL` / `AUTH_PASSWORD` 登入
3. **總覽**：看回饋數、待核准開發／發布、webhook 狀態
4. **回饋收件匣**：逐筆看內容與分析
5. **議題與投票**：同類回饋會聚成議題；影響力夠高後做五角色評估（PROPOSE / WAIT / IGNORE / ESCALATE），再產生提案
6. 評估結果是 **PROPOSE** 時，對提案按「核准開發」（Gate #1）
7. Coding / QA / Staging 通過後，用 API 或後續畫面做 Gate #2 核准發布
8. **正式機仍要走 CasaOS Deploy v3**，OPS Phase 15 預設不會自己部署

## Webhook 通知

設定：

```
OPS_NOTIFY_WEBHOOK_URL=https://discord.com/api/webhooks/...
# 或 Slack incoming webhook / 任意 https JSON endpoint
OPS_NOTIFY_ON_INGEST=1          # 可選：每筆新回饋也通知（預設關，避免洗版）
```

會通知的時機：

- 議題提案完成、等待 Gate #1
- Release candidate 組好、等待 Gate #2（outbox，可重試）
- Console「測試 webhook」
- （可選）新回饋入庫

Discord / Slack / 自訂 JSON 都會自動判斷。內容只含 metadata，不含聯絡信箱。

## 本機把整條管線跑起來（stub，不碰正式機）

```
OPS_INGEST_SECRET=dev-secret
AI_PROVIDER=stub
EMBEDDING_PROVIDER=stub
EVALUATION_PROVIDER=stub
PROPOSAL_PROVIDER=stub
OPS_NOTIFY_WEBHOOK_URL=https://example.com/your-hook
```

`CODING_PROVIDER` / `STAGING_PROVIDER` / `PRODUCTION_RELEASE_ALLOW_LIVE` 預設關閉。真的要自動寫碼或上正式機，必須另外開、且仍受 fail-closed 授權。

## 與 Tests CI 的關係

- `test.yml` 只跑 `npm test`，**不部署**
- `ai-dev/*` 草稿 PR 不會自動合併
- `cursor/ops-*` 要 Owner 看過再合併
- 其他 Owner 功能 PR 測試通過後 squash merge
