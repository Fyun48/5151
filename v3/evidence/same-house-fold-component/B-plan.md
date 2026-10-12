# (B) 方案：把「同屋源連通分量」固化成 `listings.fold_component_root`

> **狀態：等 Owner 核准欄位。本檔只是計畫＋可重跑指令，沒有 migration、沒有回填、
> 沒有對任何 PG 寫入。** 紅線：DB 一律唯讀；回填腳本若進 repo 需 Owner 同意（D-0022）。
> 本包（同一張 PR）只改 Node 路徑與前端，`foldRoleCte` 仍是 first-incident-edge，
> 因此 `fold-role-sql-parity.mjs` 目前會紅（見 §3 的實測）。

## 1. 為什麼需要固化欄（不能純 SQL 算）

讀取端的「一群一主」＝對 `候選列 ∪ extras` 的**無向連通分量**選主，分量來源有三：
① `match_post_id` 邊（`match_verdict <> 'no'`、兩端 display-ready、非 split）
② `listing_group_members` 群組（群內兩兩連通）
③ `user_same_house_members` 個人併組（只有 uid>0）

repro 隔離庫實測（2026-10-12，唯讀）：

| 指標 | 值 |
|---|---|
| `listings` | 184,736 |
| 有效 match 邊 | 74,579 |
| `listing_groups`／`listing_group_members` | 27,980 ／ 91,265 |
| 跨群邊／單端在群內／兩端都不在群內 | 226 ／ 3,076 ／ 4,911 |
| union-find（邊∪群）後節點／分量／最大分量 | 100,798 ／ 29,367 ／ 107 |

⇒ 群組 **不是**連通分量（226 條跨群邊會把兩個群黏起來），所以 `group_id` 不能直接當分量鍵。

純 SQL 連通分量的實測成本（同一池、`EXPLAIN ANALYZE` 輔助）：

| 做法 | 全表耗時 |
|---|---|
| `WITH RECURSIVE` min-label（全節點、免剪枝） | 69.7 s（66 次迭代，每次重掃 adj 14.9 萬＋seed 18.4 萬） |
| MATERIALIZED 鄰接、免剪枝 | 10.2 s（266,677 pairs） |
| 群組塌縮虛擬圖 | 3.3 s |
| 真實節點＋群組塌縮＋剪枝 | 4.2 s |

現行 guest SQL-first p50 = 2.88 s ⇒ 任何一條都不可接受。

## 2. 打算的 DDL（**尚未執行**）

沿用既有 `fold_*` 固化欄的形狀（`docs/same-house-fold-spec.md` §4.2）：

```sql
ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_component_root bigint;
COMMENT ON COLUMN listings.fold_component_root IS
  '同屋源連通分量的 canonical root（分量的 min base label）。NULL = 尚未計算／單節點分量。';
-- 非同步回填用：只掃「髒列」，不掃全表。
CREATE INDEX IF NOT EXISTS idx_listings_fold_component_stale
  ON listings (fold_component_root) WHERE fold_component_root IS NULL;
```

- 讀取端：`foldRoleCte` 改成 `component_root = COALESCE(l.fold_component_root, l.post_id)`，
  再 `row_number() OVER (PARTITION BY component_root ORDER BY <§2 的比較式>) = 1` 當 primary；
  沒有任何遞歸 CTE、沒有 O(N) 的新 hash join。
- **兩條路徑都讀同一個 root**：Node 端 `attachSameHouseRoleSteps` 改讀
  `provider.componentRoot(post_id)`（PG provider 由 `loader.groupIdsFor` 同一條批次路徑擴充），
  不再在請求期算 union-find。
- 寫入端：**必須沿用既有 fold refresh funnel**（`v3/src/repository/writePath.js` 那一條、
  `d4854a0` 收斂出的單一 funnel），**不准另開第二條刷新鏈**。

### 2.1 髒列判定（新鮮度）
以下任一變動都要讓受影響的 root 重算，且判定要看「寫入欄 ∩ 讀取輸入欄」：

| 事件 | 髒列來源 |
|---|---|
| 成員進出 `listing_group_members` | 該 `group_id` 的全部成員（+ 舊成員） |
| `match_post_id` 新增／撤銷、`match_verdict` 變 `no` | 邊的兩端（及其分量的成員） |
| `offline_confirmed` 改變 | 該列所屬分量（影響選主） |
| `user_same_house_members` 變動 | 只影響該 uid 的請求期分量 ⇒ **不固化**（個人併組維持 Node 期計算） |

⚠️ 反例（L-0541 的教訓）：只看 `match_post_id` 會漏掉「只有群組關係」的分量；
只看群組會漏掉 4,911 條兩端都不在群內的邊。

## 3. 驗證指令（Owner 點頭後照抄執行）

```bash
# 0) 只讀取樣：抽 200 個分量（每分量抽 1 列）比對 Node 期算出的 root 與固化欄
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
PG_URL="$PG_LIVE_REPRO_URL" node v3/scripts/fold-role-sql-parity.mjs          # 必須 roleMismatch=0
PG_URL="$PG_LIVE_REPRO_URL" node v3/scripts/fold-shape-fixtures.mjs           # 四種危險邊形逐位元一致
# 1) 回填（分批、冪等、可中斷續跑；每批 2,000 列，只處理 dirty 集合）
PG_URL="$PG_LIVE_REPRO_URL" FOLD_ROOT_BATCH=2000 node v3/scripts/fold-backfill.mjs --only fold_component_root
# 2) 逐欄抽樣 diff：抽樣數不足就自行續抽，抽到 0 差異才切讀取
PG_URL="$PG_LIVE_REPRO_URL" node v3/scripts/projection-freshness-check.mjs    # 樣板；新增 fold_component_root 的比對欄
```

- **切讀取的前置條件**：抽樣 `diff = 0`（隔離庫）**且**對正式庫唯讀連線跑同一支
  `fold-role-sql-parity.mjs` 也 `roleMismatch = 0`（L-0506：隔離庫全綠 ≠ 正式庫全綠，
  兩邊列數與來源組成不同）。

## 4. 本包（未經 Owner 核准前）不做的事
- 不執行 §2 的 DDL、不建索引、不回填任何列、不新增 migration 檔案。
- 不改 `foldRoleCte` 的讀取語意（維持現行，避免 SQL 端與 Node 端出現**看似一致**的假象）。
