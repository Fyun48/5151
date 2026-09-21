# Shadow PostgreSQL 實測：背景迴圈的掃描與欄位寫入（2026-09-21）

這一輪把 v3 從 SQLite 移植到 PostgreSQL 的「最後一段」做完前兩塊：

- ① 另外 7 條 `listingsNeeding*` 掃描（`FeeDetail`/`SourceKit`/`591Geo`/`AddressGeo`/`AddressEnrich`/`Mrt`/`Route`）
- ② 迴圈套用的欄位寫入（`setListingDetail`/`persistHpListingFields`/`setCachedMrt`/`setCommunityCache`/`upsertListingPrep`）

## 怎麼跑的（從本機 Windows，直連 shadow PG）

2026-09-21 的環境是：**shadow PG primary 可從開發機直連**
（`192.168.0.220:15432`，Synology `5151-postgres-B`，密碼在 NAS 的
`~/5151-shadow-ha/shadow-ha/postgres-primary/.env`），所以本輪的 live parity 不必再經 SSH 打 NAS：

```powershell
$env:PG_TEST_URL = 'postgres://postgres:<pw>@192.168.0.220:15432/5151_shadow'
node --test v3/test/crawler-reads-parity.test.js v3/test/listing-fields-parity.test.js
```

每個測試自己建一個私有 schema、用 `pgSchema.importStore()` 把 SQLite fixture 鏡射進去，跑完
`DROP SCHEMA ... CASCADE`；`PG_TEST_URL` 沒設時整組自動 skip（CI 就是這條）。

## 實測結果

```
# crawler-reads-parity.test.js（①，含原本 4 項）
✔ the backfill scans find the fixture's work on the sqlite driver
  ✔ existing row and fingerprint lookup
  ✔ the offline sweep scans match
  ✔ the backfill scans match          ← 7 條掃描逐列／逐序 = SQLite
  ✔ match candidates match on both paths
  ✔ a listing written through PostgreSQL is readable back
ℹ tests 8 / pass 8 / fail 0

# listing-fields-parity.test.js（②）
✔ the field writes go through the driver-aware entry point
  ✔ setListingDetail writes the detail columns
  ✔ persistHpListingFields writes the 5168 columns and kit
  ✔ the MRT and community caches are written where the reads look
  ✔ the 5168 prep row is stored in PostgreSQL
ℹ tests 6 / pass 6 / fail 0
```

合計 **14/14**。比對的內容：掃描是整列陣列（含順序），欄位寫入是 `listings` 的 37 個欄位投影
（排除「現在時間」類欄位與 `coord_version` 這種遞增戳記，只比對它有沒有被寫入）、`mrt_cache`／
`community_cache`／`listing_prep` 整列。

## 這一輪抓到並修掉的跨 driver 問題

1. **`CASE WHEN ?`**：PostgreSQL 要求 boolean，但 `node:sqlite` **不能綁 JS boolean**
   （`Provided value cannot be bound to SQLite parameter 26`）→ 語句一律寫 `CASE WHEN ? = 1`。
2. **`? IS NOT NULL`**：PG 無法從 `IS NOT NULL` 推斷參數型別
   （`could not determine data type of parameter $27`）→ `CAST(? AS DOUBLE PRECISION) IS NOT NULL`
   （SQLite 對 CAST 是 no-op）。
3. **`listingLocationUpdate()` 的 post_id**：SQLite 端的 `current` 是一條窄 SELECT（沒有 post_id），
   若從 `current.post_id` 取會變成 `WHERE post_id = 0` → 靜默不更新（座標永遠沒進 DB）。改由參數帶入。
4. **`repository/decorationData.js` 的 `PEER_COLUMNS_QUALIFIED`**（既有 bug，切換前就會踩到）：
   `PEER_COLUMNS.split(",\n")` 只替每行**第一個**欄位加 `l.`，於是
   `listing_group_members m JOIN listings l` 這條查詢在 PG 上回
   `column reference "source" is ambiguous`（SQLite 容忍）。改成 `split(",")`。
   觸發條件是「物件屬於同一棟群組」＋ PG 讀取，等於常態。
5. **`getListingAsync` 的 `sameHouse`**：欄位寫入的「先讀後寫」要走 crawler 的讀取縫
   （`sameHouse: false`），與 `watcher.listingForWatch()` 一致。

## 上版（2026-09-21 12:32–12:38 UTC）

PR #401 合併後（master `939ecb085fd74742d7af2e4671038ac5b703cd3b`）走三條 manual workflow，
全部由 `master` dispatch（`release_mode=manual_owner`）：

| 步驟 | run | 結果 |
|---|---|---|
| `build-production-image.yml` | [35699964209](https://github.com/Fyun48/5151/actions/runs/35599964209) | ✅ `IMAGE_DIGEST=sha256:937719ef9c128fa36a4428ee45f390800cc2262c35f4b9c29d110514fbc220f1` |
| `production-predeploy-check.yml` | [35600236264](https://github.com/Fyun48/5151/actions/runs/35600236264) | ✅ |
| `deploy-v3.yml` | [35600462363](https://github.com/Fyun48/5151/actions/runs/35600462363) | ✅ |

NAS（CasaOS）端實查（`docker inspect`／`curl`，2026-09-21 12:47 UTC）：

```
IMAGE=sha256:8eb3043a3c51c716238c54156a4b2c5cb189893a9efea547f10d371d7e9db704 STATUS=running
CREATED=2026-09-21T12:37:30.346642326Z
REVISION=939ecb085fd74742d7af2e4671038ac5b703cd3b          # = 合併的 sha
REPODIGESTS=["ghcr.io/fyun48/5151@sha256:937719ef9c1...220f1"]  # = 建置產出的 digest
HEALTH=200            # http://127.0.0.1:5153/api/health
LANDING=200 / STATE_ANON=401（需登入，設計如此）
DB_DRIVER=unset PG_URL=unset        # ← 正式站仍是 sqlite，這版不改行為
容器啟動日誌無錯誤：吉比租房物件追蹤：http://0.0.0.0:5153（role=all）／第一次檢查：19 組覆蓋條件
只有 591-tracker-v3 被重建（5151-web-A／5151-crawler／5151-haproxy／5151-cloudflared-A 皆未動）
公開站 https://jibbyrenth.reversalplay.me/ 200（title 吉比租房物件追蹤）、/api/health 200
```

⚠️ **切換仍未就緒**：③ 通知／CRM 佇列讀寫與 ④ `enqueueSimilaritySafe` 尚未完成
（清單見 `docs/runbooks/postgres-cutover-bootstrap.md` 步驟 0）。

