# 節點 SQLite 開閘／回退 Runbook（`PG_NO_SQLITE_OPEN`）

> 狀態：本文件是**操作書**，描述「把節點 SQLite 退場」這把閘該怎麼開、怎麼驗、怎麼秒回退。
> 它對應的**程式與基礎設施**（compose 直通、開閘腳本、回退腳本）都已在同一批 PR 內就緒，
> 但**閘的實際翻轉是 Production 變更**，未經 Owner 書面核准不得執行。

## 0. 這把閘是什麼

- `PG_NO_SQLITE_OPEN=1` 且 `DB_DRIVER=postgres` ⇒ 節點在啟動時**根本不開啟**業務 SQLite
  （不建 `v3.db`、不跑 PRAGMA/DDL/migration，`sqliteHandle()` 回傳一個「碰了就拋錯」的 proxy）。
- 未設／`0` ⇒ 行為與現在**完全相同**（向後相容）。
- 閘的程式端在 `v3/src/db.js:505-560`；開閘語意與守衛見 `v3/test/pg-no-sqlite-open.test.js`。
- **default 一律 0**：compose 直通寫 `${PG_NO_SQLITE_OPEN:-0}`，這包合併＋發版後**行為不變**。

## 1. 前提（哪些 SHA 必須已在正式站）

開閘前，正式站三容器（`591-tracker-v3`、`5151-web-A`、`5151-web-B`）必須已重建到**包含
批次 A/B/C 的 image digest**：

| 批次 | PR | SHA |
|---|---|---|
| listingCountForSearch 轉 PG 原生 | #676 | `d007176` |
| 開閘啟動爆點＋demand/getListing/sponsor_entitlement PG 原生 | #678 | `baa3694` |
| data_revision PG 原生 schema＋下架掃描 runtime.system | #677 | `4693132` |
| （閘本身）PG_NO_SQLITE_OPEN | #666 | `cc90292` |

- **source SHA 至少要 `≥ 4693132`（master HEAD）**，實際要用的不可變 digest 以
  `Build production image` → `Predeploy check` → `Deploy v3` 三條 workflow 的輸出為準，
  **禁止捏造 digest**。
- 查證方法（唯讀）：`bash v3/scripts/sqlite-gate.sh status` 會印出三容器的**鏡像 digest**，
  必須都是同一個「包含上述 SHA」的 digest，而不是目前線上的舊 digest
  `sha256:e795b0f5…`（那是 #676 之前的舊版，沒有閘的程式端）。

> ⚠️ 不要用 `npm run test:pg` 或 `PG_TEST_URL` 做任何驗證——那條 URL 就是正式庫
> `5151_shadow`（見 `/home/cline/.secrets/INDEX.md` 2026-09-27 警告）。寫入複驗一律用隔離庫。

## 2. 開閘順序：逐台 vs 三台同時

先講結論：**逐台，順序 `591-tracker-v3` → `5151-web-A` → `5151-web-B`，且 web-A／web-B
要在同一個短時間窗內先後開。** 但在這之前，先看 2.0 的前置動作。

### 2.0 開閘前的強制前置：把 5 支未加守衛的寫入端點修掉

**目前若直接開閘，會主動打壞 5 個功能**（詳見 §5）：`reportDemandAsync`／
`closeDemandPostAsync`／`updateWishRoomAsync`／`publishWishRoomAsync`／`reopenWishRoomAsync`
裡面的 `applyXxx(sqliteHandle())` 本機鏡像**還沒有閘守衛**（`v3/src/demandAsync.js` 第 249、
320、713、743、約 780 行）。閘一開，這 5 支會對「先寫 PG、再讓本機 handle 追上」那行拋錯。
**開閘前必須先加守衛（`if (!isPg(options)) …` 或改走 PG）並上線，否則不要開閘。**

### 2.1 逐台（建議）

```
bash v3/scripts/sqlite-gate.sh on 591-tracker-v3   # ① 先開 worker 節點
# 等一輪抓取結束（跑滿 CRAWL_TICK_BUDGET_MINUTES），看 §3 的驗收 2/4
bash v3/scripts/sqlite-gate.sh on 5151-web-A       # ② 再開 web-A
bash v3/scripts/sqlite-gate.sh on 5151-web-B       # ③ 緊接著開 web-B（間隔以分鐘計）
```

- **優點**：`591-tracker-v3` 是唯一跑 worker 迴圈（抓取／enrich／下架掃描／OPS 交付）的節點，
  先開它能**最早**暴露 worker 迴圈裡任何殘留的 un-guarded `sqliteHandle()`（這類 bug 只在
  worker 節點炸，web 節點看不到）。web 節點的風險面是寫入端點，屬 §3/§5 的複驗範圍。
- **風險**：web-A/web-B 兩台若**間隔太久**（只開一台），HAProxy 輪詢會把寫入請求打到
  「半邊 500」，出現**時好時壞**的 flicker，比全壞更難診斷。所以 ②③ 必須緊接著做。

### 2.2 三台同時

```
bash v3/scripts/sqlite-gate.sh on    # 三台同時開
```

- **優點**：乾淨切斷，`v3.db-wal` 的 mtime 在**所有節點同一時刻**凍結，驗收的「孤島不再被寫」
  沒有歧義；任何 un-guarded 寫入端點會**全站同時、100% 重現**地 500，比 flicker 好抓。
- **風險**：任何 un-guarded 寫入端點**瞬間全站中斷**，沒有先觀察 worker 節點的緩衝；判斷錯誤
  要回退時是三台同時重建的滾動窗口（雖 `off` 是 30 秒級，但三台一起動的風險面較大）。

### 2.3 建議與理由

**逐台、`591-tracker-v3` 先。** 理由是：這批閘的驗證焦點（下架掃描、排程器還原、data_revision）
全都長在 worker 節點上，先開它並跑滿一輪，等於用「真輪次」把最會藏 un-guarded 呼叫的那一層
先驗過，再動使用者面。web-A/web-B 則以「同時間窗先後開」來消除 HAProxy flicker。

## 3. 驗收（四件事，開閘後逐項確認）

1. **公網 200**：`curl -fsS https://jibbyrenth.reversalplay.me/api/health` 回 `{"ok":true}`。
2. **`business SQLite is closed` 計數 = 0**：三容器近一輪 log 不得出現該錯誤（出現＝有程式
   還在同步碰 SQLite handle，見 §5）。
   ```bash
   ssh casa-nas 'export PATH=/usr/local/bin:/bin:/usr/bin:$PATH; docker logs --since 30m 591-tracker-v3 2>&1 | grep -c "business SQLite is closed"'
   # 對 5151-web-A 同；5151-web-B 走 ssh syn-nas 同
   ```
3. **`v3.db-wal` mtime 從此凍結**：這是「孤島不再被寫」的唯一有意義信號。注意 WAL 模式下
   `v3.db` 本檔 mtime 本來就會凍結，**只有 `-wal` 的 mtime 能證明還有沒有被寫**。
   開閘後連看兩次（隔 ≥ 一個抓取週期）mtime 必須不變：
   ```bash
   bash v3/scripts/sqlite-gate.sh status   # 看 wal_mtime 欄位；連看兩次要相同
   ```
4. **PG 端資料仍在前進（唯讀抽查）**：開閘只停 SQLite，PG 是唯一權威，抓取仍要持續落地：
   ```sql
   SELECT max(alive_checked_at) FROM listings;           -- 持續前進
   SELECT max(last_run_at) FROM crawl_covers;             -- covers_max_last_run_at 持續前進
   ```
   （用 `/home/cline/.secrets/postgres/5151-agent-pg.env` 的**唯讀**連線比對兩次時間戳即可。）

## 4. 回退＝`sqlite-gate.sh off`（30 秒級，不需 revert 發版）

```bash
bash v3/scripts/sqlite-gate.sh rollback    # ＝ off 三台，並印出下一步要查的三個指令
```

- `off` 只把 `.env` 的 `PG_NO_SQLITE_OPEN` 這一個 key 刪掉（`cp -p` 備份 → `sed` 刪行 →
  `chmod` 還原 mode → `grep -c` 必須＝0）再 `docker compose up -d`，**不動 image、不動發版**，
  所以回退是 30 秒級的重建，不需要 revert 任何 commit。
- 回退後照 `rollback` 印出的三個指令查：`status`（閘值回到 `unset`、wal mtime 恢復前進）、
  公網 200、log 無 `business SQLite is closed`。

## 5. 已知未測範圍（開閘後第一件事）

**164 支寫入端點（POST/PUT/PATCH/DELETE）在開閘下完全沒打過。** 其中 5 支**已知會在閘開下壞**，
因為它們「先寫 PG、再讓本機 handle 追上」的那行 `applyXxx(sqliteHandle())` 還沒加閘守衛：

| 端點 | 函式 | 未守衛的 `sqliteHandle()` 呼叫 |
|---|---|---|
| `POST /api/demand/:id/report` | `reportDemandAsync` | `applyReportHideEffects(sqliteHandle(), …)`（demandAsync.js:249） |
| `POST /api/demand/:id/close` | `closeDemandPostAsync` | `applyClosedPostEffects(sqliteHandle(), …)`（:320） |
| `PATCH /api/wish-rooms/:id` | `updateWishRoomAsync` | `writeRow(sqliteHandle(), …)`（:713） |
| `POST /api/wish-rooms/:id/publish` | `publishWishRoomAsync` | `applyPublishInPlace(sqliteHandle(), …)`（:743） |
| `POST /api/wish-rooms/:id/reopen` | `reopenWishRoomAsync` | `applyReopenInPlace(sqliteHandle(), …)`（約 :780） |

（此缺口已於 `04d0469d` 回報。）**結論：開閘前先修這 5 支的守衛並上線；其餘 159 支用下方
步驟在閘開下 smoke 複驗。**

### 5.1 可執行複驗步驟（塞 `demand_posts`／`user_match_votes` 進隔離庫，逐欄位比對閘關／閘開）

> 隔離庫＝`prb-repro-pg` 的 `repro` 庫（連線取自 `/home/cline/.secrets/postgres/5151-live-repro.env`
> 的 `PG_LIVE_REPRO_URL`；INDEX 標示「唯讀以外的寫入都安全」）。**禁止**碰正式庫或 `PG_TEST_URL`。

1. 起一台**本機** v3（掛隔離庫、臨時 DATA_DIR），不與正式站搶資源：
   ```bash
   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
   DB_DRIVER=postgres PG_URL="$PG_LIVE_REPRO_URL" PG_SQLITE_FALLBACK=strict \
     DATA_DIR=/tmp/gate-verify-gateoff PORT=5199 node v3/src/server.js
   ```
2. 塞一筆有資料的 `demand_posts`（owner 有 `user_match_votes` 依賴的欄位）與對應
   `user_match_votes` 進隔離庫（`INSERT`；欄位以 `v3/src/demandPgSchema.js`／`demand.js` 為準）。
3. **閘關**基準：對 5 支端點各打一次（用該 owner 的登入），記下 PG 端 `demand_posts`／
   `user_match_votes`／`demand_reports` 各欄位 snapshot（`SELECT *` 存檔）。
4. **閘開**：把同一個 DATA_DIR 換成 `PG_NO_SQLITE_OPEN=1` 重啟，重置隔離庫到同一初始狀態，
   對同一 5 支端點各打一次。
5. **逐欄位比對**：閘關 vs 閘開 的 PG 端 row 必須**逐欄位一致**（開閘不得漏寫、不得改寫）；
   同時確認閘開下 `DATA_DIR/v3.db-wal` mtime **沒有前進**（孤島沒被寫），且端點回 200
   而非 500。任何 `business SQLite is closed` 的 500 就是漏網的 un-guarded 呼叫，照 §5 表格補守衛。

## 6. compose 直通怎麼落地（誰、用什麼指令）

`PG_NO_SQLITE_OPEN: ${PG_NO_SQLITE_OPEN:-0}` 已加在 5 份 compose 定義（見 PR body 的逐檔行號）。
但**只有其中一部分會被發版自動帶到 NAS**，其餘要手動落地：

| 檔 | 服務 | 誰落地 | 指令 |
|---|---|---|---|
| `docker-compose.yml` | 591-tracker-v3 | **deploy-v3.yml 自動**（"Copy" 步驟帶到 `/mnt/Storage1/apps/5151`） | 不用手動 |
| `casaos-compose.yml` | 591-tracker-v3 | **deploy-v3.yml 自動** | 不用手動 |
| `docker-compose.crawl-sandbox.yml` | 5151-crawl-sandbox | **crawl-sandbox-sync.sh 自動**（scp 到 casa-nas） | 不用手動 |
| `deploy/shadow-ha/web/web-a/docker-compose.yml`（**去識別化模板**）→ 正本 `/opt/5151-shadow/web-a/docker-compose.yml` | 5151-web-A | **人**（Owner／agent，經 `bash v3/scripts/sqlite-gate-compose-land.sh`） | 手動落地 |
| `deploy/shadow-ha/web/web-b/docker-compose.yml`（**去識別化模板**）→ 正本 `~/5151-shadow/web-b/docker-compose.yml` | 5151-web-B | **人**（同上） | 手動落地 |

**落地指令（可重跑、冪等、不印檔內容）**：
```bash
bash v3/scripts/sqlite-gate-compose-land.sh          # 落地 web-a＋web-b 兩份主機正本
DRY_RUN=1 bash v3/scripts/sqlite-gate-compose-land.sh  # 只印將執行的指令，先預覽
```

> 為什麼 web-a/web-b 要手動：deploy-v3.yml 對 A/B 組**只覆寫 `.env`（`V3_IMAGE`），不帶 compose**；
> 而這兩份主機正本含有硬編的 `SESSION_SECRET`／`PG_URL`／`R2_*` 憑證，所以 repo 裡只放去識別化模板。
> 落地腳本用 `sed` 在 `PG_SQLITE_FALLBACK` 之後插入同一行直通，`cp -p` 備份＋`chmod` 還原 mode，
> 不印檔內容（避免把正本裡的憑證帶進終端）。

### ⚠️ web-a/web-b 的閘旗標會在下一次發版被「靜默洗掉」

deploy-v3.yml 的 A/B 組步驟是 `printf 'V3_IMAGE=…\n' > .env`（**整份覆寫**）。所以：
- 對 web-a/web-b 執行 `sqlite-gate.sh on` 之後，**下一次發版會把 `.env` 的
  `PG_NO_SQLITE_OPEN=1` 洗掉，閘會靜默回到 0**（容器重建後 SQLite 重新開啟）。
- `591-tracker-v3` 不受影響：deploy-v3.yml 對它用 `sed`/append **只動 `V3_IMAGE_PIN` 一行**，
  不覆寫整份 `.env`。
- **因此**：每次發版後，都要重跑 `bash v3/scripts/sqlite-gate.sh status` 確認三台閘值；
  web-a/web-b 若被洗掉，再 `bash v3/scripts/sqlite-gate.sh on 5151-web-A 5151-web-B` 重設。
  （長期解法是讓 deploy-v3.yml 改用「只動 V3_IMAGE 一行」的寫法，另開 PR，不在此包範圍。）

## 7. 寫入面複驗（批 D）

> 批 D 把 §5 表格那 5 支「先寫 PG、再讓本機 handle 追上」的無守衛鏡射，連同
> `addDemandReplyAsync` 與 `getDemandPostAsync` 的同步 fallback，全部用
> `sqliteHandleIsUsable()` 包起來（開閘 ⇒ 不鏡射、不回退；未開閘 ⇒ 行為逐字不變）。
> 同時把 `deploy-v3.yml` 對 web-a／web-b 的 `.env` 從整份覆寫改成「單鍵寫入」，
> 讓開閘後再發版不會把 `PG_NO_SQLITE_OPEN=1` 靜默洗掉（§6 那條警示在此包修掉）。

### 7.1 單測（離線，原數字）

| 測試 | 結果 |
|---|---|
| `v3/test/demand-gate-write.test.js`（新增：開閘六支寫入不碰 SQLite、PG reject 抛原始錯誤、讀取 fallback 不回退） | 4/4 |
| `v3/test/deploy-v3-env-write.test.js`（新增：單鍵寫入 bash -n＋跑兩次不洗第二鍵） | 3/3 |
| `v3/test/mutation-anchors.test.js`（3 支 source-text 錨點已同步更新） | 1/1 |
| demand／wish 全系列（demand*.test.js＋wish*.test.js，live 項以 `PG_LIVE_REPRO_URL` 觸發） | 192 pass／1 skip（live 未設環境） |

### 7.2 live 列數（repro 隔離庫，`PG_NO_SQLITE_OPEN=1`）

六支寫入（report／reply／update／publish／reopen／close）開閘下全部回 `ok: true`、
無 `business SQLite is closed`；寫入前後列數：

| 表 | 寫入前 | 寫入後 | 變化 |
|---|---|---|---|
| `demand_posts` | 37 | 37 | 0（六支都是 UPDATE，不 INSERT） |
| `demand_replies` | 1 | 2 | **PG +1**（`addDemandReplyAsync`） |
| `user_match_votes` | 1 | 1 | 0（無誤寫） |
| `user_match_signals` | 1 | 1 | 0（無誤寫） |

節點 SQLite：開閘下 `DATA_DIR/v3.db` **未建立**（`nodeV3dbCreated: false`）。

### 7.3 有資料差分（閘關 vs 閘開，逐欄位）

往 repro 塞一筆有資料的 `demand_posts`（`districts=["1-5","1-7"]`）＋兩則 `demand_replies`＋
各一筆 `user_match_votes`／`user_match_signals`，再以 `getDemandPostAsync` 讀回同一則：

| 欄位 | 閘關 | 閘開 | 一致 |
|---|---|---|---|
| `status` | `open` | `open` | ✅ |
| `districts` | `["1-5","1-7"]` | `["1-5","1-7"]` | ✅ |
| `replies[0]` | `{body:"第一則回覆",hidden:false}` | 同左 | ✅ |
| `replies[1]` | `{body:"第二則回覆",hidden:false}` | 同左 | ✅ |

（`id` 因每次 seed 都用新 identity 而不同，非漂移；`replies`／`districts`／`status` 逐字相同。）
