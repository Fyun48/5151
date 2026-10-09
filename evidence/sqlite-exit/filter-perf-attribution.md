# 篩選速度慢：正式站歸因（2026-10-10 00:4x–01:0x）

## 量測失誤先講明（不要引用錯數字）
- 我先前在 casa-nas 用 `http://127.0.0.1:5153/...` 量的「28.9 秒」**不是 web 容器**：`5151-web-A` 的 host 埠在開閘重建後是 **`15153`**（`docker inspect` → `{"5153/tcp":[{"HostIp":"0.0.0.0","HostPort":"15153"}]}`），`127.0.0.1:5153` 在 host 上**連不上**，`curl` 回 `code=000 ms=0.001`。所以任何「1 ms」都是**失敗的快速返回**，不是快。
- 之後的數字一律用**容器內直連** `http://127.0.0.1:5153`（在 `5151-web-A` 內，`docker exec … node -e require("http").get`）與**公網**兩條路各量一次。

## 真正的端到端數字（同一支 request，重複三次）
| 來源 | 結果 |
|---|---|
| `5151-web-A` 容器內直連（`kind=whole&sort=newest&limit=5`） | `code=200 ms=27877`、`ms=27350`（連發）**bytes=30653** |
| 公網 `https://jibbyrenth.reversalplay.me/...` 同參數 | **45897 ms**（公網比容器內還慢一截，含 HAProxy→tunnel 與另一台 web-B 的機率） |
| 抓取輪次是否 concurrent | 量測當下 `--since 4m` **0** 條輪次日誌（非輪次期間） |

## 歸因：Node CPU，不是 PostgreSQL
同一發 request 進行中，每 4–5 秒連續取樣 `docker stats`：
| 取樣 | `5151-web-A` | `5151-postgres-A` | PG `active` 查詢 |
|---|---|---|---|
| t+2s | **82.33%** | 42.41% | — |
| t+6s | **79.36%** | 46.36% | — |
| t+11s | **93.88%** | 23.18% | — |
| t+15s | **108.05%** | **1.18%** | **0 active, max 0.0s** |
⇒ SQL 只在最前面 1.6–2 秒有重量（與 `EXPLAIN (ANALYZE)` 的 ~1.6s 一致），**其餘約 25 秒是 web 容器在單核以上跑 JS**：把 16.7 萬列候選變成 JS 物件 → 7 道過濾 → 全量排序 → 才取前 5 筆。

## 為什麼隔離庫只跑 5 秒（外推要打折的原因）
- 差分/par 工具是在 **DSH 主機**（`AMD Ryzen Embedded R1600`，4 邏輯核）用 `node` 直連正式 PG 的 `repro` 库跑的；正式 web 跑在 **casa-nas：`Intel Celeron N3450 @1.10GHz`，4 核，load 平均 1.9–3.1**，同機还要養 `5151-postgres-A`（PRIMARY）＋`591-tracker-v3`。
- 資料量差只有 1.55 倍（127,088 → 182,954 列），**_speed 差 ~5 倍主要是單執行緒 CPU 與記憶體頻寬_**。
⇒ 結論：**在 NAS 等級硬體上，「每個 request 重做一次全量過濾＋排序」這個架構本身就不能要**；要嘛把每 request 的工作量降到 O(頁)，要嘛讓一份工作被大量 request 共用（precompute／快取）。

## 已做／已排除的修法（實測依據）
| 做法 | 狀態 | 實測 |
|---|---|---|
| 候選欄位 42 → 36 欄（#688，`3eeed79`） | 已合併，**未發版** | repro：baseline p50 5152→4828ms、`kind=whole` 5277→4752ms；EXPLAIN row width 739→662B，**Buffers 幾乎不變**（整表都得進 buffer）⇒ 省 ~10%，**不是大砍** |
| `pg_trgm` GIN 索引 | 隔離庫已建並量過 | 對 `套房`（命中率 18.6%）**無效**，前後都是 Seq Scan（253→240ms）⇒ 只救高選擇性關鍵字/編號 |
| SQL-first／投影下推（LIMIT/COUNT） | **不准上線** | 30 combo parity 全過不了：漏 `same_house_role==="affiliate"`（多算 20,502 筆）；`searchKeys` 誤展開（少算 2,265 筆）；寫入端固化回填一致率 92.89% |
| 訪客快取用 `data_revision` 當 generation（#685） | 等 rebase 合併 | 隔離庫 cold **1522ms** → warm **26–45ms**；bump 後必 miss。前提的 bump 覆蓋已由 #687 補 17 個寫入點 |

## 下一步的兩條路（要 Owner 拍，因為一條要動正式庫結構）
1. **把「同屋源主卡/次卡」變成 SQL 可表達**：`preferPrimaryListing` 現在要在讀取時解析 `comparable_rent` 裡的**相對時間字串**（「16 小時內更新」）與 `last_seen_at`、`tie_break_key`。做法是**寫入時把可比較租金與刷新時間固化成數值欄**（`ALTER TABLE … ADD COLUMN` ＋回填 182,954 列），再用視窗函式在 SQL 內算 role ⇒ 才能 LIMIT/OFFSET 下推＋真 COUNT。需要正式庫結構變更與回填**核准**；可先在 `repro` 證明 100% 一致再上。訪客（`uid=0`）的 `splitPairs` 是空的，所以**訪客路的 fold 只取決於資料本身**，這是这条路可行的關鍵。
2. **不動結構，改成「一份工作大家共用」**：把全量過濾＋折疊**每個 revision 只做一次**（單飛＋去抖，避免抓取輪次每寫一筆就重算），各篩選參數在那份結果上繼續做。代價：Celeron 上一次重算 ~25 秒 CPU，要去抖窗口抓得準；好處：零 schema 變更、可立刻回退。
