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
3. 未設定、停用、超預算、401／429／逾時 → **自動 fallback 到現有免費實作**，並寫審計。
4. 用量與花費在 v3 後台看，不進 OPS 帳單。
5. `daily_budget_twd = 0` 的語意訂成 **不准花付費額度**（不是無限）。要無限必須老闆明確填很大的數字。剛上線建議：Google 距離每日 NT$50、LLM 每日 NT$20。

---

## 2. 資料表（新表，少動主表）

SQLite migration（`CREATE TABLE IF NOT EXISTS` + 需要時 `ALTER TABLE listings ADD COLUMN`）：

### `system_provider_configs`

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| id | INTEGER PK | |
| category | TEXT | `scraping_api`／`residential_proxy`／`llm`／`distance_matrix`／`llm_crawl_insight` |
| provider_code | TEXT | `zenrows`、`scrape_do`、`brightdata`、`smartproxy`、`qwen`、`openai`、`google_distance`… |
| is_enabled | INTEGER | 預設 0 |
| credentials | TEXT | JSON；應用層加密後再寫入，禁止明文進 git |
| daily_budget_twd | REAL | 預設 0＝不呼叫付費 |
| monthly_budget_twd | REAL | 預設 0＝不呼叫付費 |
| cost_per_call_twd | REAL | 單次估價，供累計 |
| created_at, updated_at | TEXT | ISO |

同一 `category` 同時只准一個 `is_enabled=1`（應用層守門，避免雙開燒兩份錢）。

### `provider_usage_logs`

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| id | INTEGER PK | |
| provider_code, category | TEXT | |
| call_status | TEXT | `success`／`error`／`fallback`／`budget_exceeded` |
| units_consumed | INTEGER | tokens／requests／credits |
| cost_twd | REAL | |
| error_message | TEXT | 可空；不寫金鑰原文 |
| created_at | TEXT | 加 index，供今日／本月加總 |

### `listings` 可空欄（僅新增，不改現有欄）

- `image_phash` TEXT
- `similarity_group_id` TEXT

現有同源欄位與 `match.js` 不動。

---

## 3. 執行器

`v3/src/providers/executeWithProvider.js`（概念，正式用 JS）：

```js
async function executeWithProvider({ category, actionWithProvider, fallbackAction }) {
  const cfg = loadEnabledProvider(category);
  if (!cfg || !hasCredentials(cfg) || budgetExceeded(cfg)) {
    writeLog({ category, status: cfg ? "budget_exceeded" : "fallback", cost_twd: 0 });
    return fallbackAction();
  }
  try {
    const result = await actionWithProvider(cfg);
    writeLog({ category, provider_code: cfg.provider_code, status: "success", ...result.usage });
    return result.value;
  } catch (err) {
    writeLog({ category, status: "error", error_message: brief(err) });
    return fallbackAction();
  }
}
```

現有排程**只改呼叫點一行**：`fetch(url)` → `fetchListingPage(url)`。排程、入庫、通知流程不重寫。

---

## 4. Adapter 與 Fallback

### 爬蟲／代理（`scraping_api` / `residential_proxy`）

- A：ZenRows／Scrape.do — 把目標 URL 交給代爬。
- B：Bright Data／Smartproxy — HTTP／SOCKS5 agent。
- **Fallback：** 現有 `fetchHtml`／各來源 `fetch*Page`（直連）。

### 距離（`distance_matrix`）

- 付費：沿用並收斂現有 `route.js` + `mapsBilling.js`（已有冷卻與用量）。
- 快取：起訖經緯度各取小數 3 位，快取 30 天（可另表 `route_cache`，不要重複打 Google）。
- **Fallback：** 本地 Haversine 直線距離 + 現有機車／步行係數。零外部費用。

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

- 抓到封面 URL → 下載到記憶體算 pHash（可用現有 `sharp`）→ 丢掉像素。
- 與候選做漢明距離；低於閾值再送進現有同源流程當加分，**不單獨定案**。
- 算失敗就當沒有指紋，不擋入庫。

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

1. Migration + 讀寫設定（金鑰加密、0 元＝不呼叫付費）。
2. `executeWithProvider` + 用量加總 + 測試。
3. 只包 `client591.fetchHtml` 一處當樣板，證明 fallback。
4. 距離納入守門（接到 `mapsBilling`，不要第二套 Google 帳）。
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
