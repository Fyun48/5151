# HA Cutover — PG 角色對調 B→A（實際切換記錄，2026-10-09）

> Owner 授權：2026-10-09 已核准（B 方案：primary 換到 CasaOS NVMe）。
> 範圍：**只動 shadow HA／正式站 PG**（`5151-postgres-A/B`、兩台 HAProxy）。這是**正式切換**，
> 不是演練；程序與 A4 drill（2026-09-20）一致，但方向相反（B→A）。
> 執行環境：CasaOS `192.168.0.140`（新 primary）、Synology `192.168.0.220`（原 primary → hot standby）。

## 0. 動機（磁碟效能，不是容錯）

2026-10-09 primary 在 Synology `5151-postgres-B`（HDD 卷 `/volume1/@docker/...`），且正在跑
`btrfs scrub`。實測（2026-10-09）：

| 指標 | Synology（HDD＋scrub） | CasaOS（NVMe，`/mnt/Storage1`，`rotational=0`） |
|---|---|---|
| `1k + fsync` | **327–670ms**（scrub 已跑 5.8 小時） | **15ms** |
| `32MB + fsync` | **0.87–1.42s** | **169ms** |

App 端症狀（2026-10-09 實測）：`[pg] slow commit 20485ms / 17527ms`；
`pg_stat_activity` 抓到 `wait_event_type=IO` / `wait_event=WALSync`；
`5151-crawl-sandbox` 連 6 輪 `duration_ms=2400006、jobs=0、fetched=0、timed_out=true`。

## 1. 切 procedures（RPO = 0）

1. 切點備份先落盤：`pg-5151_shadow-20261009T020034Z.dump`（`ok=1 bytes=99475708 table_data=109`）。
2. 停寫入端：`591-tracker-v3`、`5151-web-A`、`5151-crawl-sandbox`、`5151-web-B`。
3. 確認 `pg_stat_activity` 無應用連線，且兩邊 LSN 一致（`A/E4316998`）。
4. fence 舊 primary：`docker stop 5151-postgres-B`。
5. promote：`docker exec -u postgres 5151-postgres-A pg_ctl promote` → `server promoted`、
   `pg_is_in_recovery()=f`。
6. 兩台 HAProxy 的 `backend pg_primary` 就地對調順序（`pg-a` 優先、`pg-b` backup），
   `haproxy -c` + `kill -s HUP 1` 重新載入。
7. 新 primary（A）建 slot `standby_b`；casa 端跑 `fix-pg-hba.sh`。
8. syn 端用 `postgres-standby` 的 `standby-basebackup` helper 重拉 **1,516,814 kB** base backup。
9. 啟動 B：`B in_recovery=t`；casa 端 `pg_stat_replication = streaming|async|replay_lsn` 追平。

## 2. 公開面驗收（2026-10-09 實測）

| 面 | 結果 |
|---|---|
| 公網 | **8/8 200** |
| casa `25153` | **8/8 200** |
| syn `25153` | **4/4 200** |

## 3. 換完的效能（2026-10-09 實測）

| 指標 | 結果 |
|---|---|
| 新 primary 每筆 insert+commit（含 docker exec 開銷） | **171–181ms** |
| tracker 重啟後 6 分鐘 `slow commit` 筆數 | **0** |
| 備份耗時 | 53s → **41s** |

## 4. RTO / RPO

| 指標 | 結果 |
|---|---|
| RPO | **0**：切點備份 `pg-5151_shadow-20261009T020034Z.dump`（`ok=1 bytes=99475708 table_data=109`）落盤＋兩邊 LSN 一致 `A/E4316998` |
| RTO（公開站） | 停寫入端 `2026-10-09T02:01:24Z` → 應用重啟完成約 `02:11:30Z` ⇒ **公開站實際中斷約 10 分鐘**（計畫性、非事故） |
| RTO（DB 端） | 從 fence（`02:03:09Z`）到新 primary 可寫約 **1 分鐘**；其餘時間花在停寫與驗收 |
| 寫入路徑驗收 | 兩台 `25433` 都回到新 primary（`f|172.25.0.2|160014`） |

## 5. 踩到的陷阱（已寫進 runbook）

- (a) `haproxy.cfg` 有**兩個** backend 都列 `pg-a`／`pg-b`（`pg_primary` 與 `pg_standby_first`），
  用字串／整檔比對判斷「是否已對調」會誤判；要限定在 `pg_primary` block 內並確認其 server 順序。
- (b) 單檔 bind mount 綁 inode：只能用就地改寫同一 inode（`python open(p,'w')`／`printf > file`），
  `awk > f.new && mv` 會換 inode → `kill -HUP` 重載到舊設定。
- (c) `option pgsql-check` 只驗連通、不驗 `pg_is_in_recovery()` ⇒ 順序＝正確性，不是最佳化。

## 6. 仍開放的風險

- **promote 後應用端不會自己跟過去**：靠的是手動改 HAProxy `pg_primary` 順序。若忘了改，
  pg-rw 會繼續打到已降級成唯讀的舊 primary（寫入全滅）。待辦：角色感知的 pg-rw（見 §7）。
- `synchronous_standby_names` 目前是空＝純 async（RPO > 0 風險）。
- 兩節點 `archive_mode` 漂移（A=on／B=off，primary 端目前 off＝無 PITR）。

## 7. 待辦（本次新增）

1. **角色感知的 pg-rw**：用 `agent-check` 或外部探測把「這顆是 primary 嗎」回報成 `up/down`，
   讓 pg-rw 不再依賴手動排順序。
2. **複寫與歸檔的兩個風險**：`synchronous_standby_names` 空＝純 async（RPO > 0）；
   兩節點 `archive_mode` 漂移（A=on／B=off，primary 端目前 off＝無 PITR）。
