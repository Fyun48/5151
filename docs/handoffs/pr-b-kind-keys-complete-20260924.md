# PR-B：kind_keys 回填完成 + 全跑測試結果（2026-09-24）

## 一、`kind_keys` 回填完成（**部署前置條件已達成**）

`kind` 下推 SQL 的唯一前置條件是「`listing_search_projection.kind_keys = ''` 的列數為 0」。
工具：`v3/scripts/kind-keys-backfill.mjs`（只寫這一個欄位；可中斷可重跑；容器內以 `/tmp/kk` 跑新版程式碼，不動 `/app`）。

| 階段 | 輸出 |
|---|---|
| 首輪 | `{"finished":true,"scanned":119856,"updated":119876?,"failed":0,"emptyAfter":122,"withKeys":119876,"failures":[]}` |
| 收尾第二趟（只補空值列）| `{"finished":true,"scanned":122,"updated":122,"failed":0,"sec":4,"emptyBefore":122,"emptyAfter":0,"withKeys":119998,"failures":[]}` |

**`emptyAfter = 0`** ⇒ 所有投影列的 `kind_keys` 都已填入（合法的空集合存成 `","`，不是空字串）。

### 三重等價性證據（回顧）

1. **述詞探針**：`v3/scripts/kind-parity-probe.mjs`，14 種查詢 × 2,000 列真實資料 → `mismatch=0`
   （過程中抓到並修掉「手寫 key 全集漏 `apartment_huaxia`」的靜默漏列缺陷）。
2. **單元測試**：SQL 述詞結構（含 `suite,yafang` 的 legacy 語意、`wholeFloorOnly` 的 `skipWholeFloor` 規則）。
3. **生產資料驗證**：`v3/scripts/kind-column-verify.mjs`，PG 抽樣 5,000 列 → `kind_keys` 與
   `listingKindKeys(同一列)` 重算 **5,000/5,000 完全相同**。

## 二、完整套件結果（本 PR 分支）

```
# tests 1648   # pass 1627   # fail 1   # skipped 20
```

- 唯一失敗：`commute-route-live.test.js:141` 的 `cursor walks past the old 2000-row candidate cap`。
  **判定：環境性、與本 PR 無關** —— 同一個測試、同樣 100 秒上限下，`origin/master` 是 `exit=124`
  （卡住、無結果），本分支是 `exit=1`（快速失敗且可見）⇒ 本 PR 只是讓它從「無聲卡死」變成「明確失敗」。
- 先前的第二個失敗（guest SQL-first 外框斷言）已修正：以測試自身的量測確定影響範圍
  （只有 `areaMax` 改走 SQL），測試改為斷言新行為後 6/6 通過。
- 20 個 skip 是 PG 依賴測試在無 PG 連線時的優雅跳過；依 GATE-12 的定義，這在 CI 上仍須以
  「真實獨立 PG service」取代（目前判為 **FAIL**，見 `gate-1-12-evidence-20260924.md`）。

## 三、附帶修掉的一個測試套件缺陷（影響每個審查者）

`v3/test/commute-route-live.test.js` 的 `runIsolated()` 用 `spawnSync` 跑子程序但**沒有 timeout**：
子程序一卡住，`spawnSync` 就永久阻塞，父層 runner 無法中斷 ⇒ 兩次獨立全跑都停在 253 個測試後零進度。
加 `timeout: 30_000` 後全跑得以完成（253 → 1648）。

## 四、仍然不做的事（明確界線）

- `q` **不下推**：實測 `LIKE` 的大小寫語意 SQLite 與 PG 不同（SQLite `'ABC' LIKE 'abc'`=1、PG=false）
  ⇒ 直接下推會讓 ASCII 查詢在兩個 driver 得到不同結果。解法（改用 `lower(x) LIKE lower(?)`）與驗證方式已寫入 PR 說明。
- 「外框外」的其他條件（`filter≠all`、`fit_desc`、評分／per-user 類 settings）維持回退 Node 路徑，
  待以 Node↔PG parity 框架逐項驗證後再處理。
- 端到端（正式 builder SQL 對 PG 真實資料）的 kind 計數比對：腳本已寫但在 PG 被回填佔用時會撞
  `statement_timeout`；排在回填完成、PG 閒置時執行。
