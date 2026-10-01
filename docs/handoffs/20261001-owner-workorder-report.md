# Owner 工作單集中回報（2026-10-01）

- **工作單**：`5151_DS_Fixes_20261001.txt`（A1～A5、B1～B2、C1～C3）
- **PR**：<https://github.com/Fyun48/5151/pull/611>
- **分支**：`fix/owner-workorder-20261001`
- **完整 commit SHA**
  - A1／C1／C2：`7701c29…`
  - **實作本體（A2～A5、B1／B2、C3）：`232a6a7479dee78d6960f3825862f10ff278215a`**
  - A3 的完整修法（顯示名稱不再被 `rental_catalog_v2` 旗標擋住）：`0b1585b…`
  - 截圖證據：`67897014a63c822d883c563c804fed21558a4319`
  - **審閱修正 R1～R6：`66d6383…`（這一版四項 CI 全綠）**
  - 以上都是**改程式**的 SHA。本報告與後續文件更新會產生新的 commit，
    所以「PR 目前 head 的 SHA 與它的 CI」一律看
    <https://github.com/Fyun48/5151/pull/611> 的 head 與 checks
    （避免文件裡的自我指涉 SHA 每改一次就要再改一次）。
- **部署狀態**：**未部署**。Production 維持 manual-only，等 Owner 另外明確批准。

---

## 1. 逐項完成狀態

| 項 | 狀態 | 修改重點 | 驗收結果 |
|---|---|---|---|
| **A1** 說明提示文字 | ✅ 完成 | 提示與送出訊息使用工作單指定的原文「請寫一些這屋子的故事與回憶」（**不附加**「（至少 8 個字）」）；8 字規則保留，改由欄位下方的即時字數提示說明。前後端各一份常數（`SELF_BODY_HINT`／`SELF_BODY_HINT_CLIENT`） | 欄位提示與驗證訊息都是指定原文；字數不足時由即時提示顯示「目前 N 個字，至少還要 M 個字」 |
| **A2** 說明範本預設展開 | ✅ 完成 | 範本下拉＋說明輸入區移到「刊登物件」按鈕上方（`#selfBodyBlock`），開表單就看得到；`#selfBody` 仍是唯一內容來源，新增可見的 contenteditable 當輸入介面，所有寫入走 `setSelfBody()`；套用範本前 `confirm` 保護；失敗保留內容 | 桌機／手機截圖（`evidence/owner-workorder-20261001/a2-*`）；`listing-tools-ui` 測試釘住「可編輯、在送出鈕之前、只有一個寫入入口」 |
| **A3** 目錄文字沒同步 | ✅ 完成（含根因，**兩個**） | ① `selfTraits.js` 的 `selfTraitLabels()` 把目錄標籤放在 `\|\|` 後面 ⇒ 就算發布了，卡片與分享頁 chips 仍顯示靜態表。② 更關鍵：標籤對照表被 `rental_catalog_v2` 旗標擋住 ⇒ 旗標沒開時，**連刊登表單都不會跟著目錄改名**。已把「顯示名稱」與「可寫入的 id」分開：`catalogTraitLabelMap()` 不受旗標影響、`overlayTraitLabels()` 只覆蓋 label 不動結構。後台另把「草稿未發布」畫出來（按鈕文字、逐列標記、預覽標題、抽屜說明） | **端到端實測**：後台把 `elevator` 改名成「華廈/公寓電梯」→ 發布 → 重新載入前台：刊登表單 chip、我的刊登卡片、公開分享頁 chips **全部**變成新名稱；24 個條件的 id 與勾選狀態完全不動（名單與改名前一致） |
| **A4** 1 公里步行捷運 | ✅ 完成（**不是**原本的服務） | 見第 3 節。新增門檻／狀態機／端點／前端狀態機 | 真實案例：士林區中正路 100 號 → 捷運士林站 **958 公尺**；直線 843 m 但步行 **1,327 m** 的案例判成**不符合** |
| **A5** 分享頁登入狀態 | ✅ 完成 | 分享頁自己打 `/api/me`（載入中／訪客／會員三態）；公開內容維持訪客視角；順手修好說明被當純文字印出、以及 `[hidden]` 輸給 `display:flex` 導致訪客看到會員區連結 | 已登入／訪客截圖各一（`a5-*`）；未登入仍可讀、不取得屋主權限 |
| **B1** 五個獨立費用條件 | ✅ 完成 | 新增 `demand_posts.fee_includes`＋`feeIncludes.js`；Match Engine 只套用所選條件 | 任選幾項儲存／重開一致；同時勾多項要同時滿足；未勾＝未指定 |
| **B2** 六個選項集中＋文字＋移除欄位 | ✅ 完成 | 五個費用條件＋捷運需求集中在同一區；文字改為「需要離捷運距離（可行徑路線 1 公里內）」；移除獨立的「捷運／車站」欄位 | 截圖（`b1-b2-*`）；建立與編輯正常；歷史 `transit_note` 仍顯示 |
| **C1** 自動帶入會員 email | ✅ 完成（前一 commit） | 後端從已驗證 session 取 `userInfo().email`，不採用前端 `contact`；前台移除欄位 | 後台看得到聯絡 email、前台沒有該欄位 |
| **C2** 移除長段說明 | ✅ 完成（前一 commit） | 移除元素與載入器；`feedbackMeta().legal` 保留給稽核與測試 | 整段不再出現，提交流程正常 |
| **C3** 回饋附圖 | ✅ 完成 | 新表＋新模組＋三段驗證＋同交易 claim＋孤兒清理 | 貼上與上傳混用 4 張；第 5 張 409、>1,000,000 bytes 413、假圖片 400；站方可看、其他人 401/403 |

---

## 2. 舊合併費用條件的相容方式

| 情境 | `fee_includes` | 讀出來的狀態 | 行為 |
|---|---|---|---|
| 從未用新制儲存、舊旗標也沒勾 | `''` | `none` | 沒有任何費用條件 |
| 從未用新制儲存、舊旗標 = 1 | `''` | **`legacy`** | 顯示原字串「含水電／管理費（舊資料，未拆分）」；配對只標一則「待確認」，**不是**硬衝突、也**不展開成五項** |
| 用新制儲存過（含全部不勾） | `{"items":[…]}` | `split` | 完全以新制為準 |

- **不拆、不推論**：舊欄位 `includes_management` 的欄位名（management）與標籤（水電＋管理費）
  互相矛盾，且歷史上**完全沒有參與配對**（純顯示），所以原意無法確定 ⇒ 不映射成五項全選、也不清空。
- **一次只有一套生效**：寫入時新制一旦存在就以它為準；讀取端 `parseFeeIncludes()` 在新制非空時
  **不採計**舊旗標。舊旗標的**原值保留在資料庫**（可稽核、可回滾），只是不生效。
- **引導確認**：重新編輯 legacy 資料時，畫面出現
  「這則建立時只有一個合併選項（含水電／管理費），系統無法確定原本是哪幾項。請重新勾選你要的項目，再儲存。」
- **舊客戶端相容**：只送 `includes_management` 的請求仍走原邏輯，契約不破壞。
- **配對語意**：勾選代表「要求該項已含」；未勾＝未指定（不是禁止）。勾多項要同時滿足。
  房源標示另計 ⇒ 硬衝突；**房源沒有資料 ⇒ 只進 `unmet_unknowns`**（不算符合，也不算衝突）。
  這與 catalog 條件既有的 `unknown` 語意一致；若把 unknown 當成衝突，多數許願房會直接歸零曝光。
  另外：泛用「車位／停車」**不推定**汽車位或機車位（兩個 key 都回 unknown）。

---

## 3. 步行距離的實際資料來源

**FOSSGIS 的 OSRM foot profile**：`https://routing.openstreetmap.de/routed-foot/route/v1/foot/…`
（可用環境變數 `MRT_FOOT_ROUTE_BASE` 覆寫，自架 OSRM 時改這裡）。

原本用的 `router.project-osrm.org` 公開示範站**只跑車用 profile** —— `walking` 這個字在路徑裡
完全是裝飾。2026-10-01 實測：`driving`／`walking`／`cycling`／`foot` 四個字串回傳
**位元組完全相同**的結果（762.7 m／105.3 s ≈ 26 km/h），也就是拿車程冒充步行。
換到 foot profile 後同一組座標：foot **2,826.8 m／2,261.5 s**、car 2,925.1 m／265.3 s。

判定規則：

- 直線距離**只用來挑候選站**（直線是步行距離的下界 ⇒ 直線 > 1 公里的站不可能合格，
  這樣也能少打外部服務，而且這個「沒有」是**已查證**的）。
- 一律用真實步行路線判定，**≤ 1,000 公尺（含）**才算符合。
- 狀態分五種：`within`（已查證符合）／`none`（已查證沒有）／`unknown`（候選站有但路線服務
  沒給出可用結果 ⇒ **待確認**）／`unlocatable`（地址定位不到）／`error`（服務失敗，可重試、不擋刊登）。
  **只有 `within` 會顯示成符合**；`unknown` 不會被當成符合，也不會被當成「確定沒有」。
- 查證成功會把結果寫進**同一份 `mrt_cache`**，讓表單看到的數字與內頁顯示的是同一份資料。
- 隱私：只回站名與距離，**不回傳精確座標**；既有公開地址與座標隱私設定未動。

**真實成功案例（非 mock，`v3/test/mrt-walk-live.test.js` 每次 CI 都打真服務）**

| 位置 | 直線 | 步行 | 判定 |
|---|---:|---:|---|
| 台北市士林區中正路 100 號 | — | **958 m** | 符合（捷運士林站） |
| 25.0330, 121.5650（101 旁） | 322 m | **330 m** | 符合 |
| 25.0720, 121.5480（大直對岸） | 843 m | **1,327 m** | **不符合**（直線近、步行遠） |
| 25.0270, 121.5760（象山旁） | 876 m | **1,753 m** | **不符合** |

---

## 4. 是否需要資料庫 migration

**需要，兩處，都是加表／加欄位，可回滾，沒有資料搬遷腳本。**

1. **`feedback_attachment`（新表）** → `v3/src/schemaMigrations.js` 的 **version 6**
   （`ensureFeedbackMediaSchema`）。PG 由 `feedbackMediaAsync.js` 的
   `PG_SCHEMA_STATEMENTS`／`PG_ALTER_STATEMENTS` 補。
2. **`demand_posts.fee_includes`／`fee_includes_at`** → SQLite 走 `demand.js addWishColumns()` 的
   `ALTER TABLE ADD COLUMN`；**PG 走新增的 `DEMAND_PG_ALTER_STATEMENTS`（`ADD COLUMN IF NOT EXISTS`）**。
   ⚠️ 這一條是必要的：`ensurePgSchema()` 對**已存在**的表只送 `CREATE TABLE IF NOT EXISTS`
   （等於 no-op），補不了欄位 —— 少了這段，PG 會出現 42703。

舊列的 `fee_includes` 保持 `''`，行為與今天完全相同，所以**不需要資料搬遷**。

---

## 5. 測試與 CI

### 端到端驗收（本機實跑，不是只有單元測試）

| 驗收情境 | 怎麼驗 | 結果 |
|---|---|---|
| A1／A2 說明 | 手寫→套範本（先取消再確認）→套用後手改；另用「太短」觸發驗證失敗 | 取消時內容**完全保留**；確認時被範本取代並標「已套用說明範本：…」；手改後標籤變「已修改說明範本「…」的內容」；驗證失敗訊息是**新文字**且標題／地址／說明**全部保留**、按鈕可再送出 |
| A3 目錄同步 | 後台把 `elevator` 改名 → 寫入草稿 → 發布 → 重新載入前台 | 草稿階段畫面標「（草稿，未發布）」；發布後表單 chip／我的刊登卡片／分享頁 chips 都是「華廈/公寓電梯」；24 個條件的 id 與已勾選項不變 |
| A4 步行捷運 | 表單輸入「台北市士林區中正路 100 號」 | 顯示「捷運士林站，步行路線約 958 公尺（1 公里內）」，狀態 `within` |
| A4 失敗不卡死 | 服務忙碌／查不到時 | 狀態是 `unknown`／`unlocatable`（可重試），表單內容保留、可以繼續刊登 |
| A5 分享頁 | 同一頁分別用會員與訪客開 | 會員：本人 email＋「回找房頁面／登出」；訪客：只有「登入 / 註冊」與「免費註冊」 |
| B1 五個條件 | 許願房表單勾「水電／汽車位／網路」＋捷運需求 → 公開 → 重新載入 → 編輯 | 三項與捷運需求都還在、標籤正確、狀態 `split`；`includes_management` 維持 `false`、`transit_note` 維持空字串 |
| B2 表單整理 | 同一頁 | 六個選項在同一個連續區塊（`#wishNeeds`），最小點擊高度 44px |
| C3 貼上 | 對回饋對話框派送帶 PNG 的 `ClipboardEvent` | 圖片被加入（1／4 張），事件被 `preventDefault`；**純文字貼上沒有被攔**（對話框與內文框都照常插入） |
| C3 刪除後可補 | 刪到 0／4 再貼一張 | 回到 1／4，沒有卡住 |
| C1 不可偽造 | `POST /api/feedback` 帶 `contact`／`email` 都是 `attacker@evil.example` | 後台看到的聯絡方式是 **demo@example.com**（取自 session，前端傳什麼都不影響） |
| 手機／桌機 | 375×812 與 1440×900 各跑一次「找房／有房刊登／許願房／意見回饋／分享頁」 | 五個畫面都沒有橫向溢出（`scrollWidth == innerWidth`）；「刊登物件」「公開許願房」「送出回饋」三個送出鈕都看得到、沒被遮住、可點、高 44px |

- **`npm test`（本機，最終 HEAD `1653b96`、工作區乾淨）**：3594 項、**2 紅**，
  兩項都在乾淨的 `origin/master`（`f485a89`）上**照樣紅**，與本批無關（裁定方式：把同兩支測試
  丟到 `git worktree add --detach /tmp/baseline-wt origin/master` 的乾淨基線跑一次）：
  1. `cursor walks past the old 2000-row candidate cap`（既有；子行程 30 秒逾時回 `null !== 0`）
  2. `cooperative member processing preserves roles…`（既有）
  另外 95 項是環境條件不足時本來就會 skip 的（例如沒有 `PG_LIVE_REPRO_URL`）。
  前一輪看到的 `PR A src manifest`、`listListings benchmark`、`commute 1.5s` 這次都過
  （manifest 只因工作區髒而紅，bench 對負載敏感）。
- **定點變異測試**：把新行為的修正逐條拿掉，**存活 0/38**
  （A1～C3 10 個、R1～R6 12 個、這一輪補的 PG 5／R3 前台 2／R2 HTTP 5／R1 3 個、
  順手修的電話偵測 1 個）。
- **打真實外部服務的測試**：`v3/test/mrt-walk-live.test.js`（3 項）。
- **尺規**：288 → **295** 條入口（C3 四條＋A4 一條＋回饋附件兩條；交接文件現況表已同步）。
### CI 結果（同一個 SHA）

**最終 HEAD `1653b96`（四項全綠）**。`4718bff`（R1～R5 補正）與 `6391def`、`a3b9821`
（後兩者是 docs-only）也都是四項全綠，其中 `a3b9821` 第一次紅在下面那個隨機誤判、修正後綠：

| 檢查 | 結果 | 連結 |
|---|---|---|
| GitGuardian Security Checks | ✅ pass（9s） | <https://dashboard.gitguardian.com> |
| Review diff with the configured model | ✅ pass（4s） | [run](https://github.com/Fyun48/5151/actions/runs/36849094722/job/110326241036) |
| Run Tests | ✅ pass（3m49s） | [run](https://github.com/Fyun48/5151/actions/runs/36849094696/job/110326241326) |
| Run Tests (PostgreSQL integration) | ✅ pass（3m57s） | [run](https://github.com/Fyun48/5151/actions/runs/36849094696/job/110326241039) |

先前的 SHA `67897014a63c822d883c563c804fed21558a4319`（第九十九批實作＋截圖）
與 `66d6383`（第一百批 R1～R6）也都是四項全綠。
`npm test` 在本機看到的 2 紅是既有基準線（見上），CI 上沒有出現。

> 📌 程式碼的最終 SHA 是 `1653b96`；之後只會有 docs-only 的 commit，它們在 PR #611 上
> 都會重跑同一組檢查（清單以 PR 的 checks 為準）。
>
> ⚠️ **CI 在這一批紅過兩次，兩次都不是功能壞掉，但都要講清楚（不能只說「CI 全綠」）**：
> 1. **`a3b9821`（只有改文件）的 Run Tests**：`stage1-fixture-readiness.test.js` 的電話外洩偵測
>    把 12 字元 token hash（`opaqueId()`）的隨機數字串誤判成手機號碼。
>    **這是真的缺陷，已修**（見 §7 最後一項，含機率實測與變異測試）。
> 2. **`1653b96` 第一次的 Run Tests**：紅在 `cursor walks past the old 2000-row candidate cap`
>    （既有：子行程 30 秒逾時，本機在乾淨的 `origin/master` 上也紅）與
>    `v3/test/listing-sort-newest-relative-time.test.js`（**檔案層級**失敗、89 毫秒、子行程
>    沒有任何輸出，本機連跑 3 次都過）。`gh run rerun --failed` 之後同一顆 SHA 四項全綠 ⇒ 判定為
>    runner 的隨機 flake。**這一種紅燈我不會用「重跑就好了」帶過：重跑只證明它不穩定，
>    所以我把兩支測試的失敗條件與本機基準線都列出來，讓審閱可以自己判斷。**

---

## 6. 程式完成 / 驗證完成 / 部署狀態（分開列）

| 面向 | 狀態 |
|---|---|
| **程式完成** | ✅ A1～A5、B1～B2、C1～C3 全部實作完成，程式碼在 PR #611 |
| **驗證完成** | ✅ 本機全套測試、打真服務的 live 測試、定點變異測試、手機＋桌機截圖（`evidence/owner-workorder-20261001/`） |
| **部署狀態** | ⛔ **未部署**。Production 維持 manual-only；`build → predeploy → deploy` 三條 workflow 都**沒有**被觸發。**「程式修好」不等於「正式站已修好」。** |

---

## 6b. 第二輪：PR 審閱修正（R1～R6，2026-10-01）

審閱文件指出「A4、B1/B2 與 C3 尚未完成使用流程」。逐項處理如下，**同一張 PR #611**。

| 項 | 狀態 | 修改重點 |
|---|---|---|
| **R1** A4 舊快取與精度／狀態 | ✅ | `mrt_cache` 加 `source`／`checked`／`walk_m`／`searched_m`，契約字串 `osrm-foot:v1`；舊列一律不採計、按需重算（PG 用 `ADD COLUMN IF NOT EXISTS`）。門檻一律用**未四捨五入的公尺**，公里只給顯示。候選站**部分失敗或被上限截斷 ⇒ 回待確認**，不可宣告「已查證沒有」。0 公尺是合法距離 |
| **R2** B1/B2 站內刊登資料來源 | ✅ | `listings` 加費用三態與 `self_mrt_*`（**migration version 7**）；三個寫入路徑共用 `resolveSelfListingMeta()`（地址變了 ⇒ 舊座標與舊查證失效）；發布路徑做地理編碼＋步行查證並寫進同一份 `mrt_cache`（fail-soft）；費用推論改成逐項判定（只有水費已含 ≠ 含水電；第四台 ≠ 網路） |
| **R3** 一般會員預覽／上傳中提交 | ✅ | 附件網址分 `owner`／`admin` 兩種 scope（會員讀自己的未送出附件不再 403）；前台優先用**本機 blob**；上傳中鎖住送出；每次開啟對話框換世代，延遲完成的上傳會被丟棄 |
| **R4** 四張上限被並行繞過 | ✅ | 配額改成**單句條件式 INSERT**（DB 保證），`claim` 自己也擋 > 4 |
| **R5** claim 與刪除／清理競態 | ✅ | 刪除與孤兒清理改成**帶齊條件的 UPDATE … RETURNING**，只有搶到資格的那一列才 unlink |
| **R6** 兩節點附件可用性 | ✅ 程式／設定完成，**待部署生效** | 見下 |
| **A1** 提示文字 | ✅ | 改回工作單指定的原文，不再附加「（至少 8 個字）」；8 字規則保留（即時字數提示） |

### R6 的證據與現況

| 節點 | `DATA_DIR` 本體 | 私有媒體 |
|---|---|---|
| web-A（CasaOS 192.168.0.140） | `/opt/5151-shadow/web-a/data`（**節點本機**） | `/mnt/5151-media/…`＝**NFS**（`192.168.0.220:/volume1/5151-media`） |
| web-B（Synology 192.168.0.220） | `~/5151-shadow/web-b/data`（**節點本機**） | `/volume1/5151-media/…`（本機 volume，NFS 來源） |

`member-media`／`self-photos` 早就是用這份共享儲存疊上去的（`deploy/shadow-ha/media-share/`），
**`feedback-media` 漏了**。已補：三份 repo compose、**兩台主機的正本 compose**（各自備份
`.bak-20261001`，`docker compose config` 通過）、共享目錄已建立且 A 端 NFS 可讀寫。

> ⚠️ **容器尚未重建**。bind mount 要 `docker compose up -d` 才會生效，那是一次部署 ⇒
> 依規則等 Owner 當次批准。**在那之前，回饋附件仍然是節點本機檔案（跨節點會 404）。**

### 這輪新增／變更的 schema

| 變更 | SQLite | PG |
|---|---|---|
| `mrt_cache` 加 `source`／`checked`／`walk_m`／`searched_m` | `db.js` 的 `addColumnsIfMissing`（模組初始化，無條件） | `MRT_CACHE_PG_COLUMNS`（`crawlerWrites` 第一次寫入前） |
| `listings` 加 `fee_includes`／`self_mrt_*` | **migration version 7**（`schemaMigrations.js`）| `SELF_LISTING_PG_COLUMNS`（`selfListingsAsync.runnerFor`） |

> 📌 教訓：**新增欄位一定要開新的 migration version**。只改 `ensureXxxSchema()` 不會生效 ——
> migration runner 只跑沒跑過的版本（本機實測回 `no such column: fee_includes`）。

### 修正後的驗證（審閱要求涵蓋的情境）

| 審閱要求的情境 | 怎麼驗 | 結果 |
|---|---|---|
| 舊快取不採計 | `v3/test/mrt-cache-contract.test.js`（真的 db.js）：一列舊格式（無 source／checked=0）、一列新格式 | 舊列回 null（會重算）、新列讀得到且 `walk_m` 原樣保留 |
| 1,000／1,001 公尺 | `v3/test/mrt.test.js` | 1,000 ⇒ `within`；1,001 ⇒ `none` |
| 1,049 公尺（顯示 1.0 公里） | `mrt.test.js` ＋ `rental-match.test.js` | 表單 `none`、配對硬衝突（**不再因為顯示成 1.0 就符合**） |
| 0 公尺 | 同上 | `within`，`walk_m = 0`、`walk_km = 0` |
| 候選部分失敗 | `mrt.test.js`：第一站 1,300 公尺、其餘拋錯 | 回 `unknown` ＋ `nearest_walk_m`，不是「已查證沒有」 |
| 候選被上限截斷 | 同上 | 截斷時也不回 `none` |
| 一般會員預覽 | `feedback-media.test.js` ＋ 前台字串斷言 | 本人未送出 ⇒ 讀得到；已送出／別人的 ⇒ 讀不到 |
| 五張並行拒絕 | `feedback-media.test.js`：`Promise.allSettled` 五個並行上傳 | 只有 4 個成功，第 5 個 409 `attachment_limit` |
| claim 與清理競態 | `feedback-media.test.js` | 刪除回 404 且列與實體檔都還在；sweep 只清孤兒 |
| 一筆房源建立後完成費用與捷運配對 | `listing-fee-mrt-match.test.js`（真寫入 API＋真 snapshot）＋**真實 UI 端到端** | 已含 ⇒ 符合；另計 ⇒ 硬衝突（該筆 0 筆配對）；沒填 ⇒ 未確認；`mrt_walk` 958 公尺 ⇒ 符合 |
| 跨節點附件 | 兩節點 volume 實查 ＋ compose `config` 驗證 ＋ `media-share-mounts.test.js` | 見上；**容器尚未重建**（要一次部署） |

**定點變異測試**：這一輪合計 **22 個變異全部被殺（存活 0/22）**
（10 個來自 A1～C3，12 個來自 R1～R6）。

## 6c. 第三輪：第二輪複審的補正（R1～R5 的漏修，2026-10-01）

審閱固定 HEAD `682b18d`，指出「R1～R5 尚未補齊」。**其中 R4／R5 是最嚴重的一項：上一輪的
PG async 分支根本沒被改到**（我的編輯腳本在寫檔前就中止，我卻只憑一次 grep 就當成改好了）。
以下是逐項補正（同一張 PR #611）。

| 項 | 上一輪的實際狀況 | 這一輪做了什麼 |
|---|---|---|
| **R4（PG）** | `feedbackMediaAsync.saveFeedbackAttachmentAsync()` 仍是 `COUNT → await 解碼 → INSERT VALUES`；claim 沒有四張上限 | 上傳改成 `runInQuotaTransaction()`：**真 PG 走 `pgDriver.withTransaction()`**（`pgDriver.query()` 是連線池，用語句送 `BEGIN`／`COMMIT` 不會形成同一個交易），交易內先 `pg_advisory_xact_lock(使用者)` 再 COUNT → INSERT；`claim` 去重後 > 4 直接丟 400 `attachment_limit`（回饋交易整筆 rollback） |
| **R5（PG）** | delete／sweep 仍是「先 SELECT，再 `WHERE id=?` UPDATE，然後 unlink」 | 兩者都改成**帶齊條件的 `UPDATE … RETURNING`**（`user_id`／`feedback_id = 0`／`deleted_at IS NULL`），只有 RETURNING 勝出的那一列才刪實體檔 |
| **R3（PG scope）** | `listFeedbackAttachmentsForAsync()` 用 owner scope（後台已送出的附件 404）、`listOpenFeedbackAttachmentsAsync()` 用 admin scope（會員 403）—— **兩個剛好對調** | 明確改成 admin／owner，並在真 PG 上驗證 |
| **R3（前台世代）** | 只保護「成功」那一條路徑：舊上傳回來會把新上傳的 busy 清掉、409 會把舊附件混進新對話框 | 全部狀態更新（成功／錯誤／busy／訊息／清單）都受同一個世代檢查；`busy` 只在 `finally` 裡、且**只在同一個世代**才清 |
| **R1（精度）** | `osrmWalkKm()` 仍回 `meters: Math.round(meters)` ⇒ 1,000.4 公尺被當成 1,000 ⇒ 符合 | 保留服務回傳的原始公尺（含小數），公里只給顯示；測試改成**從 OSRM 回應入口**跑 0／1000／1000.1／1000.4／1001／1049／缺值 |
| **R1（缺值）** | `db.js` 的 `mrtRowToAccess()`／`mrtCacheUpsert()` 仍有 `Number(null) === 0` ⇒ 缺值被存成 0 | 新增 `nullableMeters()`，缺值一律 null；**不再**用顯示公里回推原始距離 |
| **R1（升級順序）** | PG 的 `ADD COLUMN` 只掛在寫入路徑，但裝飾讀取會 SELECT 新欄位 ⇒ 舊 schema 先讀會 42703 | 契約常數與升級搬到 `v3/src/mrtCacheSchema.js`；`preloadDecorationProviderAsync()`（**讀取路徑**）在建立 loader 前先升級（以 exec 函式身分用 WeakMap 記憶；失敗不快取，下一次會再試）。升級本身是 **best-effort**：失敗就讓後面那句 SELECT 用 42703 自己講缺哪個欄位，不會把整個讀取路徑吞掉（離線夾具的 exec 只接受它自己的 SQL，硬要它跑 DDL 會讓不相關的測試整批紅） |
| **R2（狀態）** | 發布只把 `within` 寫進房源 ⇒ 「已查證超過 1 公里」在發布後掉回 unknown，配對沒有硬衝突 | 新增 `self_mrt_state`（within／outside）與 `self_mrt_nearest_m`（**migration version 8**）；`resolveSelfListingGeo()` 把 `none` 也寫成 `outside`（含「沒有候選站」）；matcher 讀持久化狀態 → outside 是硬衝突 |
| **R2（缺值變 0）** | `resolveSelfListingMeta()` 把 `previous.self_mrt_walk_m = null` 轉成 0，同地址重發會變成「0 公尺 ⇒ 符合」 | 缺值保持 null；沿用舊結果時**驗來源契約**（非目前契約一律不沿用） |
| **R2（偽造）** | `{...body, ...geo}` 在定位／路線失敗（geo 是空物件）時會讓會員自帶的 `mrt_walk_m`／`mrt_source` 活下來 | HTTP 入口先用 `stripServerVerifiedFields()` 剝掉整組伺服器查證欄位，只認站方查證結果 |
| **A1（文件）** | §1 的 A1 列仍寫有括號版 | 已改成指定原文（程式在上一輪就已改成原文） |

### 這一輪新增的測試（都是審閱指定的情境）

| 檔案 | 驗什麼 |
|---|---|
| `v3/test/feedback-media-live-pg.test.js` | **真 PG、連線池（不同連線）**：五張並行只成功四張（第 5 張 409 且清掉檔案）、claim 後 delete 回 404 且列／檔案都在、sweep 只清孤兒、claim > 4 整筆失敗、owner／admin 兩種 scope |
| `v3/test/feedback-media-ui-generation.test.js` | 抽出 `index.html` 的 C3 區塊，用 **deferred fetch** 實跑 A／B 交錯與 A 的 409；B 上傳中持續阻擋、新對話框不混入舊結果 |
| `v3/test/self-listing-http-mrt.test.js` | **真的 HTTP 路由**：偽造欄位無效、within／outside 落地並影響配對、路線失敗維持未知、舊契約不沿用、改地址重新查證 |
| `v3/test/mrt-cache-schema-live-pg.test.js` | **真的 PG，先建舊形狀的表**：讀取路徑（含 `preloadDecorationProviderAsync`）會先升級再 SELECT |
| `v3/test/mrt.test.js`（擴充） | 從 OSRM 回應入口驗 0／1000／1000.1／1000.4／1001／1049／缺值 |
| `v3/test/mrt-cache-contract.test.js`（擴充） | 缺值必須存成 NULL（不是 0），讀回來也是 null |

**定點變異測試**：這一輪再補 15 個（PG 5、R3 前台 2、R2 HTTP 5、R1 3），**全部被殺（存活 0/15）**；
再加上順手修的電話偵測 1 個（已寫進 `mutation-check.mjs` 的新套組 `FIXTUREPHONE_MUTATIONS`）。
六套電池 ＋ 工具內建那一條**合計 38 個變異、存活 0/38**。

### 同一顆 SHA 的驗收（`1653b96`；`4718bff` 的程式內容相同，只差電話偵測那一條）

| 項目 | 指令 | 結果 |
|---|---|---|
| 全套測試 | `npm test`（工作區乾淨） | 3594 項、3497 pass、**2 紅**（都在 `origin/master` `f485a89` 上照樣紅）、95 skip |
| 真 PG 附件（R3／R4／R5） | `set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a; node --test v3/test/feedback-media-live-pg.test.js` | 4/4 pass（隔離庫 `repro`、連線池＝不同連線；五張並行只成功四張） |
| 前台世代（R3） | `node --test v3/test/feedback-media-ui-generation.test.js` | 4/4 pass（deferred fetch 實跑 A／B 交錯與 409） |
| HTTP 入口到配對（R2） | `node --test v3/test/self-listing-http-mrt.test.js` | pass（真 HTTP、假走路服務、種 `geo_cache`；偽造無效、within／outside／未知、重發、改地址） |
| 舊 PG 表的讀取升級（R1） | `node --test v3/test/mrt-cache-schema-live-pg.test.js` | 2/2 pass（先建舊形狀的表） |
| CI | PR #611 四項檢查 | `1653b96` 全綠（第一次的兩個 flake 見 §5 說明） |

> ⚠️ 這一節只證明「程式與驗證完成」。**正式站沒有部署**（§6），R6 的共享掛載也要等部署才生效。

### 合併前再抓到的三個問題（都已修掉）

補正之後跑**全套**才發現的三個問題，都不是審閱指出的，但會讓「綠」變成假綠：

| 問題 | 症狀 | 修法 |
|---|---|---|
| 讀取路徑的 schema 升級太硬 | `commute-snapshot-async.test.js` 3 項紅：離線夾具的 exec 一收到 DDL 字串就丟「夾具收到不是 SQL 的東西」，整個讀取路徑陪葬 | 升級改成 **best-effort**（`try/catch`，失敗不快取、下次再試）；真 PG 的行為照樣由 `mrt-cache-schema-live-pg.test.js` 2/2 守住 |
| 突變錨點停在第二輪的形狀 | `mutation-anchors.test.js` 紅：`self-listing-create-async`／`self-listing-publish-async` 兩組找不到 `{ ...body, ...geo }`（R3 已改成 `stripServerVerifiedFields(body)`） | `v3/scripts/mutation-check.mjs` 兩處 `from` 更新成 R3 的形狀 |
| 兩條路由接線測試的斷言同樣過期 | `self-listing-create-async.test.js`、`self-listing-publish-async.test.js` 各 1 項紅 | 斷言改成新形狀，並**再加一條禁止**：路由內不得再出現 `{ ...body, ...geo }`（會員偽造的查證欄位一定要先被剝掉） |

> 📌 教訓：**改動一行呼叫形式，會同時打到突變錨點與靜態斷言這兩種「不會編譯錯」的守衛。**
> 這一輪改了 3 處呼叫，就有 4 個測試因此紅 —— 它們全都不是被改壞的功能，而是守衛過期。

## 7. 需要 Owner 決定或動手的事

1. ~~A4 的舊快取不會自動重算~~ → **R1 已修**：沒有契約來源的舊列一律不採計，會按需重算。
2. ~~站內刊登沒有費用與座標欄位~~ → **R2 已補**（房東端三態＋發布時定位與步行查證，
   並以端到端實測確認能跑出符合／不符合／未確認）。
3. **A3 的發布語意沒有改**（審閱已確認維持現狀）。後台改條件名稱仍然是「寫入草稿」，
   要按「確認並發布」才會改前台；本批把它標示得非常清楚，但沒有改成自動發布。
4. 🔴 **R6 需要一次部署才會生效**：回饋附件的共享儲存掛載已經寫進 repo 與**兩台主機的正本
   compose**，但容器要 `docker compose up -d` 重建才會套用。**在那之前回饋附件仍是節點本機檔案。**
   這需要 Owner 當次批准（Production 維持 manual-only）。
5. `rental_catalog_v2` 的目錄變更仍需在後台按「確認並發布」（同第 3 點，審閱已確認）。
6. **5168 仍暫緩**（審閱指示不擴大本 PR 範圍）。

### 一個必須講清楚的地方：A3 我第一次只修了一半

第一次只改了 `selfTraits.js` 的 `||` 優先序，單元測試全綠 —— 但**照工作單的驗收步驟實際操作**
（後台改名 → 發布 → 重新載入前台）之後，前台**還是顯示舊名稱**。真正的原因還有第二層：
標籤對照表被 `rental_catalog_v2` 旗標擋住，旗標沒開的安裝連刊登表單都不會跟著改名。
已在 `0b1585b` 修掉（顯示名稱與可寫入的 id 分開），並把「單元測試綠 ≠ 功能有通」
寫進交接文件的踩坑清單。

### 順手修掉、但不在工作單裡的既有缺陷

1. **SQLite 模式下每一筆站內刊登都 400**：`server.js` 傳給 `createSelfListingAsync()` 的
   `matchCandidates` 是 async 的 PG 島嶼版本，SQLite 分支直接往下傳給**同步**的
   `createSelfListing()` ⇒ `bestMatch()` 收到 Promise，回 `(candidates || []) is not iterable`。
   （我是為了做 A5 的截圖要建一筆刊登才撞到的。）
2. **分享頁把物件說明當純文字印出來**：`esc(d.body)` 讓畫面直接出現 `<p>` 這幾個字。
   改成過一次與首頁相同的白名單 sanitizer 再放進 `innerHTML`。
3. **`[hidden]` 輸給 `display:flex`**：訪客在 375px 會看到會員區的「回找房頁面／登出」。
   這是**看截圖才發現的** —— 自動化斷言（`hidden` 屬性、`aria-live`）全綠，畫面卻是錯的。
4. **Stage 1 fixture 的「電話外洩」偵測會誤判 12 字元 token hash**（是在 CI 上真的遇到的）：
   `a3b9821` 的 Run Tests 紅在 `cleanup failure keeps non-fixture rows…`，訊息是
   `fixture evidence leaked phone near …"token_hash":"e**********d"`。
   `opaqueId()` 是 sha256 的前 12 個十六進位字元，**光靠機率**就會出現 `e0912345678d`
   這種「中間剛好 10 位數字」的形狀：實測 **0.0091%／每個 hash**，而那個測試檔每次執行
   約有 510 個 hash ⇒ **約 4.5% 的執行會隨機變紅**（`a3b9821` 就是那個 4.5%）。
   舊邊界只排除「前後是數字」的位置；改成排除「前後是十六進位字元」
   （`FIXTURE_PHONE_RE = /(?<![0-9a-fA-F])09\d{8}(?![0-9a-fA-F])/`），
   真正的電話（`"phone":"0912345678"`）照樣抓到。偵測器改成**匯出常數**，
   測試直接吃正式那一條（原本測試自己抄了一份 regex，改壞了也不會紅），
   並把這一條加進 `mutation-check.mjs`（新套組 `FIXTUREPHONE_MUTATIONS`，拿掉邊界會被殺）。
