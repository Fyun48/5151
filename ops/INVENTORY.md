# OPS／v3 現況對照表（ChatGPT 審查後）

盤點對象：本分支 `cursor/ops-cmd-cancel-ed3f`（第 0–21 包，疊在 qa-cancel 上）。  
ChatGPT 抽查的是較早的 master；本分支已多 OPS Console、多站契約、Deploy OPS、產品卡、退出演練、站內 CRM、隔離 staging、開發發行檢視、OPS 供應商抽屜、v3 BudgetGuard、pHash 附屬表與兩個 LLM 開關、第 8 包 live 契約、第 9 包可打包設計套件、第 10 包遠端客服、第 11 包跨站洞察與清除、第 12 包統計指標／後續服務門、第 13 包 worker 重驗訂閱世代、第 14 包晚到評估／提案／webhook、第 15 包製作／QA 重驗訂閱世代、第 16 包 staging／發行重驗訂閱世代、第 17 包移交前確認正式部署狀態、第 18 包自動重評重驗訂閱世代、第 19 包遠端客服重驗訂閱世代、第 20 包測試中的 QA 取消、以及第 21 包未送出的遠端客服可取消。**不以那次抽查當現況。**

本次是第 21 包（未送出的遠端客服可取消），**不是部署指令**，不 Deploy v3，也不擅自跑 Deploy OPS。`PRODUCTION_RELEASE_ALLOW_LIVE` 維持預設 0。`stats`、`followup_service`、`cross_site_insight`、`remote_cs` 與 `retain_after_exit` 維持預設關。Cursor 製作仍標未整合。

圖例：`存在`＝可承接；`需改`＝有程式但契約不足；`待做`＝尚未實作。

## 1. 已核實存在／需改／待做

| 項目 | 狀態 | 路徑（相對 repo） | 說明 |
| --- | --- | --- | --- |
| 回饋本機主本＋同交易 outbox | 存在 | `v3/src/feedback.js`、`v3/src/feedbackOutbox.js` | `createFeedbackWithOutbox()` 必須保留，不另建第二套 |
| 非同步遞送、可關 | 存在 | `v3/src/opsDelivery.js`、`v3/src/server.js` | `OPS_FEEDBACK_DELIVERY` 預設 0；失敗不回滾本機回饋 |
| 站內回饋後台 | 存在 | `v3/public/admin.html`、`v3/src/server.js` | 「使用者回饋」讀本機 |
| 回饋法律告知 | 本輪已改 | `v3/src/feedback.js` `FEEDBACK_LEGAL` | 明示不含 CRM／跨站分析／對外 LLM；跨站洞察要另授權 |
| HMAC ingest | 已做 | `ops/src/ingestSignature.js`、`ops/src/products.js` | 憑證定站；env 只在完全沒有憑證列時當 v3 後備 |
| 去重鍵 | 已做 | `ops/src/ingest.js`、`ops/src/opsDb.js` | OPS 去重是 `(product_id, delivery_id)`／`(product_id, idempotency_key)` |
| 單一 `OPS_INGEST_SECRET` | 已做 | `ops/src/products.js` `resolveIngestAuth` | 憑證表為主；env 只當 v3 後備 |
| `production_stable_current` | 本輪已改鍵 | `ops/src/opsDb.js`、`ops/src/release/productionRelease.js` | 現以 `(product_id, environment_key)` 為鍵；含 static_tree_hash／schema_compat |
| 每站／每環境部署租約 | 本輪已改 | `ops/src/opsDb.js` `production_release_target_lease` | 站 A 不擋住站 B；同站同環境仍互斥 |
| Owner 直達 Deploy | 存在 | `.github/workflows/deploy-v3.yml`（`manual_owner`／`ops_phase15`） | 藍圖承接；第 8 包不拆直達線；OPS 只接驗證後的 session／workflow actor |
| Owner 指令來源完整線 | 本輪已做 | `ops/src/instructionSource.js` `instruction_record` | payload `owner_direct` 仍 403；正式執行寫入 append-only 指令紀錄 |
| Owner 規則檔 | 存在 | `.cursor/rules/owner-merge-deploy.mdc` | 契約寫進藍圖與 AGENTS.md；不另造批准儀式 |
| 版本退回契約 | 本輪已改 | `ops/src/release/rollbackContract.js` | 程式退回要 SHA＋digest＋靜態樹雜湊＋schema compatible；DB 還原另要 `RESTORE-PRODUCTION-DB`，且不由 code rollback 執行 |
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
| OPS live 串既有部署 | 本輪已做 | `ops/src/productEnvironment.js`、`ops/src/instructionSource.js`、Phase 15 | 多站目標、指令來源完整線、每站互斥、正式版重核對；live 預設關；Owner 直達 workflow 不拆 |
| 共用設計元件可打包 | 本輪已做 | `design-system/tokens.css`、`design-system/kit/`、`v3/public/kit/`、`ops/public/kit/` | 第 9 包；固定版本可本機打包；runtime 不回抓 OPS；v3 保留內建 `tokens.css` |
| 遠端客服操作 | 已做 | `ops/src/siteCommand.js`、`v3/src/siteCommandApply.js`、Console CRM、後台 `#feedback` | 第 10 包；capability `remote_cs` 預設關；本站驗證後才寫本機；離線不假成功 |
| 跨站洞察與清除 | 已做 | `ops/src/insightConsent.js`、`ops/src/exitDrill.js`、Console 產品卡 | 第 11 包；`cross_site_insight`／`retain_after_exit` 預設關；撤回停新洞察；刪複本才清向量／匯出 |
| 統計指標／後續服務門 | 已做 | `ops/src/usageConsent.js`、`ops/src/purgeLedger.js`、Console 產品卡 | 第 12 包；預設關；未授權不列入指標、不送入庫 webhook；清除帳本還原後重套；不發明報表 |
| Worker 重驗訂閱世代 | 已做 | `ops/src/insightConsent.js` `workerWriteDecision`、分析／分群 worker | 第 13 包；晚到結果不開單、不寫入、不復活已退出訂閱 |
| 晚到評估／提案／webhook | 已做 | `ops/src/insightConsent.js` `issueWriteDecision`、評估／提案／impact worker、入庫通知 | 第 14 包；世代已換不寫入新評估／提案、不送 webhook；未綁 product 的舊議題相容 |
| 製作／QA 重驗訂閱世代 | 已做 | `ops/src/codingTask.js`、`ops/src/qaRun.js`、未決清單 | 第 15 包；能推到產品才戳世代；晚到不開 PR、不寫 QA；未綁產品仍相容 |
| staging／發行重驗訂閱世代 | 已做 | `ops/src/stagingDeploy.js`、`ops/src/releaseCandidate.js`、`ops/src/release/productionRelease.js`、未決清單 | 第 16 包；能推到產品才戳世代；晚到不佈測試站、不組 RC、不送通知、不開新正式發布；未綁產品仍相容 |
| 移交前確認正式部署狀態 | 已做 | `ops/src/exitDrill.js` `listUnknownProductionRuns`、Console 產品卡 | 第 17 包；`PRODUCTION_STATE_UNKNOWN` 擋移交；未綁產品不能擋別站；已送出的部署不宣稱撤回 |
| 自動重評重驗訂閱世代 | 已做 | `ops/src/reevaluation.js` `autoReevaluationDecision`、重評 worker、未決清單 | 第 18 包；能推到產品的延後／拒絕決策戳世代；自動重評不把已退出或換世代的舊議題重開；未綁產品仍相容；Owner 手動重評不在此限 |
| 遠端客服重驗訂閱世代 | 已做 | `ops/src/siteCommand.js` `siteCommandWriteDecision`、未決清單 | 第 19 包；命令戳世代；外送前重驗；解除訂閱或換世代後舊佇列不外送；已送出的不宣稱撤回 |
| 測試中的 QA 取消 | 已做 | `ops/src/qaRun.js` `cancelQaRun`、開發發行畫面、未決清單 | 第 20 包；Owner 可取消尚未完成的獨立 QA；已在跑的不宣稱撤回；已完成的結果不改寫；晚到完成不寫入 current |
| 未送出的遠端客服可取消 | 本輪已做 | `ops/src/siteCommand.js` `cancelSiteCommand`、未決清單 | 第 21 包；Owner 可取消 pending／sending 命令；已送出的不宣稱撤回；晚到外送不 fetch、不寫回 sent |

## 2. 第 14 節驗收情境的實作安排

| 情境 | 安排 |
| --- | --- |
| OPS 被擋，本站仍收意見／登入 | 已有基礎；第 1 包加本機停送；第 3／4 包補附件與 CRM |
| 長期停用、outbox 堆積 | 第 3 包：容量警戒與清理傳輸複本 |
| A、B 各送 `feedback:1` | **第 1 包測試必過** |
| A 憑證冒稱 B／查 B 的 ID | **第 1 包**：伺服器用憑證定站；跨站查詢回同一 404 |
| 本機送出與 OPS 同時故障 | 已有 outbox 測試；保持 |
| Owner 直達部署、OPS 停機 | 已有 workflow；第 8 包只接 OPS 線，不拆直達線 |
| AI 自稱 Owner 直達 | **第 5／8 包已測**：payload 旗標 403；來源只接受 verified session／authorized workflow actor |
| Owner 已上新版、OPS 舊候選 | **第 8 包已測**：觀察到 live 與候選／上一版都不同就重核對並擋下 |
| 站 A 退回、B 繼續 | **第 8 包已測**：A 持租約不擋住 B |
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
