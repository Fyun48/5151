# 會員列表版本化快取（`MEMBER_LISTING_CACHE`）— 2026-10-11 試開又退的實測、env 生效位置、與 web A/B compose 漂移盤查

## TL;DR

- 這是 **#712** 帶進來、**預設關閉**的開關（`v3/src/memberListingCachePg.js`，已合併進 master `b5b1399`）。
- 2026-10-11 **17:56** 在 `5151-web-A`／`5151-web-B` 這對 web 節點的 compose 上打開過；
  **18:15:43 已回滾關閉**（回滾檔 `docker-compose.yml.bak-20261011-cache`）。
- 關掉的原因：**失效粒度不是「有意義的變更」，而是「任何一列寫入」**。key 裡的 `r<revision>` 取自
  `data_revision.MAX(id)`，而它**每秒變 1 次以上** ⇒ 同參數間隔 2 秒的請求幾乎不可能落在同一代
  ⇒ **3/3 硬性未命中**，還比不開慢約 2 秒。
- **要重啟這條路，先解決失效粒度（見第 3 節），不是把開關打開。**
- 現況：**兩台都關著**（第 1.2 節有 `printenv` 實測）。

## 1. 開關語意

### 1.1 四個環境變數

| 環境變數 | 預設 | 作用 | 程式位置 |
|---|---|---|---|
| `MEMBER_LISTING_CACHE` | **關閉** | 主開關。**只有** `1` / `on` / `true`（`trim()` ＋ `toLowerCase()` 之後比對）才算開；其他任何值（`yes`、`0`、空字串…）＝關。沒開時「一行都不經過」。 | `v3/src/memberListingCachePg.js:84-87` |
| `MEMBER_LISTING_CACHE_FRESH_MS` | `30000` | 第二道閘：entry 年齡超過它就未命中。這是**陳舊上限**，不是失效機制。 | `:94-96`（`DEFAULT_FRESH_MS` 在 `:72`） |
| `MEMBER_LISTING_CACHE_ENTRIES` | `24` | 記憶體護欄①：entry 筆數上限，超過以插入序淘汰最舊一筆。 | `:98-100`（`DEFAULT_MAX_ENTRIES` 在 `:73`） |
| `MEMBER_LISTING_CACHE_MAX_LISTINGS` | `1200` | 記憶體護欄②：**全部 entry 合計的物件筆數**上限（`GET /api/state` 用 `limit=500` 走同一條路，單頁可達 643KB）。 | `:102-104`（`DEFAULT_MAX_LISTINGS` 在 `:78`） |

`positiveInt()`（`:89-92`）的語意：**不是有限正數就回退預設** ⇒ 填 `0`、負數、亂字串都等於沒填。

> 逾時語意補充（`:42-44`）：`FRESH_MS` 之所以是「上限」而不是「失效」，是因為
> `pg_stat_user_tables` 的計數約有 1 秒統計落後；給一個新鮮窗口，是讓「沒被版本號涵蓋到的周邊資料」
> 的陳舊有界。

### 1.2 現況＝關著（2026-10-11 18:1x 實測，唯讀）

```
$ ssh casa-nas "docker exec 5151-web-A printenv MEMBER_LISTING_CACHE; echo exit=\$?"
exit=1
$ ssh casa-nas "docker exec 5151-web-A printenv MEMBER_LISTING_CACHE_FRESH_MS; echo exit=\$?"
exit=1
$ ssh syn-nas "/usr/local/bin/docker exec 5151-web-B printenv MEMBER_LISTING_CACHE; echo exit=\$?"
exit=1
$ ssh syn-nas "/usr/local/bin/docker exec 5151-web-B printenv MEMBER_LISTING_CACHE_FRESH_MS; echo exit=\$?"
exit=1
```

`printenv` 回 **exit 1 ＋ 空字串**＝這個變數**不存在**（不是「存在但為空」）。

兩台 NAS compose 也沒有這三個鍵（casa **37 行**、syn **62 行**）：

```
$ ssh casa-nas "grep -n MEMBER_LISTING_CACHE /opt/5151-shadow/web-a/docker-compose.yml"   # 無輸出
$ ssh syn-nas  "grep -n MEMBER_LISTING_CACHE ~/5151-shadow/web-b/docker-compose.yml"    # 無輸出
$ ssh casa-nas "grep -n PUBLIC_LISTINGS_SQL_FIRST /opt/5151-shadow/web-a/docker-compose.yml"
22:      PUBLIC_LISTINGS_SQL_FIRST: "1"      # ← 這一條還在（回滾只拿掉快取那 3 行）
```

## 2. 為什麼「硬性未命中」在這個寫入頻率下必然打不中

### 2.1 key 裡有兩個「每列寫入都變」的成分

`memberListingCacheKey()`（`:216-227`）＝

```
member:v1 | r<revision> | d<dataVersion> | u<uid> | <會員簽章> | <正規化後的請求參數>
```

- `r<revision>` ← `SELECT MAX(id) FROM data_revision`（`MEMBER_LISTING_GENERATION_SQL` `:162`）
- `d<dataVersion>` ← `SUM(n_tup_ins + n_tup_upd + n_tup_del) FROM pg_stat_user_tables
  WHERE relname IN ('listings','route_cache','route_jobs','mrt_cache','community_cache')`（`:163-165`）

**兩個都是累計量**：爬蟲每寫一列，`d` 就變；`data_revision` 每插一列，`r` 就變。
（`data_revision` 的用途見 `:10-30` 的檔頭說明。）

### 2.2 實測：版本號每秒變 1 次以上

在 primary（`5151-postgres-A`，`5151_shadow` 庫）上唯讀取樣：

```
$ cat growth.sql
SELECT to_char(clock_timestamp(),'HH24:MI:SS') AS t, (SELECT count(*) FROM data_revision) AS rows,
       (SELECT max(id) FROM data_revision) AS max_id;
SELECT pg_sleep(20);
SELECT to_char(clock_timestamp(),'HH24:MI:SS') AS t, (SELECT count(*) FROM data_revision) AS rows,
       (SELECT max(id) FROM data_revision) AS max_id;

$ ssh casa-nas 'docker exec -i 5151-postgres-A psql -U postgres -d 5151_shadow -f -' < growth.sql
    t     |  rows   | max_id
----------+---------+---------
 10:19:13 | 2246356 | 2246359
 10:19:34 | 2246380 | 2246383
```

**21 秒內 `max_id` ＋24（≈ 1.14 次／秒）。** 對照組：Owner 18:15 量到 2,245,924 列，
本次 18:18 已是 2,246,316 列、18:19 為 2,246,356 列。

⇒ 同參數間隔 2 秒的兩次請求，**幾乎一定落在不同 generation**；`FRESH_MS=30000` 那道閘根本輪不到。

### 2.3 問題不在成本，在粒度

`MEMBER_LISTING_GENERATION_SQL` 是**單一 statement、一次 round trip**（模組註解自述「實測 3ms 上下」，`:158`）。
我在 primary 上以 psql `\timing` 量（把 `?` 代入 `0`）：

| 次數 | 時間 |
|---|---|
| 冷跑（同 session 第一次） | `52.9 ms` |
| 暖跑 1 | `13.3 ms` |
| 暖跑 2 | `14.9 ms` |
| 暖跑 3 | `13.6 ms` |
| 暖跑 4 | `14.7 ms` |

（psql 的往返與輸出佔掉大部分；重點是**毫秒級**。）
**毫秒級的成本配上每秒變一次的 key ⇒ 100% 未命中，還多付一次 round trip。**

### 2.4 現場數字

| 情境 | 預設列表 `list` | 來源 |
|---|---|---|
| 開快取**前** | `3.37 s` | Owner 2026-10-11 實測 |
| 開快取**後**（同參數間隔 2 秒連打三次） | `5.0 / 5.1 / 5.7 s`，**3/3 未命中** | Owner 2026-10-11 18:15 實測 |

⇒ 開了**反而慢約 2 秒**（多一次 generation 查詢，且完全沒命中）。

> ⚠️ **這三個延遲數字來自 Owner 的實測回報，本文件作者沒有重現**——回滾後再量只會量到「關著」的基線。
> 要重現，一律照 `docs/runbooks/web-latency-measurement.md`：**進容器內量、一定要看 http code**；
> 不要在 casa-nas 的 host 上打埠 5153（那是 `591-tracker-v3`，不是 web 節點）。

## 3. 要重啟這條路，先解決失效粒度（**不要直接打開開關**）

現在的失效語意是「**任何一列寫入**」。可行方向（**僅列出，未實作、未驗證**）：

1. **把版本號換成時間桶**：`data_revision.MAX(id)` → 以 `crawl_covers.last_run_at` 的 `max()` 為基準，
   再把時間**向下取整到 N 秒**（`date_trunc('second', …)` 之類的桶）。N 要與「可接受的陳舊上限」對齊。
2. **只認與這頁結果有關的變更**：把 `d<dataVersion>` 的 `pg_stat_user_tables` 全表累計量，換成
   **該 filter 命中的子集**的簽章（例如 `max(listings.updated_at)` 之類），而不是五張表的總寫入次數。
3. **兩條都要先量命中率**：在候選版本上真的跑出「命中率 x%」再談上線。
   `timing` 欄位可以分辨「真命中」與「伺服器算得快」——命中時 `query_ms/stats_ms` 是 **0**，
   不是照抄冷算的時間（`:52-54`）。

**底線：先把 `data_revision.MAX(id)` 與 `pg_stat_user_tables` 這條失效路徑換掉，再談開關。**

## 4. ⚠️ 最容易再踩的坑：web 容器的 env 要改哪裡

### 4.1 兩份 NAS compose 是主機本地檔，**發版不會從 repo 覆蓋、也不會讀 repo**

`deploy-v3.yml`（543 行）查證（`grep -n 5151-shadow` 在該檔**只有 364、416 兩行**）：

| 行 | 內容 | 意義 |
|---|---|---|
| **L286–287** | `source: "v3/src,v3/public,docker-compose.yml,casaos-compose.yml,docker-compose.override.yml"` → `target: /mnt/Storage1/apps/5151` | scp **只鋪正式站（tracker）目錄**；`deploy/shadow-ha/web/**` **不在 `source`** |
| **L364** | `A_DIR=/opt/5151-shadow/web-a` | A 組指向 NAS 本地目錄 |
| **L369** | `sed -i "s\|^V3_IMAGE=.*\|V3_IMAGE=${IMAGE_PIN}\|" "$A_ENV"`（或 append） | A 組**只改 `<dir>/.env` 的一行** |
| **L375** | `docker compose config --format json`（cwd = `$A_DIR`） | 用**主機本地** compose 渲染，不是 repo 版 |
| **L416–417** | `B_DIR="$HOME/5151-shadow/web-b"`；`DOCKER=/usr/local/bin/docker` | B 組同上（也對上 syn-nas 非互動 PATH 沒有 `docker` 這件事） |
| **L422** | B 組 sed 改 `.env` 的 `V3_IMAGE` | 同上 |

**整個 workflow 沒有任何一步把 repo 的 shadow web compose 複製到 NAS，也沒有任何一步去讀它。**

### 4.2 `.env` 無效（會被發版改寫，而且備份也留不住）

| 行 | 內容 |
|---|---|
| L369 / L422 | `sed -i` 重寫 `V3_IMAGE=`（A/B 各一） |
| L367 / L420 | `cp -p "$A_ENV" "$A_ENV.bak"` —— **每版都蓋掉上一份 `.bak`** |

⇒ **要改 web 容器的 env，改 NAS compose 的 `environment:`（或它 `env_file:` 指向的 secrets 檔）；
改 `.env` 無效。**
（NAS compose 內原生的註解就是這樣寫的：「`deploy-v3.yml` 每次發版都會覆寫本目錄的 `.env`，
寫 `.env` 會被蓋掉」。）

### 4.3 回滾方式（2026-10-11 實際用過）

```bash
# 兩台各自：
cp -a docker-compose.yml.bak-20261011-cache docker-compose.yml
docker compose up -d --no-build --force-recreate 5151-web-A     # casa-nas
/usr/local/bin/docker compose up -d --no-build --force-recreate 5151-web-B   # syn-nas（非互動 PATH 沒有 docker）
```

回滾後實測（唯讀）：

```
5151-web-A  StartedAt=2026-10-11T10:15:43.287838794Z   （台北 18:15:43）
5151-web-B  StartedAt=2026-10-11T10:15:57.578604306Z   （台北 18:15:57）
兩台的 image 皆為 ghcr.io/fyun48/5151@sha256:0b143434…（同一顆）
之後 printenv MEMBER_LISTING_CACHE / …_FRESH_MS 皆為空（exit 1）
```

## 5. 附錄：web A/B compose 的 repo／NAS 既有漂移（2026-10-11 盤查）

基準：repo master `b5b1399`。

| | repo 版 | NAS 正本 |
|---|---|---|
| web-a | `deploy/shadow-ha/web/web-a/docker-compose.yml` **53 行** | `casa-nas:/opt/5151-shadow/web-a/docker-compose.yml` **37 行** |
| web-b | `deploy/shadow-ha/web/web-b/docker-compose.yml` **101 行** | `syn-nas:/var/services/homes/tori/5151-shadow/web-b/docker-compose.yml` **62 行** |

`diff -u`（取檔一律 `ssh <host> cat <path>`）：**web-a 單一 hunk `+19 / -33`；web-b 單一 hunk `+29 / -65`。**

> 兩邊都含敏感字面值（NAS 有明文 R2 帳號 id／zone id 等）。**本文件、PR、commit 一律不出現任何值**，
> 只以「鍵名＋行號＋遮罩」呈現（F-0003）。

### 5.1 NAS 有、repo 沒有

| 項目 | web-a 位置 | web-b 位置 |
|---|---|---|
| `env_file:` → 主機 secrets 檔 | NAS L12–13（`/opt/5151-shadow/secrets/web-a.env`） | NAS L9–10（`…/secrets/5151-web-B.env`）、L43–44（`…/secrets/5151-worker.env`） |
| `PUBLIC_LISTINGS_SQL_FIRST: "1"` | NAS L22 | NAS L19 |

`env_file` 內的**鍵名**（**只讀鍵名，值未讀、未驗證**）：三個檔完全相同、各 5 鍵 ——
`PG_URL`、`R2_ACCESS_KEY_ID`、`R2_PURGE_TOKEN`、`R2_SECRET_ACCESS_KEY`、`SESSION_SECRET`。

### 5.2 repo 有、NAS 沒有

- `SESSION_SECRET: ${SESSION_SECRET:?…}`（a L23；b L23、L66）
- `PG_URL: ${PG_URL:?…}`（a L25；b L25、L73）
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_PURGE_TOKEN`（a L38/39/44；b L86/87/92）—— NAS compose 沒有這三把，實測在 `env_file` 內
- web-b `5151-worker` 的 `OPS_FEEDBACK_DELIVERY` / `OPS_INGEST_URL` / `OPS_INGEST_SECRET`（L70–72）
- 一批「去識別化模板」用的說明註解（a L2–8、L12、L16、L26、L28–30、L32–35、L50；b 對應各段＋L54–55）
- 檔尾多一個空行（a L53；b L101）

### 5.3 同一鍵不同值（12 組）

| 鍵 | repo 版 | NAS 版 | 判讀 |
|---|---|---|---|
| `image` | `${V3_IMAGE:?…}`（**必填**，缺就 fail） | `${V3_IMAGE:-ghcr.io/fyun48/5151@sha256:43bd376c…}`（硬編一顆**舊** digest 當預設） | repo 較嚴；NAS 的預設值不是現行版本（實跑由 `.env` 蓋掉） |
| `DB_DRIVER` | `${DB_DRIVER:-postgres}` | 字面 `postgres` | 等價 |
| `PG_SQLITE_FALLBACK` | `${PG_SQLITE_FALLBACK:-strict}` | 字面 `strict` | 等價 |
| `PG_NO_SQLITE_OPEN` | `${PG_NO_SQLITE_OPEN:-1}` | `${PG_NO_SQLITE_OPEN:-0}` | ⚠️ **預設值不同**（repo 模板較安全） |
| `MEDIA_SERVE` | `${MEDIA_SERVE:-local}` | 字面 `"r2"` | 環境差異（NAS 已開 CDN） |
| `R2_ACCOUNT_ID` | `${R2_ACCOUNT_ID:-}`（空預設） | 字面值 **`<MASKED>`**（長度 34） | repo 是佔位 |
| `R2_BUCKET` | `${R2_BUCKET:-}` | **`<MASKED>`**（12） | 同上 |
| `R2_ENDPOINT` | `${R2_ENDPOINT:-}` | **`<MASKED>`**（67） | 同上 |
| `R2_MEDIA_DOMAIN` | `${R2_MEDIA_DOMAIN:-}` | **`<MASKED>`**（31） | 同上 |
| `R2_ZONE_ID` | `${R2_ZONE_ID:-}` | **`<MASKED>`**（34） | 同上 |
| web-a `volumes[0]` | `${WEB_A_DATA_DIR:-/opt/…}` | 字面 `/opt/…` | 等價 |
| web-b `volumes[0]` | `${WEB_B_DATA_DIR:-~/…}` | 字面 `~/…` | 等價 |

### 5.4 差異成因

行數差幾乎全部來自三件事，**不是**兩邊跑不同版本：

1. **NAS 把 5 個敏感鍵從 compose 抽到 `env_file:`** → NAS 行數比 repo 少的主因。
2. **NAS 把 `${VAR}` 插值寫成字面值** → 5.3 那 12 組。
3. **repo 多出一批模板用註解與檔尾空行。**

唯一要留意的**行為**差異是 `PG_NO_SQLITE_OPEN` 的預設值（repo `1` vs NAS `0`）。

### 5.5 誰是權威

- **程式碼與發版流程**：GitHub `github.com/Fyun48/5151`（repo 根 `AGENTS.md`「專案來源（唯一權威來源）」）。
- **這兩個 shadow web 節點的 runtime 設定**：**NAS 本地檔**（第 4.1 節的 L286／364／416 查證）。
  repo 那兩份的**檔頭自我描述**就是「去識別化的模板，實際在跑的正本是主機上的…」（a L5–8、b L5–8），
  `deploy/shadow-ha/web/README.md` L67–69 也寫「重跑下面的指令會用模板覆蓋主機設定（含 secret）」。
- 兩邊**已經漂移**，而且**目前沒有任何機制會發現漂移**。

### 5.6 建議（只寫建議，**本次未實作**）

1. **短期（純唯讀）**：加一條 shadow-ha compose 漂移檢查——用 `ssh <host> cat <path>` 取回 NAS 正本
   （**不要用 scp**：DSM 沒有 sftp 子系統，會 `Connection closed`），與 repo 版做正規化後的比對：
   非敏感鍵比「鍵是否存在 ＋ 值是否相同」；**敏感鍵只比鍵名**，值永不落地；只出報告，
   **不寫任何檔、不重啟任何容器**。掛在發版後或獨立 `workflow_dispatch`，
   **不要**放進 `deploy-v3.yml` 的阻斷路徑（免得發版被影子站的漂移卡住）。
2. **中期**：把 NAS 正本的**非敏感**鍵收回 repo 當唯一來源；敏感鍵一律留 `env_file`——
   建議**在 repo 模板補上 `env_file:` 這一行**當契約（目前 repo 完全沒有這行，是差異最大的一塊）。
3. **不建議**現在就用 repo 覆蓋 NAS 正本：會弄丟 `env_file:` 結構與 5 個明文值。
   若要單一來源，順序應是「**先**把 NAS 現值（遮罩後）反寫回 repo 模板 → **再**加校驗」。

## 6. 未驗證 / 已知限制

- 第 2.4 節的三個延遲數字來自 **Owner 實測回報**，本文件作者**沒有重現**。
- 第 2.3 節的計時是**在 primary 上用 psql 量**，不等於 Node 應用內的實測值（模組註解自述 3ms 上下）。
- NAS 的 `env_file` **只讀鍵名**，值未讀、未驗證 ⇒ 5.1「鍵名相同」不代表值相同。
- 第 3 節的方向**未實作、未驗證**。
- 本次盤查基準是 repo master `b5b1399`；共享 checkout `/workspace/repos/5151` 停在 `d4854a0`，
  那份已舊（例如 `PG_NO_SQLITE_OPEN` 還停在 `:-0`），**不要拿它當基準**。
