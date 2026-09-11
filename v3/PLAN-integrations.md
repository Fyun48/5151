# v3 外掛串接、預算硬熔斷與進階比對

這是**吉比租房站自己的**計畫，不依賴 OPS 在線。退出 OPS、關掉遞送，這裡的爬蟲與後台都要繼續動。  
實作時非侵入：不重寫排程，只在現有抓取／距離／比對呼叫點套包裝函式。

相關：OPS 多站與分家見 [`../ops/PLAN.md`](../ops/PLAN.md)。

## 和現有程式怎麼接

堆疊是 **Node 22 + Express + `node:sqlite`**，不是 TypeScript／PostgreSQL／JSONB。後台已是 `v3/public/admin.html`（含爬蟲、站務、**使用者回饋**）。

| 能力 | 現在 | 外掛要掛哪 |
| --- | --- | --- |
| 抓頁 | `v3/src/client591.js` 的 `fetchHtml`／`fetch`；住商／5168／好房等各有 `fetch*Page` | 換成 `fetchListingPage(url)`，內走 `executeWithProvider` |
| 距離 | `v3/src/route.js` + `mapsBilling.js`（已有 Google Directions 額度／冷卻；沒金鑰就不用） | 納入同一套預算守門；沒開或熔斷 → 既有直線／推估 |
| 同源 | `v3/src/match.js` 規則（路名、樓層、坪數、社區） | 規則先跑；可選 pHash、可選 LLM 只當確認，失敗就跳過 |
| 回饋 | 本機 `feedback` 表 + 後台「使用者回饋」；OPS 遞送可關 | 不要改成「只送到 OPS」 |

**不要**另開一套 ORM，**不要**為了這份規格改寫成 TS。SQLite 用 `TEXT` 存 JSON、用 `CHECK` 當列舉。

---

## 1. 原則

1. 後台可登記各類廠商金鑰，**預設全關**。
2. 有開、有憑證、當日／當月還沒熔斷 → 走付費外掛。
3. 未設定、停用、超預算、401／429／逾時 → **自動 fallback 到現有免費實作**，並寫審計。timeout 若無法確認供應商是否已受理，**不釋放已送出的保留額度**，先對帳。
4. 用量與花費在 v3 後台看，不進 OPS 帳單。
5. `daily_budget_twd = 0` 的語意訂成 **不准花付費額度**（不是無限）。要無限必須老闆明確填很大的數字。剛上線建議：Google 距離每日 NT$50、LLM 每日 NT$20。這兩個數字是使用者限額，不是供應商價格。
6. **並行不變式：** 已結算成本＋尚未結算的保留額度＋本次成本上界 ≤ 任何適用上限。先在短交易內保留，交易結束後才打外網。金額用整數最小單位（例如百萬分之一元），不用 float。

---

## 2. 資料表（新表，少動主表）

SQLite migration（`CREATE TABLE IF NOT EXISTS` + 需要時 `ALTER TABLE listings ADD COLUMN`）：

概念上要能分清「設定／額度桶／保留／事件」。表可合併，但不能省略責任。金額欄位用 INTEGER（最小貨幣單位），不用 REAL。

### `system_provider_configs`

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| id | INTEGER PK | config_id |
| category | TEXT | `scraping_api`／`residential_proxy`／`llm`／`distance_matrix`／`llm_crawl_insight` |
| provider_code | TEXT | `zenrows`、`scrape_do`、`brightdata`、`smartproxy`、`qwen`、`openai`、`google_routes`… |
| region, model_id, endpoint | TEXT | 可空；同一供應商不同帳號／地區／模型要能分開 |
| is_enabled | INTEGER | 預設 0 |
| credential_ref | TEXT | 指向加密憑證，不把金鑰原文寫進這張表的可匯出欄 |
| price_version | TEXT | adapter 計價模型版本 |
| fallback_policy | TEXT | JSON：有限次數、禁止 A↔B 循環 |
| created_at, updated_at | TEXT | ISO |

同一 `category` 可登記多個 provider，但須明定優先順序與有限 fallback。不能爬蟲 API 內部再掛付費代理造成雙重費用。

### `budget_limits`（額度桶）

作用域（站台／用途／供應商／付費帳戶）、日／月期間、時區（預設 `Asia/Taipei`）、上限、已結算合計、保留合計。`0`＝不准花錢。換 key 不把已用額度歸零；換供應商不能繞過本站總預算。

### `call_reservations`

`request_id`、`attempt_id`、config_id、價格版本、成本上界、狀態（reserved／settled／released／unknown）、供應商 request_id、送出／結算時間。retry、換供應商、測試連線、批次、人工重跑都要走保留。

### `provider_usage_logs`／`usage_events`

發送、結果、實際用量、結算、調整／退款。不寫金鑰與原始錯誤機密。報表分開顯示已結算、保留中、估算及供應商對帳差額。

### 圖片指紋（不要只在 `listings` 塞一個欄）

| 表 | 說明 |
| --- | --- |
| `listing_image_phash` | 每張可用圖一列：listing 識別、來源 URL／object id、算法版本、pHash、算出時間 |
| `listing_similarity_suggestion` | 可選；建議群組、證據、審核狀態。不覆寫使用者手動併入／拆分 |

現有同源欄位與 `match.js` 不動。可靠門牌／樓層衝突不能被一句 AI 蓋過。A≈B、B≈C 不鏈式合併。

---

## 3. 執行器

`v3/src/providers/executeWithProvider.js`（概念，正式用 JS）：

```js
async function executeWithProvider({ category, actionWithProvider, fallbackAction, costCeilingMinor }) {
  const cfg = loadEnabledProvider(category);
  if (!cfg || !hasCredentials(cfg)) return fallbackAction();
  const reservation = reserveBudget({ cfg, ceiling: costCeilingMinor }); // 短交易；失敗則不呼叫
  if (!reservation.ok) {
    writeLog({ category, status: "budget_exceeded", reserved_minor: 0 });
    return fallbackAction();
  }
  try {
    const result = await actionWithProvider(cfg, reservation);
    settleBudget(reservation, result.usage);
    return result.value;
  } catch (err) {
    if (err.uncertainCharge) holdReservation(reservation); // timeout／重啟：不釋放
    else releaseUnused(reservation);
    writeLog({ category, status: "error", error_message: brief(err) });
    return fallbackAction();
  }
}
```

「只改呼叫點一行」只能當某個呼叫點的展示。要盤點 HTML、子請求、圖片下載、代理、距離、LLM、測試連線與 retry 是否都進守門員。排程、入庫、通知流程不重寫。

各 adapter 必須提供有版本的計價與用量上界：住宅代理可能依流量、LLM 依輸入／輸出 token、路線矩陣依可計費 elements。沒有可確認的成本上界就不發付費請求。

---

## 4. Adapter 與 Fallback

### 爬蟲／代理（`scraping_api` / `residential_proxy`）

- A：ZenRows／Scrape.do — 把目標 URL 交給代爬。
- B：Bright Data／Smartproxy — HTTP／SOCKS5 agent。
- **Fallback：** 現有 `fetchHtml`／各來源 `fetch*Page`（直連）。

### 距離（`distance_matrix`）

- 付費：沿用並收斂現有 `route.js` + `mapsBilling.js`（已有冷卻與用量）。
- 新 adapter 評估 Routes API（Compute Route Matrix）；舊 Distance Matrix 僅在既有帳戶仍使用時相容。
- 快取政策依採用 API 與適用條款設計，**不能**直接採用「任何路線結果存 30 天」或「座標一律取三位小數當同一點」。key 至少區分有方向的起訖、交通模式、路線選項、出發時間需求與 provider／版本。
- **Fallback：** 本地 Haversine 顯示「直線距離」；若加時間，標示粗估、未考慮道路。不能冒充實際步行／騎車。付費路線與本地估算不混用快取。

### LLM 同源確認（`llm`，例如 Qwen3.7 Flash）

- OpenAI 相容端點（DashScope 等）。
- 只送兩物件的標題、非結構說明、模糊地址、特殊標籤，回 `is_same` / `confidence`。
- **Fallback：** 只信現有 `match.js`，或略過語意確認。
- 預設關。不可把整頁 HTML 或會員個資送出。

### 爬蟲結果 AI 分析開關（`llm_crawl_insight`）

和「是不是同一間」分開，避免一開 LLM 就兩處一起燒錢。

- 用途：從說明抽出樓層／車位／頂加／費用結構等，**只當提示**，不覆寫已結構化欄位，除非信心高且後台允許。
- **Fallback：** 完全不做，沿用現有欄位剖析。
- 預設關；每日預算建議先 NT$20（可與同源 LLM 共用一個 provider、兩個 category 分開熔斷）。

### 圖片 pHash

- 每張可用圖寫入 `listing_image_phash`（算法版本＋來源識別）。背景算，不阻塞入庫。
- 漢明距離是相似證據，不是同戶判決。同建案公設照、樣品照、浮水印會混淆。
- 只有仍有疑義且額度允許的候選才送 LLM；回應 `same / different / uncertain`。
- 算失敗就當沒有指紋，不擋入庫。最大檔案／像素、MIME、timeout、有限並行、壞圖跳過、下載目的地限制。

---

## 5. 後台 UI（現有 admin，不加新 SPA）

在 `admin.html` 新增一頁「外掛與預算」，四張（加洞察則五張）卡片：

- 網頁代爬、住宅代理、LLM 同源、爬蟲洞察、地圖距離
- 每卡：開關、憑證欄、每日／每月預算（TWD）、單次估價、**測試連線**
- 報表：今日花費 vs 日預算（80% 橘、100% 熔斷紅）、本月各商長條或表格、最近 50 筆（時間、類型、金額、Success／Fallback）
- 圓餅／折線可後做；先表格即可，不必為圖表引入重型套件

API 掛在現有 `requireAdminApi` 下，例如 `/api/admin/providers`、`/api/admin/providers/test`、`/api/admin/providers/usage`。

---

## 6. 實作切片（仍只做 v3）

1. Migration + 讀寫設定（金鑰加密、0 元＝不呼叫付費）。**第 6 包已做。**
2. `executeWithProvider` + **保留／結算／unknown 對帳** + 並行超支測試（20 元已結算 18、同時 10 個上界 1 元 → 最多再核准 2 個）。**第 6 包已做。**
3. 只包 `client591.fetchHtml` 一處當樣板，證明 fallback。**第 6 包已做。**
4. 距離納入守門（接到 `mapsBilling`，不要第二套 Google 帳）。**第 6 包已做。**
5. pHash 欄位與比對加分（預設關或只算不阻擋）。
6. LLM 同源與爬蟲洞察兩個獨立開關。
7. 後台卡片與用量列表。
8. 熔斷預設：距離 NT$50／日、Qwen NT$20／日。

每步都要有「關開關＝與現在行為相同」的回歸測試。

---

## 7. 和 OPS／分家

- 這些表在 **該站 `v3.db`**。幫別家做的站若也用這套，金鑰是**該站經營者的**，退出你的 OPS 後他們後台還在、熔斷還在。
- 不要把 ZenRows／Google 金鑰同步進 OPS。
- OPS 若要看「這站今天熔斷了沒」，以後只訂閱指標，不存金鑰。
