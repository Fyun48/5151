# OPS／v3 現況對照表（ChatGPT 審查後）

盤點對象：本分支 `cursor/ops-phash-ed3f`（第 0–7 包，疊在 budget 上）。  
ChatGPT 抽查的是較早的 master；本分支已多 OPS Console、多站契約、Deploy OPS、產品卡、退出演練、站內 CRM、隔離 staging、開發發行檢視、OPS 供應商抽屜、v3 BudgetGuard、pHash 附屬表與兩個 LLM 開關。**不以那次抽查當現況。**

本次是第 7 包（pHash、同屋源 AI、爬蟲資料 AI），**不是部署指令**，不 Deploy v3，也不擅自跑 Deploy OPS。

圖例：`存在`＝可承接；`需改`＝有程式但契約不足；`待做`＝尚未實作。

## 1. 已核實存在／需改／待做

| 項目 | 狀態 | 路徑（相對 repo） | 說明 |
| --- | --- | --- | --- |
| 回饋本機主本＋同交易 outbox | 存在 | `v3/src/feedback.js`、`v3/src/feedbackOutbox.js` | `createFeedbackWithOutbox()` 必須保留，不另建第二套 |
| 非同步遞送、可關 | 存在 | `v3/src/opsDelivery.js`、`v3/src/server.js` | `OPS_FEEDBACK_DELIVERY` 預設 0；失敗不回滾本機回饋 |
| 站內回饋後台 | 存在 | `v3/public/admin.html`、`v3/src/server.js` | 「使用者回饋」讀本機 |
| 回饋法律告知 | 存在／需改 | `v3/src/feedback.js` `FEEDBACK_LEGAL` | 目前只授權站方修 bug／改功能；跨站洞察／對外 LLM 要另授權（第 4／7 包） |
| HMAC ingest | 存在／需改 | `ops/src/ingestSignature.js`、`ops/src/server.js`、`v3/src/opsSignature.js` | 演算法可留；密鑰必須改為每站一把，由伺服器決定 `product_id` |
| 去重鍵 | 需改 | `v3/src/feedbackOutbox.js`、`ops/src/ingest.js`、`ops/src/opsDb.js` | 本機 `feedback:${id}` 可留；OPS 不可再全域 UNIQUE |
| 單一 `OPS_INGEST_SECRET` | 需改 | `ops/src/server.js` `createHandler` | 改憑證表＋env 只當 v3 後備 |
| `production_stable_current id=1` | 本輪已改鍵 | `ops/src/opsDb.js`、`ops/src/release/productionRelease.js` | 現以 `product_id` 為鍵；環境拆分留第 8 包 |
| 全域部署租約 `id=1` | 需改 | `ops/src/opsDb.js` `production_release_global_lease` | 第 8 包改成每站／每環境互斥 |
| Owner 直達 Deploy | 存在 | `.github/workflows/deploy-v3.yml`（`manual_owner`／`ops_phase15`） | 藍圖承接；不得退化成人人必走 Gate #2 |
| Owner 規則檔 | 需改 | 本 checkout 無 `.cursor/rules/owner-merge-deploy.mdc` | 契約寫進藍圖與 AGENTS.md；不另造批准儀式 |
| 版本退回＝只換 digest | 需改 | `docker-compose.yml` bind-mount `v3/src`＋`v3/public`；`deploy-v3.yml` | 完整退回還要 source SHA／靜態檔／schema 相容（第 8 包） |
| `RELEASED → ROLLED_BACK → EVALUATING` | 本輪已改 | `ops/src/stateMachine.js`、`ops/src/followUp.js` | 已發布事實不變；再開發用 follow-up，不重用已發布授權 |
| 議題狀態機其餘出口 | 存在 | `ops/src/stateMachine.js` | 前期取消／拒絕／封鎖可留 |
| OPS／v3 分容器分庫 | 存在 | `docker-compose.yml`、`ops/src/opsDb.js`、`v3/src/db.js` | 維持 |
| Console 收件匣／總覽 | 本輪已做 | `ops/src/dashboard.js`、`ops/public/` | 可依 `productId` 過濾；產品卡分頁可暫停／退出／重連／輪替 |
| 產品／訂閱／每站憑證 | 已做 | `ops/src/products.js`、`ops/src/ingest.js`、`ops/src/opsDb.js` | A／B `feedback:1` 不撞號；憑證定站；暫停／解除訂閱 |
| 站內「停止傳送至 OPS」 | 已做 | `v3/src/opsDelivery.js`、`v3/public/admin.html` | 本機 `settings.ops_feedback_stop`，不依賴 OPS 在線 |
| Deploy OPS 工作流 | 本輪已做 | `.github/workflows/deploy-ops.yml` | 確認字 `DEPLOY-OPS`；只 SCP `ops/`、只重建 `5151-ops`；並發鎖 `ops-deploy` |
| 四種退出／移交演練 | 本輪已做 | `ops/src/exitDrill.js`、`ops/public/console.js`、`v3/src/handoffImport.js` | 暫停／解除訂閱／移交／刪複本分開；交接包可在無 OPS 環境還原回饋；outbox 警戒 |
| 站內 CRM／OPS CRM 檢視 | 本輪已做 | `v3/src/crm.js`、`ops/src/crmReplica.js`、後台 `#crm`、Console CRM 檢視 | 第 4 包；四欄分開；關 CRM ≠ DROP；`crm_sync` 不隨回饋複製自動開啟 |
| 隔離 staging UI | 本輪已做 | `ops/src/stagingDeploy.js`、`ops/public/console.js` | 開發發行四欄；TTL 到期可重建；共用測試站被覆寫會標示；真容器 provider 仍關 |
| BudgetGuard 先保留再呼叫 | 本輪已做 | `v3/src/budgetGuard.js`、`v3/src/providers/executeWithProvider.js` | 先保留再呼叫；0 元不准花；逾時標 unknown 不釋放 |
| OPS 供應商抽屜 | 本輪已做 | `ops/src/providerDrawer.js`、Console「供應商」 | 預設關；金鑰只在 OPS；cursor 製作仍標未整合 |
| pHash 附屬表、同屋源／爬蟲 AI | 本輪已做 | `v3/src/phash.js`、`v3/src/listingSimilarity.js`、`v3/src/providers/llm.js`、後台 `#plugins` | 附屬表；不鏈式合併；人工判定優先；關開關＝舊 `match.js` |
| OPS live 串既有部署 | 待做 | Phase 15 預設關 | 第 8 包 |
| 共用設計元件可打包 | 待做 | `v3/public/tokens.css` | 第 9 包；runtime 不回抓 OPS |
| 遠端客服操作 | 待做 | — | 預設關；本站驗證後才寫本機 |

## 2. 第 14 節驗收情境的實作安排

| 情境 | 安排 |
| --- | --- |
| OPS 被擋，本站仍收意見／登入 | 已有基礎；第 1 包加本機停送；第 3／4 包補附件與 CRM |
| 長期停用、outbox 堆積 | 第 3 包：容量警戒與清理傳輸複本 |
| A、B 各送 `feedback:1` | **第 1 包測試必過** |
| A 憑證冒稱 B／查 B 的 ID | **第 1 包**：伺服器用憑證定站；跨站查詢回同一 404 |
| 本機送出與 OPS 同時故障 | 已有 outbox 測試；保持 |
| Owner 直達部署、OPS 停機 | 已有 workflow；第 8 包只接 OPS 線，不拆直達線 |
| AI 自稱 Owner 直達 | **第 5 包已擋 payload 旗標**；第 8 包再接完整指令來源 |
| Owner 已上新版、OPS 舊候選 | 第 8 包：互斥＋重核對正式版 |
| 站 A 退回、B 繼續 | 第 1 包先拆穩定版鍵；第 8 包做完整退回 |
| 已發布後再開發 | **第 5 包已做**：follow-up 新議題，不重用已發布授權 |
| 退出時 AI／部署未決 | 第 3 包 |
| 站 C 分家還原 | 第 3 包最小演練 |
| 關 CRM 再開／刪複本再還原 | 第 4／7 包 |
| 20 元＋並行 10 個 1 元 | **第 6 包已測**：已結算 18 時最多再核准 2 個 |
| 逾時不釋放已送出額度 | **第 6 包已測**：`unknown` 不釋放 |
| 付費爬蟲失敗不誤下架 | 第 6 包 fallback 到直連；下架語意見第 7 包 |
| pHash 不鏈式誤併 | **第 7 包已測**：A≈B、B≈C 不產生 A=C |
| 關付費／AI＝舊路徑 | **第 6／7 包已測**；基準 `pack6-budget-guard-v1`／`pack6-ops-provider-drawer-v1`／`pack7-phash-v1`／`pack7-llm-same-house-v1`／`pack7-llm-crawl-insight-v1` |
| staging 被蓋或 TTL | **第 5 包已做**：`ttl_expired`／`environment_occupied`；已到期可重建相同版本 |

完成後要交真實結果（測試、還原演練、並行預算），不以按鈕存在或 CI 綠燈取代。
