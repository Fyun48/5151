# OPS／v3 現況對照表（ChatGPT 審查後）

盤點對象：本分支 HEAD `46b5d531ad467d96fd8c9a04e43769ec984ce78c`（`cursor/ops-complete-ed3f`）。  
ChatGPT 抽查的是 master `b57dbdd3a70dcbd55ba68375d091a87e5d14c696`。本分支已比該 SHA 多 OPS Console、`ops/BLUEPRINT.md`、`ops/PLAN.md`、`v3/PLAN-integrations.md`、compose 的 `5151-ops` 與分頁 CSS 修正。**不以那次抽查當現況。**

本次是規格修訂與第 1 包契約落地，**不是部署指令**，不 Deploy v3。

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
| `RELEASED → ROLLED_BACK → EVALUATING` | 需改 | `ops/src/stateMachine.js` guarded `ROLLED_BACK → EVALUATING` | 第 5 包改為已發布事實不變，再開發用 follow-up／revision |
| 議題狀態機其餘出口 | 存在 | `ops/src/stateMachine.js` | 前期取消／拒絕／封鎖可留 |
| OPS／v3 分容器分庫 | 存在 | `docker-compose.yml`、`ops/src/opsDb.js`、`v3/src/db.js` | 維持 |
| Console 收件匣／總覽 | 存在／需改 | `ops/src/dashboard.js`、`ops/public/` | 第 1 包加 `product_id`；產品卡 UI 第 2 包 |
| 產品／訂閱／每站憑證 | 本輪已做 | `ops/src/products.js`、`ops/src/ingest.js`、`ops/src/opsDb.js` | A／B `feedback:1` 不撞號；憑證定站；暫停／解除訂閱 |
| 站內「停止傳送至 OPS」 | 本輪已做 | `v3/src/opsDelivery.js`、`v3/public/admin.html` | 本機 `settings.ops_feedback_stop`，不依賴 OPS 在線 |
| Deploy OPS 工作流 | 待做 | — | 第 2 包；現況仍可 SSH 同步，非常態 |
| 四種退出／移交演練 | 待做 | — | 第 3 包 |
| 站內 CRM／OPS CRM 檢視 | 待做 | — | 第 4 包；關 CRM ≠ DROP |
| 隔離 staging UI | 待做 | `ops/src/stagingDeploy.js` 骨架關著 | 第 5 包 |
| BudgetGuard 先保留再呼叫 | 待做 | `v3/PLAN-integrations.md` 舊虛擬碼是先 SUM | 第 6 包 |
| pHash 附屬表、同屋源／爬蟲 AI | 待做 | 規劃曾寫 `listings.image_phash` 單欄 | 第 7 包改附屬表 |
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
| AI 自稱 Owner 直達 | 第 5／8 包：來源＝已驗證身分，不信 payload 旗標 |
| Owner 已上新版、OPS 舊候選 | 第 8 包：互斥＋重核對正式版 |
| 站 A 退回、B 繼續 | 第 1 包先拆穩定版鍵；第 8 包做完整退回 |
| 已發布後再開發 | 第 5 包：follow-up，不重用已發布授權 |
| 退出時 AI／部署未決 | 第 3 包 |
| 站 C 分家還原 | 第 3 包最小演練 |
| 關 CRM 再開／刪複本再還原 | 第 4／7 包 |
| 20 元＋並行 10 個 1 元 | 第 6 包必測 |
| 逾時不釋放已送出額度 | 第 6 包 |
| 付費爬蟲失敗不誤下架 | 第 6／7 包 |
| pHash 不鏈式誤併 | 第 7 包 |
| 關付費／AI＝舊路徑 | 第 6／7 包；基準 SHA 寫在該包，不寫死 3.51 |
| staging 被蓋或 TTL | 第 5 包 |

完成後要交真實結果（測試、還原演練、並行預算），不以按鈕存在或 CI 綠燈取代。
