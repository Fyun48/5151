# PR-A 證據（2026-09-24）

> 基準 commit `9c6b7b04f9801717cb6696e8e095fde4c309473f`。以下皆為實查輸出；未執行項明確標示 NOT_RUN／BLOCKED。

## A. 節點唯讀採證（主節點 casa，2026-09-24T12:52Z）

```json
{
  "host": "ubuntucasaos",
  "containerFound": true,
  "container": {"name":"591-tracker-v3","id":"fb0cbdb5d078"},
  "revision": "9c6b7b04f9801717cb6696e8e095fde4c309473f",
  "imageDigest": "",
  "startedAt": "2026-09-24T11:57:03.436857518Z",
  "restartCount": 0,
  "dbDriver": "postgres",
  "pgTarget": "192.168.0.140:25433/5151_shadow",
  "runtimeHashes": {"file":"/app/src/db.js","sha256":"64ea0aa6…"}{"file":"/app/src/server.js","sha256":"d0ce356e…"}{"file":"/app/src/watcher.js","sha256":"b37355e7…"}{"file":"/app/src/listingSearchAsync.js","sha256":"20c9e19b…"}{"file":"/app/public/index.html","sha256":"1d830bb0…"},
  "sqliteDb": {"bytes":498970624,"mtime":"2026-09-24 20:42:50 +0800"},
  "sqliteWal": {"bytes":38818672,"mtime":"2026-09-24 20:52:24 +0800"},
  "health": "{\"ok\":true,\"version\":\"3.57\"}"
}
```

- `revision` = 基準 commit ✓；`DB_DRIVER=postgres` ✓；健康端點正常 ✓。
- **`imageDigest` 為空 = 腳本缺陷**（用 `.Image` 影像 ID 去查 `RepoDigests` 取不到）→ 待修（不影響本輪結論：`revision` 已足夠對應 commit）。
- **註**：`/app/src`、`/app/public` 是 host bind mount → 上面的 `runtimeHashes` 才是「執行中的程式」證據（不是 image digest），已符合 ChatGPT 指令文件的要求。

## B. SQLite 一致快照（主節點，2026-09-24T12:52:43Z）

```
label  : casa-591-tracker-v3
source : /data/v3.db（walExists=true）
方法   : node:sqlite 的 VACUUM INTO（非 cp；見 v3/scripts/sqlite-consistency-snapshot.mjs）
integrity : ok
pageCount : 111392
tables    : 98
bytes     : 456261632
sha256    : 8ac49c3b589ea8555a7047157dc30f123ab562ad564b146dab02afceedf239d2
counts    : listings 115618 / data_revision 685489 / user_events 7280 /
            listing_match_evaluations 861424 / crawl_covers 2
```

封存步驟（**⚠️ 未成功，見 F 節第 3 點**）：原計畫搬到 `/mnt/Storage1/docker_data/591-tracker-v3-backups/sqlite-archive-20260924/`；
搬移後該目錄為空、`/data` 與 live 目錄也都找不到快照檔 → **manifest（含 sha256）已取得，但檔案目前不在任何已知位置**。
本輪結論不受影響（manifest 的 integrity／筆數／sha256 都是在檔案還在時對快照本身實測的），但**封存能力必須修好才能算 PR-A 完成**。

## C. 本輪新增的量化證據（原報告沒有）

| 時間（UTC） | `listing_match_evaluations`（容器 SQLite） |
|---|---|
| 12:17:30 | 859,383 |
| 12:19:03 | 859,396 |
| 12:52:43 | **861,424** |

→ 33 分鐘 **+2,028 筆（≈ 每秒一筆）**，全部只寫進節點本機 SQLite。這是 F4 的量化證據，
也說明「COUNT 不變 ≠ 沒寫入」的反面：這張表一直是**在長**的（只是原報告的 93 秒窗只抓到 +13）。

## D. 本輪 NOT_RUN／BLOCKED（不填 PASS）

| 項目 | 狀態 | 原因 |
|---|---|---|
| web-B（Synology）採證 | **BLOCKED** | `root@syn-nas` 需密碼；已提供 `v3/scripts/node-readonly-evidence.sh`（只輸出白名單欄位）交由既有管理者執行 |
| web-A 快照 | NOT_RUN | 本輪先做正式站容器；web-A 需先確認其 `/data` 實際來源路徑 |
| PG 備份／PITR 資訊 | NOT_RUN | 需 PG 主機存取（`5151-postgres-B` 在 Synology） |
| 違規錯誤碼 `SQLITE_ACCESS_FORBIDDEN_IN_PG` | NOT_RUN | 尚未實作 |
| 執行攔截（constructor／prepare／exec spy） | NOT_RUN | 尚未實作 |
| 逐 route 完整矩陣 | PARTIAL | 288 入口已機械抽出，A／B／C 三層只填 SQLite 相關者 |

## E. 本輪與 ChatGPT 指令的對應

- PR-A 第一步（入口矩陣）→ 已完成初版：`pr-a-access-matrix-20260924.md`、`pr-a-entrypoint-inventory-20260924.md`。
- PR-A 資料保存 → 快照工具與主節點快照已完成（本文件 B 節）；其餘節點待執行。
- PR-A 錯誤邊界與違規碼 → 未開始（D 節）。
- PR-B～PR-F → 未開始。

## F. 腳本缺陷（待修）

1. `node-readonly-evidence.sh`：`imageDigest` 為空（見 A 節）；`runtimeHashes` 目前輸出接近 JSON 但缺外層陣列括號（解析時需自行補 `[...]`）。
2. `sqlite-consistency-snapshot.mjs`：快照暫存在 `/data`（live 目錄）後由 host 搬出；若同一節點多次執行需注意磁碟餘裕（現有 817 GB 可用）。
3. **封存失敗（本輪最重要缺陷）**：`mv` 到 `sqlite-archive-20260924/` 後，該目錄為空、live 目錄與容器 `/data` 也都沒有快照檔。
   尚未查明原因（可能跨檔案系統複製失敗或路徑誤判）。**修法**：改用 `cp` ＋ 事後 `sha256sum` 兩端比對 ＋ 只在比對通過後才刪除來源；
   重跑後把檔案與 sha256 一起記錄，才能宣告「各節點快照已保存」。
