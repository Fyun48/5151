# 交接：三節點本機資料對齊 ＋ 公開入口 HA（2026-09-24）

## 0. 一句話

公開站現在**入口與應用層都有冗餘**（tunnel 兩個 connector ＋ HAProxy 兩台 ＋ web 兩台），
但**「搜尋設定」等 SQLite 孤島還沒移植到 PG** —— 這是今晚「列表全空」的主因，也是 web 層 HA 的最後一塊。

## 1. 今晚（2026-09-23 深夜–09-24）發生什麼

### 1.1 現象
使用者在網頁上看到「0 全部／0 未瀏覽／0 已瀏覽、完全沒有物件」，且「設定檔不見、重建也留不住」。

### 1.2 診斷（逐項都有硬證據，資料沒有遺失）
- PG 完整：`listings=115,721`、`users=27`（id 1 = 使用者）、`user_listing_flags`（user 1 = 606）、
  `user_events`（user 1 = 4,406）、`user_search_profiles`（user 1 兩個，內容長度與 SQLite 相同）。
- `/api/public/listings` 200 且回得出真實物件（store 讀取正常）。
- **真因**：公開流量在 HAProxy 上**輪流到 web-A／web-B**，而 `v3/src/searchProfiles.js`（搜尋設定檔）
  **是純 SQLite、沒有 driver-aware 版本** → 兩台 web 各讀**自己的**本機 SQLite：
  - 正式站容器：`user_search_profiles` 3 筆（user 1 active，**今天 09:59 還更新過**）、settings 26 鍵
  - web-A：只有一筆 `id=live`（預設值）、settings 8 鍵 ← **輪到它回答時就是「資料全空」**
  - web-B：同理，各一份
  → 使用者的設定「看哪一台回答」而變，用空設定篩選 → 畫面 0 筆。

### 1.3 追查結論（2026-09-24 修正我先前的判斷）

- 我先前說「我的發版把 2.4 推上正式站造成 provider 短路」是**錯的**：正式站 SQLite 的
  `provider_usage_logs` 早就有 **6 萬筆 `fallback` 紀錄（到 2026-09-23 10:40）**，
  而且 SQLite 與 PG 的 `system_provider_configs` **完全相同**（全部 `is_enabled=0`、
  `credential_ref=null`、`provider_secrets` 0 筆）→ **2.4 的閘門在我的發版前就已經在跑**，
  沒有付費 provider 時一律走 `fallback()`（＝原本的直連路徑），所以**不是回歸**。
- 真正該修的是**診斷寫入**：`fallback: disabled_or_no_credential` 每次呼叫都寫一列（爬蟲每個抓取
  一次），在 PG 模式 ＋ 寫入 fail-closed（#473）之下，那一列寫失敗會讓**整個 provider 呼叫
  （含直連 fallback）** 一起失敗 → 已修（**PR #477**：同一 (category, note) 每行程只記一次，
  且任何錯誤都吞掉）。證據：`v3/test/provider-fallback-logging.test.js` 2/2。
- 爬蟲「重新確認」量能偏低（6 小時每 10 分鐘約 1 筆）是**更早以前就存在**的現象（與發版無關），
  仍待查（疑 591 端）。

### 1.5 發版前的一次性資料同步（2026-09-24）

`user_settings`／`user_search_profiles` 在發版前的最後一次變更（使用者 09-23 09:59 的儲存）只落在
SQLite，PG 還是 09-22 的舊值 → 已把這兩張表從正式站 SQLite **upsert 進 PG**（186 列 ＋ 3 個設定檔，
實查 PG 的 active 設定檔 `updated_at` 已是 `2026-09-23T09:59:15Z`）。
腳本：`/tmp/dump-member-island.mjs` ＋ `/tmp/sync-member-island.mjs`（一次性，可重跑）。

- 我當下先把正式站**回滾**（`v3/src`＋`v3/public` → `9e79b23b`；web-A／web-B → image `43bd376c…`；
  新版原始碼備份在 casa `/tmp/v3-src-new-*.tgz`）——那是**預防性**處置：事後查證發現 2.4 的閘門
  在回滾前就已經在跑，且行為與 2.4 之前相同（沒有付費 provider 時走直連），沒有造成短路。
- **重新發版的順序**（2026-09-24 進行中）：①修掉診斷寫入的影響（PR #477）
  ②把會員設定島嶼的最後一次變更同步進 PG（§1.5）③走 build／predeploy／deploy
  （會同時帶上 #473 fail-closed、#476 設定島嶼、2.4 provider／budget）。

### 1.4 處置（使用者選的方案：不動入口，讓三台一致）
1. 對正式站做 SQLite **熱快照**（`VACUUM INTO`，`integrity=ok`，455MB）＋ `member-media`／`self-photos`
   ＋ `auth.env`，換進 web-A（`/opt/5151-shadow/web-a/data`）與 web-B（`~/5151-shadow/web-b/data`），
   各自先備份原資料（`/tmp/data-before-align-*.tgz`）。三台現在 `profiles=3`、`settings=26` 一致。
2. **停用 `5151-crawler`**：它與 web-A **共用同一份 SQLite**（換檔時它握著鎖 → web-A `database is locked`
   起不來），且與正式站容器自身的爬蟲重複（同 `5151-worker` 的模式）。
3. 可重跑的工具與說明：`/home/cline/scripts/5151-align/README.md`
   （`make-snapshot.sh`、`align-node.sh`、`cmp-sqlite-profiles.mjs`）。
4. ⚠️ **寫入仍會分歧**：線上「儲存設定」或上傳媒體只會落在回應你的那一台。
   重跑對齊可治標；**治本是移植 SQLite 孤島到 PG**（見 §3）。

## 2. 公開入口 HA（完成，2026-09-24）

- 釐清兩條**不同** tunnel（名稱很像，容易誤判）：
  | tunnel | id | 成員 | 用途 |
  |---|---|---|---|
  | **`5151`** | `3adb90bf-…fca01` | `591-tracker-tunnel`（casa）、**`591-tracker-tunnel-b`（syn，新增）** | **公開站**（ingress `jibbyrenth → 127.0.0.1:25153`） |
  | `5151-shadow-web` | `4c70b226-…c9fb` | `5151-cloudflared-A`（casa）、`5151-cloudflared-B`（syn） | shadow 測試 hostname（ingress → `192.168.0.140:25153`） |
- 新增：Synology 的 `~/5151-shadow/haproxy/`（container `5151-haproxy-B`，25153 回 200）＋
  `~/5151-shadow/cloudflared-public/`（container `591-tracker-tunnel-b`，加入公開 tunnel）。
  正本 compose：`deploy/shadow-ha/haproxy/docker-compose.synology.yml`、
  `deploy/shadow-ha/cloudflared/docker-compose.public-b.yml`。
- **演練（實測）**：停掉 CasaOS 的 `591-tracker-tunnel` 約 30 秒 → 公開站 **32/32 次全部 200**
  （Synology 的 connector ＋ `5151-haproxy-B` 接手）；恢復後 tunnel 連線數 4→8（＝2 個實例）。
  步驟寫在 `deploy/shadow-ha/cloudflared/README.md`。
- 環境事實：`connectors=N` 其實是「連線數」，**每個 cloudflared 實例固定 4 條**，所以 8＝2 個實例。

## 3. 待辦（照序）

1. ~~**把 SQLite 孤島移植到 PG**（web 層 HA 的最後一塊）：`searchProfiles.js`（搜尋設定檔）~~
   → **已完成（2026-09-24，PR #476）**：新增 `v3/src/settingsAsync.js` ＋
   `v3/src/repository/memberSettings.js`，`getSettings／saveSettings／saveAsProfile／loadProfile／
   deleteProfile／armMemberExternalFetch` 全部 driver-aware，`/api/settings`（GET／POST）與
   `/api/profiles*` 改走 async 版；純判斷仍在 `settingsState.js`／`db.js`（兩個 driver 共用）。
   證據：`v3/test/settings-driver-parity.test.js` 離線 4/4 ＋ live 1/1（PG 寫入後讀回）。
   **媒體（member-media／self-photos）仍需要共享儲存**——那是 web 層 HA 剩下的最後一項。
2. **`5151-crawler` 與 `5151-worker` 已停用**；若日後要恢復，先確認它們不會再寫各節點自己的 SQLite。
2. ~~**2.4（provider／budget）修好 PG provider 設定後再重發**（見 §1.3）~~
   → **誤判已釐清，不需要動 provider 設定**（SQLite 與 PG 一致、都是未啟用）；
   真正要修的是診斷寫入（PR #477）→ 已隨發版上線（見 §4）。
   ⚠️ **要啟用付費 provider 之前**：三台必須設**同一組** `V3_PROVIDER_SECRET`
   （`budgetGuard.js` 的 `activeSecret()` 依序取 `V3_PROVIDER_SECRET` → `AUTH_PASSWORD` →
   `"v3-local-provider-secret"`），否則在某一台加密的憑證到別台解不開 → 該 category 一律走 fallback。
3. ~~爬蟲「重新確認」量能長期偏低（過去 6 小時每 10 分鐘約 1 筆；24 小時內只確認 91 筆，
   但近 3 天新增 8,364 筆）→ 查 591 是否在擋。~~
   → **2026-09-24 更正**：那是**誤用 `listings.last_seen_at` 當健康指標**（程式自己在
   `adminOverview.js` 註明它「只代表曾經寫入底庫，不是現在健康」）。實際的節奏與通知規則已由
   Owner 口述並逐條核對程式，記在 **`docs/architecture/crawl-and-notify-rules.md`**：
   系統依後台設定（生產站 **20 分**）抓取並形成「基地」，會員 **8 分**（贊助 **5 分**）補抓，
   基地剛跑完的 **90 秒**內會員不重複抓（`RECENT_COVERING_MS`）。
   **要判斷健康請看後台 IA／底庫頁的「最近一輪結果」**，不要看 `last_seen_at`。
4. `listings` 有 1 列 `last_checked_at` 內容壞掉（`post_id=2414061000`）。
5. `5155`（正式站容器的本機別名埠）仍只被 deploy 的健康檢查使用；要收回需同時改 workflow 與
   compose override（會重啟正式站），併入下一次發版。
6. **VS Code dev tunnel（`cline-server`）的 1006**：dev box（cline-dev）上 `/tmp/vscode-tunnel.log`
   顯示 `NoAttachedServerError` 多次、且同時存在兩個 server 版本（`Stable-7debcd0e…` 與
   `Stable-2242ebbb…`）。重啟 tunnel 會中斷目前連線，需使用者同意後再做。

## 4. 發版（2026-09-24 02:0x UTC）：#473 ＋ #476 ＋ 2.4 ＋ #477

- **內容**：#473（寫入 fail-closed）、#476（會員設定島嶼 → PG）、2.4（provider／budget）、
  #477（診斷用量紀錄去噪 ＋ 吞錯）。
- **流程**：build（`manual_owner`，digest `sha256:b64f85eca735b1c3ea4b2cdfd1484e89cd667996abb9f2550839aa79a9d3cce7`）
  → predeploy check → deploy（`sha=4660f2cd46c07f2632a4cf87256d3f3103622ee9`、
  `confirmation=DEPLOY-PRODUCTION`）→ 三個容器 revision 皆 = `4660f2cd…`
  （`591-tracker-v3`、`5151-web-A`、`5151-web-B`）。
- **驗收證據（本次實查）**：
  - 公開站 **`https://jibbyrenth.reversalplay.me/`** → **200**。入口 tunnel `5151` 為 `healthy`、
    8 條連線（＝2 個 connector 實例各 4 條）。兩條 connector 皆在跑（`591-tracker-tunnel`／
    `591-tracker-tunnel-b`）。
    ⚠️ **`5151.clinehelptw.dpdns.org` 不是本站網址**（對外 DNS 沒有這個委派、tunnel ingress 也沒有），
    不要再拿它當公開站測試（本次一度誤判為停機）。
  - 三台的 `/app/src/providers/executeWithProvider.js` md5 都是 `ad47e491e2`（＝合併後的本機檔）。
  - **#477 生效**：發版後 `provider_usage_logs` 只新增 **2 筆**（修正前約 14 筆/分鐘、3 天 6 萬筆）。
  - **#476 生效（端到端，唯讀）**：在正式站容器內以已部署的程式碼呼叫 `getSettingsAsync(1)`
    （容器 `DB_DRIVER=postgres`）得到 73 個鍵、`settingProfiles` 2 個、
    `activeProfileId=p-1789370842700`、`watchDistricts` 7、`intervalMinutes` 3 → 與 PG 直查一致
    ⇒ **公開站在 web-A／web-B 之間輪流時不會再出現空設定**。
  - 發版前已把 `user_settings`（186 列）／`user_search_profiles`（3 筆）從正式站 SQLite upsert 進 PG
    （§1.5）；PG 現在是 `user_settings=229`／`profiles=4`（含 PG 原有的列）。

## 5. 媒體共享儲存上線（2026-09-24，web 層 HA 的最後一項）

- **架構**：Synology 共用資料夾 `/volume1/5151-media`（NFS export 給 `192.168.0.140`，
  Squash＝所有使用者→admin、安全性 sys）→ casa 掛 `/mnt/5151-media`
  （fstab：`nfs nfsvers=3,soft,timeo=50,retrans=2,_netdev,nofail`）
  → 正式站與 `5151-web-A` 各 bind 兩個子目錄到 `/data/{member-media,self-photos}`；
  `5151-web-B` 同機直接 bind `/volume1/5151-media/...`。**程式完全沒改**
  （路徑本來就是 `DATA_DIR/member-media`、`DATA_DIR/self-photos`）。
- **三份 compose 已改**：repo 根 `docker-compose.yml`、`deploy/shadow-ha/web/web-a|web-b/docker-compose.yml`；
  主機端同步套用並保留 `.bak-20260924` 備份。
  ⚠️ 正式站 compose 由發版流程 SCP 覆蓋 → **改動必須落在 repo 版**，只改 NAS 會被下次發版蓋掉。
- **掛載守護**：`deploy/shadow-ha/media-share/mount-guard.sh` ＋ systemd timer（casa，每 2 分鐘）。
  原因：Docker 的 bind mount 在掛載變動後仍指向舊目錄 —— NFS 斷線又重掛時，容器會繼續寫本機空目錄
  （靜默分歧）。守護程式會「救出本機檔案 → 重掛 → 搬回共享 → 重建容器」。
- **驗收（實查）**：casa NFS 掛載＋寫入 OK；三個容器各看到 11 個媒體檔；
  **用 App 的 `saveSelfPhoto` 在 web-A 寫入 → web-B 讀到 `found:true`**
  （共享目錄檔案擁有者 `admin`，符合 Squash 規則）；`listMemberMediaFor(1)` 三台一致
  （`media_count=3`、`tag_count=2`）＝ 媒體**資料表**本就走 PG，不是孤島；
  另做一次「卸載 NFS → 守護程式自動復原 → 容器重建 → 公開站仍 200」的演練。
- **回退**：刪掉三份 compose 的那兩行 → 重建容器（各節點原本的本機檔案都還在）；
  casa `umount /mnt/5151-media` ＋ 刪 fstab 該行 ＋ 停用 timer。

## 6. 會員媒體改走 Cloudflare R2 CDN（2026-09-24 上線，PR #480）

- **動機**：媒體原本只存在自家（今日稍早集中到 Synology，反而讓它變成單點）。改由 R2 ＋ CDN 直送瀏覽器，
  位元組不經過 NAS，媒體也不再依賴任何一台機器。
- **程式**：`v3/src/media/r2Client.js`（零依賴 SigV4，PUT／HEAD／DELETE）、
  `v3/src/media/mediaStore.js`（儲存策略）、`memberMedia.js`（交易內上傳、302 導向、刪除／重算時清快取）。
  開關 `MEDIA_SERVE=local|r2`（**預設 local**）。
- **隱私界線**：只有公開顯示檔（`<hash>.jpg`、`<hash>_t.jpg`）進 R2；`_o.jpg`（未浮水印原圖）與
  `self-photos`（身分自拍）**永不外流**。外部平台（591）的物件圖**維持外連、不快取**（不重製他人內容）。
- **設定位置（易踩雷）**：`deploy-v3.yml` 每次發版會用 `printf … > .env` 覆寫 web 節點的 `.env`
  → **web-A／web-B 寫在主機 compose 的 `environment:`、正式站寫在 `/mnt/Storage1/apps/5151/.env`**。
  三節點皆已設定，備份為 `*.bak-20260924-r2`。
- **上線**：發版 `d50dbcc`（image digest `sha256:43b188ed…`）；既有 6 個公開顯示檔已遷移（`_o.jpg` 略過）。
- **驗收（實查）**：三容器 `/media/lib/<hash>.jpg` → **302** 到 `media.reversalplay.me`；
  `_o.jpg` → **404**；R2 上 self-photos 與 `_o.jpg` 皆**不存在**、公開檔**存在**；CDN `MISS→HIT`；公開站 200。
- **回退**：把 `MEDIA_SERVE` 改回 `local` ＋ 重建容器（本機檔案一直都在，圖片不會掉）。
