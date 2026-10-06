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
