# PR-B 發現：Node 路徑的行政區子句在 PostgreSQL 上不合法（2026-09-24）

## 一、現象（實跑，未修改行為）

以 `searchListingsNodePg`（B3 新路徑）對真實 PG 跑西屯區查詢時，PG 直接拒絕：

```
error: recursive reference to query "district_related" must not appear within its non-recursive term
  file: 'parse_cte.c', line: '1070', routine: 'checkWellFormedRecursionWalker'
  position: '3411'
```

## 二、根因（程式位置）

`v3/src/listDistrictSql.js:19` `appendDistrictCandidates(names, clauses, params, { preserveRelationsFor })`：
當帶了 `preserveRelationsFor`（＝投票/配對用的使用者）時，它會產生一個**含多個 recursive 分支**的 CTE：

```sql
post_id IN (
  WITH RECURSIVE district_related(post_id) AS (
    SELECT post_id FROM listings WHERE (<district alternatives>)     -- non-recursive
    UNION SELECT l.match_post_id FROM district_related connected …    -- recursive #1
    UNION SELECT l.post_id       FROM district_related connected …    -- recursive #2
    UNION SELECT peer.post_id    FROM district_related connected …    -- recursive #3（個人同屋源群組）
  )
  SELECT post_id FROM district_related
)
```

SQLite 允許 `non_recursive UNION rec1 UNION rec2 …`；**PostgreSQL 只允許一個 non-recursive term 與一個 recursive term**，
且要求自我引用出現在 recursive term 的 FROM 頂層 ⇒ 直接執行會被 parser 拒絕。

## 三、為什麼之前沒被抓到（我的驗證缺口，需更正）

- 我先前所有端到端等價性檢查（`kind`／`q`）都用**stub deps**（`appendDistrictCandidates: () => {}`）把行政區子句關掉，
  所以「SQL 文字在 PG 上是否可執行」這件事**沒有被涵蓋** ✗。這是我的驗證設計缺口，不是別人的錯。
- 影響範圍：**PG-fed Node 路徑（B3）在「會員查詢帶行政區」時必然失敗** ✗（而會員查詢幾乎一定帶行政區 ✗）。
  既有的 SQL-first 路徑不受影響（它用不含 `preserveRelationsFor` 的簡化形式 `p.district IN (…)` ✓）。

## 四、解法選項（建議 (B)）

| 方案 | 內容 | 評估 |
|---|---|---|
| **(A) 改寫成 PG 也合法的 CTE** | 把多個 recursive 分支合併成單一 recursive term | PG 要求自我引用在 recursive term 的 FROM 頂層，合併後往往需要 derived table 而仍不合法；改寫風險高，且要同時維持 SQLite 行為 |
| **(B) 在 PG 端先算 closure，再把 id 集合當條件（建議）** | PG＋Node 路徑先用**PG 專屬**的 recursive 查詢（或分批 BFS）算出 `district_related` 的 id 集合，再把該集合以 `post_id IN (…)` 形式交給共用的子句建構 | 語意與 Node 相同（同一組 predicates）；SQL 端不需要 CTE ⇒ 無 dialect 風險；代價是多一次查詢與 id 集合大小（本案候選規模約 6 千，可接受）；需要在 `buildListListingsClauses` 增加「已算好的行政區 id 集合」入口 |
| **(C) 把 `preserveRelationsFor` 的關係展開留在 Node** | 先取「行政區候選」再在 Node 展開關係 | 展開需要遞移查詢，等於把 (B) 搬到 Node，成本更高 |

**驗收**：以本篇第一節的指令重跑 `node_pg`（真實行政區）必須成功，且與 SQLite Node 的結果在 B5 的雙向差集下為空。

## 五、對計畫的影響

- B3 的**效能量測被此項阻塞**（跑不到成功查詢就無法量 p95／RSS／lag／查詢數）。
- 新增工作項 **B3b：行政區 closure 的 PG 化（建議採 (B)）**，排在 B5 之前。
- 我對先前「端到端等價性」的說明需補一句：那些檢查涵蓋的是 **kind／q 述詞與資料**，
  **不含**「整條 Node 子句組在 PG 上可執行」這件事；B5 的完整管線 parity 才會涵蓋它。
