# Owner 工作單集中回報（2026-10-01）

- **工作單**：`5151_DS_Fixes_20261001.txt`（A1～A5、B1～B2、C1～C3）
- **PR**：<https://github.com/Fyun48/5151/pull/611>
- **分支**：`fix/owner-workorder-20261001`
- **完整 commit SHA**：`67897014a63c822d883c563c804fed21558a4319`
  （前一個：`232a6a7479dee78d6960f3825862f10ff278215a` 實作本體、
  `7701c29…` A1／C1／C2）
- **部署狀態**：**未部署**。Production 維持 manual-only，等 Owner 另外明確批准。

---

## 1. 逐項完成狀態

| 項 | 狀態 | 修改重點 | 驗收結果 |
|---|---|---|---|
| **A1** 說明提示文字 | ✅ 完成 | 提示與送出訊息改成「請寫一些這屋子的故事與回憶（至少 8 個字）」，前後端同一條規則（`SELF_BODY_MIN`） | 新文字出現在欄位提示與驗證訊息；8 字規則未變 |
| **A2** 說明範本預設展開 | ✅ 完成 | 範本下拉＋說明輸入區移到「刊登物件」按鈕上方（`#selfBodyBlock`），開表單就看得到；`#selfBody` 仍是唯一內容來源，新增可見的 contenteditable 當輸入介面，所有寫入走 `setSelfBody()`；套用範本前 `confirm` 保護；失敗保留內容 | 桌機／手機截圖（`evidence/owner-workorder-20261001/a2-*`）；`listing-tools-ui` 測試釘住「可編輯、在送出鈕之前、只有一個寫入入口」 |
| **A3** 目錄文字沒同步 | ✅ 完成（含根因） | 根因是 `selfTraits.js` 的 `selfTraitLabels()` 把目錄標籤放在 `\|\|` 後面 ⇒ 就算發布了，卡片與分享頁 chips 仍顯示靜態表；修正優先序，並把後台「草稿未發布」畫出來（按鈕文字、逐列標記、預覽標題、抽屜說明） | 條件 ID 與勾選結果不動（改名只動顯示）；後台可見性由 `self-traits-taxonomy` 測試守住 |
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

- **`npm test`（本機）**：3562 項、5 紅，全部是既有基準線，與本批無關：
  1. `PR A src manifest matches git tree`（工作區有未提交變更時必紅）
  2. `cursor walks past the old 2000-row candidate cap`（既有 flake）
  3. `commute list plus stats stay under 1.5s`（既有效能 flake）
  4. `cooperative member processing preserves roles…`（既有 flake）
  5. `list-unhang` 的既有 flake
- **定點變異測試**：把 10 個新行為的修正逐條拿掉，**存活 0/10**
  （A3 目錄優先、A4 門檻／foot profile、B1 另計衝突、B2 捷運配對、C3 大小邊界／claim 參數順序／
  站方權限、A5 訪客狀態、B2 欄位移除）。
- **打真實外部服務的測試**：`v3/test/mrt-walk-live.test.js`（3 項）。
- **尺規**：288 → **293** 條入口（C3 四條＋A4 一條），交接文件現況表已同步。
### CI 結果（同一個 SHA）

SHA `67897014a63c822d883c563c804fed21558a4319`（PR #611 的 head）：

| 檢查 | 結果 | 連結 |
|---|---|---|
| GitGuardian Security Checks | ✅ pass | <https://dashboard.gitguardian.com> |
| Review diff with the configured model | ✅ pass | [run](https://github.com/Fyun48/5151/actions/runs/36816898409) |
| Run Tests | ✅ pass（2m56s） | [run](https://github.com/Fyun48/5151/actions/runs/36816898385/job/110223898679) |
| Run Tests (PostgreSQL integration) | ✅ pass（3m43s） | [run](https://github.com/Fyun48/5151/actions/runs/36816898385/job/110223899126) |

四項全綠。`npm test` 在本機看到的那 5 紅都是既有的基準線／flake，CI 上沒有出現。

---

## 6. 程式完成 / 驗證完成 / 部署狀態（分開列）

| 面向 | 狀態 |
|---|---|
| **程式完成** | ✅ A1～A5、B1～B2、C1～C3 全部實作完成，程式碼在 PR #611 |
| **驗證完成** | ✅ 本機全套測試、打真服務的 live 測試、定點變異測試、手機＋桌機截圖（`evidence/owner-workorder-20261001/`） |
| **部署狀態** | ⛔ **未部署**。Production 維持 manual-only；`build → predeploy → deploy` 三條 workflow 都**沒有**被觸發。**「程式修好」不等於「正式站已修好」。** |

---

## 7. 還沒做、需要 Owner 決定的三件事

1. **A4 的舊快取不會自動重算**。`mrt_cache` 沒有 TTL，切換 profile **之前**寫入的值
   （當時是用車用 profile 算的）不會自己重算。最小作法是**把 profile 名放進 cache key**
   （`mrt:v2:<lat>,<lng>`），舊 key 自然失效，不必新增欄位、也不必做 PG 遷移。
   我沒有在這一批做，因為那會牽動 PG 的匯入／對帳路徑。**要不要做，請 Owner 決定。**
2. **站內刊登沒有費用與座標欄位**。B1／B2 的配對邏輯已經接上（勾選的條件會逐項判定，
   `unknown` 不會被當成符合），但 Match Engine 只配對站內刊登，而站內刊登表單沒有費用欄位、
   `listings.lat/lng` 也沒寫 ⇒ **目前所有可配對物件都會顯示「未確認」**。
   要讓它真的配對得到，得在刊登表單補「租金已包含」三態欄位與地址定位（屬下一批）。
3. **A3 的發布語意沒有改**。後台改條件名稱仍然是「寫入草稿」，要按「確認並發布」才會改前台
   （本批把它標示得非常清楚，但沒有改成自動發布）。若 Owner 要的是「存檔就生效」，
   那是流程決定，我再改。

### 順手修掉、但不在工作單裡的既有缺陷

1. **SQLite 模式下每一筆站內刊登都 400**：`server.js` 傳給 `createSelfListingAsync()` 的
   `matchCandidates` 是 async 的 PG 島嶼版本，SQLite 分支直接往下傳給**同步**的
   `createSelfListing()` ⇒ `bestMatch()` 收到 Promise，回 `(candidates || []) is not iterable`。
   （我是為了做 A5 的截圖要建一筆刊登才撞到的。）
2. **分享頁把物件說明當純文字印出來**：`esc(d.body)` 讓畫面直接出現 `<p>` 這幾個字。
   改成過一次與首頁相同的白名單 sanitizer 再放進 `innerHTML`。
3. **`[hidden]` 輸給 `display:flex`**：訪客在 375px 會看到會員區的「回找房頁面／登出」。
   這是**看截圖才發現的** —— 自動化斷言（`hidden` 屬性、`aria-live`）全綠，畫面卻是錯的。
