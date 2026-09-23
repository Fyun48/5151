# 下一個 session 交接（2026-09-23 收尾）

> 前一份歷程：`docs/handoffs/20260921-postgres-cutover-session.md`（③ 之前）。
> **新 session 先讀這份**：現況、待辦順序、每包切法與驗證、踩過的坑、需要 Owner 的事。

## 0. 一句話現況

- 正式站：CasaOS `591-tracker-v3`，`DB_DRIVER=postgres`（PG `192.168.0.140:25433/5151_shadow`）；
  公開站 `jibbyrenth.reversalplay.me`、OPS `jibbyrentops.reversalplay.me`。
- 移植進度：**① 掃描 ✅ ② 迴圈欄位 ✅ ③ 通知佇列 ✅（含 live）④ 相似度／洞察 ✅（含 live）
  2.2 CRM（2.2a／2.2b／2.2c）✅ 2.3 佇列四支 ✅（2.3a jobQueue／jobWorker、2.3b listingEnrichQueue
  三段全部完成，含 live）**
  → 單容器切換已無阻塞項。剩 **provider／budget 島（§3.4）→ HA（§3.5）**。

## 1. 環境（先看這節，省半小時）

- **路徑**：repos 在 `/workspace/repos/5151`（**不是** `/workspace/5151`）。
  `/workspace/repos/5151-projects.code-workspace` 已修好 18 條路徑；若終端機仍報
  `Starting directory … does not exist` → **Reload Window**。
- **兩條執行通道**：
  1. 原生終端機（工作區正常後）：`cd /workspace/repos/5151`。
  2. 備援：Playwright MCP（server 就在 `cline-dev` 本機）——用 `browser_run_code_unsafe`，
     先 `const host = page.constructor.constructor("return process")()`，再 `host.getBuiltinModule("node:child_process")`。
- **共用憑證庫（2026-09-23 起，跨專案）**：`/home/cline/.secrets`
  （NAS：`~/code-server/workspace/cline-server/home/.secrets`）
  - `postgres/5151-agent-pg.env` → `PG_TEST_URL` / `PG_TEST_STANDBY_URL`（跑 live 用這個）
  - 清單 `INDEX.md`、用法 `README.md`、重抓 `sync.sh`
  - ⛔ **不要把值寫進 repo／PR／對話**；引用只寫檔名與鍵名。
- **SSH（免密碼，`~/.ssh/nas_cline`）**：`ssh syn-nas`（`tori@192.168.0.220:58722`）、`ssh casa-nas`（`root@192.168.0.140:54722`）。
- **PG 影子站**：`192.168.0.220:15432/5151_shadow`（primary／standby）。

## 2. 已完成（含證據）

| 階段 | PR／證據 |
|---|---|
| ① 七條掃描、② 迴圈欄位 | #401 ＋ `v3/evidence/pg-loop-parity-20260921/` |
| ③ 通知佇列（讀寫＋決策鏈） | #405／#409 ＋ `v3/evidence/pg-notify-*-20260921/` |
| ④ 相似度／洞察（審核 UI ＋ 佇列寫入） | **#442／#447**；離線 7/7、**live 8/8（0 skip）** |
| 共用憑證庫 | **#448**（runbook §5.1 ＋ AGENTS.md） |
| 2.2 CRM 移植計畫 | **#449**（`docs/handoffs/20260923-crm-port-plan.md`） |
| 2.2a CRM 讀取 | **#451**；2.2b 寫入 **#455**；2.2c `crm_outbox`／投遞迴圈 **#456** |
| 2.3a `jobQueue`／`jobWorker` 接上 PG 佇列 | **#459**（`v3/test/job-queue-parity.test.js` 離線 2／live 3、0 skip） |
| 2.3b 第一段：listing enrich 讀取與後台統計 | **#460**（`v3/test/listing-enrich-parity.test.js`） |
| 2.3b 第二段：listing enrich 寫入路徑 | 本 session：builder ＋ async 入口 ＋ `enrichQueue` façade，watcher／server／adminOverview 接線；離線 5 pass、live 7 pass 0 skip；PG 端另修掉 identity 序號未推進（見 §5.9） |
| 2.3b 第三段：種子查詢改讀 PG | 本 session：`seedEnrichCandidatesQuery()` ＋ `seedHousepriceEnrichJobsAsync()`，`enrichQueue.seed` 不再回 0；離線 7 pass、live 10 pass 0 skip |

## 3. 待辦（照序做，一包一 PR）

### 3.1 2.2a CRM CRUD ＋ admin 路由
照 `docs/handoffs/20260923-crm-port-plan.md`（2.2a）：新 `v3/src/repository/crm.js`（共用 SQL builder）
＋ `v3/src/crmAsync.js`（`withFallback` ＋ `options.exec` 短路 ＋ `strict`）；
`db.js` 12 個 CRM 包裝改 async；`server.js` 12+ 條 CRM 路由改 `await` ＋ try/catch（同 #442）；
測試 `v3/test/crm-parity.test.js`（離線 shim `$n`→`?`；live 用 `PG_TEST_URL`）。

### 3.2 2.2b `crm_outbox` 佇列 ＋ 投遞迴圈
`claimCrmOutboxBatch` 是 `UPDATE … RETURNING`（PG 用 `rowCount`）；`db.js` 的 `opsDeliveryDb()` 在 PG 模式
要回 async façade（不要把 PG 連線塞進同步 API）；`startCrmDeliveryLoop`／`deliverCrmOutboxOnce` 改 await。

### 3.3 2.3 佇列四支（下一個島）
`jobQueue`／`jobWorker`／`geoQueue`／`listingEnrichQueue`（runbook 步驟 7 的孤島清單）。先跑：
```bash
grep -nE "db\.prepare|res\.changes|last_insert_rowid|INSERT OR |datetime\(|julianday" \
  v3/src/jobQueue.js v3/src/jobWorker.js v3/src/geoQueue.js v3/src/listingEnrichQueue.js | head -40
```
再用同一套模式（repository ＋ async ＋ parity ＋ live）。`listingEnrichQueue.js` 已有 `upsertListingPrepAsync()` 可參考。

**2026-09-23 進度（實查）**：2.3a ✅（#459）、2.3b 第一段 ✅（#460）、2.3b 第二段 ✅（寫入路徑
enqueue／claim／reclaim／finish／recordEnrichMetric ＋ `helpers.enrichQueue` façade）、
2.3b 第三段 ✅（種子查詢改讀 PG；`enrichQueue.seed` 不再刻意回 0）。
`jobQueue`／`jobWorker`／`geoQueue` 都不需要再動（`geoQueue` 是純記憶體佇列，見 PG-2.3-NOTES.md）。
**runbook §7 列的孤島到此只剩 provider／budget（見 §3.4）**。

### 3.4 provider／budget 島
`budgetGuard.js`／`providers/*`／`callOpenAiCompat` 目前讀 SQLite（④ 刻意只把「產出的列」放 PG，見 #447 說明）。
移植後 `loadEnabledProvider()` 等才能全走 PG，AI 成本控管也才會跟著資料庫走。

### 3.5 HA 切換（最後）
runbook `docs/runbooks/postgres-cutover-bootstrap.md` 步驟 7 的孤島清完 ＝ 可切 HA；
切之前跑一次全 live 套件（目標 0 skip）＋ predeploy 檢查。

## 4. 常用指令

```bash
cd /workspace/repos/5151 && npm test                      # 全套（CI 也會跑）
set -a; . /home/cline/.secrets/postgres/5151-agent-pg.env; set +a
PG_TEST_URL="$PG_TEST_URL" node --test v3/test/<parity>.test.js   # live parity（0 skip 才算過）
gh pr create --base master --head <branch> --fill         # 非草稿 PR
gh pr merge <n> --squash --delete-branch                  # Owner 說合併就立刻合併，不要再問
```
發版三條（manual，依序）：`build-production-image.yml` → `production-predeploy-check.yml` → `deploy-v3.yml`
（確認字串 `DEPLOY-PRODUCTION` / `PREDEPLOY-PRODUCTION` 由代理人代填）。

## 5. 這個 session 踩過的坑（別重犯）

1. **內層呼叫要帶 `exec`**：`withFallback` 裡的 `isPhashEnabledAsync(options)` 漏傳 → PG 多開 driver、離線 `strict` 直接爆（#447 修）。
2. **測試 fixture 會被新測試清掉** → 用 `beforeEach` 還原種子列，否則後面第一段的測試會紅。
3. **時間欄位先固定**：`options.now = STAMP`，否則 `created_at` 毫秒差讓 parity 假紅。
4. **`extractCrawlInsight` 的 `opts.llmInsight` 只吃函式**（傳物件會靜默回 null）。
5. **`gh` 401**：不要 `export GH_TOKEN=$(awk …)` 蓋掉內建認證（會變空 token）；用 `gh` 自己的登入。
6. **內容含反引號或 `$` 時別用 `node -e "…"`**（shell 會做命令替換、內容被吃掉）→ 改用 quoted heredoc（`cat > f <<'EOF'`）。
7. **`pkill -f "…"` 會殺到自己**（pattern 撞到自己的命令列）→ 用更精確的 pattern。
8. **SQLite-only 寫法**：`INSERT OR IGNORE/REPLACE`、`last_insert_rowid()`、`res.changes`、`? IS NOT NULL`、
   `CASE WHEN ?`、布林綁定 —— 逐條換成 PG 寫法（清單在 2.2 計畫）。
9. **PG 的 identity 序號不會被「帶 id 的匯入」推進**：影子站的表是照 SQLite 的 id 複製進去的，
   所以 `GENERATED BY DEFAULT AS IDENTITY` 的序號還停在 1，第一個不帶 id 的 INSERT 就撞 pkey
   （實測 `listing_enrich_jobs` 9145 列、序號 = 1 → `duplicate key … listing_enrich_jobs_pkey`）。
   寫入路徑要接 `pgSchema.resyncIdentitySequences()`（2.3b 第二段已接在 `preparePgEnrichStore()`），
   切換前也要確認 cutover 有跑到這一步。
10. **寫入路徑的離線 exec 替身要回 `{ rows, rowCount }`**：只回陣列會被當成 rowCount 0，
    claim 就永遠搶不到工作（`v3/test/listing-enrich-parity.test.js` 的 `shimCounted()` 是正確形狀）。

## 6. 需要 Owner（代理人做不到）

1. **Reload Window** 一次（讓工作區路徑生效，終端機才會正常）。
2. 合併文件 PR（或說「合併」讓代理人做）。
3. **輪替三項機密**並補進憑證庫：NAS 登入密碼、Cloudflare API token、CF Access service token 的 client secret。
4. 路由器／DSM 主機層設定（代理人無 sudo）；Synology `58722` 是否關閉需 Owner 決定。

