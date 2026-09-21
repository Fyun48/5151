# 切換前置：PostgreSQL schema bootstrap 與資料匯入（2026-09-21）

`v3/POSTGRES_SWITCH_PLAN.md` §2.7 與 §2 末的兩件事：**PG 端要先把 schema 建起來**（app 只會 ensure
SQLite 的），而且**匯入工具要能在寫入凍結視窗內跑完**（108k 筆 listings 用逐列 INSERT 會很久）。
這一輪把工具收進 repo、加了批次與串流，並在 shadow 上用**正式站快照**量測。

## 工具（現在都在 repo 裡）

| 檔案 | 角色 |
|---|---|
| `v3/scripts/pg-import.mjs` | SQLite 快照 → PostgreSQL：鏡射 schema、匯入資料、逐表印 rows／ms。`DRY_RUN=1` 先看計畫，`TABLES=`／`SKIP_TABLES=`／`SKIP_ROWS=` 可裁剪，`IMPORT_SCHEMA=` 可指定 schema |
| `deploy/shadow-ha/pg-import-run.sh` | 在 NAS 上跑完整流程（先 `VACUUM INTO` 快照，再用 app image 跑上面那支） |
| `v3/src/pgSchema.js` | `ensurePgSchema`（schema 鏡射）＋ `importTable`（批次匯入）＋ `readTableChunks`（串流讀取） |
| `deploy/shadow-ha/pg-indexes.sh` | 匯入後建 hot-path 索引（匯入只建表與 primary key；沒索引是 20k 筆 seq scan） |

## 這一輪改了什麼

1. **批次 INSERT（預設）**：原本一列一句 `INSERT`，現在一次送 `rowsPerStatement()` 列
   （受 PostgreSQL 65535 個 bind parameter 上限約束：200 欄的表每次 325 列）。
   仍然是 `ON CONFLICT DO NOTHING`，所以中斷重跑不會重複。
2. **串流讀取**：原本把整張表讀進記憶體（108k × 106 欄＋內文）才開始寫；現在用 **rowid keyset**
   一次讀 2000 列（`readTableChunks()`），記憶體有界、也更快（60.3 s → **49.3 s**）；
   `WITHOUT ROWID` 的表退回 LIMIT/OFFSET。
3. **流程進 repo**：切換用的匯入腳本原本只存在 NAS 上一次性的 `~/pgtest/incoming/pg-import.mjs`
   （後來已不存在）——現在是版控內的 `v3/scripts/pg-import.mjs` ＋ `pg-import-run.sh`，可重現。
4. **可量測**：工具逐表印出 rows／ms 與總計，凍結視窗可以用數字排，不用猜。

## 實測（shadow 叢集，正式站快照 `/root/pgsnap/v3-snap.db`）

`listings` 表，**108,539 列**，目標 = shadow primary（Synology `5151-postgres-B`，經 192.168.0.220:15432），
每一次都匯入到**全新的資料庫**（`imp_fast`／`imp_fast2`／`imp_row`，量完即刪）：

| 模式 | 工具自報匯入時間 | 容器 wall clock（含啟動 + `npm install pg`） | 結果列數 |
|---|---|---|---|
| **multi-row + 串流（現在預設）** | **49.3 s** | 55 s | 108,539 ✅ |
| multi-row（批次，未串流，先前的實作） | 60.3 s | 66 s | 108,539 ✅ |
| per-row（`MULTI_ROW=0`，舊行為） | — | 16.5 分鐘後**只完成 106,000 列**（推算全表 ≈17 分鐘）→ 量測中止 | 106,000（未完成） |

- **約 21 倍差距**（49 秒 vs 約 17 分鐘），而且串流版把記憶體用量從「整張表」降到 2000 列 —— 對 NAS 這種
  機器是安全性問題，不只是速度問題。
- 兩條路徑寫出的列**完全相同**：`v3/test/pg-import-batches.test.js` 的 live 子測試在同一個 fixture 上
  分別用兩個模式匯入，再 `deepEqual` 整張表的內容；上面 imp_fast／imp_fast2 的 count 也都是 108,539。

## 怎麼跑

```bash
# 1) 先看計畫（不寫任何東西）
DRY_RUN=1 sh deploy/shadow-ha/pg-import-run.sh

# 2) 正式匯入（預設目標 DB：5151_import_test；IMPORT_DB=... 可換）
sh deploy/shadow-ha/pg-import-run.sh

# 3) 建 hot-path 索引
sh deploy/shadow-ha/pg-indexes.sh 5151_import_test
```

相關：`docs/runbooks/postgres-cutover-bootstrap.md`（切換當天的完整步驟與回復方案）、
`v3/evidence/pg-explain-20260921/`（索引前後的 plan 差異）。

