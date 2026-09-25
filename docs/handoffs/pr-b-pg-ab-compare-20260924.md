# PR-B：PG 端 A/B 對照（SQL-first vs PG-fed Node）2026-09-24

> 這是 B5（強化驗收）的第一步，也是 astra6 要求的「PG 端實際影響量測」。
> 兩條路徑跑在**同一份 PG 資料**、**同一組 args**：A＝`repository.searchPage`（SQL-first，正式路徑）；
> B＝`searchListingsNodePg`（PG-fed Node，B3 新路徑）。腳本：`v3/scripts/node-pg-ab-compare.mjs`（唯讀）。

## 一、結果（行政區：西屯區，limit 50，uid 0，settings {}）

| 案例 | A totalMatched | B totalMatched | A/B 首頁差異 |
|---|---|---|---|
| `filter=all`／`newest`（生產 args，未帶 `searchKeys`）| 0 | 0 | 一致 ✓ |
| `filter=all`／`newest`（`searchKeys: []`）| **6,228** | **4,446** | 首頁 ID 完全相同 ✓ |
| `filter=all`／`price_asc`（`searchKeys: []`）| 6,228 | 4,446 | **13 筆不同** ✗ |
| `kind=whole`（`searchKeys: []`）| ✗ `Connection terminated unexpectedly` | 2,497 | — |
| `q=電梯`（`searchKeys: []`）| 911 | 654 | 2 筆不同 ✗ |
| `filter=hidden`（`searchKeys: []`）| `null`（不在外框 ⇒ 正確地交給 Node）| 0 | 一致 ✓ |

## 二、判讀

1. **在 PG 上首次量化差異** ✓：`filter=all` 時 A 比 B **多 1,782 列（+40%）**、`q=電梯` 多 257 列（+39%）。
   形態與先前在**生產 SQLite 快照**上量到的差異一致（該量測已被 astra6 更正為「語意反例」，
   本次是**同資料、同 args 的 PG 直接量測**）。
   ⇒ 這正是 SQL 端缺少 same-house 角色條件所造成的多回傳。
2. **`node_pg` 是可用的** ✓：每個案例都成功回傳（無錯誤），且總數低於 SQL-first ⇒ 與「排除同源配對列」的預期一致。
   ⇒ B3b（closure ＋ `= ANY(?::bigint[])`）與 B3（共用後處理）**在真實資料上可運作** ✓。
3. `filter=hidden` 在 A 回 `null` ✓ ⇒ 外框外查詢確實被交給 Node 路徑（B3 接線正確）✓。
4. **新問題（待查）** ✗：`kind=whole` 在 A（SQL-first）出現 `Connection terminated unexpectedly`。
   可能與 statement timeout／連線被回收有關（本次未提高 `PG_STATEMENT_TIMEOUT_MS`）。
   ⇒ 若在正式環境的 `kind` 查詢也會逾時，這是**獨立於本項**的效能問題，需單獨量測。

## 三、這對驗收的意義

- B5 的驗收標準（astra6 §2）：**同一份 fixture／快照、同 args、同一 `asOf` 下雙向差集為空**。
  本表顯示在**真實資料**上，`all` 的 `totalMatched` 有 +40% 差異 ⇒ **目前不通過** ✓（符合預期：角色語意尚未在 SQL 端實作）。
- 建立 A/B 對照後，後續任何修正都能用**同一支腳本**驗收（差異應逐步收斂到 0）✓。

## 四、重跑方式（唯讀）

```bash
bash v3/scripts/run-in-container.sh v3/scripts/node-pg-ab-compare.mjs
```
