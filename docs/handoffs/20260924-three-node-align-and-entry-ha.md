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
4. ~~`listings` 有 1 列 `last_checked_at` 內容壞掉（`post_id=2414061000`）。~~
   → **2026-09-24 已修**：該值原本是亂碼位元組；已設回同列的 `last_seen_at`（程式的寫入語意就是這個），
   全庫格式異常筆數 **0**。查證時確認全庫只有這 1 筆。
5. ~~`5155`（正式站容器的本機別名埠）仍只被 deploy 的健康檢查使用；要收回需同時改 workflow 與
   compose override（會重啟正式站），併入下一次發版。~~
   → **2026-09-24 已收回**：`docker-compose.yml` 不再發佈第二個埠；`deploy-v3.yml` 的本機健康探測改用
   `5153`（原本那三行只是對 5155 重做同樣的檢查，已刪除）。公開流量本來就走 HAProxy 25153，未受影響。
6. ~~**VS Code dev tunnel（`cline-server`）的 1006**~~ → **2026-09-24 使用者確認已正常**。
   根因是「新舊 CLI 版本並存造成下載鎖死鎖」（log 一直印 `Another instance is still downloading the server`），
   清掉 `~/.vscode-server/cli/servers/.locks/*` 後以同版 CLI 重啟即恢復。
   同日稍晚又斷一次（`vscode-tunnel tunnel status` 回 `{"tunnel":null}`、主機上完全沒有 tunnel 行程）：
   根因是前一次重啟用的 `/tmp/restart-tunnel.sh` 直接呼叫 CLI、**沒帶 `VSCODE_CLI_DATA_DIR`**，
   CLI 改去預設目錄 `~/.vscode/cli` 找憑證 → 卡在 GitHub device login（同時兩個實例並存造成下載死鎖）。
   已於 **2026-09-24 修復並恢復上線**（`"tunnel":"Connected"`、`last_fail_reason: null`）。
   **完整手冊（PATH 1 Cloudflare SSH／PATH 2 Dev Tunnel、用戶端設定、持久化缺口與選項）：
   [`docs/runbooks/cline-server-remote-access.md`](../runbooks/cline-server-remote-access.md)。**
7. **後台可自行開關付費外掛** → **2026-09-24 已完成**：新增後台頁「系統與整合 > 外掛與預算」
   （`v3/public/admin-providers.js`、`admin.html` 面板、`admin-ia.js` 索引），可逐類別啟用／關閉、
   設定每日／每月／單筆上限、填金鑰（加密存放）、測試連線、刪金鑰，並有全站預算與用量紀錄。
   測試 `v3/test/admin-providers.test.js` 6/6；UI 以真實後台版面截圖驗證（0 console error）。
8. **前台重整預設分頁** → **2026-09-24 已修**：原本切到許願房會把 `#demand` 寫進網址且回到找房不清掉，
   導致之後每次重整都被帶回許願房；現在只有明確帶 `#demand`／`#wish` 的網址才會停在許願房。
6. ~~**VS Code dev tunnel（`cline-server`）的 1006**：dev box（cline-dev）上 `/tmp/vscode-tunnel.log`
   顯示 `NoAttachedServerError` 多次、且同時存在兩個 server 版本（`Stable-7debcd0e…` 與
   `Stable-2242ebbb…`）。重啟 tunnel 會中斷目前連線，需使用者同意後再做。~~
   → **2026-09-24 已修並上線**（根因有兩個：沒帶 `VSCODE_CLI_DATA_DIR` 導致憑證找不到 →
   卡在 device login；以及兩個 tunnel 實例並存造成 `downloading the server` 死鎖）。
   **剩下唯一未完成項是「持久化」**：容器沒有 systemd／dbus，官方 `code tunnel service install`
   實測失敗（`Error creating dbus session…`），要撐過容器重啟只能改容器啟動流程（P1）或用 DSM
   工作排程器（P2）——兩者都需要 Owner 決定。連線手冊（含用戶端步驟與選項）見
   [`docs/runbooks/cline-server-remote-access.md`](../runbooks/cline-server-remote-access.md)。

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

## 7. 發版（2026-09-24，PR #483）：後台外掛頁＋分頁預設＋收回 5155＋修壞資料

**Release identity**

- source SHA：`ebf695b6224ff35b82339c03ed42b393ecfa071f`（PR #483 squash merge）
- image digest：`sha256:21ce5bb46a337bff21f509d0074fd820f788e9e8f13cfc508af993caca558d67`
- predeploy check run `35961287333`（success）；build image run `35961289874`（success）；deploy run `35961651897`（success）
- 正式站容器 revision `ebf695b6224ff35b82339c03ed42b393ecfa071f`；`5151-web-A` revision 同；
  `5151-web-B` 同（**更正 2026-09-24：web-B 的 docker 可用 `tori` 執行**——`tori` 在 `administrators` ＋ `docker` 群組，
  只需 `export PATH=$PATH:/usr/local/bin`；先前「只能 root 進」的說法未經實測，已作廢。實測 revision 同為 `9c6b7b04…`）。

**驗收證據（都是實際輸出，不是推論）**

- 正式站容器埠：`591-tracker-v3|127.0.0.1:5153->5153/tcp` → **5155 已消失**；`http://127.0.0.1:5155/api/health` 回 `000`（連不上）。
- 公開站 `https://jibbyrenth.reversalplay.me/` 200；`index.html` 已是新版（新註解出現 1 次、舊的 `location.search}#demand` 出現 0 次）。
- 公開站 12 次破壞快取取樣：**新版 12／舊版 0** → A、B 兩台節點都已更新（HAProxy 不會打到舊版）。
- 線上容器內檔案與本機逐檔 **sha256 相同**：`admin-providers.js 5e2631c4…`、`admin-ia.js cadbafd2…`、
  `admin.html 293733dc…`、`index.html 41a6f374…`。
- API 未登入時 `GET /api/admin/providers`、`GET /api/admin/providers/usage`、`PUT /api/admin/providers` 皆 **401**
  （路由存在且受保護，不是 500）。
- R2 CDN 仍在服役：`/media/lib/<key>` → 302 → `media.reversalplay.me/…` → 200 `cf-cache-status: HIT`。
- 壞資料：`listings` 格式異常的 `last_checked_at` 由 **1 → 0** 筆。

**新增的後台頁面（系統與整合 > 外掛與預算，`#system/providers`）**

- 逐類別：啟用／關閉、供應商代碼、每日／每月／單筆上限（TWD）、金鑰（加密存放，留白＝不變更）、
  「測試連線」、「刪除金鑰」；另有全站每日／每月預算與最近 50 筆用量。
- 今日額度用盡（`fuse=tripped`）或達 8 成（`warn`）會顯示警示；頁面明講「未啟用走免費路徑、不會花費」「0＝不花錢」。
- **刻意不改 provider 的執行邏輯、也不自動啟用任何付費供應商** → 上線後仍是四類全關、`provider_secrets` 0 筆、無付費。
- 之後若要啟用付費供應商：**三台節點必須同一組 `V3_PROVIDER_SECRET`**，否則跨節點解不開金鑰（頁面已寫明）。
- 測試：`v3/test/admin-providers.test.js`（6 個，含 TWD payload、清除金鑰、額度警示、金鑰狀態文案、
  空用量提示）；`test/v3-compose.test.js` 與 `v3/test/deploy-v3-workflow.test.js` 同步更新 5155 的期望。

**⚠️ 仍待 Owner 本人確認（我沒有管理員密碼，無法代登入看畫面）**
- 開 `https://jibbyrenth.reversalplay.me/admin.html#system/providers`，確認五個類別卡與「最近用量」符合預期。

### 7.1 修正發版（同日，PR #485）

上線後從驗收截圖發現：**「地圖距離」的單筆上限 `0.2` 在欄位裡顯示成 `0`**（`moneyInput()` 用了 `Math.round`），
管理員只要按「儲存這一類」就會把 `ceiling_minor` 靜默改成 0。

- 修法：`moneyInput` 保留兩位小數（整數欄位仍輸出 `20`）；新增測試（修之前會失敗，`distance_matrix` 的
  ceiling 欄位必須是 `value="0.2"`）。
- 第二次發版：source `bd7f22ccb57d1cb12af44934403bcef6f8ca7c7e`、
  digest `sha256:083074966747a0d3ee0ef6ad31f6c18ef6f9065416967aef92e2cd5e784f7e28`；
  predeploy `35963293450`、build `35963295768`、deploy `35963668959`（皆 success）。
- 驗收：`591-tracker-v3` 與 `5151-web-A` revision 皆 `bd7f22cc…`；容器內 `admin-providers.js`
  sha256 `84e88c4a…` 與本機相同；公開站 12/12 新版；正式站埠仍只有 `127.0.0.1:5153->5153/tcp`。
- 真實瀏覽器複驗（Chrome，清掉 SW／CacheStorage 後）：`distance_matrix` 的單筆上限欄位 = `0.2`。
  先前看到 `0` 是本機快取造成的（線上 `sw.js` 的 fetch 策略是 **network-first**，使用者連線時會拿到新檔）。

- 前台：進「許願房」後回「找房」再重整，應停在**找房**（不是許願房）。
- 想確認爬蟲健康：看「房源與資料 > 抓取範圍與排程」的「最近一輪結果」（**不要**看 `last_seen_at` 當健康指標）。


## 8. 發版（2026-09-24，PR #487）：已下架縮排、特別關注下架子檢視、Discord 訊息配色

**Release identity**

- source SHA：`eec0111f81f1b0a9c55cef0110e203eff39b3450`（PR #487 squash merge）
- image digest：`sha256:8b9e50dc15e96ab88afff55b94372f01aa32f7d15ade6b2b55dc27885521824c`
- predeploy check run `35967428379`（success）；build image run `35967431370`（success）；deploy run `35967608157`

**Owner 的 9 點需求與處理**

1. **已確定下架的物件縮小版面**：拿掉封面圖、標題限一行、規格與地址各一行、費用／捷運／關注備註收起來。
   原本只靠 `opacity: 0.78` 淡化，版面完全沒變；現在改用「降低排版密度」表達結束（不再壓低透明度，
   避免對比低於 4.5:1）。實測確認下架卡 220px vs 一般卡 332px。同房源合併的下架中卡片也先把
   費差／規格兩行收掉，避免被撐高。
2. **特別關注可切換下架狀態**：點「特別關注」後多一列「全部／確認下架中／已確定下架」子按鈕，
   可以只看正在確認下架、或已確定下架的物件（後者原本混在清單裡、也不佔配額名額）。
   子檢視只裁畫面不動 `listCache`，已確定下架排最後，三個子檢視各有自己的空狀態說明。
3. **特別關注可整批退出**：批次列新增「取消關注已選」（只在特別關注清單出現），搭配既有
   「全選本頁」，部分失敗會說「已取消關注 N／M 筆」。用的是既有的 `POST /api/listings/:id/flags`
   與 `{ watched: false }`（與卡片上的「取消關注」完全相同）。
4. **同房源不重複說明**：同一房源的多則事件（例：重刊＋費用變更＋標題更新）原本每則都貼同一段
   規格／位置；現在一組同房源只留「最便宜」（租金＋額外月費）與「最新更新」兩則的完整說明欄。
5. **費用變更＝紫色** `0xa855f7`，且 detail 已寫出變更內容，就不再重貼整份費用清單。
6. **全新物件＝金黃** `0xfbbf24`（原本淺藍）。
7. **確認下架中＝紅** `0xef4444`（原本灰）；「確認已下架」維持深紅 `0xdc2626`，紅色家族＝下架。
8. 同 4（同房源只呈現最便宜與最新更新的說明欄）。
9. **搜尋設定的統計框「疑似」→「疑似同源」**（側欄統計）。

> Discord 的 embed 顏色是整則訊息的左側色條（Discord API 不支援訊息內單行彩色文字，
> 除非用 ANSI code block）。所以第 5～7 點是改「這則訊息屬於哪一類事件」的顏色。
> 若 Owner 要的是**逐行**彩色文字，需要用 ```ansi 區塊，可以再另外做。

**測試**

- `v3/test/webhook-notify.test.js` 26/26（色票斷言更新＋同房源收斂、說明欄兩個新測試）。
- `v3/test/index-script.test.js` 48/48（子檢視／批次取消／低密度卡片／「疑似同源」三組新斷言）。
- 以真實版面（本機假後端、三筆假物件：進行中／確認下架中／已確定下架）瀏覽器驗證：
  子檢視各只顯示對應卡片、已確定下架卡明顯變矮、統計標籤正確、0 console error。
- 過程中修掉兩個自己寫錯的地方：`moneyInput` 把單筆上限 0.2 取整成 0（前一次發版）、
  以及本次的排序比較子寫反（已確定下架跑到最前面）。兩者都是靠實際畫面驗證抓到的。

**驗收證據（實際輸出）**

- deploy run `35967608157` **completed success**。
- 線上 v3 image：`ghcr.io/fyun48/5151@sha256:8b9e50dc15e96ab88afff55b94372f01aa32f7d15ade6b2b55dc27885521824c`
  （就是這次建的 digest）。
- 正式站容器埠：`127.0.0.1:5153->5153/tcp`（沒有 5155；上一版的收回維持住）。
- 線上容器內檔案與本機 **sha256 相同**：`index.html 8ce5008d…`、`notify.js d3bcd098…`
  （代表前台與 Discord 訊息程式都是這一版）。
- 公開站 `https://jibbyrenth.reversalplay.me/` 200；**12 次破壞快取取樣 12／12 都含
  `data-watch-view="confirmed"`**（A、B 兩台節點都已更新）。
- 瀏覽器（本機假後端、三筆假物件）驗證：子檢視各只顯示對應卡片、已確定下架卡 220px vs 一般卡 332px、
  統計標籤「疑似同源」、0 console error。

**仍待 Owner 看畫面**

- 前台特別關注：點「特別關注」後應出現「全部／確認下架中／已確定下架」，勾選後「取消關注已選」可整批退出。
- 已確定下架的卡片應明顯比其他卡片矮（沒有照片、單行標題）。
- Discord：費用變更＝紫色、全新物件＝金黃、確認下架中＝紅色；同房源不會重複貼同一段說明。

## 9. 追加修正（2026-09-24，PR #490）：子檢視預設只看還在的、批次按鈕搬進浮動列、下架用詞統一

Owner 看完 §8 的畫面後提出的兩點修正。

### 9.1 特別關注的子檢視

- **子按鈕只在點「特別關注」後出現**：原本 `#watchViewRow` 雖有 `hidden`，但 `.chip-row` 是
  `display: flex`（作者樣式優先於 UA 的 `[hidden]`）→ 子按鈕在「全部」也一直顯示。
  修法：`#watchViewRow[hidden] { display: none; }`。
- **預設（子按鈕都不選）只顯示還在刊登的物件**（`watchView = ""` → `matchesWatchView()` 回
  `!offline && !confirmed`）。移除「全部」子按鈕；再點同一個＝取消選取回預設；兩個子按鈕互斥。
- **用詞統一**：`確認下架中` → **物件暫離**、`確認已下架`／`已確定下架` → **已下架**。套用到
  卡片狀態標籤、`listingStatusLabel`、`offlineLine`、篩選空狀態、通知與 Discord 的事件名稱
  （`notify.js` 的 `eventLabel`）、`listingCompare.js`、Q&A（`helpQa.js`）。
  **後台設定「確認已下架天數」不動**（那是機制名稱，不是列表狀態）。

### 9.2 批次按鈕搬進浮動列

- 症狀：勾選物件後畫面會往下捲，列表上方的批次列（`#bulkBar`）就搆不到。
- 修法：把「已選 N 筆／全選本頁／取消勾選／比較（N／3）／不再顯示已選／取消關注已選／取消／
  併入同房源」全部搬進既有的浮動列 `#mergeDock`（`position: fixed`，捲到哪裡都在）。
  移除 `#bulkBar` 元素；`paintMergeDock()` 改成「勾了任何一筆就顯示」；
  「取消」（離開合併選取模式）只在該模式出現，避免與「取消勾選」重複。
- 手機（≤767px）：單列橫滑 ＋ `white-space: nowrap`，實測高度 **104px**（換行版是 326px）；
  比較提示在手機收進「比較」按鈕的 `title`，桌面仍顯示。

### 9.3 驗證

- 針對性測試 **101/101**（`index-script`／`webhook-notify`／`help-qa`／`offline-report`／
  `area-offline`／`system-crawl`）；新增 2 個測試（子檢視預設只看還在的、批次按鈕必須在浮動列）。
- 瀏覽器實測（本機假後端，3 筆假物件：進行中／物件暫離／已下架）：
  `全部` → 子列 `display:none`；`特別關注` → 子列出現且只顯示進行中那筆；`物件暫離` → 只有暫離那筆；
  再點一次 → 回預設；`已下架` → 只有已下架那筆（低密度卡）；勾選 → 浮動列出現並含全部批次按鈕。
- 375／768／1280：浮動列在捲到底時仍完整可見（desktop 在 `scrollY=2743` 時 top 634、bottom 728）、
  按鈕皆 ≥44px、無橫向破版。
- `activate-rental-marketplace-pra-workflow.test.js` 的 src manifest 測試在**工作區未提交**時會失敗
  （它比對工作區 `v3/src` 與 git HEAD），提交後即通過。



### 9.4 發版（PR #490）

**Release identity**

- source SHA：`d8fbf88ce357c576ed86bce14ed0a5ed223bcc61`（PR #490 squash merge）
- image digest：`sha256:e00a272324f69ab7dec2eed35d18884ba52a37f8997c82c3a560596e96719b56`
- predeploy run `35977876097`（success）；build image run `35977878808`（success）；
  deploy run `35978536748`（success）；master Tests run `35977738852`（success）；PR Tests run `35977375414`（success）

**驗收證據（實際輸出）**

- `591-tracker-v3` 與 `5151-web-A` 的 `org.opencontainers.image.revision` 都是 `d8fbf88c…`。
- 容器內檔案與本機 **sha256 相同**（兩台都一樣）：
  `/app/public/index.html` = `1d830bb009bb7c5ed0b87b8100f6e3541e170a25c588def36e5ce784d77a4b60`、
  `/app/src/notify.js` = `b2e0bb88ad2e19661889d585d3c2bd895cd7780a6ce5609d9239a3961c50a5c9`。
- 正式站埠仍只有 `127.0.0.1:5153->5153/tcp`；舊的 `5155` 對外埠筆數 = **0**。
- 公開站 `https://jibbyrenth.reversalplay.me/` **200**；破壞快取取樣：**8/8 含「物件暫離」**、
  **4/4 含 `dock-count`**、`id="bulkBar"` 出現 **0** 次 → A、B 兩台節點都已更新。
- 本機完整測試 1614 pass／1 fail，唯一失敗是「2000 列路線快取需在 1.5s 內」的效能時序測試
  （本機同時跑瀏覽器驗證造成；與本次前端／文案改動無關，CI 的完整套件已 pass）。

## 10. 事故：爬蟲每一輪都中止、通知停擺（2026-09-24，PR #492 ＋ #493）

Owner 問「目前爬蟲是否有正常在工作」後查出的 Production 事故。成因是兩個（後來三個）PG 移植缺口。

### 10.1 症狀（實查數字，全部來自 PG）

- `crawl_covers.last_run_at` 38 筆全部 NULL（沒有任何一輪跑完）；`lastSystemCoveringAt` 凍結在 `2026-09-22T05:35:11Z`。
- 每小時只檢查 10–24 筆物件（正常約 670）；**09-23 整日只有 50 筆**（09-22 是 16,095）。
- 09-23 的 `user_events` 共 **0 筆**（＝不會有任何通知）；新發現物件 36/日（正常 1,800–6,000）。
- 啟動日誌：`第一次檢查失敗： duplicate key value violates unique constraint "data_revision_pkey"`。

### 10.2 根因

1. **`data_revision` 的 identity 序號落後**：表內 `max(id)=685,489`、序號 `last_value=305`。PG 的 store 是
   「帶 id 匯入」的，PostgreSQL 不會因為帶 id 的 INSERT 推進 `GENERATED BY DEFAULT AS IDENTITY` 序號
   → 每一次 `bumpRevision()` 都撞 `data_revision_pkey`。`pgSchema.js` 早就有 `identityResyncSql()`／
   `resyncIdentitySequences()`，但只有 budget／enrich 等 repo 接上，change-log 這張表沒有。
2. **PG 路徑的變更紀錄沒有防護**：`persistListing()` 是 `await writer.bumpRevision(...)`
   （SQLite 路徑 `upsertListing()` 有 try/catch）→ 一次序號碰撞就把整輪抓取打斷；
   而 `schedule()` 又把錯誤 `.catch(() => {})` 吞掉，所以日誌完全安靜。
3. **整輪完成的紀錄只寫 SQLite**：`crawlCovers.touchCrawlCoversRun(db)` 與
   `writeSettingKey("lastCoveringAt"／"lastSystemCoveringAt")` 都只有同步 SQLite 版本，
   但 `isSystemCoveringDue()` 在 PG 模式讀的是 PG 的 settings → 完成時間寫不進去、判定永遠讀到凍結值
   → 每分鐘都判定「該抓了」→ 爬蟲背對背連續全速跑（實測約 570 筆/分鐘）。

### 10.3 修法

- **資料面（Production 已執行，1 條 SQL 的邏輯）**：對所有「序號落後 max(id)」的表執行
  `setval(seq, GREATEST(目前序號, max(id)) + 1, false)`（只上調、不調低）。共 30+ 張表，含
  `data_revision`（305→685490）、`listings.post_id`（1 vs 2,699,975,575）、`users.id`（1 vs 710,003）。
- **PR #492**：`db.js` 新增 `ensureChangeLogStoreOnce()`（`ensurePgSchema` ＋ `resyncIdentitySequences`，
  與 `budgetGuardAsync`／`listingEnrichQueueAsync` 同慣例）；`persistListing()` 的變更紀錄改 best-effort；
  新增 `v3/test/change-log-identity.test.js`（3 個，含「bump 失敗時仍成功」與「校正必須在寫入前」）。
- **PR #493**：新增 `src/coveringBookkeepingAsync.js`（`coveringBookkeepingAsync()`／
  `isSystemCoveringDueAsync()`／`markCoveringCompletedAsync()`，設計同 `settingsAsync.js`／
  `notifyEnqueueAsync.js`）；`server.js` 的 `tick()` 與 `watcher.js` 的整輪結束改用 async 版本；
  `db.js` 新增純讀 `coveringBookkeeping()`；新增 `v3/test/covering-bookkeeping.test.js`（4 個）。

### 10.4 發版與驗收（2026-09-24）

**Release identity**

- source SHA：`71c25944d1a6ff5453eb7ef22867f69befee30db`（PR #493 squash merge，含 PR #492）
- image digest：`sha256:45275e80e615adbc33ffe1810c83ee9549fc8a3c874dc5881b5f692cab2b359c`
- predeploy run `35990892011`（success）；build image run `35990896003`（success）；deploy run `35991348154`（success）
- CI：PR #492 Tests `pass`（2m15s）；PR #493 Tests `pass`

**驗收證據（實際輸出）**

- 容器 revision ＝ `71c25944…`；`restarts=0`；容器內 `coveringBookkeepingAsync.js`／`db.js`／`server.js`／
  `watcher.js`／`index.html` 的 sha256 **與本機完全相同**；正式站埠只有 `127.0.0.1:5153->5153/tcp`。
- 啟動日誌不再出現 `data_revision_pkey`（修正前每次啟動都出現），公開站 `https://jibbyrenth.reversalplay.me/` **200**。
- 修正後即時效果：`data_revision` 10 分鐘 +3,436 筆；近 5 分鐘檢查 971→2,866 筆；
  `user_events` 由 09-23 的 0 筆恢復到每小時 20–42 筆；今日新發現物件回到 2,903 筆。

### 10.5 仍未完成：整輪跑不完 15 分鐘預算

發版後觀察（11:10 起）：`crawl_covers.last_run_at` 與 `lastSystemCoveringAt` **仍然沒有更新**，
代表**沒有任何一輪在 `TICK_BUDGET_MS`（15 分鐘）內跑完**（`withBudget()` 到時會放棄整輪）。因此：

- PR #493 修好了「完成紀錄寫不進 PG」的**程序**，但只要沒有輪次真的跑完，那筆紀錄就不會被寫，
  `isSystemCoveringDue()` 仍會一直回 true → 爬蟲繼續背對背重跑。
- 觀察到的實際樣態：11:10:15 起跑第一輪 → 11:11:03 後完全沒有新物件落地（`checkedPer5Min` = 0）但
  **CPU 46% 在忙** → 直到約 11:22 才恢復；重啟容器亦立即恢復。也就是「一輪跑很久、中途不落地、
  最後被 15 分鐘預算放棄」的循環。
- ⇒ **#493 是必要但不充分**：要真正回到「每 20 分鐘一輪」，還需要下列其中一項。

**候選作法（尚未實作）**

1. 讓完成紀錄**逐組覆蓋就更新**：`crawl_covers` 每列本來就有 `last_run_at`，現在卻是在整輪最後
   一次 `UPDATE` 全部；改成每跑完一組就更新該列，並讓 `isSystemCoveringDue()` 以「上一組覆蓋的
   完成時間」判定，就不會因為單輪過長而永遠處於「該抓了」。
2. 先查清「一輪為何跑超過 15 分鐘」（591 端回應變慢／重試、或覆蓋條件數量 19→38 的變化）。
3. 短期緩解：在 2 完成前不要再放大負載（例如不要縮短全站抓取間隔）。

### 10.6 待辦

1. 清掉 1–2 筆亂碼壞資料（`listings.first_seen_at` 與一筆 `source` 是亂碼）。
2. 稽核其他「只有同步 SQLite 版本」的島嶼（本次已在 tick 路徑修掉 change-log 與 covering 兩處）。
3. 完成 10.5 的修法，讓抓取節奏回到每 20 分鐘一輪。

