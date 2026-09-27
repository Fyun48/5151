# 正式站 PG：9 個 identity 序列落後，導致寫入撞主鍵（2026-09-27）

> 本文只寫**我自己實測**到的東西。所有數字都是 2026-09-27 從正式站
> （`PG_TEST_URL` 直連 `192.168.0.220:15432/5151_shadow`）**唯讀**查出來的，可重跑。
> 撰寫者：DeepSeek Harness（DSH）。

## 一、結論（先講）

**正式站的 PostgreSQL 有 9 個 identity 序列處於「下一個值 ≤ 目前最大值」的狀態。**
在這種狀態下，任何**不指定 `id` 的 INSERT** 都會拿一個已經存在的 id，直接撞主鍵：

```
duplicate key value violates unique constraint "<table>_pkey"
```

其中 `admin_audit.id` 這一項**已經在造成實際損害**：`#521` 之後管理員稽核走 PG，
但每一筆都失敗——而且被 `auditReq()` 的 fire-and-forget `.catch(() => {})` **完全吞掉**，
所以 12 天來沒有任何日誌或告警。

`admin_audit` 目前只有 **1 列，`at` = 2026-09-15T08:18:16.680Z**（就是資料匯入的那一列）。
這 12 天內實際發生過的管理操作（`same_house_reconcile`、`same_house_confirm`、
`crawl_sources_save`…）**一筆都沒有進到稽核表**。

## 二、怎麼發現的

不是靠讀程式碼，是靠**對真 PG 跑一次 live 測試**。

我為 `/api/listings/:id/reject-match` 的 PG 分支寫了離線 parity 測試（用記憶體 SQLite
當 PG 替身，12 項全綠、變異測試 16/16 KILLED），看起來已經很紮實。
接著把**同一個函式**接到隔離環境的真 PG（NAS 上 `prb-repro-pg`，PG 16.14）跑，第一次就失敗：

```
[pg] failed query after 21ms :: duplicate key value violates unique constraint "user_match_signals_pkey"
  :: INSERT INTO user_match_signals (user_id, post_id, peer_id, type, weight, created_at)
     VALUES ($1, $2, $3, 'split', 1, $4)
```

**離線夾具抓不到這個**——SQLite 的 `AUTOINCREMENT` 會自己維護計數器，
所以「匯入時帶明確 id、序列沒前進」這個情境在 SQLite 上根本不存在。
這正是 `CUTOVER-STALL-ROOTCAUSE` 記過的同一類教訓：全離線測試會讓
「在真 PG 上不成立」的問題直接上線。

## 三、根因

匯入資料時，資料列是**帶著明確 id** 寫進 PG 的；identity 序列沒有跟著前進，
停在 `last_value = <max> AND is_called = false`。PostgreSQL 的語意是：

| 序列狀態 | `nextval()` 回傳 |
|---|---|
| `last_value = N, is_called = true` | `N + 1` |
| `last_value = N, is_called = false` | **`N`（就是 N 本身）** |

所以 `last_value = max = 1, is_called = false` → `nextval()` 回傳 **1** → 撞到既有那列 `id = 1`。

而失敗的 INSERT 仍然會把序列推進（序列不參與交易），所以**第一次失敗之後狀態會從
`is_called=false` 變成 `is_called=true`**——這解释了為什麼我事後回頭看，
`user_match_signals` 的 `is_called` 已經是 `true`。

## 四、受影響清單（正式站實測，唯讀）

`information_schema.columns WHERE is_identity='YES'` 共 **75** 個 identity 欄位，
其中 **9 個**落後：

| 表.欄位 | 列數 | max | 序列 last_value | is_called | 下一個值 |
|---|---:|---:|---:|---|---:|
| `admin_audit.id` | 1 | 1 | 1 | false | **1** ← 已在造成損害 |
| `community_cache.community_id` | 7,352 | 6,614,338 | 6,613,267 | false | 6,613,267 |
| `demand_match_generation.id` | 1 | 1 | 1 | false | 1 |
| `feedback.id` | 1 | 1 | 1 | false | 1 |
| `feedback_outbox.id` | 1 | 1 | 1 | false | 1 |
| `listing_search_projection.post_id` | 127,842 | 2,699,975,575 | 2,699,912,194 | false | 2,699,912,194 |
| `support_page_config.id` | 1 | 1 | 1 | false | 1 |
| `system_announcements.id` | 1 | 1 | 1 | false | 1 |
| `user_match_signals.id` | 1 | 1 | 1 | false | 1 |

> 判讀注意：`listing_group_audits.id` 一度被我誤列（下一個=10、max=9，其實是**安全**的）。
> 原因是我第一版腳本用 BigInt 與 node-postgres 回傳的字串比較，寫出了錯誤的條件。
> 第二版改用 `Number()` 明確轉型重跑才得到上面這份清單。**凡是用程式判定的清單，都要人工核對邊界那幾筆。**

同一份檢查在隔離環境 `prb-repro-pg`（由生產 `pg_dump` 還原）也跑出**同樣的 8 個**
（少 `user_match_signals`，因為我先前的測試已把它的序列推進了）。
兩邊一致 ⇒ 這是**匯入流程**的產物，不是正式站獨有的怪狀態。

## 五、修法（已實作並在隔離環境驗證）

```bash
# 唯讀檢查（exit 1 代表有落後）
PG_SEQ_URL='postgres://…' node v3/scripts/pg-identity-sequences.mjs --check

# 修復（只動序列，不碰任何資料列）
PG_SEQ_URL='postgres://…' node v3/scripts/pg-identity-sequences.mjs \
  --repair --apply --database 5151_shadow
```

修復動作是 `setval()`：

| 情況 | 動作 | 效果 |
|---|---|---|
| `max > 0` | `setval(seq, max, true)` | 下一個 `nextval()` = `max + 1` |
| `max = 0`（空表） | `setval(seq, 1, false)` | 下一個 `nextval()` = `1` |

**只改序列，不改任何資料列**，必要時可以 `setval` 回舊值完全回溯。

腳本刻意的摩擦（避免誤觸正式站）：`--repair` 必須同時給 `--apply` **與**
`--database <名稱>`，且名稱要與 URL 裡的資料庫相符。三個守衛都已實測會拒絕。

### 隔離環境的完整驗證迴路

| 步驟 | 結果 |
|---|---|
| 對 `prb-repro-pg` 跑 live 測試（修復前） | **失敗**：`duplicate key … user_match_signals_pkey` |
| `--check` | 發現 8 個落後 |
| `--repair --apply --database repro` | 8 個全部 `OK` |
| `--check` 重跑 | **OK：75 個全部健康** |
| 對 `prb-repro-pg` 跑 live 測試（修復後） | **通過**（2/2，含 `getListingAsync` 完整裝飾鏈） |
| 刻意把序列弄回落後，再跑 live 測試 | **失敗，且訊息是可讀的**「identity 序列落後…請先跑 …--repair」 |
| 再次修復 | 恢復綠燈 |

## 六、這件事改變了什麼

1. **`reject-match` 的 PG 分支在正式站會 100% 失敗**，直到序列修好。
   所以這個修復是那個 PR 的**前置條件**，不是可選的加分項。
2. **`auditReq` 的政策要重新評估。** Owner 先前決定維持 fire-and-forget，理由是
   「稽核失敗不得擋住管理操作」、代價只是「極端情況下少一筆稽核」。
   實測結果不是這樣：稽核是**每一筆都失敗**、而且**錯誤被完全吞掉**，
   所以「有沒有效」根本看不出來。至少要讓失敗**看得見**（記 log／計數），
   否則任何稽核相關的判斷都沒有依據。
3. **其他 8 個欄位是潛在未爆彈**，規律相同：只要有一條路徑開始往那張表做
   「不指定 id 的 INSERT」，就會立刻撞。`listing_search_projection`（127,842 列）
   與 `community_cache`（7,352 列）的缺口最大，值得優先確認有沒有寫入路徑。

## 七、後續（Owner 已於 2026-09-27 決定並執行）

| 項目 | 決定 | 狀態 |
|---|---|---|
| 正式站序列修復 | **核准套用** | ✅ **已套用**（見下方證據） |
| `auditReq` 政策 | **保留 fire-and-forget，但讓錯誤看得見** | ✅ 已實作 |
| live PG 測試接進 CI | **接** | ✅ 已接 |

### 7.1 正式站修復：已套用，證據如下

```
BEFORE: [seq] 發現 9／75 個 identity 序列落後     (exit=1)
REPAIR: 9 個全部 OK（admin_audit、community_cache、demand_match_generation、
        feedback、feedback_outbox、listing_search_projection、
        support_page_config、system_announcements、user_match_signals）
AFTER:  [seq] OK：75 個 identity 欄位全部健康（next > max）   (exit=0)
```

**只動序列、沒有動任何資料列**——修復前後筆數完全相同：
`admin_audit=1`、`listings=127844`、`user_match_signals=1`。

> 尚未做的確認：沒有在正式站實際寫一筆稽核來驗證（那是 production 寫入，不在核准範圍內）。
> 目前的證據是「狀態正確（`next > max`）」＋「同樣的缺陷與同樣的修法已在隔離環境端到端驗證過」。
> **要到 100% 確定，最乾淨的方式是下一次真正的管理操作後看 `admin_audit` 有沒有增加**，
> 或看 `/api/health` 的 `audit_failures` 是否停在 0。

### 7.2 `auditReq` 的失敗可視性：已實作

契約**不變**（不 await、不擋管理操作），只讓失敗留下痕跡：

- `adminAuditAsync.js`：`appendAdminAuditAsync()` 內部 catch → 記數 → **再往外丟**
  （呼叫端行為完全不變）。
- 日誌：第一次一定印，之後每 100 次印一次（避免洗版）。印 log 的節奏用**獨立**計數器，
  刻意不與失敗計數共用——耦合的話，計數器一壞掉就會變成每次都印。
- `/api/health` 新增 `audit_failures` 欄位（正常為 0）。**`ok` 不因此變 false**，
  以免影響既有的健康判斷與自動重啟邏輯；要監控請看這一個數字。

測試：`v3/test/admin-audit-visibility.test.js`（4 項），變異測試 **6/6 KILLED**
（含一條**複合變異**：單獨把日誌節奏改回耦合版是等價變異、殺不掉，
必須與「計數器壞掉」同時發生才顯現代價——那正是解耦要防的情境）。

```bash
node --test v3/test/admin-audit-visibility.test.js
node v3/scripts/mutation-check.mjs v3/test/admin-audit-visibility.test.js
```

### 7.3 live PG 測試已接進 CI

`.github/workflows/test.yml` 的 PG job 多一行 `PG_LIVE_REPRO_URL="${PG_TEST_URL}"`
（指向該 job 自己的拋棄式容器）。安全性已確認：

- 該 job 自建 `postgres:16.14-alpine`，並在建構步驟**覆寫** `PG_URL`／`PG_TEST_URL`，不讀憑證庫。
- `pg-integration-setup.mjs` → `importStore()` 的 `resyncSequences` 預設為 `true`，
  會 `setval(seq, max+1, false)` ⇒ 序列健康，測試不會因此變紅。
- `test/deploy-safety.test.js`（13 項）仍然全綠——新增的變數不涉及 NAS／production secret。

> 未做：沒有把 `pg-identity-sequences.mjs --check` 排進任何定期檢查。
> 它很便宜（唯讀、75 個查詢），適合放進 predeploy 或每日巡檢；留給 Owner 決定。

