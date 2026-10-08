# 20261009 待辦：輪次預算與覆蓋／外站的交互（今晚量到的回歸訊號）

## 現象（全部為正式站實測，唯讀取得）

* 部署 `841d7d7`（PR #655：591 覆蓋階段 20 分上限＋5168 可見性反轉）之後：
  * 近 3 小時 **2 輪**、近 1 小時 **4 輪**「這輪抓取超過 40 分鐘沒結束」（部署前同窗口 **0 輪**）。
  * 每輪耗時都是 `2400004~2400006ms` ⇒ 是被預算砍掉，不是自己跑完。
  * `排程抓取略過：busy` 43 次／45 分 ⇒ 排程 tick 幾乎一直在.busy。
* 覆蓋吞吐下滑：`crawl_covers.last_run_at` 按小時計數
  * 18–19（部署前）＝ 2、19–20 ＝ 14、20–21（部署後）＝ 4。
  * 但**沒有停擺**：最新一筆 `2026-10-08T12:43:19Z`（被砍的輪次內仍持續寫入）⇒ 覆蓋成果是增量落地的。
* 591 健康計數**沒有被灌水**：`settings.crawlScheduleV1.sourceStreaks` 的 `591.fails = 0`；
  記帳點在 `v3/src/watcher.js:964 recordCrawlSourceRoundAsync`，被砍的輪走不到那行。
* 5168 自愈仍在前進（反證「不是卡死」）：可展示 0 → 56 → 129 → 357 → **465**；
  只差 `facility` 的 5500 → 5369 → 5254 → **5118**（約 270–340 筆／小時）。
* enrich 佇列不是兇手：`queued=100`、`running=1`、`source_limited=150`、`failed=10866`（歷史堆積）。

## 目前最可信的機制（尚未證明）

部署前是「覆蓋 591 約 29 分 ⇒ 外站只剩 11 分 ⇒ 剛好 40 分內收工」的**僥倖**。
現在覆蓋被 20 分上限提前讓路 ⇒ 外站拿到 20 分，但 `hbhousing / sinyi / housefun / ddroom`
正處於**慢速失敗**狀態（`SOURCE_UNAVAILABLE`、`FETCH_BLOCKED`，三家 `fails` 已卡在 120 上限），
重試把 20 分吃光 ⇒ 整輪超過 40 分被砍。

## 要做的事（順序）

1. **沙盒 A/B**（`5151-crawl-sandbox`，不准拿正式站當白老鼠）：
   * A＝目前 master（含 20 分覆蓋上限）；B＝把覆蓋上限關掉（`COVERING_PHASE_*` 環境變數調大）。
   * 各跑 `SANDBOX_ROUNDS=3`，比較每輪耗時、`crawl_covers` 前進量、各來源 covered/total。
   * 報告要寫進 `docs/handoffs/`，並附 `docker exec 5151-crawl-sandbox tail -3 /data/crawl-sandbox.jsonl`。
2. **外站也要有階段預算**（同一個 `coveringPhaseDeadlineMs` 的思路）：給外站一個上限＋
   「到點停手」的明確訊號，讓整輪落在 40 分預算內；不要只靠整輪預算把已抓到的東西一起砍。
3. **observability 缺口**：`errors[]` 只在輪次收尾時寫出（`watcher.js:798` 的「到點停手」就是走 `errors.push`），
   輪次被砍時整份摘要遺失 ⇒ 到點停手要**即時** `log`（或至少在被砍路徑上 dump 目前 errors）。
4. 慢速失敗的三家（`hbhousing/sinyi/housefun`）另開單查：錯誤是「覆蓋 N/6 但這一輪沒有任何錯誤回報」
   與 `SOURCE_UNAVAILABLE`，`fails` 已頂在 120；先確認是來源改版還是 IP 被封。

## 今晚已排除的選項

* 不是覆蓋上限的程式寫錯（`watcher.js:781-800` 只在兩個覆蓋條件之間檢查、`break` 乾淨，無 busy-wait）。
* 不需要回填大量 UPDATE：5168 靠排程自己翻，約 15–19 小時翻完。
* 不是 enrich 佇列塞住（見上）。
