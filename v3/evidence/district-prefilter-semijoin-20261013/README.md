# 行政區投影預篩改寫成「查詢內 semi-join」：**實測否決**（2026-10-13）

**狀態**：已量測、**未落地**。基準 `master = 67d0e62`。
依任務規格「效能門檻…若不達 −30% 就不要硬上，回證據」⇒ 本包**不含行為變更**，
只留可重跑的量測與一支鎖住載體形狀的離線測試。

---

## 1. 要驗的假設

規格假設：把行政區預篩從「Node 端取回 27,317 個 id → `post_id = ANY(?::bigint[])`」
改成查詢內 semi-join，可以省掉

* id 搬運（每請求 2 次 `SELECT post_id FROM listing_search_projection WHERE district = ANY(...)`，合計 37ms）
* 27k 個 `listings_pkey` 隨機探測（~35ms）
* 27,317 個 bigint 的參數解析／規劃（DECLARE 內 ~50ms 的一部分）

## 2. 量測（唯讀；隔離靶）

靶：`CREATE DATABASE mlattr_<pid> TEMPLATE repro2`（184,754 列，與 repro／repro2 逐表同列數），
收尾 `DROP DATABASE … WITH (FORCE)`（L-0863）。會員 `uid=1`、請求行政區 `大安區`、`limit=20`，
每發前對 `data_revision` 插入 4 列（模擬正式站爬蟲讓版本號前進，避免凍結快照讓版本化快取命中）。

探針用**真的 builder**（`prepareStatsScope`／`prepareListScope`／`buildScopeScanQuery`）組出一趟掃描
實際送出的那條 SQL，四種寫法並排、同一組述詞、同一批參數（只把 id 陣列換成行政區名稱）、交替各 5 輪取中位：

| 寫法 | exec 中位 | planning | 讀取 block | heap filter 移除列 | 列數 | 逐列結果 |
|---|---|---|---|---|---|---|
| **V0 現況** `post_id = ANY($n::bigint[])` | **111.6–145.1ms** | 12.3ms | 0–18,033 | 17,975 | 10,505 | 基準 |
| F1 `EXISTS (相關子查詢)`（規格原文） | 376.1–403.3ms | 3.7–4.4ms | 43,922 | **176,873** | 10,505 | 逐列相同 |
| F2 `post_id IN (子查詢)` | 377.4–384.0ms | 3.2–3.6ms | 43,898–43,922 | 176,873 | 10,505 | 逐列相同 |
| F3 `post_id = ANY(ARRAY(子查詢))` | 1,441–1,450ms | 3.4ms | 23,222 | 17,975 | 10,505 | 逐列相同 |

**F1 對 V0 ＝ −250%（慢 3.5 倍）**；F2 −233%；F3 −1151%。
「逐列相同」是逐筆比對 10,505 列的 `(post_id, in_list_scope, in_stats_scope)` 三元組（差異 0 筆）
⇒ 這是**純效能**差異，不是語意差異。

## 3. 為什麼會慢（EXPLAIN 可證）

```
V0： Bitmap Heap Scan listings rows=10505
       BitmapAnd
         BitmapOr  Bitmap Index Scan idx_listings_search  rows=179864
         BitmapOr  Bitmap Index Scan listings_pkey        rows=16597   ← 會員七區（16,600 個 id）
         BitmapOr  Bitmap Index Scan listings_pkey        rows=5142    ← 大安區
                   Bitmap Index Scan listings_pkey        rows=5575    ← 關係閉包 id

F1/F2： Bitmap Heap Scan listings rows=10505  removed=169359        ← 只剩 COMMON 的 bitmap
          BitmapOr  Bitmap Index Scan idx_listings_search  rows=179864
          Bitmap Heap Scan listing_search_projection rows=5142/16600（SubPlan，各 1 次）
```

`post_id = ANY(bigint[])` 的陣列是**可索引的條件** ⇒ PG 能替行政區建 bitmap 再與其它 bitmap 做
**BitmapAnd**，heap 掃描因此只看得到 1 萬列所在的頁面。
改寫成子查詢後，那個條件變成 **SubPlan／hashed SubPlan**：不是可索引條件 ⇒ 行政區縮窄整項掉出
bitmap，退化成 heap filter（`Rows Removed by Filter = 169,359`），要讀 179,864 列的頁面
（讀取 block 18k → 44k）。PG 也**沒有**把它去關聯化成 hash semi-join——即使 `IN (子查詢)` 也一樣。

換句話說：規格要省的三項（id 搬運 ~37ms、pkey 探測 ~35ms、參數解析 ~50ms）是真的存在，
但代價是把「bitmap 前置縮窄」整項弄丟（+250ms）。**淨值大幅為負。**

## 4. 這一包做了什麼、沒做什麼

**做了**：
* `v3/scripts/district-prefilter-semi-join-probe.mjs`（可重跑探針，見 §5）
* `v3/test/district-prefilter-carrier.test.js`（鎖住載體形狀＋說明否決理由）

**沒做（依規格的「不達 −30% 就不要硬上」）**：
* 沒有加 `loadDistrictPrefilterIds({semiJoin})` 選項、沒有 builder 的 semi-join 分支、
  沒有把呼叫端切過去 ⇒ **沒有留下任何跑不到的死碼**
* 沒有動 `districtProjectionVerified()` 的 se-p7／se-p8 守門（一個字都沒動）
* 沒有動 `listing_search_projection` 的 revision 快取語意

## 5. 重跑指令

```bash
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_URL="$PG_SNAPSHOT_REPRO2_URL" MEMBER_UID=1 DB_DRIVER=postgres
node v3/scripts/district-prefilter-semi-join-probe.mjs --district 大安區 --rounds 5
node --test v3/test/district-prefilter-carrier.test.js
node --test v3/test/listing-district-prefilter.test.js      # 守門原樣綠
```

（探針只送 `SELECT`／`EXPLAIN`；會在輸出開頭印出靶的資料庫名，並拒絕非隔離資料庫。）

## 6. 建議（掃描這一塊還能怎麼砍）

掃描的 111–145ms 幾乎全在 **heap 讀取**（10,505 列散落在 16k–18k 個 8KB 頁），
其次是 flag 運算式（~35ms）與參數解析／規劃（~50ms）。**沒有非 DDL 的一刀 ≥30%**：

1. **覆蓋索引**（例如把 `(post_id, xmin, ctid)` 或 district 相關欄位蓋進索引）——屬 DDL，需 Owner 核准。
2. 縮小候選集合（產品決策；`totalMatched` 必須來自完整候選集的不變量見 D-0036）。
3. 參數去重（旗標沿用 WHERE 的同一個 `$n`）：實測 **−8.4%**，可以順手做，但不到門檻。
