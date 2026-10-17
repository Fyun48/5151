# 訪客清單「閒置後的第一發很慢」：SWR 陳舊上界放寬為 10 分鐘（2026-10-16）

> 一句話：訪客清單快取的**陳舊上界**（`v3/src/publicListings.js` 的 `MAX_STALE_MS`）原本只有 45 秒，
> 低流量站幾乎每一發訪客請求都掉進「同步重算」那一格（實測十幾秒）；改成 **10 分鐘**
> （對齊爬蟲約 20 分鐘一輪的節奏，Owner 2026-10-16 核可）之後，閒置後的第一發改成
> **先回舊值＋背景重算**，量測上每發 < 3 秒。
>
> 這一包**只動訪客（未登入）清單路徑**，沒有動會員快取、沒有動爬蟲、沒有動資料庫。

## 一、症狀（實測數字）

同一個查詢形狀（`/api/public/listings?districts=中山區&sort=newest&excludeRooftop=1&excludeLowFloors=1&limit=40`，
也就是訪客首頁的預設形狀），**連續發、每次都間隔很久**時，每一發都要重算一次（正式站／開發站十幾秒到三十秒；本包重跑時為 3.6～4.3 秒，見下表）：

| 量測目標 | 請求間隔 | 每發秒數 | 來源 |
|---|---|---|---|
| 正式站 `jibbyrenth.reversalplay.me` | 150 秒 | 17.5／17.0／16.6／17.3／17.1／15.8／16.4（7 發） | planner 2026-10-16 早上 |
| 開發站 `jibbydev.reversalplay.me`（同一份資料，無爬蟲競爭） | 150 秒 | 30.3／29.9／29.8 | planner 2026-10-16 早上 |
| 正式站（本包重跑對照組） | 150 秒 | 3.56／4.30／4.16／3.76（第 1 發 0.90） | 本包 §五 A/B-3 |
| **請求間隔縮短到 12 秒** | 12 秒 | 16.4 → 4.8 → 2.4（**會快**） | planner 2026-10-16 早上 |

「間隔縮短就會快」是關鍵線索：慢的不是資料庫本身，而是**每一發都被要求重新算一次**。

## 二、歸因（讀碼，`v3/src/publicListings.js`）

訪客快取有三個時間常數（修正前）：

```
TTL_MS       = 20_000   // 同 generation 的「新鮮窗口」
BUCKET_MS    = 20_000   // PG revision generation 讀取的粗粒度 bucket
MAX_STALE_MS = 45_000   // SWR 的陳舊上界
```

命中判斷（修正前，`origin/master` 的 `v3/src/publicListings.js:79-93`）是：

```js
if (sameGeneration && age < TTL_MS)          → 直接命中
if (!sameGeneration && age <= MAX_STALE_MS)  → SWR（先回舊值＋背景重算）
// 其餘（年齡 > MAX_STALE_MS；或「同 generation 但已過新鮮窗口」）→ 同步重算
```

問題出在最後那一行註解裡的「**同 generation 但已過新鮮窗口**」：

- `generation` 是 PostgreSQL 的 `data_revision.MAX(id)`（`guestCacheNamespace()` 的 `pg:guest:v${revision}`），
  **爬蟲寫入才會換代**；兩輪爬蟲之間（實務上約 20 分鐘）generation 完全不動。
- 於是低流量站的訪客請求（間隔 150 秒 ≫ TTL 20 秒）每一次都命中
  「同 generation、年齡 20 秒～45 秒（或更久）」這一格 ⇒ **每次同步重算**。
- 45 秒的 `MAX_STALE_MS` 本來只覆蓋「換代之後」那條路，對「沒換代」這條路完全沒有幫助；
  而且 `MAX_STALE_MS=45s` 相對「爬蟲 20 分鐘才更新一輪」的資料節奏嚴格了一個量級
  （entry 陳舊 45 秒就不准回舊值，但資料本身 20 分鐘才動一次）。

## 三、修正（`v3/src/publicListings.js`）

新的命中判斷（修正後）：

```js
if (hit) {
  const age = nowMs - hit.at;
  const generationChanged = hit.namespace !== namespace;
  if (!generationChanged && age < TTL_MS) → 直接命中（新鮮窗口，不發背景重算）
  if (age <= MAX_STALE_MS)                → 先回舊值＋一次 single-flight 背景重算
  // 其餘（沒有 entry，或年齡 > MAX_STALE_MS）→ 同步重算
}
```

也就是說：**只要 entry 還在陳舊上界（10 分鐘）內，就一律先回舊值**，
背景重算負責把 entry 換成最新結果；只有「完全沒有 entry」或「年齡超過 10 分鐘」才同步重算。

### 為什麼 `TTL_MS`、`BUCKET_MS` 都沒有跟著動

- `TTL_MS` 維持 20 秒：它是「**零背景工作的新鮮窗口**」——20 秒內連續的請求直接命中，
  不會每發都觸發一次全量搜尋；它同時是「在完全沒有背景重算的前提下，同一筆結果最多可以沿用多久」。
  調大 ⇒ 「同一代資料的後續更新最慢多久會被追上」變長；調小 ⇒ 背景重算變頻繁。
  這個症狀不需要動它。
- `BUCKET_MS` 維持 20 秒：它是「行程內 memo 多久重讀一次 `data_revision`」，
  也就是**資料被改掉之後最慢多久會被 generation 換代偵測到**的上界。它與陳舊上界是兩件事，
  放大它只會讓偵測變慢。
- 真正要改的只有「回舊值可以回多久」這一個數字，因此只動 `MAX_STALE_MS`。

### 為什麼「同 generation 但已過新鮮窗口」也要發背景重算（而不是當成純命中）

generation 沒換代代表寫入端沒有 bump ⇒ 這筆 entry 的資料仍然有效，回舊值其實**就是正確值**。
即便如此仍發一次背景重算，理由是「讓 entry 的年齡回到 0」：如果同 generation 的命中完全不重算，
同一筆 entry 會一路被養到 10 分鐘上界，之後**每隔 10 分鐘就會有一發請求掉回同步重算**
（低流量站＝每隔幾發卡一次十幾秒）。固定發背景重算之後，只要還有流量，entry 的年齡就會被壓在
`TTL_MS` 附近，「> 10 分鐘才同步重算」只剩「真的 10 分鐘沒人來」這一種情形。

### 開關（照 repo 慣例：只認環境變數，不動 compose／`.env`）

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `GUEST_SWR_MAX_STALE_MS` | `600000` | 陳舊上界（毫秒）。**硬上界 clamp 在 `[TTL_MS(20000), 600000]`**：只能調小，調大於 Owner 核可的 10 分鐘會被夾回 600000；解析失敗（未設／空字串／非正數）回到預設。 |

## 四、資料陳舊上界（明確上界）與已知殘留

### 使用者最多看到多久以前的清單

**上界＝10 分鐘（600 秒）＋ 該次計算本身的耗時。** 推導：

1. 回舊值的前提是 `age <= MAX_STALE_MS`；`age` 是「上一次**成功計算完成**到現在」的毫秒數，
   所以被回出去的 payload 最多是 600 秒前算出來的（另加那次計算自己的耗時，實測十幾秒）。
2. 資料被寫入之後，最快會在 `BUCKET_MS`（20 秒）內被 generation 換代偵測到；偵測到之後，
   **當下那一發仍然會回舊值**（因為它還在 600 秒內），下一發才是新資料。
   ⇒ 最壞情況是「使用者看到的是最新一輪爬蟲**之前**的清單（可能還含著剛被下架／標記消失的物件）」，
   但這個情形只會出現在換代後的第一發，且該發已經在背景重算，下一發就修正。

### 已知殘留（沒有被這次修正解決，不要當成已修）

1. **沒有 entry 的第一次查詢仍然是同步計算**（語意刻意不變）：全新的查詢形狀、
   或服務剛重啟、或 entry 被 `MAX_ENTRIES=200` 淘汰之後第一次查，都要等一次完整計算
   （本機實測 1.20～2.11 秒；正式站的完整計算時間見 §一）。
2. **距上次成功計算超過 10 分鐘的「閒置後第一發」仍然是同步計算**（同上，一次）。
   之後的每一發才會回到 SWR。這是「陳舊上界」這個設計的必然結果：不設上界就等於可以回無限舊的資料。
3. **SQLite 路徑（`sqlite:guest:v2`，namespace 固定不換代）也一起吃 10 分鐘上界**：
   它的 generation 永遠相同，所以 20 秒之後的請求都會走「先回舊值＋背景重算」。
   本機開發／沒有 PG 的部署因此也會看到「最多落後 10 分鐘」的舊值。
4. 陳舊上界內的清單**可能包含已經被下架或缺漏最新一批的物件**（見上面第 2 點的機制）。

## 五、驗證（可重跑）

量測腳本：`v3/scripts/guest-latency-probe.mjs`（唯讀，只發 GET，不帶憑證、不寫檔）。

```bash
# 離線語意（假時鐘）：三個檔案共 21 個測試
node --test v3/test/public-cache-swr.test.js v3/test/public-listings-cache.test.js v3/test/public-cache-async.test.js

# 本機服務（只指向隔離庫 jibbydev；APP_ROLE=web ⇒ 不起爬蟲／worker 迴圈）
#   憑證：/home/cline/.secrets/apps/5151-dev-casaos.env 的 DEV_PG_URL 鍵
bash /tmp/5151-swr-run.sh <worktree> 5254

# A/B 量測
node v3/scripts/guest-latency-probe.mjs --base-url http://127.0.0.1:5254 --gap-seconds 60  --count 5
node v3/scripts/guest-latency-probe.mjs --base-url http://127.0.0.1:5254 --gap-seconds 150 --count 5

# 正式站對照組（唯讀 GET）
node v3/scripts/guest-latency-probe.mjs --base-url https://jibbyrenth.reversalplay.me --gap-seconds 150 --count 5
```

### A/B 結果

| # | 情境 | 改動前（`origin/master`，`MAX_STALE_MS=45s`） | 改動後（本分支，`MAX_STALE_MS=600s`） |
|---|---|---|---|
| A/B-1 | 本機、`--gap-seconds 60 --count 5` | 1.43／1.59／2.22／2.04 秒，全部 `cache_hit=false`（同步重算） | **0.08／0.03／0.02／0.03／0.03 秒，5/5 `< 3 秒`，全部 `cache_hit=true`（SWR）** |
| A/B-2 | 本機、`--gap-seconds 150 --count 5`（驗收門檻） | 1.85／1.45／1.80／1.50 秒，全部 `cache_hit=false`（同步重算） | **0.08／0.02／0.03／0.03／0.03 秒，5/5 `< 3 秒`，全部 `cache_hit=true`（SWR）** |
| A/B-3 | **正式站**、`--gap-seconds 150 --count 5` | **3.56／4.30／4.16／3.76 秒（第 1 發 0.90），`cache_hit=false`，`< 3 秒`只有 1/5** | 未量（不得在未經 Owner 核准下部署） |
| A/B-4 | 本機、generation 換代之後的第一發（arm 乙，見下） | 同步重算（`cache_hit=false`、1.5 秒級） | **先回舊值（`cache_hit=true`、0.0x 秒）** |

`--count 5` 的第 1 發要小心判讀：**「改動前」那三組的第 1 發都是新鮮命中**
（0.06／0.07／0.90 秒、`cache_hit=true`），因為探針啟動前幾十秒內剛好有別的請求把 entry 寫進去；
那一發不是被修正的路徑。被修正的路徑是第 2 發之後每一發（間隔已經超過 `TTL_MS`／舊的 45 秒上界）：
**「改動前」的第 2～5 發全部 `cache_hit=false`**；**「改動後」的兩組第 1 發就已經是 SWR**（量測前刻意
各等了 60／150 秒），5 發全部 `cache_hit=true`。判讀時請看第 2 發之後，或直接看 `cache_hit` 欄位。

### arm 乙：generation 換代之後的第一發（`!sameGeneration` 那條路）

```
[3] 對隔離庫 jibbydev 插入一列 data_revision（generation 換代）：
    data_revision: before=2847833 inserted=2847834 after=2847834
[5] 換代後的第一發（兩台服務的 entry 年齡都約 90 秒，早已超過舊上界 45 秒）
    改動前（port 5253）：1.49 秒  HTTP 200  cache_hit=false  ← 同步重算
    改動後（port 5254）：0.08 秒  HTTP 200  cache_hit=true   ← 先回舊值（SWR）
[6] 改動後再過 3 秒的第二發：0.05 秒  cache_hit=true         ← 背景重算已完成 ⇒ 新鮮命中
```

這一組證明「generation 換代」那條路在 10 分鐘上界內也走 SWR，而不是同步重算。
改動前之所以同步重算，是因為 entry 年齡（約 90 秒）已經超過舊上界 45 秒——這正是正式站
「間隔 150 秒」的實際情形（entry 永遠比 45 秒舊）。

> 這一項動到**隔離庫**：插入一列 `entity_type='guest_cache_probe'`、`entity_id=0` 的
> `data_revision`（與 `revisionBumpAsync.js` 的 bump 同形狀）。`entity_type` 不是 `listing`，
> 對 `listingDistrictPrefilter.js:133-155` 的增量證明是 fail-safe（`entity_type !== "listing"`
> ⇒ 回 `null` ⇒ 全掃，不會少算）。
> **正式庫、正式站容器都沒有被碰**：正式站那 5 發是唯讀 GET；正式庫這條路只做過 SELECT
> （而且影子庫的連線因密碼不符而未成功，見 §六）。

### 量測環境（可重現的前提）

| 項目 | 值 |
|---|---|
| 本機服務 | cline-server，`APP_ROLE=web`（不起爬蟲／worker 迴圈）、`DB_DRIVER=postgres`、`PG_SQLITE_FALLBACK=strict`、`PG_NO_SQLITE_OPEN=1` |
| 資料庫 | **隔離庫** `jibbydev`（syn-nas `prb-repro-pg`，正式庫的遮罩副本；憑證：`/home/cline/.secrets/apps/5151-dev-casaos.env` 的 `DEV_PG_URL` 鍵） |
| 改動前 | worktree `/home/cline/lab/5151-swr-window-base`（`origin/master`，`MAX_STALE_MS=45_000`），port 5253 |
| 改動後 | worktree `/home/cline/lab/5151-swr-window`（`fix/guest-swr-stale-window`），port 5254 |
| 正式站 | `https://jibbyrenth.reversalplay.me`（唯讀 GET，只當對照組） |

> 本機（cline-server）的完整計算只要 1.2～2.2 秒，比正式站／開發站快一個量級，
> 所以「改動前」的本機數字本來就低於 3 秒門檻；**本機 A/B 證明的是機制**
> （`cache_hit=false` 的同步重算 vs `cache_hit=true` 的先回舊值），
> **正式站的 3 秒門檻則以 A/B-3 那組為準**（同一支腳本、同樣 150 秒間隔，改動前只有 1/5 低於 3 秒）。
> 改動後的正式站數字**未量**：本包不得部署，正式站目前跑的仍是 `MAX_STALE_MS=45_000` 的版本。

## 六、未驗證／不確定（交付時的事實）

1. **正式站「改動後」的數字未量**：本包不部署，正式站跑的仍是舊版 ⇒ A/B-3 只有「改動前」那一欄。
   要拿到正式站的改動後數字，必須先經 Owner 核准部署，再用同一支腳本跑一次。
2. **「改動前」正式站本輪的 3.56～4.30 秒，比 planner 早上量到的 15.8～17.5 秒低**：
   兩輪的機器負載不同。我沒有追查差異來源，只確認了同一件事——
   第 2 發之後**每一發都是 `cache_hit=false`（同步重算）**，沒有任何一發走 SWR。
3. **arm 乙沒有證明「回出去的 payload 內容確實是舊的」**：換代那次只插入一列 revision、
   房源資料本身沒有變，所以新舊 payload 逐字相同。這一項證明的是**行為**
   （走 SWR 分支、不阻塞回應、3 秒後回到新鮮命中），不是內容差異。
   「SWR 期間回的是上一次成功計算的完整結果」這一條由離線測試釘住
   （`v3/test/public-cache-swr.test.js` 的 ④：刻意讓背景重算永不 resolve，比對整份 payload）。
4. **本機與正式站不是同一個效能量級**：本機完整計算 1.2～2.2 秒、正式站本輪 3.6～4.3 秒
   （早上 15.8～17.5 秒）。「本機 < 3 秒」**不能**外推成「正式站 < 3 秒」；正式站那條要部署後量。
5. **正式庫的 generation 推進速率沒量到**：我原本要對影子庫取兩次 `MAX(id)` 算速率（唯讀 SELECT），
   但 `/home/cline/.secrets/postgres/5151-agent-pg.env` 的 `PG_TEST_STANDBY_URL`
   （`192.168.0.140:15432/5151_shadow`）密碼認證失敗（`password authentication failed for user "postgres"`），
   我沒有再試其他連線字串。「爬蟲約 20 分鐘一輪」這個節奏來自 planner 的敘述，以及既有量測
   `v3/evidence/member-listing-cache-20261011/README.md:91`（爬蟲活躍時 `max_id` ≈ +1.14 次／秒）；
   本包**沒有重新量**這一項。
6. **「同 generation ⇒ 回舊值是正確值」依賴「寫入端都會 bump `data_revision`」**：
   `memberListingCachePg.js:17-19` 列出的是房源／同戶／配對／站內刊登等影響訪客結果集的寫入；
   會員個人化狀態（`user_settings`／`user_listing_flags` 等，`memberListingCachePg.js:27-31`）
   不 bump。若未來出現「會改變訪客可見結果集、卻忘記 bump」的寫入路徑，
   這一條推論就會退化成「最多落後 10 分鐘」（仍然有界，但會比預期舊）。
7. **沒有做多節點量測**：本包量測都在單一行程（per-process 快取）。多節點（web-A／web-B）
   各自的 `revisionBucket` memo 只會讓背景重算次數變多，理論上不影響正確性，但本包沒有實測。
