# PR-B：PG 投影回填完成證據（2026-09-24）

## 結論

PostgreSQL 的 `listing_search_projection` 已與 `listings` **完全對齊**，且一致性檢查全數為零：

```
missing=0  missing_visible=0  orphan=0  dup=0  nulls=0
listings=119669  projection=119669  ok=1
```

## 證據 1：回填腳本自身的完成摘要

指令（容器內，寫 PG，可中斷可重跑）：

```bash
docker exec -d 591-tracker-v3 sh -lc 'node /tmp/projection-backfill.mjs > /tmp/backfill.log 2>&1'
```

完成輸出（節錄，`/tmp/backfill.log` 尾端）：

```json
{
  "finished": true,
  "done": 86522,
  "failed": 0,
  "sec": 2873,
  "missingBefore": 86522,
  "missingAfter": 0,
  "failures": []
}
```

- `done = 86522`、`failed = 0`、耗時 `2873s`（約 48 分鐘）。
- 起始缺漏為 **86,522**（先前 PR-A 現場量測為 86,533；差異來自期間 crawler 新增／更新的列數，兩者都是同一現象的量測值）。

## 證據 2：獨立唯讀檢查（與回填腳本無關的第二條路徑）

以 `v3/scripts/projection-check.mjs`（全程在同一個 `REPEATABLE READ READ ONLY` 交易內、只有 SELECT）：

```
missing=0 missing_visible=0 orphan=0 dup=0 nulls=0 listings=119669 projection=119669 ok=1
```

- `missing`：`listings` 有、投影沒有的列 → **0**
- `orphan`：投影有、`listings` 沒有的列 → **0**
- `dup`：同一 `post_id` 多列 → **0**
- `nulls`：`post_id IS NULL` → **0**

## 證據 3：唯讀監控的長期自動執行紀錄

`5151-projection-monitor.timer`（systemd，每 15 分鐘，讀取端只做 SELECT）在回填期間的無人介入紀錄，
`missing` 單調下降且 `ok=1`：

```
2026-09-24T13:34:42Z missing=62583 ... projection=56972  ok=1
2026-09-24T13:35:26Z missing=61687 ... projection=57868  ok=1
2026-09-24T13:50:30Z missing=35528 ... projection=84092  ok=1
2026-09-24T14:05:53Z missing=7210  ... projection=112459 ok=1
（回填結束後）        missing=0     ... projection=119669 ok=1
```

## 仍未完成（不可誤讀為 PR-B 全綠）

1. **`kind_keys` 欄位回填仍在進行**（F3）：目前約 15,500 / 119,669 列。
   - 新欄位已建立（`listing_search_projection.kind_keys`，SQLite 與 PG 皆有 idempotent 遷移），
     但既有列的值仍是空字串。
   - **部署前置條件**：`kind_keys = ''` 的列數必須為 0，否則 `kind` 查詢（已下推 SQL）會回空清單。
2. **F2 尚未完成**：PG 失效已改為 503 + 穩定錯誤碼（`3db004a`），但「查詢落在 SQL 外框外」時
   仍會回退 Node／SQLite 路徑，需待 F3 逐項補齊後才能移除。
3. F3 其餘項：`q`、`sort=fit_desc`、`filter≠all`、以及 `priceMin`／`minBuildingFloors`／
   `excludeKeywords`／`excludeAgents`／`excludeAgentIds`／`excludeBoxes`／`commuteKm` 等 settings。

## 如何重現

```bash
# 1) 回填（寫 PG，只 INSERT/UPDATE 投影，不刪列）
ssh root@casa-nas 'docker exec -d 591-tracker-v3 sh -lc "node /tmp/projection-backfill.mjs > /tmp/backfill.log 2>&1"'

# 2) 唯讀驗證（可重複執行）
git show ops/readonly-projection-monitor:v3/scripts/projection-check.mjs \
  | ssh root@casa-nas 'docker exec -i -e SUMMARY=1 591-tracker-v3 node --input-type=module'

# 3) 監控歷史
ssh root@casa-nas 'tail -5 /var/log/5151/projection-monitor.log'
```
