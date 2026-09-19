# 5151 Runtime HA + Performance Modernization — 進度

整合分支：`deepseek/ha-runtime-modernization`
BASE_SHA：`c60a4f084bc5a01df0858eb669527f074bf22d8a`

## 主機存取（已確認）

| 主機 | SSH | 身份 | Docker |
|---|---|---|---|
| CasaOS `192.168.0.140` | `114.34.73.76:54722` | root | ✅ docker（production `591-tracker-v3` + `5151-ops`） |
| Synology `192.168.0.220`（TORI_NAS01, DSM r1000） | `114.34.73.76:58722` | tori（docker group） | ✅ `/usr/local/bin/docker`（`5151-ops`） |

- 兩台同一內網 `192.168.0.0/24`，TCP 互通（Synology→CasaOS:5432 已通）→ streaming replication 可行。
- 注意：`5151-ops` 兩台都有（CasaOS 與 Synology 各一），正式 v3 在 CasaOS。

## 已完成

### Phase 0 — 保護 Production / 建立分支
- fetch master、記錄 BASE_SHA、建立 integration branch。

### Phase 2 — Performance Baseline（第一優先）
- `v3/benchmark-runtime.mjs` + `v3/run-baseline.mjs`，量測 1k/10k/50k p50/p95/p99 + stage。
- `evidence/runtime-modernization/baseline.{json,md}`（50k fit_desc p95 ≈ 684ms，符 section 21 標準）。

### Cross-platform test harness（Windows + Linux）
- `pathToFileURL(...).href` 修正 38 個測試檔；`.gitattributes` 加 `*.yml eol=lf`。

### Phase 13/14/15/19 — Shadow PostgreSQL Primary/Standby（已上線並驗證）
- `deploy/shadow-ha/postgres-primary/`：PostgreSQL-A（Primary, CasaOS `192.168.0.140:15432`）+ setup-replication.sh + fix-pg-hba.sh。
- `deploy/shadow-ha/postgres-standby/`：PostgreSQL-B（Hot Standby, Synology `192.168.0.220:15432`）+ setup-standby.sh。
- `deploy/shadow-ha/haproxy/`：`postgres-rw` / `postgres-ro` / `web` 三組路由（config，尚未上線 HAProxy 容器）。
- `docs/runbooks/postgres-manual-failover.md`：manual failover runbook（fence / split-brain prevention）。
- **已實際在兩台 NAS 起 shadow container 並驗證**：
  - `pg_stat_replication` = `192.168.0.220 | streaming | async`。
  - Standby `pg_is_in_recovery()` = `t`，寫入被拒（`cannot execute INSERT in a read-only transaction`）→ split-brain prevention OK。
  - 資料傳播：primary 寫入 1 筆 → standby 讀到 1 筆。
- 全部用 env（`CASAOS_HOST`/`SYNOLOGY_HOST`/`PG_*_PASSWORD`），獨立 name/port/volume，不碰 Production。

## EXTERNAL_SETUP_REQUIRED（仍需 Owner 提供）

- **HAProxy shadow container 上線**（config 已備好，未起容器）；Web-A/Web-B / crawler / worker shadow 容器上線。
- **Object storage（S3/R2）credentials**：storage abstraction 的 S3 driver。
- **Gitea instance hostname / token**：Gitea migration rehearsal + loop-engine。
- **OpenAI Reviewer API key**：optional Final Review flow。

## 尚未開始（依優先序）

1. Phase 7 SQL-first search（listing_search_projection、indexed ORDER BY、cursor pagination）
2. Phase 3 Web/Crawler/Worker split（APP_ROLE）
3. Phase 4 durable PostgreSQL job queue（FOR UPDATE SKIP LOCKED）
4. Phase 5/6 repository layer + PostgreSQL adapter + migration framework
5. Phase 16–17 Web active/active + Cloudflare HA（shadow config 未寫）
6. Phase 18 storage abstraction（local/s3）
7. Phase 22–27 Gitea + loop-engine + optional Final Review

## 注意（Windows 本機）

- 完整 `npm test` 本機 Windows 仍有環境差異：`activate-rental-marketplace-pra-workflow.test.js` 呼叫
  `python3`（Windows 為 `python`）、部分 `ops/test/*` 依賴 git/shell 路徑。Linux CI 不受影響。

