# 5151 切換上線計畫（2026-09-26）

依上線收尾指令第七節：先把正式執行內容做成確定版本，再走既有 manual-only 流程。
**本計畫尚未執行；需要 Owner 對「第七節」與「待決事項」給出指示後才開始。**

## 一、版本

| 項目 | 值 |
|---|---|
| 候選程式 | PR [#497](https://github.com/Fyun48/5151/pull/497)，head `4accdbd`（含本輪所有 PG 島嶼修正） |
| 合併後 master | 合併後以 merge commit 的完整 SHA 為準（`build-production-image.yml` 的 `sha` 輸入） |
| 目前正式版本（**回版目標**） | image `sha256:a47285c6a1856fbba265c67222ebc1fd2faa3bb975c5eaaecb5eb923596c5e7e`，revision `9c6b7b04…` |
| 部署範圍 | `591-tracker-v3`、`5151-web-A`（CasaOS）、`5151-web-B`（Synology） |
| PG schema 變更 | **無**。已逐一核對 PG 具備新程式寫入的所有欄位（`listing_match_evaluations`、`listing_groups`、`listing_group_members`、`listing_group_audits`、`user_listing_flags.watch_group_id`、`listings.kit_*`／`match_*`、`users.verify_*`），且 `listings.fixture_namespace` 在 PG 也存在 |

## 二、這次切換解決什麼

三個 web 節點過去各自把配對／群組／評估／收藏／抓取進度寫進**自己的** SQLite，
而站上讀的是 PG。結果是：新配對在站上看不到、兩台節點各自累積不同狀態、PG 落後。
本輪把這些路徑全部改成寫 PG（讀寫同源），並補上 PG 的 predeploy 備份。

## 三、備份（已備妥，切換時 predeploy 會再取一次）

- 三份 SQLite 一致性快照（`VACUUM INTO`，含 WAL）＋ 一份 PG `pg_dump -Fc`，皆已做**異機副本**並核對 SHA256。
- 位置：CasaOS `/mnt/Storage1/cutover-20260926/`、Synology
  `/volume1/homes/tori/5151-shadow/cutover-20260926/`。
- 補遷 `backfill.sql`（133 筆 INSERT）已產生並經隔離排練通過。

## 四、切換順序（依既有流程，不新增路徑）

三條 workflow 的輸入已核對（`PRODUCTION_DEPLOY_ALLOWED_ACTOR=Fyun48`，`release_mode` 用預設
`manual_owner`、`release_intent_id` 留空）：

1. **合併 PR #497** → 取得 **master 上的 merge SHA**（三個 workflow 都要求 `sha` 可從
   `origin/master` 追溯）。
2. ```bash
   gh workflow run build-production-image.yml --repo Fyun48/5151 --ref master \
     -f sha=<merge SHA> -f release_mode=manual_owner
   ```
   完成後從 run 的 artifact／log 取得 **image digest**（`sha256:` ＋ 64 碼）。
3. ```bash
   gh workflow run production-predeploy-check.yml --repo Fyun48/5151 --ref master \
     -f sha=<merge SHA> -f confirmation=PREDEPLOY-PRODUCTION -f release_mode=manual_owner
   ```
   現在會同時備份 SQLite 與 **PG**（缺 PG dump 會 fail），並輸出 `pg_backup_sha256`。
4. ```bash
   gh workflow run deploy-v3.yml --repo Fyun48/5151 --ref master \
     -f sha=<merge SHA> -f image_digest=<digest> \
     -f confirmation=DEPLOY-PRODUCTION -f release_mode=manual_owner
   ```
   先重建 A 群（CasaOS），再重建 B 群（Synology），兩邊同一個 digest。
5. **部署後才取最後差異**：兩個節點都跑新映像之後 SQLite 不應再被寫入；
   重取一次 SQLite 快照 → 重跑 `cutover-backfill.mjs`（新的 `backfill.sql`）→ 套用差額 →
   套用 `conflicts.sql`（4 句，前提是 Owner 對 15 筆的決定不影響它們）。
   ⚠️ **舊的 `backfill.sql`／`conflicts.sql` 是 09-26 快照產生的，切換當天必須重新產生**，
   不能直接套用（PG 已經又長了資料：listings 由 126,734 增至 126,994）。
6. **短驗證**：版本／health／登入／關鍵 A/B 讀寫（A 寫→B 讀→B 改→A 讀）／房源搜尋／
   一輪必要抓取入庫；確認 SQLite 檔的 mtime 不再前進、standby 正常接收。

> 為什麼最後差異放在部署後：watcher 跑在 web 容器內，部署前的舊版本仍會寫 SQLite。
> 先把三個節點換成新版本（寫 PG），再取差額，才不會一邊補一邊漏。

## 五、回復方式

- 程式回版：把三個容器指回 `sha256:a47285c6…`（同一組 compose override 改 digest 即可），
  不需要動資料庫。
- 資料回復：PG 用 predeploy 的 `pg_dump` 還原（隔離還原已實測可讀）；SQLite 舊檔保留未刪。
- 注意：**回復程式不等於回復資料**——舊版本會重新開始寫 SQLite，所以回復後若要再次前進，
  必須重跑一次第四節第 5 步。

## 六、預估影響

- 維護時間：容器重建（三個容器，映像已預先建置），預估 **3～5 分鐘**的滾動重建；
  v3 有 HAProxy 在兩台之間輪詢，A/B 分組重建期間服務不中斷（單邊容量）。
- 資料風險：補遷只做 INSERT … ON CONFLICT DO NOTHING，不覆寫；衝突處置只動 3 筆；
  沒有任何 DROP／DELETE／DDL。

## 七、待決事項（需要 Owner 一次決定）

1. **是否核准合併 PR #497 並執行第四節的切換**（這是第七節要求的「明確批准」）。
2. 16 筆衝突的三類選擇（見 `CUTOVER-DATA-DIFF-20260926.md` 第五節）：
   - `user_listing_flags` 8 筆 → 建議 (c) 先看兩邊狀態再定
   - `settings` 3 筆 ＋ `user_settings` 3 筆 → 建議 (c) 逐筆看文字差異
   - `listing_group_members` 2 筆 → 建議先看兩個群組在 SQLite 的完整成員
   若希望簡化，可全部選 (a)「保留 PG」，我可以直接照做。
3. `PG_SQLITE_FALLBACK` 是否要在正式站設為 `strict`（讀取也不回退）。
   建議**先不設**，等上線穩定後再切，避免 PG 的短暫錯誤直接變成使用者可見的失敗。
