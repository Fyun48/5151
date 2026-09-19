# 5151 Runtime HA + Performance Modernization — 進度

整合分支：`deepseek/ha-runtime-modernization`
BASE_SHA：`c60a4f084bc5a01df0858eb669527f074bf22d8a`

## 已完成

### Phase 0 — 保護 Production / 建立分支
- fetch master、記錄 BASE_SHA、建立 integration branch（不在 master 直接工作）。
- 未碰任何 Production container / Cloudflare / v3.db / 5151-ops。

### Phase 2 — Performance Baseline（第一優先）
- 新增 `v3/benchmark-runtime.mjs`：可重複執行的 synthetic benchmark，量測
  `listListings()` + `stats()`，含 p50/p95/p99 與 stage 分解（sql/profile/relations/display/sort/hydrate）。
- 新增 `v3/run-baseline.mjs`：每個 dataset size 獨立子行程執行（避免 module-level
  SQLite singleton 跨 import 快取），寫出 `evidence/runtime-modernization/baseline.{json,md}`。
- 已量測 1k / 10k / 50k（見 baseline.md）。目前 `node:sqlite` 下 50k `fit_desc` p95 ≈ 684ms，
  仍在 section 21 接受標準內；主要瓶頸是 SQL 候選 33k 列全量載入 Node 再過濾。

### Cross-platform test harness（Windows + Linux）
- 修正 `runIsolated` 型測試以 `pathToFileURL(...).href` 包裝 ESM specifier
  （Windows 上 `import "C:\\..."` 是無效 ESM）。
- `.gitattributes` 增加 `*.yml/*.yaml eol=lf`，避免 Windows checkout 的 CRLF
  讓 `onBlock` regex 撈不到 `on:` 區塊。

## EXTERNAL_SETUP_REQUIRED

- **Synology NAS SSH**：`61.30.26.182:54222`（DOCKER_HOST）連線逾時。已知 local key
  `~/.ssh/5151_ops_synology`（`github-5151-ops-synology`）。需要 Owner 提供目前可達的
  Synology SSH host/port 才能做 shadow PostgreSQL-B / Web-B / crawler-B / worker-B。
- **Object storage (S3/R2) credentials**：storage abstraction 的 S3 driver 需要 endpoint/key。
- **Gitea credentials / hostname**：Gitea migration rehearsal + loop-engine 需要 Gitea instance。
- **OpenAI Reviewer API key**：optional Final Review flow 需要。

## 尚未開始（依優先序）

1. Phase 7 SQL-first search（listing_search_projection、indexed ORDER BY、cursor pagination）
2. Phase 3 Web/Crawler/Worker split（APP_ROLE）
3. Phase 4 durable PostgreSQL job queue（FOR UPDATE SKIP LOCKED）
4. Phase 5/6 repository layer + PostgreSQL adapter + migration framework
5. Phase 13–15 PostgreSQL Primary/Standby + HAProxy + manual failover runbook
6. Phase 16–17 Web active/active + Cloudflare HA
7. Phase 18 storage abstraction（local/s3）
8. Phase 22–27 Gitea + loop-engine + optional Final Review

## 注意（Windows 本機）

- 完整 `npm test` 在本機 Windows 仍有一個已知環境差異：`activate-rental-marketplace-pra-workflow.test.js`
  呼叫 `python3`（Windows 為 `python`），以及部分 `ops/test/*` 依賴 git/shell 路徑。
  Linux CI（GitHub Actions）不受影響，全綠。
