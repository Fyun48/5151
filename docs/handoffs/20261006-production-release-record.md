# Production 發版紀錄（2026-10-06）

> 撰寫者：DeepSeek Harness（DSH）。本次為剛完成的 Production 發版留下單一 release 紀錄檔。
> 本檔同時保存於 repo（`docs/handoffs/20261006-production-release-record.md`）。
> 所有數字均為部署當時量測的已驗證事實，直接引用、不改寫。

---

## 一、發版身分

| 項目 | 值 |
|---|---|
| 發版時間 | 2026-10-06T02:59Z（容器重建完成 03:00:49Z） |
| master SHA | `719ac6577823a2af50560022bb33f67b7c4d43de` |
| image digest | `sha256:dc29ae06fd420c274f6b0c78b19f9ce0dc6abcc4cf1457c4c866b410079a8ccf` |
| build-production-image | [37405197812](https://github.com/Fyun48/5151/actions/runs/37405197812) success |
| production-predeploy-check | [37406206827](https://github.com/Fyun48/5151/actions/runs/37406206827) success |
| deploy-v3 | [37406702561](https://github.com/Fyun48/5151/actions/runs/37406702561) success（job sync-nas-v3） |

前次發版：2026-10-01（SHA `b0719570`，run [36807429995](https://github.com/Fyun48/5151/actions/runs/36807429995)）。

## 二、本批內容清單

- **#611** 第九十九批：Owner 工作單 A1～C3（有房刊登、許願房、意見回饋）
- **#614** CTA cooldown 時間炸彈——`atMs` 對 ISO 字串退化真實時鐘
- **#615** 三支 5 分鐘 tick 接上 PG async 路徑＋`OFFER_REPORT_DAILY_CAP` parity
- **#616** 收編唯讀投影完整性監控進 repo（關閉可稽核性缺口）
- **#613** CRM 遞送 loop 接上 driver-aware async 零件（收掉非路由殘留）
- **#612** predeploy PG 備份/回版對齊：pg_dump 改打真 primary＝syn-nas `5151-postgres-B` 本機 unix socket、standby 上 fail-closed、`BACKUP_HASH` 改用 pg dump sha256
- **#617** tori 證據檔拉取從 scp 改成 ssh exec cat（因 syn-nas SFTP 不通）

## 三、predeploy 新閘門與備份身份

predeploy 改為「對真 primary 打 pg_dump」的新閘門，本次通過值：

| 項目 | 值 |
|---|---|
| pg_dump_bytes | `91628432` |
| pg_dump_table_data | `105` |
| pg_dump_sha256 | `324e614d50d93ca6ab40258c6107050ad91904ba48dd6a15aace65eedfdf90cd` |

- dump 存放於 syn-nas `tori:~/backups/5151/pg-5151_shadow.dump`。
- SQLite／media 備份仍在 casa-nas。

## 四、R6 修復驗證（feedback-media 掛載前後對比）

- **部署前基準**：三容器皆**無** feedback-media 掛載。
- **部署後**：
  - casa-nas `591-tracker-v3` 與 `5151-web-A` 都有 `/mnt/5151-media/feedback-media:/data/feedback-media`。
  - syn-nas `5151-web-B` 有 `/volume1/5151-media/feedback-media:/data/feedback-media`。
  - 三容器同一 image id `sha256:b3ec2f13dbdc…`、revision label＝`719ac657…`、全部 running。

## 五、部署前 predeploy 失敗紀錄（供稽核）

本次成功前有兩次 predeploy 失敗：

1. run [37402173149](https://github.com/Fyun48/5151/actions/runs/37402173149)：舊腳本對 standby `5151-postgres-A` 做 pg_dump → `canceling statement due to conflict with recovery`。
2. run [37404222131](https://github.com/Fyun48/5151/actions/runs/37404222131)：新腳本 dump 成功，但 tori 用 scp 拉證據檔 → `subsystem request failed`（SFTP 在 ssh-tori bridge 不通）。

修復方式即本批 #612＋#617（見第二節）。

## 六、master CI 一次性瞬時紅燈

run [37405185152](https://github.com/Fyun48/5151/actions/runs/37405185152) 首跑 `notify-enqueue-parity` 出現 3 條
`does not provide an export named 'bumpRevision'`。本地與 PR CI 同樹皆綠，`rerun --failed` 後 success，
判定為 runner 瞬時異常、非程式問題。

## 七、5168 爬蟲暫緩說明

5168 爬蟲目前暫停中。三個旋鈕（`blockedUntil`／`interval`／cap 12→6、fairness）屬 Owner 業務決策，
本次發版**未動**。

## 同日第二梯發版（2026-10-06T07:20Z）

- 部署身分：master SHA `8eda28ebb37e0c29785fd6c074c8d36cf7986065`、image digest `sha256:a127ee9d36c8f12dacbafcce568f914db895e1ee99ea2d0dff097d8f2a939e4f`
- 三條 workflow：build #37428184612、predeploy #37428660475（PG primary dump：92160937 bytes、106 表、sha256 `c4e99b5fd7cbaba8df3728a36bac8d185afd59877c2e3985971cb81ffbf96484`）、deploy #37428944046，全 success
- 本梯內容（三個 PR，皆 CI 四項綠後 squash）：
  - #619 `fix(ticks)`: rental_match_seen SELECT-then-INSERT 改冪等 ON CONFLICT——多節點 HA（web-A/web-B 同跑 tick 打共享 PG）競態會以 23505 讓整輪 tick 交易回滾；附真 PG 雙連線併發測試（修復前可確定性重現）
  - #620 `fix(crawl)`: 來源被擋冷卻預設 90s→1800s（輪間隔 15min，90s 跨輪形同虛設；5168/houseprice 實測 ~2.2 被擋輪/天）。決策紀錄 agent-brain D-0009：interval 400ms 與 cap 12 不動、fairness 不加權、來源不關；沙盒報告 3 輪全成功（836s/669s/699s、fetched 2016/1973/2059、errors_total=0、covers_max_last_run_at 持續前進）已附於 PR #620
  - #621 `fix(test)`: commute-route-live 2105 筆種子包單一交易（node:sqlite autocommit 慢 fsync 每筆 ~253ms → 491s 超 30s 子程序上限；修後 5.8–7.2s）。修後本地全套 npm test 3607 tests / 0 fail / 96 skipped
- 部署後驗證：三容器（casa-nas 591-tracker-v3、5151-web-A；syn-nas 5151-web-B）revision label 皆 `8eda28eb…`、同一 image id `sha256:348e369f57db113…`、feedback-media 掛載維持（各 1 條）、07:20:39–07:21:30Z 重建、全 running
- 前梯（02:59Z，SHA 719ac65…）紀錄見本文件上方章節
