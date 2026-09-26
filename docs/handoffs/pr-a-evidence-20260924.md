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

## G. web-B（Synology）採證與快照（2026-09-24T13:15Z，**已解除 BLOCKED**）

**重要更正**：先前交接寫「`tori` 無 docker 權限、web-B 的 docker 只能 root 進」是**錯的**（未經實測的推論）。
實測：`ssh tori@syn-nas`（port 58722，密碼登入）成功，`groups` = `users, administrators, docker` →
**tori 有 docker 權限**；只是 `docker` 不在非互動 SSH 的 PATH，需 `export PATH=$PATH:/usr/local/bin`。
Synology 上同時可見 `5151-postgres-B`（PG primary，15432→5432）、`5151-haproxy-B`、`5151-web-B`、`5151-ops`、`591-tracker-tunnel-b`。

### 節點採證（`EVIDENCE_CONTAINER=5151-web-B`）

```json
{
  "host": "syn-web-B",
  "container": {"name":"5151-web-B","id":"52b999061cee"},
  "revision": "9c6b7b04f9801717cb6696e8e095fde4c309473f",
  "startedAt": "2026-09-24T11:57:51Z",
  "restartCount": 0,
  "dbDriver": "postgres",
  "pgTarget": "192.168.0.140:25433/5151_shadow",
  "sqliteDb": {"bytes":465666048,"mtime":"2026-09-24 19:09 +0800"},
  "sqliteWal": {"bytes":4157112,"mtime":"2026-09-24 19:11 +0800"},
  "dataMount": "/var/services/homes/tori/5151-shadow/web-b/data",
  "health": "{\"ok\":true,\"version\":\"3.57\"}"
}
```

- **runtime 檔 sha256 與 casa 完全相同**（`db.js 64ea0aa6…`、`server.js d0ce356e…`、`watcher.js b37355e7…`、`listingSearchAsync.js 20c9e19b…`、`index.html 1d830bb0…`）→ 三節點同版 ✓
- **重要精確化**：web-B 的 SQLite 主檔 mtime = 19:09（本地）＝ **11:09Z**、WAL = 11:11Z → **web-B 自 11:11Z 起就沒有再寫 SQLite**；
  web-A 的 mtime 也是 19:08／19:10 本地（同樣時間點）。也就是**剩下的持續 SQLite 寫入集中在跑爬蟲的 casa 容器**（`listing_match_evaluations` ≈ 1/秒、`crawl_covers` 每輪重寫）。

### web-B 一致快照（`VACUUM INTO`）

```
integrity=ok, pageCount=112869, tables=98, bytes=462311424
sha256=8143a76fba193f854b1d0b6732d88f74d753b854918d0e82ba3e33e7021860e2
counts: listings 115619 / data_revision 685489 / user_events 7280 /
        listing_match_evaluations 895182 / crawl_covers 19
```

封存：`/var/services/homes/tori/backups/5151/sqlite-archive-20260924/`，`cp` ＋ 兩端 sha256 比對 **VERIFY_MATCH**，來源已移除
（`ls` 因屬性快取列不到，驗證以 `sha256sum <完整路徑>` 為準）。
**兩節點 SQLite 分歧已實證**：`listing_match_evaluations` casa 861,654（12:56Z）vs web-B **895,182**（13:15Z）；`crawl_covers` casa 2 vs web-B 19。

## H. PG primary 事實（`5151-postgres-B`，2026-09-24T13:16Z，**GATE-11 相關**）

| 項目 | 實查值 | 判讀 |
|---|---|---|
| 版本 | PostgreSQL **16.14**（Alpine） | — |
| `synchronous_commit` | `on`（本機 WAL flush） | 不等於同步複寫 |
| `synchronous_standby_names` | **空** | ✗ 複寫為**非同步** |
| `pg_stat_replication` | `walreceiver / streaming / **async** / sent_lsn=replay_lsn=0/B347FDC8 / lag=0 bytes` | 取樣當下無落後，但**非同步 → RPO > 0** |
| `pg_stat_archiver` | `archived_count=0, failed_count=0, last_archived_time=NULL` | ✗✗ **沒有開啟 WAL 封存 → 沒有 PITR** |

→ 依 ChatGPT 指令文件 §6：**目前不能承諾「已回覆成功的資料一筆不丟」**（非同步複寫），
且**沒有 PITR**（只有磁碟／volume 層備份）。這兩點應列入 GATE-11 的 FAIL／缺口清單。


1. `node-readonly-evidence.sh`：`imageDigest` 為空（見 A 節）；`runtimeHashes` 目前輸出接近 JSON 但缺外層陣列括號（解析時需自行補 `[...]`）。
2. `sqlite-consistency-snapshot.mjs`：快照暫存在 `/data`（live 目錄）後由 host 搬出；若同一節點多次執行需注意磁碟餘裕（現有 817 GB 可用）。
3. **封存流程（已解決，作法已改）**：第一次用 `mv` 後目錄看似空的（NFS 屬性快取／glob 展開問題，`ls` 列不到但檔案以路徑讀取正常）。
   已改成「`cp` → 兩端 `sha256sum` 比對 → 相同才 `rm` 來源」：
   第二次執行 `sha_src = sha_arc = cbfe43b5457ef571c15bd7431cf8ca8096f71dca8f66c74eaf9c2941c232ddc3` → **VERIFY_MATCH**、來源已移除。
   **待注意**：封存目錄的 `ls` 可能因 NFS 屬性快取暫時列不到內容；驗證請以 `sha256sum <完整路徑>` 為準，不要只看 `ls`。
