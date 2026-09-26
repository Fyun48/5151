# 5151 PG 切換上線紀錄（2026-09-26）

依 `5151_DeepSeek_PG_Exit_Release_Complete_20260926.md` 執行。Owner 於 2026-09-26 核准。

## 一、版本與流程

| 項目 | 值 |
|---|---|
| 候選程式 | PR #497（squash `4967fff0bfb7a05f65a6323f6cd14807707dba02`） |
| 修正後正式版本 | PR #501（squash `71ef46fab15d4da1b2c2f9170c87dd8db0d13a0e`） |
| Image digest | `sha256:913da82ca742617c8b3439ace9f40fd758f979177793a4268ef2e618530d4df8` |
| 容器 image ID | `sha256:d3806637b71015b74c0bba07edaa334a4ee5b887b089304df123e7dcb3c7e7d2`（revision label = `71ef46f…`） |
| build | [36262118580](https://github.com/Fyun48/5151/actions/runs/36262118580) success；`ISOLATED_V3_SMOKE_OK`、integrity_check ok |
| predeploy | [36262417423](https://github.com/Fyun48/5151/actions/runs/36262417423) success；備份 `predeploy-20260926-182452` |
| deploy | [36262636550](https://github.com/Fyun48/5151/actions/runs/36262636550) success |
| PG schema 變更 | **無**（切換前已逐一核對欄位齊全） |

### 過程中擋下的問題

第一次 build（[36260831191](https://github.com/Fyun48/5151/actions/runs/36260831191)）**失敗**：

```
SyntaxError: The requested module './personalFlags.js' does not provide an export named 'setFlags'
```

`personalFlagsAsync.js` 從 `personalFlags.js` 匯入不存在的 `setFlags`（它其實在 `db.js`）。
CI 沒抓到的原因：該模組沒有專屬離線測試、也沒有既有測試匯入它，所以壞掉的 import 從未被執行。
以 PR #501 修正，並新增 `v3/test/module-imports.test.js`（靜態掃描每個具名 import 是否存在於
目標模組的 export，含自我測試）。**正式站全程未受影響**（容器當時仍跑舊映像）。

## 二、資料補遷

- 部署後 12 分鐘確認新程式**完全停止寫本機 SQLite**（591 的
  `listing_match_evaluations` 停在 967,289／`max(evaluated_at)` 18:28:07Z；web-A 停在
  896,600／18:28:57Z，之後筆數與時間戳都沒再變）。
- 以三份最終快照重新產生：`backfill-final.sql`（135 筆 INSERT）、`conflicts-final.sql`
  （4 筆 UPDATE），兩份都在單一交易、`ON_ERROR_STOP=1` 下套用成功。

| 表 | 套用前 | 套用後 | 增減 |
|---|---:|---:|---:|
| `settings` | 29 | 30 | +1 |
| `user_listing_flags` | 705 | 745 | +40 |
| `listing_groups` | 14,486 | 14,511 | +25 |
| `listing_group_members` | 45,181 | 45,250 | +69 |
| 合計 | | | **+135**（與 dry-run 預測一致） |

## 三、驗證

- **兩節點 A/B 讀寫**（用每個容器自己的 `PG_URL`）：A（CasaOS `591-tracker-v3`）寫
  `{"from":"casa"}` → B（Synology `5151-web-B`）讀到並改為 `{"from":"syn"}` → A 讀回
  `{"from":"syn"}`。兩邊都連到 `5151_shadow` 且 `pg_is_in_recovery()=false`。測試鍵已刪除（0 筆）。
- **關聯完整性**：無 group 的成員 0、無 listing 的成員 0、無 listing 的旗標 0。
- **搜尋投影**：`listing_search_projection` 與 `listings` 落差 0。
- **冪等**：兩份 SQL 再各套一次，四張表筆數不變。
- **公開站**：首頁 200（607 KB）、訪客搜尋 API 200、`/api/health` `{"ok":true,"version":"3.57"}`。
- **複寫**：primary `streaming／async／write_lag 0.77ms／replay_lag 10.8ms`；CasaOS standby
  `pg_stat_wal_receiver.status = streaming`。
- **備份**：predeploy 同時產出 SQLite 與 PG dump（`pg_backup_ok: true`、61,757,111 bytes、
  105 個 TABLE DATA、來源為 standby）；另有三份 SQLite 一致性快照與 PG dump 的異機副本。

## 四、剩餘項目（上線後）

- 15 筆內容衝突**保留 PG 不動作**（Owner 未指定；這是零風險預設）。其中 7 筆是會員的
  收藏／隱藏、6 筆是站台內容與通知設定、2 筆是群組歸屬，明細在 NAS
  `cutover-20260926/data-diff-detail.txt`。
- `PG_SQLITE_FALLBACK` 未設 `strict`（讀取仍 fail-open）；建議穩定後再切。
- 舊 SQLite 檔保留未刪；`609/591-tracker-v3` 的 `v3.db` 已不再被寫入。
- 一筆 listing 的 `source` 是損壞的多位元組字串（既有瑕疵，非本次造成）。
- PITR（primary `archive_mode=off`）、HA promotion 演練、整體 SQLite 退場（C～F）、
  未啟用功能移轉、舊 NAS 效能門檻（NAS 四案仍為 FAIL，依 Owner 指示不作為發布前提）。
