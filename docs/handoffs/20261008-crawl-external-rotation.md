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

**(c) 修正版：跑整輪沒跑出報告，所以改拿「真 streak」直接問選擇（不打網路）**
第二串 `SANDBOX_ROUNDS=2` 用修正版同步後開跑（03:33Z），591 照常落地（1935 筆，到 03:42Z），
但**整輪跑了 47 分鐘都沒寫出本輪報告**——沙盒那條路是有接 `withBudget` 的（`v3/scripts/crawl-sandbox.mjs:153`），
正常應該 40 分鐘就回報 `timed_out=true`（上面第 15 輪就是這樣）。我 TERM 掉那輪，同步腳本的 trap
已把排程還原（`CRAWL_SANDBOX_SCHEDULER=1`，實查確認）。
**嫌疑最大的就是 `rakuya` 那段**：依修正版的选择，這一輪排的正是 `rakuya`（它 `lastSuccessAt`／`lastFailureAt` 全空＝從未排過），
而 `collectExternal("rakuya", ...)` 在抓取前會先跑 `repairRakuyaScopes(db, jobs)`——`db` 是本機 SQLite，
`watcher.js` 自己那段註解早就寫過「PG 模式下讀本機 SQLite 會拿到別台的舊頁碼」。
**這一條我沒有順手改**（它跟輪轉是兩件事），列為下一件要查：为什么砍不下去＋rakuya 在 PG 模式的讀寫是否合法。

因為拿不到「整輪報告」，我改用同一顆容器、同一份真實 streak 直接問輪轉會排誰（不碰網路）：
```
   hbhousing   fails=95   上次被排到=10-08T03:18 ｜上次成功=從未
   sinyi       fails=94   上次被排到=10-08T01:09 ｜上次成功=從未
   houseprice  fails=12   上次被排到=10-07T19:15 ｜上次成功=10-01T01:21
   ddroom      fails=94   上次被排到=10-08T01:09 ｜上次成功=從未
   housefun    fails=94   上次被排到=10-08T01:09 ｜上次成功=從未
   rakuya      fails=-    上次被排到=從未        ｜上次成功=從未
新政策本輪排   : rakuya
新政策本輪延後 : houseprice,sinyi,ddroom,housefun,hbhousing
舊政策本輪排   : hbhousing（沙盒連三輪都排到它，因為它永遠不會成功）
```
正式站 `rakuya` 是關著的（`settings.crawlSources` 實查 `enabled:false`），所以正式站第一輪會排 `houseprice`，
而昨晚連三輪霸榜的 `hbhousing` 被擠到最後 ⇒ 「排過就讓位」這條在真實資料上生效。

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
  1. **`rakuya` 那段為什麼讓整輪砍不下去**（上面 (c)；含 `repairRakuyaScopes(db, jobs)` 在 PG 模式讀本機 SQLite）。
  2. 信義 503 與 5168 403 是**真擋台**（沙盒與正式站都遇到），輪轉解決不了，要另案。
  3. 租租通／好房網在正式站 `lastError` 是**空字串**（沙盒卻抓得到資料）——輪轉上線後先看它們會不會自己活過來，
     如果還是不行，查它們自己的錯誤為什麼沒文字（診斷盲點）。
  4. `/p/<不存在的 id>` 回 200 的 soft-404。
