# 切換當天照抄清單（v3：SQLite → PostgreSQL）

> 這是 `docs/runbooks/postgres-cutover-bootstrap.md` 步驟 0-6 的**可照抄版本**：每一步都有指令、預期輸出、
> 判斷依據與回復點。前提：步驟 0 已無功能阻塞項（2026-09-22 查證，見該檔）。
> **憑證政策**：本文不寫任何密碼；需要的地方一律用 `<PG_SUPER_PASSWORD>` 佔位，或引用 NAS 上那份不在版控的 `.env`。

## 事前查證（2026-09-22 實測；切換前請重跑一次）

| 項目 | 值 |
|---|---|
| shadow preflight | ✅ `drill.sh preflight --expect-role primary` → `local role: primary (pg_is_in_recovery=f)`／`replication: 172.21.0.1\|streaming\|async`／`haproxy 192.168.0.140:25433 pg_is_in_recovery() = f`／**`preflight OK`**（報告留在 NAS `~/shadow-ha-tools/drill-reports/`） |
| primary／standby | `192.168.0.220:15432`（`pg_is_in_recovery=false`，PG 16.14）／`192.168.0.140:15432`（`true`、`caught_up=true`） |
| 切換用 image | sha `828acf76a9a8568d292b347cc7eb802183454851` → digest `sha256:dd2bb8f02db127307404e3ada21d6574f835f45b0805493f08cad8ef078fe187`（`revision_label=828acf7…`、`SHARP_OK`、amd64 smoke ✅） |
| 目前正式站 image | `sha256:0f758bd6eab542429f68f16bd920107fe92abae781945e5b2a705b7ebef8af3e`（＝`64828a8`）← **回復點** |
| predeploy 備份（**今天的回復點**） | 2026-09-22 重跑 `PREDEPLOY_CHECK_OK` → `/mnt/Storage1/docker_data/591-tracker-v3-backups/predeploy-20260922-051725`（`v3.db` `sha256:2e1b149da66abcdc9e502b2a30234909146f73a1dd1c7dd6b48d2b464de4b630`）；2026-09-21 那次為 `predeploy-20260921-133223`（`sha256:6cf1f045…`） |
| live parity（切換前基準） | 11 個 live 檔 **61/61、0 skip**（2026-09-22，shadow） |

## 步驟 0.5（建議、可先做）：先把新 image 上正式站，但**先不切 driver**

目的：把「程式變更」與「driver 變更」分開；切換當天就只改環境變數，出問題時容易歸因。

```bash
# 三條 manual workflow（順序固定）；sha / digest 用上表那組
gh workflow run build-production-image.yml --ref master -f sha=828acf76a9a8568d292b347cc7eb802183454851 \
  -f release_mode=manual_owner -f release_intent_id=""
gh workflow run production-predeploy-check.yml --ref master -f sha=828acf76a9a8568d292b347cc7eb802183454851 \
  -f confirmation=PREDEPLOY-PRODUCTION -f release_mode=manual_owner -f release_intent_id=""
gh workflow run deploy-v3.yml --ref master -f sha=828acf76a9a8568d292b347cc7eb802183454851 \
  -f image_digest=sha256:dd2bb8f02db127307404e3ada21d6574f835f45b0805493f08cad8ef078fe187 \
  -f confirmation=DEPLOY-PRODUCTION -f release_mode=manual_owner -f release_intent_id=""
```

預期：`DEPLOY_V3_OK source=828acf7… image=…@sha256:dd2bb8f0…`、只有 `591-tracker-v3` 被重建、
NAS 健康四項 true、公開站 `/api/health` 200。**這一步會重啟容器（約 5-10 秒）**；若連這幾秒都不要，
就跳過、改成切換當天與 driver 一起換（風險：程式與 driver 同時變）。

## 步驟 1：凍結寫入（方式由 Owner 決定）

- **選項 A（公開站不停）**：只讓爬蟲停下來。正式站的 web 與爬蟲在同一個 `591-tracker-v3` 容器裡，
  所以做法是「從後台把爬蟲暫停」（admin 的爬蟲設定／排程）；若後台沒有這個開關，就用選項 B。
- **選項 B（短暫停站）**：`docker stop 591-tracker-v3`（停站期間公開站 502）。

凍結後**先驗證真的沒有寫入**再往下：

```bash
# 1) SQLite 檔的 mtime 不再變動（相隔 10 秒比對）
ls -l --time-style=full-iso /mnt/Storage1/docker_data/591-tracker-v3/v3.db; sleep 10
ls -l --time-style=full-iso /mnt/Storage1/docker_data/591-tracker-v3/v3.db
# 2) PG 端沒有來自正式站的活動連線（切換前 shadow 不該有正式站流量）
psql "postgres://postgres:<PG_SUPER_PASSWORD>@192.168.0.220:15432/5151_shadow" -c \
  "select count(*) from pg_stat_activity where state = 'active'"
```

## 步驟 2：快照 ＋ 匯入

```bash
# 在「有正式站資料 ＋ 有 docker」的那台（CasaOS）跑。
# 用法：sh deploy/shadow-ha/pg-import-run.sh [env_file] [src_dir] [prod_data_dir] [pg_host]
#   env_file      放 PG_SUPER_PASSWORD（那台主機上的路徑；**不進版控**）
#   src_dir       repo checkout（腳本只會複製 v3/ 進去；預設 /root/pgtest/incoming）
#   prod_data_dir 正式站 DATA_DIR
#   pg_host       192.168.0.220
IMPORT_DB=5151_import_test sh deploy/shadow-ha/pg-import-run.sh \
  <env_file> <src_dir> /mnt/Storage1/docker_data/591-tracker-v3 192.168.0.220
```

預期：`=== 1) VACUUM INTO snapshot of the live DB ===` → `snapshot ok, listings=<N>` →
逐表 `rows/ms` → **identity sequence re-sync 清單**（這步不能省：帶明確 id 的 INSERT 不會推進 identity）。

先匯進 `5151_import_test` 彩排（比對列數與正式站一致），再匯進切換用的 DB（`IMPORT_DB=5151_shadow`）。
腳本可重跑（`ON CONFLICT DO NOTHING`），所以「先匯 → 發現漏 → 再匯」是安全的。

## 步驟 3：建索引（**不可跳過**）

```bash
sh deploy/shadow-ha/pg-indexes.sh 5151_shadow
# NAS 上也有副本：~/shadow-ha-tools/5151-pg-indexes.sh
```

沒有索引時 hot path 是 20,324 筆的 seq scan（12-19 ms）；建完後 newest／price_asc／price_desc
都是 `Index Scan using idx_proj_district`、count/page 各 6.9-8.0 ms、**0 個 Seq Scan**。

## 步驟 4：驗證（**沒過就不要進步驟 5**）

```bash
# 4a) 列數對照（SQLite 快照 vs PG）
DRY_RUN=1 node v3/scripts/pg-import.mjs

# 4b) live parity：指向「切換用的 DB」。測試自建／自刪 schema，不會碰正式表
PG_TEST_URL=postgres://postgres:<PG_SUPER_PASSWORD>@192.168.0.220:15432/5151_shadow \
PG_TEST_STANDBY_URL=postgres://postgres:<PG_SUPER_PASSWORD>@192.168.0.140:15432/5151_shadow \
node --test v3/test/crawler-reads-parity.test.js v3/test/listing-fields-parity.test.js \
  v3/test/listing-state-writes.test.js v3/test/listing-detail-parity.test.js \
  v3/test/write-path-parity.test.js v3/test/listing-stats-parity.test.js \
  v3/test/notify-queue-parity.test.js v3/test/notify-enqueue-parity.test.js \
  v3/test/decoration-data.test.js v3/test/pg-import-batches.test.js \
  v3/test/pg-live-integration.test.js
```

預期：**61 tests / pass 61 / fail 0 / skipped 0**（2026-09-22 於 shadow 實測；含
「測試 schema 在 standby 可見」）。這裡有任何紅燈就先停手、修好再繼續。

## 步驟 5：切正式站（**只改環境，不改程式**）

> 機制：正式站的 compose 由 deploy workflow 每次 SCP 覆蓋（`v3/src`、`v3/public`、`docker-compose.yml`、
> `casaos-compose.yml`、`docker-compose.override.yml` → `/mnt/Storage1/apps/5151/`），所以**直接改 NAS 上的
> compose 會在下次部署被蓋掉**。正解是把變數寫進 compose（repo 內、一次性的小 PR）＋把值放 NAS 的 `.env`：

1. repo 的 `casaos-compose.yml` 的 `591-tracker-v3` service 加兩行（**不含密碼**）：
   ```yaml
   DB_DRIVER: ${DB_DRIVER:-sqlite}
   PG_URL: ${PG_URL:-}
   ```
2. NAS 的 compose 同目錄放 `.env`（**不進版控**）：
   ```
   DB_DRIVER=postgres
   PG_URL=postgres://postgres:<PG_SUPER_PASSWORD>@192.168.0.140:25433/5151_shadow
   ```
   `192.168.0.140:25433` 是 HAProxy 的 `pg-rw` frontend（指向當下的 primary；preflight 已驗證可達）。
3. 先切 shadow 的 `web-A` 走一輪（同一組 `.env` 放到 `~/5151-shadow-ha/shadow-ha/web/web-a/.env` 後重啟）：
   `/api/state`、`/api/listings`（排序／分頁／cursor）、詳情頁、`/go`、`/api/listings/:id/history`。
4. 通過後重建正式站的單一服務：
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.override.yml \
     up -d --no-build --no-deps --force-recreate 591-tracker-v3
   ```

## 步驟 6：觀察與回復

觀察（至少 15 分鐘）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://jibbyrenth.reversalplay.me/api/health
curl -s -D - -o /dev/null 'https://jibbyrenth.reversalplay.me/api/listings?sort=newest&limit=30' | grep -i 'server-timing'
psql "$PG_URL" -c "select application_name, state, count(*) from pg_stat_activity group by 1,2 order by 3 desc"
psql "$PG_URL" -c "select client_addr, state, pg_wal_lsn_diff(sent_lsn, replay_lsn) as lag_bytes from pg_stat_replication"
```

回復（任一異常）：
1. NAS 的 `.env` 把 `DB_DRIVER` 改回 `sqlite` → 重建 `591-tracker-v3`（**最常見且最快**）。
2. 要回程式版本：用上表的「目前正式站 image」digest（`sha256:0f758bd6…`）重新 `deploy-v3.yml`。
3. **`v3.db` 全程沒被動過**（只被唯讀快照）→ 回復不會丟資料。
4. 切換期間寫進 PG 的資料要人工評估：先 `pg_dump` 那個時間窗、再決定怎麼補。

## 切換後仍留在 SQLite 的東西（**預期，不是異常**）

- **CRM 領域 ＋ `crm_outbox`**、**`jobQueue`／`jobWorker`／`geoQueue`／`listingEnrichQueue`**：生產者與消費者
  都在同一個 store（單容器自洽，不是「寫 A 讀 B」）；**HA（兩個 web 共用 PG）之前必須移植**。
- **④ pHash／相似度建議／爬蟲洞察**：opt-in 且正式站未啟用；**啟用該功能或 HA 之前必須移植**。
- 兩者的掛點與移植範圍都寫在 `docs/runbooks/postgres-cutover-bootstrap.md` 步驟 7。


