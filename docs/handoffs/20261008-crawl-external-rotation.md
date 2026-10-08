# 2026-10-08：外站抓取改成跨輪輪轉（`externalRotation`）

## 0. 一句話
六家外站在 `watcher.js` 是**寫死順序依序跑**、全部排在 591 之後，而它們的總工作量裝不进 40 分鐘的輪次預算
⇒ 排在後面的家**每輪一開工就被我們自己的取消訊號打死**，外表看起來像「對方擋人」。這包把它改成
「一輪只排一家外站、最久沒被排到的先；延後不算失敗」。

## 1. 量到的事實（2026-10-08 上午，正式站 `5151_shadow`）
| 來源 | 後台開關 | 近 24h 有看到 | `last_seen_at` 最後 |
|---|---|---|---|
| 591 | ✓ | 9820 筆 | 2026-10-08T01 |
| 住商 hbhousing | ✓ | 521 筆 | 2026-10-07T18 |
| 信義 sinyi | ✓ | **0** | 2026-10-06T00（≈2 天） |
| 5168 houseprice | ✓ | **0** | 2026-10-05T22（≈2 天） |
| 好房網 housefun | ✓ | **0** | 2026-09-22（≈15 天） |
| 租租通 ddroom | ✓ | **0** | 2026-09-22（≈15 天） |
| 樂屋網 rakuya | ✗（關著） | — | — |

* 輪次健康度（同一容器近 12 小時日誌）：**被 40 分鐘預算砍掉 23 次**、`busy` 跳過排程 700 次、
  真正完成只有 2 輪（`排程抓取完成（2282037ms）`／`（2387920ms）`，都是「剛好沒超」）。
* `settings.crawlScheduleV1.sourceStreaks`：租租通／好房網 `fails=117`、`lastSuccessAt` **空字串**（從未成功）、
  `lastError` 甚至也是空；住商是整批 `第 N 頁 [23]：The operation was aborted due to timeout`。
* `[23]` 是 DOMException 的 TIMEOUT 碼，而 "aborted due to timeout" 這句話在我們自己的
  `crawlWatchdog.js`（`abortSignalTimeout`／`LIST_FETCH_TIMEOUT_MS = 8_000`）裡
  ⇒ **是我們 abort 它，不是對方回錯**。

## 2. 機制（為甚麼一定爆）
`crawlPolicy.js`：`COVERING_JOBS_PER_RUN = 6`、`CRAWL_PAGES_591 = 12`、`CRAWL_PAGES_EXTERNAL = 6`。
591 那 6 組覆蓋條件是**有輪轉的**（`rotateCoveringJobs`，2026-09-24 就是為了同一種爆預算而加），
但外站六家在 `watcher.js` 裡是 `collectExternal(...)` 依序 await、**每家用自己那套行政區清單跑到底**：
沙盒實測每家約 **93 頁／輪**，單頁上限 8 秒 ⇒ 一家最壞 ~12 分鐘，五家 60 分鐘起跳，
而 `TICK_BUDGET_MS` 只有 40 分鐘（`CRAWL_TICK_BUDGET_MINUTES`，compose 設 40）。
591 先跑掉一部分，剩下的預算更不夠 ⇒ 排在後面的家每輪都只拿到「已被取消的輪」，
每頁立刻 AbortError，`fails` 就這樣一路累積到 117，而且 `lastSuccessAt` 永遠是空。

## 3. 這包改了什麼
* 新增 `v3/src/externalRotation.js`（純函式，不碰網路不碰 DB）：
  * `externalSourcesPerRun(env)`：一輪排幾家，預設 **1**，可用 `CRAWL_EXTERNAL_SOURCES_PER_RUN` 調 1～6。
  * `externalSourceStaleness(streak, now)`：取 `max(lastSuccessAt, lastFailureAt)` 當「上次被排到的時刻」，
    兩者都空 ⇒ 無限餓（排最前）。
  * `rankExternalSources` / `pickExternalSources`：回傳 `{ running, deferred, cooling }`；
    冷卻中的家**兩邊都不進**（不碰它，讓對方的封鎖窗口過期）。
* `watcher.js`：六個寫死的 `if (wantX && !cooling.has(...))` 區塊 → 一個 `externalTasks` 清單
  ＋ 依 streaks 排序後的 `for (const task of externalRotation.running) await collectExternal(...)`。
  每家原本的 fetch 選項（`postJson`／`postForm`／`getHtml`／`getJson`／`startPages`）**逐字保留**。
* **延後不是一種失敗**：`deferred` 不會被呼叫 `noteSourceRound`，而 `applySourceRound` 是先把所有舊
  streak 原样複製、才套用本輪 `rounds` ⇒ 缺席的家 streak 逐字不變（不歸零、不累加 `fails`、不會被誤裝冷卻期）。
* 後台不受影響：`adminOverviewAsync.js` 的 `crawlSourceHealthAsync()` 用的是 `listings` 的
  `lastSeen`／`todayNew` 加累計 streak，**不看「這一輪有没有出現」**⇒ 延後不會被畫成失敗。

## 4. 沙盒實測
`5151-crawl-sandbox`（真來源、隔離庫 `crawl_sandbox`），`SANDBOX_ROUNDS=N bash v3/scripts/crawl-sandbox-sync.sh`。

**(a) 改動前（同一容器自己的排程，舊寫死順序）**
| 輪 | 時間 | 耗時 | 結果 | 本輪外站 |
|---|---|---|---|---|
| 13 | 23:41→23:52 | 628s | `timed_out=false`、fetched 1987 | hbhousing＋sinyi＋houseprice＋ddroom＋housefun **5 家全跑**，各 `0/6`、fails 93／93／12／93／93 |
| 14 | 00:22→00:32 | 616s | 同上，fetched 1991 | 一樣 5 家全跑 |
| 15 | 01:02→01:42 | **2400s** | **`timed_out=true`**，`已自動放棄`、報告無彙總 | — |

第 15 輪雖然報告是 0，但查隔離庫 `listings` 可知**六家在 01:00–01:54 都有落地痕跡**
（591 2031、sinyi 1602、houseprice 1413、housefun 1205、hbhousing 845、ddroom 681 筆）
⇒ **租租通／好房網在正式站 15 天零成功不是對方擋人**，是我們讓它排不到；
`timed_out` 那輪 `fetched=0` 是「超時輪不回彙總」的報告假象，不是整輪歸零。

**(b) 第一版輪轉（用 `lastSuccessAt` 排序）＝我自己的設計錯，被抓出來**
| 輪 | 時間 | 耗時 | 本輪外站 |
|---|---|---|---|
| 1 | 01:51→02:05 | 823s（不再爆預算） | **hbhousing 1 家** ✔ |
| 2 | 02:35→02:46 | 646s | **又是 hbhousing** ✘ |

連兩輪都排到同一個「永遠抓不通」的家：用「最後成功時間」排序時，它永遠最餓 ⇒ 每輪都吃掉外站名額，
另外四家照樣等死——**跟原本的寫死順序一樣糟，只是換了人質**。所以排序改成
「上次被排到」＝ `max(lastSuccessAt, lastFailureAt)`，排過就讓位。

**(c) 修正版：兩輪都跑完了，而且排序換家了（我中途的「砍不下去」判斷是錯的，一併更正）**
第二串（修正版）的兩輪報告都在 `/data/crawl-sandbox.jsonl`：

| 輪 | 時間 | 耗時 | `timed_out` | fetched | 本輪外站 |
|---|---|---|---|---|---|
| 1 | 03:31→03:43 | **746s** | false | 1935 | **houseprice**（上次被排到 10-07T19:15，最舊） |
| — | 04:19→04:30 | 639s | false | 2159 | **houseprice**（這是排程還原後、容器自己跑的一輪） |

容器日誌直接印出這包要的行為：
`外站輪轉：本輪排 houseprice｜延後 sinyi,ddroom,housefun,hbhousing（不算失敗，下一輪優先）`
⇒ 昨晚連三輪霸榜的 `hbhousing` 被擠到延後清單（它在 03:18 剛被排過），`houseprice` 因為上次被排到最舊而拿到名額。

**我先前寫的「第二串那輪 47 分鐘沒被 40 分鐘預算砍掉」是誤判，兩個原因**：
1. 我查報告時把篩選寫成 `started_at >= 03:33`，而該輪是 **03:31** 開始 ⇒ 被我的篩選擋掉，看起來像「沒寫報告」。
2. 實際狀況是第二輪（排到 `sinyi`）跑到 35 分鐘仍在 40 分鐘預算內，**我提前送 TERM**，所以它永遠不會有報告。
把「自己看錯」當成「程式有缺陷」寫進文件，是這次最該記的錯誤；已在本節改正。

**真正還留著的問題（第 2 件重新定義）**：輪轉減少的是「每輪幾家」，**沒有減少「每家一輪的工作量」**。
一家外站一輪仍然要跑約 93 頁（自己那套行政區清單 × 頁數），單頁上限 8 秒 ⇒ 一家就能吃掉 12～35 分鐘，
五家輪完一圈之後，下一輪又是 12 分鐘起跳。所以下一步不是再調輪轉，而是**給每家一個每輪上限**
（例如一輪只跑該家的前 N 個行政區／前 M 頁，剩下的下一輪接），讓「一輪一家」變成「一輪一家的一小塊」。
另外 `rakuya` 在 PG 模式下會先呼叫 `repairRakuyaScopes(db, jobs)`（`db` 是本機 SQLite，
`watcher.js` 自己的註解就警告「會拿到別台的舊頁碼」），這條要一起查，但它跟「砍不下去」無關。

## 5. 上線後要看什麼（合併 ≠ 生效）
```sql
-- ① 四家停滯的來源有没有開始前進（最重要的一項）
select source, count(*) filter (where last_seen_at >= to_char(now() - interval '6 hours','YYYY-MM-DD"T"HH24:MI')) 近6h
     , max(left(coalesce(last_seen_at,''),16)) 最後看到
  from listings group by 1 order by 3 desc nulls last;
-- ② 延後的家不該被累加 fails（同一時點前後對照）
select key, value from settings where key = 'crawlScheduleV1';
```
* 日誌：`外站輪轉：本輪排 …｜延後 …（不算失敗，下一輪優先）` 應該每輪出現；
  `超過 40 分鐘沒結束，已自動放棄` 的次數應該明顯下降（一輪變成 591 的 6 組＋1 家外站）。
* **退路**：`CRAWL_EXTERNAL_SOURCES_PER_RUN=5` 就回到「幾乎每輪全跑」的舊行為（不用改 code）；
  整包退回就是 revert 這顆 commit。
* 還沒處理（下一件，依序）：
  1. **每家外站一輪的工作量太大**（93 頁／家）⇒ 要做「每輪上限：只跑前 N 個行政區或前 M 頁，下一輪接」（上面 (c) 的結論）。
     另查 `rakuya` 在 PG 模式呼叫 `repairRakuyaScopes(db, jobs)` 讀本機 SQLite 這條（與時效無關，是正確性）。
  2. 信義 503 與 5168 403 是**真擋台**（沙盒與正式站都遇到），輪轉解決不了，要另案。
  3. ✅ 已做（PR #652）：租租通／好房網在正式站 `lastError` 是**空字串**（沙盒卻抓得到資料）——輪轉上線後先看它們會不會自己活過來，
     如果還是不行，查它們自己的錯誤為什麼沒文字（診斷盲點）。
  4. ✅ 已做（PR #652）：`/p/<不存在的 id>` 回 200 的 soft-404 改成 404（存在但 hidden 仍 200，那是沒拍的產品決定）。

---

## （d）2026-10-08 下午：第 2 件做实了——「每家階段預算＝本輪剩餘時間」

### 先講我上午那句「一輪只排一家就不會爆預算」是錯的

發版（`sha256:e1c316c9…`，04:58:12Z 起來）後的第一輪實測：

| 時間（UTC） | 事件 | 證據 |
|---|---|---|
| 04:59 | `外站輪轉：本輪排 houseprice｜延後 hbhousing,sinyi,ddroom,housefun` | 容器日誌 |
| 05:00:36→05:13:51 | **591 一個人就花 13 分**（556 筆 `last_seen_at` 落在這個區間） | `select source, count(*), min/max(last_seen_at) from listings` |
| 05:14→05:38 | 5168 一家跑了約 **27 分、零落地**（`houseprice` 在 04:58 之後沒有任何一筆） | 同上 |
| 05:38 | `這輪抓取超過 40 分鐘沒結束，已自動放棄` | 容器日誌 |

⇒ 輪轉把「五家」變「一家」是**必要但不夠**：一家就能吃光整輪。
所以第 2 件的正解不是「砍行政區數量」，而是**給每一家在這一輪的時間上限，上限綁在「這一輪還剩多少」**。

### 做了什麼（commit `a267875`，PR 見下）

1. `externalRotation.js` 新增純函式 `externalPhaseBudgetMs({ remainingMs, env })`：
   上限預設 10 分（`CRAWL_EXTERNAL_PHASE_MAX_MINUTES`，夾在 3〜20），
   但 `min(上限, 本輪剩餘 − 2 分收尾)`；剩餘不足 3 分 ⇒ 回 **0**，語意是「這一輪不碰外站」（全部延後）。
   留那 2 分鐘是因為 2026-09-24 `rotateCoveringJobs` 那批學到的：**整輪爆掉時 591 已完成的覆蓋紀錄也不會落地**。
2. `watcher.js` 的 `collectExternal(source, label, run, phaseBudgetMs)` 用**巢状 `withBudget`** 包外站階段
   （`crawlExecution.js` 的 context 是 `AsyncLocalStorage`，所以巢状會暫時取代內層 signal，來源的逐頁
   `isCrawlCancelled()` 就會在我們自己的deadline到時停手）。`catch` 的第一行仍是
   `if (isCrawlCancelled()) throw error;`——**整輪**被砍/被取代要立刻往上丟（AGENTS 第三條）；
   只有「外層沒取消、錯誤看起來是我們自己的 abort」才算階段用盡 ⇒ `partial`。
3. `crawlSourceStreaks.js` 新增 `lastAttemptAt`：**成功／失敗／不適用／只跑一半四條分支都蓋章**，
   `externalSourceStaleness` 改看 `max(lastAttemptAt, lastSuccessAt, lastFailureAt)`。
   少了這個章，被預算停手的家會永遠看起來「從沒被排過」，下一輪還是它 ⇒ 等於回到寫死順序。
   完全沒排到的家仍然**逐字不變**（延後≠失敗，有尺規釘死）。
4. 測試注入點 `options.externalPhaseBudgetMs`（跟 `hbPostJson` 同一套 fake 做法）。

### 證據

**離線**（截斷這條路只能這樣驗，詳見下節沙盒說明）：
`crawl-round-integration.test.js` 用「400ms 階段預算＋會睡 2.5 秒的 fake」跑真的 `runWatch`：
該家被標 `partial:true`、輪次錯誤寫著「階段預算…用盡」、streak `fails` 不增加、`lastAttemptAt` 有蓋章、
**整輪照常收尾不擲錯**。
存儲層另有測試釘住「四條分支都蓋章＋沒排到的家逐字不變」。

**變異**：`mutation-check.mjs` 新增 `EXTERNALROT_MUTATIONS` 13 條（排序方向、三個 staleness 鍵、
每輪家數上限、階段預算的 min/cap/收尾餘裕、巢状 withBudget、吞取消、partial 標記、`!phaseMs` 的 break、
`phaseMs` 有沒有傳进去）→ **13/13 KILLED**；另外把 5 條因這包改動而失效的舊錨點重新釘到新形狀，
`crawl-source-streaks 15/15`、`source-recovery 31/31`、`crawl-round-integration 3/3` 都全接到。

**沙盒（真來源）**：見（e）。

### 兩個我自己的失誤（記在這裡，不要重犯）

- 用 python 的 `s[i:j]` 切片重寫 `from:`/`to:` 時，把 `const ROUNDINT_MUTATIONS = [` 整段吃掉：
  檔案 `node --check` 照過、執行才 `ReferenceError`，而 dispatch 落到**別套**變異，
  於是我看到一排 `SURVIVED 拆開／票選…` 差點當成這包的成績。教訓：改長檔一律**逐行比對**、
  改完立刻 grep 符號還在不在（`grep -c ROUNDINT_MUTATIONS` 應該 ≥2）。
- `pkill -f "npm test"` 的 pattern 也 match 到我自己那條 bash（指令裡含這四个字）⇒ 自我 SIGTERM。
  要停就按 pid，或用 `[n]pm test` 這種 bracket 寫法。

### （e）沙盒真來源這一條路的實測，以及一筆**假缺陷**

沙盒 `5151-crawl-sandbox`（casa-nas，隔離庫 `crawl_sandbox`，同一顆映像）：

| 串 | 條件 | 結果 |
|---|---|---|
| 第三串 | `SANDBOX_EXTRA_ENV="CRAWL_EXTERNAL_PHASE_MAX_MINUTES=3"`，2 輪 | 輪 1（05:53:24→06:07:51，786s→866s 含第二輪排隊）`jobs=6 fetched=2159 timed_out=false`；`591 6/6`、`houseprice 0/6`。**截斷沒發生**：5168 在沙盒約 2 分鐘就因為被擋而**自己停工**（`lastError='5168 三芝區 第 2 頁 [FETCH_BLOCKED]…'`），輪不到我們的 3 分鐘上限。但這輪驗證了記帳語意：`houseprice.lastAttemptAt` 有蓋章、`fails` 從 12 沒有增加、**四家延後的家逐字不變** |
| 第四串 | `SANDBOX_EXTRA_ENV="CRAWL_TICK_BUDGET_MINUTES=12"`（這個名稱在沙盒沒生效，`budget_ms` 仍是 2400000） | `jobs=0` 空轉，無證據價值。⚠️ 這一輪的 `error` 欄位出現 `batches is not defined`——是**我把 mutation-check 跟沙盒同步同時跑**造成的：變異工具在這一刻把 `let batches = []` 故意挪進 `try`（那正是它要造的變異），同步腳本把「變異中」的 worktree 複製過去。**不是程式缺陷**：本地用 `jobs: []` 重跑真 `runWatch` 得到的是正常防護錯誤「請先選行政區或貼上至少一組 591 搜尋網址」。教訓：**變異跑完之前不要同步沙盒**（兩者都會動 `v3/src`） |
| 第五串 | 先把 `hbhousing` 的 streak **從隔離庫刪掉**（⇒「從未排過」＝最餓），再配 3 分鐘上限跑 2 輪 | 輪 1（06:34:22→06:47:26，784s）`jobs=6 fetched=1821 timed_out=false`；`591 6/6`、**`hbhousing covered 0/6、fails 0、last_error 空`**——這形狀只有「我們自己停手 ⇒ partial/applicable 跳過」才會出現（正常失敗會 `fails+1`、會被擋停工會留 `lastError`）⇒ **真來源上打到了截断路径**；輪 2 要看的是「換人」（住商已被蓋章，不該再被排到） |

### （f）合併＋發版後的正式站收據（`master=0201924`，映像 `sha256:9a3a0a1767…`，07:11:43Z 起來）

**輪轉真的會換人**（兩輪的日誌）：
```
外站輪轉：本輪排 houseprice｜延後 hbhousing,sinyi,ddroom,housefun（不算失敗，下一輪優先）
外站輪轉：本輪排 hbhousing｜延後 sinyi,ddroom,housefun,houseprice（不算失敗，下一輪優先）
```
**streak 的記帳**（`settings.crawlScheduleV1.sourceStreaks`，`at` 是輪次開始時刻）：

| 家 | `lastAttemptAt` | `fails` | `lastError` |
|---|---|---|---|
| 591 | 07:52:08 | 0 | （成功，空） |
| houseprice | 07:13:52（第一輪排到） | 32 | `5168 三芝區 第 1 頁 [FETCH_BLOCKED]…` |
| hbhousing | 07:52:08（第二輪排到） | 119→120 | **`覆蓋 2/6，但這一輪沒有任何錯誤回報（比抓取失敗更可能是…）`** |
| ddroom / housefun / sinyi | （無＝這輪沒排到） | 119 | 維持原值 |

`lastError` 空字串那個 15 天查不起來的洞，現在會自己寫一句話了（#652 那包）。soft-404 也即時驗過：
`/p/22113055`（真實 `post_id`）→ **200／56.9 KB**；`/p/99999999`、`/p/abc` → **404**；`/` 與 `/api/health` → 200。
（顺手記一下：`/p/:id` 查的是 `listings.post_id`（bigint），清單裡**沒有** `id` 欄位。）

**時間都在 591 身上，第 2 件還沒做完。** 這兩輪的分解：

| 輪 | 591 階段 | 外站階段 | 結局 |
|---|---|---|---|
| 04:58Z（只有輪轉、還沒階段預算） | 05:00:36→05:13:51（13 分、556 筆） | 5168 約 27 分、零落地 | **40 分被砍** |
| 07:12Z（階段預算上線） | 07:13:52→**07:42:31（29 分、1561 筆）** | 只剩 `9.5−2=7.5` 分可用 → 07:50 停手 | **07:52:08 收在預算內**，`超過 40 分鐘` 這段期間 **0 次** |

⇒ 階段預算把這一輪救回來（靠的就是那 2 分鐘收尾餘裕），但**地板是 591**：它一個階段就能吃掉 29 分。
下一包要做的（同一個問題的另一半）：
**591 的覆蓋階段也要有「佔本輪預算的比例」上限**，超收就標 `partial` 讓下一輪續跑——
現在 591 是 6 個 covering job × 每 job 逐頁抓，頁數政策在 `crawlPolicy.js`，停手點要在 `runWatch` 的 591 段落，
而且要留意 `rotateCoveringJobs`（2026-09-24 那批）已經有「一輪跑不完就下一輪續」的骨架，可以沿用。

## （g）第 1 件（下一包）：591 覆蓋階段也要有上限

**為什麼必要**（都是正實站的數字，不是推測）：外站有每家預算之後，發版後第一輪 591 一個人就
`07:13:52 → 07:42:31`（**29 分、1561 筆**），外站階段只分到 `40 − 30 = 10` 分再扣 2 分收尾＝7.5 分，
整輪 `07:52:08` 才收進預算（差一點點就又爆）。上一輪對照組：591 只花 13 分（556 筆）
⇒ **591 的耗時随當輪覆蓋條件的負载大幅変動**，不能假設它跑得完。

**做法**（跟外站那半一致，但停手點不同）：
* `crawlPolicy.js` 新增純函式 `coveringPhaseDeadlineMs({ now, remainingMs, env })`：
  上限＝`min(（本輪剩餘 − 2 分收尾）× 55%, 20 分)`，**算出來不到 5 分就不設限**（回 0），
  `remainingMs` 拿不到也不設限（不憑空造上限把輪次咬死）。
  環境變數：`CRAWL_COVERING_PHASE_SHARE`（30〜80）、`CRAWL_COVERING_PHASE_MAX_MINUTES`（5〜30）。
* `watcher.js` 的 591 段落只在**兩個覆蓋條件之間**檢查（不在半頁中停）：已經抓到的頁面
  照樣落地、照樣記完成；到點就 `break` 並把 `coveringTimedOut` 立起來。
* 輪次記錄改成 `noteSourceRound("591", successful, sourceErrors, false, true, coveringTimedOut)`
  ⇒ 用既有的 `partial` 語意：**不累加 `fails`**（第 2 件加的 `lastAttemptAt` 仍會蓋章），
  未跑完的縣市**不會被記成完成**（`completeCoveringPlan` 只吃 `successful`），下一輪照樣排進去。
* 新增測試注入點 `fetchPage: options.fetchPage`（`client591.fetchListings` 本來就支援
  `typeof options.fetchPage === "function"`，沒傳完全不變）與 `coveringPhaseDeadlineMs`，
  讓「到點停手」這條路可以離線跑**真 `runWatch`**（三個覆蓋條件 × 每頁睡 120ms × 上限 150ms）。

**臨時庫小坑**（整合測要建使用者）：覆蓋階段的完成記錄是 per-user 的，`saveSettings` 落在
`defaultUserId()`（臨時庫裡是 **1**）；只插 id 101 的使用者會撞到 `user_settings` 的
`FOREIGN KEY constraint failed`。

**變異**：`EXTERNALROT_MUTATIONS` 從 13 條擴到 **23 條**（新增的 10 條覆盖：到點不停手、
停了但不記 `coveringTimedOut`、輪次記錄不带 `partial`、抽掉注入點、不看本輪剩餘時間、
拔掉 2 分收尾餘裕、上限不夾、比例不夾、少於 5 分也設限、拿不到 deadline 憑空造上限）。

⚠️ **踩到兩次、都記进 agent-brain**：
1. `mutation-check.mjs` 的判定是 `killed = failingNames(out).some(n => n.includes(m.expect))`
   ⇒ **沒寫 `expect` 的條目永遠算 SURVIVED**，跟我測得嚴不嚴無關（我一开始以為是尺規没接到，
   手動套同一條變異才證明測試是紅的）。新條目**一定要带 `expect`**，而且要正好是失敗測試名的子字串。
2. 我用「只重組陣列區間」的方式寫回 `mutation-check.mjs`，把前後 6291 行**整段寫掉**
   （`node --check` 仍然過，因為剩下的片段本身合法）。已 `git checkout` 還原，改成
   `s[:j] + entries + s[j:]` 的定點插入，並用「行數＋符號引用次數＋`--check-anchors-only`」三重確認。

## (h) 第 1 件（591 覆蓋階段上限）與第 2 件（5168 設施推估）

### 591 覆蓋階段的時間上限（`4683d80`）

正式站 07:12Z 那輪的分解把地板暴露了：591 一個人 07:13:52→07:42:31＝**29 分鐘**（1561 筆
`last_seen_at` 落在這段），外站階段只分到 `40 − 29 − 2 = 9` 分。同一天 04:58Z 那輪 591 只花
13 分（556 筆）⇒ **591 的耗時依當輪負载大幅変動，不能假設它跑得完**。

* `crawlPolicy.coveringPhaseDeadlineMs({now, remainingMs, env})`＝
  `min((本輪剩餘 − COVERING_PHASE_TAIL_MS 120s) × share%, cap)`；
  `CRAWL_COVERING_PHASE_SHARE` 預設 55（夾 30〜80）、`CRAWL_COVERING_PHASE_MAX_MINUTES`
  預設 20（夾 5〜30）；**拿不到本輪剩餘時間 ⇒ 回 0（不設限）**，不憑空造上限把輪次咬死。
* `watcher.js` 只在**兩個覆蓋條件之間**檢查（不在半頁中停：已抓到的頁面照樣落地、照樣記完成），
  到點 `break` 並立 `coveringTimedOut`，輪次記錄 `noteSourceRound("591", …, true, coveringTimedOut)`
  ⇒ `partial` 的語意是「**不累加 fails**、仍蓋 `lastAttemptAt`」，未跑完的縣市由
  `successful` 規則保證不會被記成完成，下一輪照樣排進去。
* 注入點 `options.coveringPhaseDeadlineMs` ＋ `fetchPage: options.fetchPage`
  （`fetchListings` 本來就支援 `typeof options.fetchPage === "function"`，沒傳行為不變），
  所以這條路可以**離線跑真 `runWatch`**：3 個覆蓋條件 × 每頁 120ms × 上限 150ms ⇒
  驗到停手訊息、`fails` 不增加、`lastAttemptAt` 有蓋章、整輪照常收尾、0 筆落地。
* 變異 23/23 KILLED（`crawl-external-rotation`，其中 10 條是這包新加的）。
  **教訓：`mutation-check.mjs` 的每一條一定要有 `expect`（要能在失敗的測試名稱裡出現的子字串），
  少了它一律回報 SURVIVED**——我這次 10 條全被誤判成「測試不夠嚴」，實查是工具用法錯。

沙盒（casa-nas／`crawl_sandbox`／同一顆映像）`SANDBOX_ROUNDS=2
SANDBOX_EXTRA_ENV="CRAWL_COVERING_PHASE_MAX_MINUTES=3"`：

| 輪 | 時間（UTC） | 秒 | jobs | fetched | completed | timed_out | 591 | 外站 |
|---|---|---|---|---|---|---|---|---|
| 1 | 09:34:19→09:49:02 | 883 | 6 | 2749 | 19 | false | **6/6 fails 0** | hbhousing 2/6 fails 1 |

* ⚠️ **這一串沙盒沒有打到 591 截斷**：沙盒只有 19 筆覆蓋條件、資料又是當天剛跑過的，
  591 階段約 3 分鐘就 `6/6` 跑完 ⇒ 3 分上限「剛好好夠」。函式本身在容器內單獨驗過
  （`env=3、剩 39 分 → 3 分；拿不到剩餘 → 0`）。截斷的行為級證據在離線真 `runWatch` 那條；
  正式站 29 分鐘才是這條上限要綁的實况。
* 順帶證到 #652：`hbhousing covered 2/6` 且**沒有任何頁面錯誤**時 `lastError` 現在會自己寫一句話
  （以前是空字串，15 天查不出原因）。
* `covers_max_last_run_at` 有前進（09:10:44 → 09:49:02）⇒ 覆蓋完成記錄沒被這改動擋住。

### 5168 設施「推估」不再擋展示（`6a123f1`＋`5bc3059`）

正式站 `listing_prep` 現況（只讀查得）：

| `display_ready=0` 卡在 | 筆數 |
|---|---|
| `withhold_reason=facility`（`facility_status=not_provided`、`facility_basis=inferred`） | **5297** |
| `detail,address,floor,facility`（`not_fetched`，還沒補抓） | 3678 |
| `detail,floor,facility` | 1171 |
| `coords_missing` | 144 |

`facility_basis=inferred` 合計 5569 筆 ⇒ 這 5297 筆不是資料壞，是政策把「來源根本不提供設施欄位、
我們由內文推估」定義成不完整；而 `hpDisplayReadySql()` 只對 `source='houseprice'` 生效，
擋住的正好是這一家。

**最終實作（只動展示，其他全部不動）**：

```js
const facilityOnlyGap = missing.length === 1 && missing[0] === "facility"
  && identity && detailRecognized && address.usable && floor.status === FIELD_PROVIDED;
displayReady: status === PREP_READY || keepVisible || facilityOnlyGap,
```

* `facilityComplete` 維持「推估不算完整」、`missing_fields` 照樣記 `facility`、
  `status` 照樣 `pending` ⇒ `enrichErrorClass` 仍回 `pending_missing`，queue 繼續補抓。
* 缺口訊號不消失：`facility_basis=inferred`＋`facility.reason` 是「這是推估的」的正字標記
  （要查就查這兩欄，不要用 `missing_fields`）。
* 前端 `kitLine()`：`facility_status === "not_provided"` 的項目尾端加
  「（推估：來源未提供設備欄位，由刊登內文判斷）」⇒ 推估的天然氣／陽台不會被當成來源實測。
* 通知不會暴增：`watcher.js` 的 `onFirstReady` 只對 `first_seen_at` 兩小時內的物件發事件
  （既有防護），5297 筆舊資料轉可展示時不會各發一則「新物件」。

**踩到的坑（一定要看）**：我第一版把「推估」從 `missing_fields` 裡拿掉、還新增一條
`source_limited` 分支，企圖一併改掉結案語意。`npm test` 全套立刻紅了一條——
`listing-enrich-pending-missing.test.js`（「來源沒提供設備且是推估時仍判 pending」）：
那條測試是 **5168 一個間歇性 403 造成 386 次重試** 事故後鎖住的規則，
`pending_missing` 必須留在「`next_retry_at` 要当真鎖住」的清單裡。
⇒ 教訓：**「能不能展示」與「缺欄位怎麼記帳／怎麼重試」是兩件事，放寬前者不要把後者一起改掉**；
而且這種越界只有**全套**抓得出來（相鄰四套 101/101 全綠也照樣漏）。改回來之後
四套 101/101 綠，`outcome` 仍照 `displayReady` 記（既有定義，不另改）。

**訪客看到同屋源 chips**：原建議是「默認關閉」，盤點後我**改變建議**——
`/api/public/listings/:id/similar`（`app.get` 那條）本來就是訪客可見，同屋候选名單已用
`display_ready` 過濾（`db.js:3650 .filter((peer) => peer.display_ready)`），資料本身在 5168
的頁面就是公開的；關掉它只是把「同一個房東還在別處刊登」這個消費者最需要的警示藏起來。
⇒ 決定：**保持可見，不再加默認關閉**；要加的是「這是推測同屋源」的措辭（下一包，屬 UI 文案）。
