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
- 第 61～91 批全部合併；**第 85～91 批已部署**。
  - 目前正式站 digest：`sha256:287008eda3a0c0b6bf5d7d7585f516a1239f4b2ea4f909e22b239ca2c334e24f`
    （source `54c826a9814604e260d7f878d949a931c737c6f0`，第九十一批）
  - 上一個 digest（rollback 參考）：`sha256:1423cc90c1f6e53c8095dd3b608315519ebbd52c0428e01c84d5d0681a6e7983`
- 最近七批在做什麼：85 OAuth callback／86 建立外部匯入／87 建立許願房提案（缺口歸零）／
  88 非路由工具安全閥／89 `/api/*` 一律回 JSON／90 修「登入後變訪客」（缺 import ＋ 漏 await）／
  91 抓取輪次預算 ＋ 逐批完成記錄。
- 正式站現況：`/api/health` ok；**登入已恢復正常（Owner 已確認）**；`houseprice`(5168) 自 09-26 無新資料。

## 3. 最重要：下一批（第九十二批）＝抓取完成判定，**待 Owner 同意政策變更**

現況（實查正式 PG，2026-09-30）：
- `crawl_covers.last_run_at` 38 列全部凍結在 `2026-09-27T04:05:35Z`、`settings.lastCoveringAt` 凍結在
  `2026-09-27T04:08:05Z`；`crawlScheduleV1.completed` **空**、`attempts` 已累積到 **3010**。
- 但 `lastSystemCoveringAt` 持續更新、591 房源持續落地（近 60 分鐘 2,362 筆 ≈ 39 筆/分 ≈ 1.5 秒/筆）
  ⇒ 輪次有在跑，只是**完成紀錄永遠寫不進去**。
- 根因：完成判定是「該覆蓋條件在**每一個啟用來源**都成功」（`watcher.js` 的
  `sourceSuccess.every(set => set.has(job.searchUrl))`，刻意的保守設計）。任何一個來源／分頁失敗
  ⇒ `successfulJobs` 空集合 ⇒ 連第九十一批加的「逐批記錄」也不會觸發。
- 已做的緩解（第九十一批，已部署）：預算 15→40 分鐘（`CRAWL_TICK_BUDGET_MINUTES`，compose 設 40）、
  逐批記錄完成、排程器 busy 不再重印逾時錯誤。**這些還不足以讓完成紀錄落地。**

計畫（等 Owner 點頭）：
1. `sourceSuccess` 每組帶上**來源 id**（目前只有集合），逐輪記錄 `state.sourceStreaks[source]`：
   連續失敗輪數、最後錯誤樣本、最後成功時間。
2. 連續失敗達門檻（建議 3 輪）⇒ 該來源**不再阻擋**完成紀錄，但必須
   (a) 輪次結果與日誌留明確 warning、(b) 後台可見（`crawlSourceHealthAsync` 已有來源健康資料）。
3. 來源恢復成功立刻歸零、照舊從嚴。
4. 之後再處理 `houseprice`（本機同支 `fetchHpCoveringListings()` 實測 701ms／20 筆無錯誤 ⇒ 不是來源壞，
   很可能是被這個判定卡住）。

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
