# 交接：5151 PG 島嶼遷移收尾＋抓取輪次修復（2026-09-30）

> 給新 session 的 agent：先讀本檔，再讀 `docs/handoffs/PG-ISLAND-MIGRATION-PLAN-20260927.md`
> （主文件；最近三批在 §89～§91）與 `/home/cline/.dsh/AGENTS.md`（Owner 硬性規則）。

## 1. 身分、環境、鐵則

- 唯一權威來源：`github.com/Fyun48/5151`（branch `master`）。只做 v3。
- 正式站：容器 `591-tracker-v3`（CasaOS，埠 5153；公開 `https://jibbyrenth.reversalplay.me`）；
  OPS Console 是另一個容器（5154，獨立 `ops.db`）。正式站已是 **PostgreSQL**（`DB_DRIVER=postgres`）。
- 每批流程：實作 → 離線 parity 測試 ＋ 變異全殺 → live PG（隔離庫 `repro`）→ PR → 四項 CI 綠 →
  squash 合併。**部署一律要 Owner 當次明確說「可部署」**，再走三條 manual-only workflow。
- 憑證：先讀 `/home/cline/.secrets/INDEX.md`。常用：
  - 正式站設定：`/home/cline/.secrets/apps/5151-prod-casaos.env`（`PG_URL`、`DB_DRIVER`）
  - live PG（隔離）：`/home/cline/.secrets/postgres/5151-live-repro.env`（`PG_LIVE_REPRO_URL`→`repro`）
  - 正式站 session 簽章金鑰：casa-nas `/mnt/Storage1/docker_data/591-tracker-v3/auth.env` 的 `SESSION_SECRET`
    （只在診斷時暫讀、用完刪暫存檔；**值不可寫進 repo／PR／對話**）
- 回報：台灣繁中、只寫「結果／證據／剩下的選項」，不要旁白。改檔案不要用全域字串取代；
  寫文件用 quoted heredoc。
- 不要自行部署、不要另開 tunnel、不要動 v1/v2。

## 2. 目前狀態（2026-09-30 06:30Z）

- **PG 島嶼遷移：路由缺口 0**。尺規 `PG 268／無直接DB 20／MIXED 0／SQLite 0`。
- 第 61～96 批全部合併；**第 85～96 批已部署**（92／93 兩批於 2026-09-30 08:17Z 與 09:35Z 上線，
  Owner 當次核准）。
  - 目前正式站 digest：`sha256:d2ba53ce1f4f8b2562e96406c00759d885896414d14ebaf148ca0b1274f1ebcd`
    （第九十七批之二）
  - 上一個 digest：`sha256:b04af5ab…`（第九十七批）→ 再上一個 `sha256:f04eabef…`（第九十六批之二）
  - 上一個 digest（rollback 參考）：`sha256:287008eda3a0c0b6bf5d7d7585f516a1239f4b2ea4f909e22b239ca2c334e24f`（第九十一批）
- ✅ **2026-09-30 09:54Z 追蹤：凍結解除**。第九十二批＋第九十三批上線後，
  `crawlScheduleV1.completed` 由空轉 **2 筆**、`settings.lastCoveringAt` 由 `2026-09-27T04:08Z`
  變成 **`2026-09-30T09:54Z`**、`crawl_covers.last_run_at` 開始前進；
  放行 warning 四則都帶出「哪個來源、哪一區、哪一頁、哪個網址」。
  下一步的兩個選項（暫停門檻改成「連續被擋 N 次」、降低 5168 明細量）見主文件 §94.5。
- **第九十三批（2026-09-30，已合併已部署 09:35Z）**：來源的「第一線 fail-soft」——591／5168／住商／信義
  補上逐頁 try/catch（被擋就暫停這一家、已抓到的批次照樣回報、錯誤樣本帶出事的網址），
  並確保逐頁 catch 不吞掉整輪取消。見主文件 §94。Owner 指定「第一線就要 fail-soft」已寫進
  repo 的 `AGENTS.md`。
- 🚨 **部署紀律（2026-10-01 實測踩到）**：跑三條 workflow 時**一定要逐段檢查結論**——
  我有一行指令用 `gh run watch … >/dev/null` 把狀態吃掉，predeploy **失敗卻照樣部署**。
  那次失敗是 standby `pg_dump` 的 hot-standby 衝突（`canceling statement due to conflict with recovery`，
  偶發、與程式無關），重跑即過；但閘門失敗就該停。**不要再用 `>/dev/null` 吞結論。**
- ⚠️ **第九十六批之二（2026-10-01 00:23Z 部署）**：修「輪次 70 分鐘沒收尾、兩輪重疊」——
  第九十六批的冷卻寫成同一輪空等 90 秒把收集階段拖過預算，加上落地階段不理會整輪取消。
  **教訓：不要在輪次中間 await 冷卻；落地階段一定要檢查取消**（主文件 §97.6）。
- ✅ **第九十六批（2026-09-30，已部署 14:47Z）**：同輪去重 ＋ 被擋冷卻重試 ＋「不適用」不再算失敗。
  沙盒驗證：5168 由每輪 0/6 變成 **1/6**、房源在 14:50 重新落地（沙盒該輪 9,632 筆）。
  詳見主文件 §97。
- ✅ **第九十五批（2026-09-30，已部署 12:09Z）**：暫停門檻改成「連續被擋 2 次」、
  5168 明細量 280→60。沙盒驗證：完成紀錄由 0 變 6 列／`completed` 0 變 6、
  5168 在同一輪也有房源落地。⚠️ 沙盒抓到一個新問題：有一輪超過預算後**沒有收尾**
  （沒寫報告、DB 也不再寫入、留下一條 `idle in transaction`）——正式站不受影響，
  但沙盒要加硬性收尾（下一批第一項）。
- **第九十四批（2026-09-30）＝抓取沙盒**：常駐容器 `5151-crawl-sandbox`（casa-nas，寫隔離庫
  `crawl_sandbox`）用真程式、真來源跑完整輪次。**動抓取邏輯的 PR 開之前必須先跑沙盒並附報告**
  （見 repo `AGENTS.md` 的同名段落；主文件 §95）。
- 最近八批在做什麼：85 OAuth callback／86 建立外部匯入／87 建立許願房提案（缺口歸零）／
  88 非路由工具安全閥／89 `/api/*` 一律回 JSON／90 修「登入後變訪客」（缺 import ＋ 漏 await）／
  91 抓取輪次預算 ＋ 逐批完成記錄／92 來源連續失敗的放行政策（見 §3）。
- 正式站現況：`/api/health` ok；**登入已恢復正常（Owner 已確認）**；`houseprice`(5168) 自 09-26 無新資料。
- 🚨 **2026-09-30 追加事故（已修、已部署，08:17Z）**：後台「版面與功能分類全不見」。根因是
  `resolveSession()` 對**所有**靜態副檔名路徑都寫入「未登入」，但 `requireAuth()` 仍要擋
  `/admin-ia.js`／`/admin-support.js`／`/admin-providers.js` ⇒ 那三支檔對**已登入的人**也回
  302 到 `/login.html`，瀏覽器把登入頁 HTML 當 JS 執行（SyntaxError）⇒ 後台只剩靜態骨架。
  修法：`auth.js` 新增 `skippableStaticAsset()`（只有「公開的」靜態資產才跳過解析）。
  詳見主文件 §93（二之負六十四）。部署後外部實測：三支 .js 已由 302 變 200。

## 3. 第九十二批：來源連續失敗的放行政策（**已實作、已合併、已部署 2026-09-30 08:17Z**）

政策變更已由 Owner 於 2026-09-30 當次明確同意；實作與完整紀錄見主文件
`docs/handoffs/PG-ISLAND-MIGRATION-PLAN-20260927.md` §92（二之負六十三）。

- 根因（不變）：完成判定原本是「該覆蓋條件在**每一個啟用來源**都成功」（`watcher.js` 的
  `sourceSuccess.every(...)`）。6 個啟用來源裡只要有一個失敗／部分失敗，`successfulJobs` 就是
  空集合 ⇒ `crawl_covers.last_run_at` 38 列凍結在 `2026-09-27T04:05:35Z`、
  `settings.lastCoveringAt` 停在 `2026-09-27T04:08:05Z`、`crawlScheduleV1.completed` 一直是空的。
- 這一包做的事：逐輪記錄 `crawlScheduleV1.sourceStreaks[source]`（連續失敗輪數、最後錯誤樣本、
  最後成功時間）；**連續失敗達 3 輪**的來源不再阻擋完成紀錄，但會留下輪次 `warnings`＋
  `console.warn`，後台「抓取來源」卡片顯示「連續失敗 N 輪（已放行完成紀錄）」；
  來源恢復成功立刻歸零。另加安全閥：**所有**來源都在容忍名單時（全滅）仍然不記完成。
- 驗證：`v3/test/crawl-source-streaks.test.js` 9 項全綠、變異 `CRAWLSTREAK_MUTATIONS` 15 條全殺、
  `CRAWLROUND_MUTATIONS` 4 條全殺；`v3/test/crawl-source-streaks-live-pg.test.js` 在隔離庫
  `repro` 上**不注入驅動**實測通過（島嶼自己解析 driver 的那條路）。
- **上線後第一輪實測（08:24:45Z）**：`crawlScheduleV1.sourceStreaks` 第一次寫進正式站——
  591 成功（fails 0）、其餘五個外站各 fails 1，其中 **houseprice 的錯誤樣本是
  `5168 暫時無法抓取（HTTP 403）`** ⇒ 這就是「每一輪都被單一來源卡住」的那個來源
  （也回答了 §91.7：正式站的 5168 是回 403，不是沒被輪到）。
  預期第 3 輪起該來源被放行、`crawl_covers.last_run_at`／`lastCoveringAt`／`completed` 開始前進
  （一輪 25～40 分鐘）。
- 接著要處理：`houseprice`（5168）自 09-26 沒有新資料（本機同一支 `fetchHpCoveringListings()`
  實測 701ms／20 筆正常 ⇒ 要另外追來源本身，不是完成判定）；
  以及 40 分鐘仍跑不完的落地效率（約 1.5 秒/筆，批次寫入／並行化）。

## 4. 其他待辦（依優先序）

1. **非路由殘留**（§88 盤點）：三個 5 分鐘 tick（許願房生命週期／提案逾期／租賃通知）與 CRM 遞送 loop
   仍是同步 SQLite；`workerConvergence.js` 已寫好未接線。
2. **UAT fixture PG 化**：`production-uat-stages-wiring.mjs` 目前 fail-closed（PG 模式不能跑）。
3. `cutover-backfill`／`cutover-conflicts` 的快照新鮮度檢查；`sqlite-consistency-snapshot.mjs`
   會把過期快照寫進正式資料卷。
4. `migrate-v3-data-volume.yml` 搬的是已作廢的 SQLite 目錄；`predeploy` 仍要求 `v3.db` 存在。
5. 主機 `/opt/5151-scripts/` 有 repo 沒有的腳本（`projection-monitor`，PR #498 未合併）⇒ 可稽核性。
6. 爬蟲長輪次：40 分鐘仍跑不完（落地 1.5 秒/筆）⇒ 未來要批次寫入／並行化。

## 5. 常用指令（照抄）

```bash
# 尺規（路由缺口）
node v3/scripts/route-data-map.mjs            # 人看
node v3/scripts/route-data-map.mjs --json     # 給程式解析

# 全套測試（基線：3 紅＝PR-A manifest 需 commit 後才過 ＋ 2 條已知 flake）
npm test
#   已知 flake：cursor walks past the old 2000-row candidate cap /
#              cooperative member processing preserves roles…

# 單一測試檔
node --test v3/test/<name>.test.js

# 變異（全殺才算過；背景跑，跑完確認 sources 已還原）
node v3/scripts/mutation-check.mjs v3/test/<name>.test.js
node v3/scripts/mutation-check.mjs v3/test/<name>.test.js --check-anchors-only

# live PG（隔離庫 repro；**不要**用 PG_TEST_URL）
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
node --test v3/test/<name>-live-pg.test.js
#   第九十二批那支會自己把 DB_DRIVER/PG_URL 指向 repro（刻意不注入 driver）：
#   node --test v3/test/crawl-source-streaks-live-pg.test.js

# 正式站診斷（唯讀）：健康、容器 digest、日誌
curl -s https://jibbyrenth.reversalplay.me/api/health
ssh casa-nas "docker inspect 591-tracker-v3 --format '{{.Config.Image}} | {{.State.Status}}'"
ssh casa-nas "docker logs 591-tracker-v3 --since 30m 2>&1 | tail -20"
# 需要「已登入視角」時：從 NAS auth.env 讀 SESSION_SECRET 簽一個 591_session cookie 打正式站，
# 只用於診斷（例如 GET /api/me、/api/admin/*），用完刪掉暫存檔。

# 正式站資料查詢（唯讀）
set -a; . /home/cline/.secrets/apps/5151-prod-casaos.env; set +a
node -e '…'   # 用 v3/src/dbDriverPostgres.js + PG_URL
```

## 6. 部署（每次都要 Owner 當次「可部署」）

```bash
sha=$(git rev-parse HEAD)
gh workflow run build-production-image.yml --ref master -f sha=$sha -f release_mode=manual_owner -f release_intent_id=
# 等 run 完，下載 evidence artifact 讀 image_digest（不是 log 裡的雜訊 digest）
gh workflow run production-predeploy-check.yml --ref master -f sha=$sha \
  -f confirmation=PREDEPLOY-PRODUCTION -f release_mode=manual_owner -f release_intent_id=
gh workflow run deploy-v3.yml --ref master -f sha=$sha -f image_digest=sha256:… \
  -f confirmation=DEPLOY-PRODUCTION -f release_mode=manual_owner -f release_intent_id= -f debug=false
```
部署後要**外部實測**（不是只看 workflow 自報）：`/api/health`、容器 `Config.Image`、必要時用偽造 cookie
打 `/api/me` 確認已登入視角；並在下一次 PR 把 digest／rollback identity 寫進主文件。

## 7. 這一輪踩過的坑（新 session 別重犯）

1. **島嶼測試幾乎都注入 `exec`／`pgDriver`** ⇒ 正式站「島嶼自己解析驅動」那條路沒被測到。
   新島嶼至少留一條**不注入**的測試（live 檔最適合）：`adminMembersAsync` 少一個 `await` 就是這樣躲過 CI 的。
2. **`server.js` 有 600+ import 與後段註冊路由**：刪任何 import 前先跑
   `v3/test/server-module-wiring.test.js`；「看起來沒用」的同步函式可能還在 `/api/me` 裡被呼叫。
3. **`/api/*` 的 JSON 404／錯誤中介層必須在最後一條路由之後**（`/api/events/revision`、`/api/events/stream`
   註冊在檔案後段，曾被 404 蓋掉）。
4. **5xx 不外洩內部訊息、4xx 沿用路由訊息**；前端一律用 `readApi()`（非 JSON 要翻成人看得懂的字）。
5. **變異錨點**：`from` 必須在檔案中恰好出現一次；字面比對要留 `\s*`（換行會漏殺）；等價變異要移除並寫理由。
6. **寫入要 fail-closed**：`withFallback(...)` 要明示 `{ write: true }`（第二個參數才是 `write`）。
7. **尺規盲點**：`db.js` 的轉出（`export { x } from "./y.js"`）不會被追進原模組 ⇒ 補回 import 後量尺才會看見它。
8. **PG 的 `state=active` 很久 ≠ 卡住**：先看 `application_name`／`wait_event`（`walreceiver`＋`WalSenderMain`
   是 standby 複寫，正常）。
9. 文件「現況表」由 `v3/test/route-data-map.test.js` 守著：動了尺規數字要同步改
   `docs/handoffs/PG-ISLAND-MIGRATION-PLAN-20260927.md` 的表現況表。
10. 變異工具會**就地改寫** `v3/src/*.js`：一定要在 repo 內跑（工具已加守衛），不要在正式站原始碼目錄跑。
11. **變異錨點要唯一化到「同一句話在檔案裡只出現一次」**（第九十二批實測）：`warnings: sourceWarnings,`
    在 `watcher.js` 出現兩次（正常結束與 `skipped: "portals"` 兩條回傳路徑），只寫那一行會被工具以
    「錨點出現 2 次」擋下；改用含前後行的片段（`errors,\n      warnings: …,\n      sources: …,\n      skipped: "portals",`）。
    同理，測試若用 `assert.match(src, /…/)` 驗一個出現兩次的字串，變異只改其中一處時**會漏殺**
    ⇒ 改成數出現次數（`src.split(x).length - 1 === 2`）。
12. **中介層的「跳過」條件必須與守門條件一致**（2026-09-30 事故）：`resolveSession()` 為了效能
    跳過靜態資產的 session 解析，但 `requireAuth()` 還是要擋同一批檔案 ⇒ 需要登入的靜態資產
    （`/admin-ia.js` 等）變成「對任何人都未登入」→ 302 到登入頁 → 瀏覽器把 HTML 當 JS 執行，
    整頁初始化靜默死掉（畫面只剩靜態骨架，console 只有一句 SyntaxError）。
    寫這種 skip 條件時，問句要改成「這個路徑**本來就不需要身分**嗎」，不是「它像不像靜態檔」。
13. **抓取邏輯不准再拿正式站當白老鼠**（2026-09-30 第九十四批）：沙盒容器
    `5151-crawl-sandbox` 已建好（casa-nas、隔離庫 `crawl_sandbox`、不發佈埠）。
    同步＋跑一輪：`SANDBOX_ROUNDS=1 bash v3/scripts/crawl-sandbox-sync.sh`；
    報告：`ssh casa-nas "docker exec 5151-crawl-sandbox tail -3 /data/crawl-sandbox.jsonl"`。
    沙盒**不會**自動跟著部署更新（刻意的：要能測還沒上線的候選版本）。
14. **變異測試會抓出「測試寫得不夠利」**（2026-09-30 第九十三批實測）：同一個 fail-soft 行為，
    只放**兩個**受測對象時，「有暫停」與「沒暫停」的呼叫次數一樣 ⇒ 變異活下來；
    取消守衛只驗「有沒有丟錯」也不行（吞掉取消的版本最後仍會因整批失敗而丟錯）。
    **要驗「呼叫次數」與「後續有沒有再打」**，不是只驗最後的結果形狀。
15. **`npm test` 之外的驗證順序**：變異工具與 `npm test` 都會吃 CPU，而且變異會就地改寫 `v3/src/*.js`
    ⇒ **不要同時跑**（會讀到變異版的原始碼）。本批是等變異跑完才跑全套。
