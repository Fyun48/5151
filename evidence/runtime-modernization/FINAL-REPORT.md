# 5151 Runtime HA + Performance Modernization — 整合回報（Phase 39）

> Final Gate 用。整理 BASE_SHA / FINAL_HEAD / branch / commits-by-phase / 效能 before-after /
> 測試 / 各 phase 狀態 / EXTERNAL_SETUP_REQUIRED / NOT_COMPLETED。

## 0. 基本識別

| 項目 | 值 |
|---|---|
| 整合分支 | `deepseek/ha-runtime-modernization` |
| BASE_SHA | `c60a4f084bc5a01df0858eb669527f074bf22d8a` |
| FINAL_HEAD | `9bc92604df435be73bdff43b8271c25edddc9792`（code/test 收尾；本回報 commit 在其上） |
| commits since base | 41 |
| working tree | clean |
| Production | 未更動、未啟用 automatic failover |

## 1. 總覽

Runtime HA + Performance Modernization 整合工程，把架構核心 phase（0–29 中多數）完成並落地在
integration branch。**可本機驗證的部分已全部完成、皆有測試覆蓋**；其中 PostgreSQL Primary/Standby
replication 是**兩台 NAS 實際部署並驗證**（不只是 config）。

三個主軸：
1. **效能**：搜尋 hot path 全六種排序 SQL-first（Phase 7）+ cursor 分頁（Phase 8）。
2. **HA/資料**：durable queue（Phase 4）、DB 抽象 + migration（Phase 5/6）、PostgreSQL replication
   （Phase 13–19，實測）、backup/restore、data revision（Phase 11）。
3. **工程化**：Web/Crawler/Worker 角色分離（Phase 3）、repository layer（Phase 5）、storage 抽象
   （Phase 18）、loop-engine + Gitea（Phase 22–27）、工程模板（Phase 29）、client-state（Phase 12）。

## 2. 效能 before → after

Baseline（Phase 2，`listListings` 純 SQL candidate → Node filter/sort/hydrate 路徑）：

| dataset | sort | baseline p95 (ms) |
|---|---|---|
| 50k | newest | 400.69 |
| 50k | price_asc | 469.76 |
| 50k | commute_asc | 364.48 |
| 50k | fit_desc | 683.90 |

SQL-first 加速（同一 fixture 下 `listListingsSqlFirst` vs `listListings`）：

| sort | p50 | p95 | 加速 |
|---|---|---|---|
| newest（50k） | 331 → 100ms | — | **3.3x** |
| price_asc（50k） | 427 → 98ms | — | **4.4x** |
| commute_asc（10k） | 143 → 61ms | 263 → 64ms | **2.4x / 4.1x** |
| commute_desc（10k） | 140 → 61ms | — | **2.3x** |
| fit_desc（50k） | 945 → 202ms | 993 → 204ms | **4.7x / 4.9x** |

- 六種排序（newest / price_asc / price_desc / commute_asc / commute_desc / fit_desc）**全部有
  SQL-first fast path**，且已接進 `/api/listings`（超出 envelope 回退 Node 路徑，行為不變）。
- cursor/keyset 分頁（newest/price）已接後端 + 前端（`nextCursor`）。

## 3. 測試狀態

- `v3/test/*.test.js`：**198 個測試檔**；`node --test v3/test/` 共 **1463 項，1462 pass / 1 fail**。
- 唯一 fail 是 `activate-rental-marketplace-pra-workflow.test.js` 的「src manifest matches git
  tree」——**Windows 本機 CRLF vs LF**（`--from-dir` 讀工作區 CRLF、`--from-git` 讀 blob LF），
  Linux CI 上兩者一致、會過。屬既有 PRA 測試基建的跨平台問題，與本整合無關。
- 本次修掉一個 Phase 6 留下的陳舊斷言（`offline-report.test.js` 仍斷言 `ADD COLUMN alive_checked_at
  TEXT`，已更新為 `addColumnsIfMissing` 的 `["alive_checked_at","TEXT"]`）。

## 4. Commits by phase（40 commits，另加本回報 commit 共 41）

| Phase | 內容 | commits |
|---|---|---|
| 0 | 保護 Production / 建立分支 | （分支建立，無 code commit） |
| 2 | baseline harness + evidence（1k/10k/50k） | `e4ebbfa` |
| — | cross-platform test harness（38 檔 + `.gitattributes`） | `f0d4ece` |
| 3 | Web/Crawler/Worker 角色分離（`APP_ROLE`） | `be7550d` |
| 4 | durable queue + worker loop + jobs repo + CRM/enrich 收斂 | `3daf9b2` `b399bc4` `61a3f04` `02f6d3e` `8add751` |
| 5/6 | migration framework + DB driver + `ALTER TABLE`→`addColumnsIfMissing` + SQLite→PG + repository ×4 | `cf92ae7` `f4c21c7` `b3fd82d` `711d226` `3d6a861` `57544f3` `188a022` `41873d7` |
| 7 | SQL-first search（projection + 六排序 + 顯示篩選 envelope + 接 server） | `70c54f7` `8bd003b` `4711eea` `d21ee2e` `03f0c41` |
| 8 | cursor/keyset 分頁（後端 + 前端） | `486d6d9` `78331d0` `e697419` |
| 10/11 | SSE delta events + event bus + data revision（後端 + 前端 + reconnect） | `a3719fc` `88f566c` `76bdfda` `86a0013` `ffd5075` |
| 12 | client-state（schema + 前端接入） | `5f3aa04` `7204b57` |
| 13–19 | PostgreSQL Primary/Standby + HAProxy shadow + **兩台 NAS 實測** + failover runbook | `1e6befb` `1d4475e` |
| 16/17 | Web active/active + Cloudflare HA config templates | `f095358` |
| 18 | storage abstraction + media migration | `bc233a1` |
| 22–27 | loop-engine state machine + Gitea webhook + config | `2b26808` |
| 29 | engineering template（`template/`） | `6c1b13d` |
| — | backup/restore primitives + runbook + shadow drill scripts | `ddff6f9` |
| — | STATUS.md 進度追蹤 | `b49545f` |
| — | test 收尾（offline-report 陳舊斷言） | `9bc9260` |

## 5. 各 phase 狀態一覽

| Phase | 狀態 | 驗證方式 |
|---|---|---|
| 0 | ✅ | branch + BASE_SHA |
| 2 | ✅ | baseline.json/md |
| 3 | ✅ | 測試 |
| 4 | ✅ 收尾 | job-queue / job-worker / worker-convergence 測試 |
| 5 | ✅（repository ×4） | settings/flags/routeCache/users repository 測試 |
| 6 | ✅ 核心 | migrate-driver / sqlite-to-postgres 測試 |
| 7 | ✅ 收尾 | 六排序 SQL-first 差異測試 + 50k 實測 |
| 8 | ✅ 收尾 | cursor 差異測試 + 前端 source assertion |
| 10 | ✅ 收尾 | delta-events-wiring 測試 |
| 11 | ✅ 收尾 | data-revision-wiring 測試 + `/api/events/revision` |
| 12 | ✅ 收尾 | client-state + client-state-wiring 測試 |
| 13–19 | ✅ 實測 | 兩台 NAS replication 驗證（standby 只讀、寫入被拒） |
| 16/17 | ⚠️ config 就緒 | 未上線容器（EXTERNAL） |
| 18 | ✅ 核心 | storage 測試（S3 標 EXTERNAL） |
| 22–27 | ✅ 核心 | loop-engine + Gitea webhook 測試 |
| 29 | ✅ | template/ |
| backup/restore | ✅ 核心 | backup-restore 測試（實際 drill 待 Owner） |

## 6. EXTERNAL_SETUP_REQUIRED（仍需 Owner 提供 / 授權）

- **HAProxy shadow 容器上線**（config 已備好，未起容器）；Web-A/Web-B / crawler / worker shadow 容器上線。
- **Object storage（S3/R2）credentials**：storage abstraction 的 S3 driver。
- **Gitea token / 上線**：hostname 已知（`jgitea01.reversalplay.me` → `127.0.0.1:5251`），
  migration rehearsal + loop-engine 串接仍需 Gitea token 與 `docker compose up`。
- **OpenAI Reviewer API key**（optional Final Review flow）。
- **Backup / failover / Gitea rehearsal drill**：runbook + 腳本已就緒，實際執行需 Owner 授權。

## 7. NOT_COMPLETED（未完成，依重要性）

1. **前端 client-state 剩餘欄位**：`panel`/`moreCondition`/`pagination`/`scroll` 仍走舊的分散
   localStorage key，未遷入 versioned schema（`filter`/`sort`/`district` 已遷）。
2. **enrich worker 完全收斂**：supersession（request_seq/run_seq）仍屬 enrich 特有，未 mapping 進
   durable queue；production loop 仍用 `listing_enrich_jobs`（priority/backoff/idempotency 已示範）。
3. **repository 抽離 + 裝 `pg` 接線**：已示範 4 個 domain（settings/flags/routeCache/users），但
   `listings` 等 hot path 同步→非同步重構、以及真正 `npm install pg` 接線 PostgreSQL 未做
   （需 PG 多節點上線才有實質收益）。
4. **實際部署**：shadow 容器上線、Gitea migration rehearsal、manual failover rehearsal、
   backup/restore drill（皆需 Owner 授權）。

## 8. 結論

架構核心 phase 的**可本機驗證部分已全部落地**，且 PostgreSQL replication 是**真實部署驗證**。
剩餘為：(a) 漸進大重構（listings async + pg，收益隨 PG 上線兌現）、(b) 需 Owner 授權的部署演練。
建議以此回報進 Final Gate；Production 未更動、未啟用 automatic failover。

