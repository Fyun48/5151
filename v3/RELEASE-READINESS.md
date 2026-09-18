# Rental Marketplace v2 — Release Readiness Gate（Issue #327）

本文件是 Issue #327 的盤點證據。**不是 Production deploy 授權。**

- 不執行 Production deploy
- 不變更 Production DB
- 不啟用 Production B/C/D flags
- 不正式啟用 email / push / daily digest
- 不自行開始 staged activation

```text
A/B/C/D 已進 master
→ Release Readiness（本文件）
→ Build / Test / Predeploy Gate
→ STOP 等 Owner deploy approval
→ 未來部署時保持新功能 flags OFF
→ Production authenticated UAT
→ STOP 等 Owner activation approval
→ Stage 1 owner matching
→ Stage 2 wish offer / double consent
→ Stage 3 public share v2 / growth
→ Stage 4 in-app owner notifications
→ email / push / digest 最後另行批准
```

部署程式 ≠ 開啟功能。

---

## 1–3. Identity

| 項目 | 值 |
|---|---|
| Gate 開始時 `origin/master` SHA | `ea1872b95fb3bb8139b5fb64f044ad4b79e01906` |
| Gate 開始時 tree SHA | `b985ce64a7a842e2786ec54612a22e803d823476` |
| 來源 | Merge pull request #326（PR D notifications） |
| 本 remedation branch | `cursor/rental-marketplace-release-readiness-337d` |
| 本 PR | https://github.com/Fyun48/5151/pull/328 |
| 本 PR HEAD | `598d6b29a4a4c345b74ee0cc2d6709fa363f165d` |
| 本 PR tree | `a83d3ff6d930e088c6ca2eebc7ed8b64250598e4` |
| 本 PR 合併後 | 必須重新鎖定 **新的** master exact SHA + tree SHA |

目前正式站最後一次成功 Deploy v3（**不含** B/C/D code）：

| 項目 | 值 |
|---|---|
| Production source SHA | `9fb94e4a81cceebbb7b29fcb0cb49b24b396f3c4` |
| Workflow | Deploy v3 to CasaOS (manual) run `35091173197`（2026-09-16） |
| 先前 image / backup | 以該次 predeploy run `35089846997` 實際 artifact 為準，禁止捏造 digest |

PR A flags 啟用：Activate PR A run `35070846756`（2026-09-16），source `376876794dabe6eeaa93aef074d045c4543479a6`。預期 Production 已有 catalog + lifecycle ON，B/C/D 與 outbound 仍 OFF。

---

## 5–7. A. Release workflow audit

盤點 `.github/workflows/`（10 檔）：

| Workflow | Trigger | Production 效果 | 結論 |
|---|---|---|---|
| `test.yml` | push / PR → master | 只跑 `npm test`，無 NAS、無 deploy | OK |
| `build-production-image.yml` | `workflow_dispatch` only | 建 SHA tag + digest，不 SSH、不改 `:latest` | OK |
| `production-predeploy-check.yml` | `workflow_dispatch` + `PREDEPLOY-PRODUCTION` | 檢查 / 備份，不部署、不跑 schema migration | OK |
| `deploy-v3.yml` | `workflow_dispatch` + `DEPLOY-PRODUCTION` + digest | digest pin，禁止 `:latest`，只 recreate v3 | OK |
| `deploy-v2.yml` | `workflow_dispatch` | 授權後一律拒絕 | OK（已拆除） |
| `docker.yml` | `workflow_dispatch` | **本 PR 前**：推 `:latest` 並 `compose pull/up` | **BLOCKER → 本 PR 已停用** |
| `activate-rental-marketplace-pra.yml` | `workflow_dispatch` + `ACTIVATE-PRA-PRODUCTION` | 只開 catalog + lifecycle，保留 B/C/D OFF | OK |
| `activate-rental-marketplace-stage1.yml` | `workflow_dispatch` + `ACTIVATE-STAGE1-PRODUCTION` | 只開 `owner_matching`；PRA 維持 ON；Stage 2–4 / outbound 維持 OFF | **repo 已建、尚未在 Production 執行** |
| `production-support-check.yml` | `workflow_dispatch` + `VERIFY-V3-SUPPORT` | 唯讀檢查 | OK |
| `production-rakuya-diagnostic.yml` | `workflow_dispatch` + `DIAGNOSE-RAKUYA` | 唯讀 | OK |

### Manual-only proof

三條正式路徑與支援檢查皆：

- `on: workflow_dispatch`（無 `push` / `pull_request` / `schedule` / `workflow_run`）
- 必須 `refs/heads/master`
- `PRODUCTION_DEPLOY_ALLOWED_ACTOR` 未設定 fail-closed
- actor + triggering_actor 雙檢
- 40 碼 SHA；deploy 另需 `sha256:` + 64 hex digest
- concurrency group `production-deploy`，`cancel-in-progress: false`
- Production 未知（digest / backup / confirmation 不合）fail-closed

未建立第二套 deployment framework。本 PR 把既有第四條 `:latest` 路徑改成與 `deploy-v2.yml` 相同的 refuse-closed。

### Artifact identity strategy

1. Build：`ghcr.io/fyun48/5151:<40-sha>`，OCI `org.opencontainers.image.revision` 必須等於 source SHA；Production 身分以 **manifest digest** 為準。
2. Predeploy：不 checkout 候選 SHA 到 NAS；備份路徑 + `sha256:` hash 寫入 artifact。
3. Deploy：tag digest 必須等於輸入 digest；compose override `image: …@sha256:…`；若解析到 `:latest` 則失敗。
4. Rollback：另一次 `deploy-v3.yml` 指向先前已驗證的 SHA + digest + 該次 predeploy backup。不自動還原 DB。

---

## 8. C. Full regression gate

覆蓋（現有測試，未 skip / 刪除 / 放寬）：

| 領域 | 主要測試 |
|---|---|
| Catalog / Wish lifecycle | `rental-marketplace-pra.test.js`, `wish-lifecycle.test.js`, `wish-room.test.js`, `wish-conditions.test.js` |
| Match Engine / reverse discovery / aggregate | `rental-match.test.js`, `rental-match-query.test.js`, `rental-match-ui.test.js` |
| Wish Offer / state / double consent | `wish-offer.test.js` |
| Block / Report | `wish-offer.test.js` |
| Notify / digest / workers | `rental-notify.test.js`, `rental-notify-isolation.test.js` |
| Share v2 / growth | `rental-marketplace-pra.test.js`, `rental-notify.test.js` |
| Survey / admin analytics | `rental-notify.test.js`（survey + ops） |
| Ranking / duplicate primary / same-house isolation | `listing-score.test.js`, `rental-match-isolation.test.js`, `user-same-house.test.js` |
| Auth / CSRF / opaque refs | wish / offer / pra / oauth 既有套件 |
| Performance | `list-perf-bench.test.js`, match/notify EXPLAIN bounds |

**master `ea1872b` Actions** run `35191081347`：1748 pass / 1 fail。失敗是既有 `list-perf-bench` 抖動：`paired p50 delta 7.54 should not exceed +5ms`。**不得放寬 threshold。** 本 PR 的 same-SHA Actions 若再遇到同一抖動，重跑即可，不可改門檻。

本 PR HEAD 本機 `npm test`：1753 pass / 1 fail。失敗是既有 `list-district-relations` EXPLAIN 抖動（同一 `idx_listings_district_prefix` 被報成 `SCAN` 而非 `SEARCH`）。重跑 lock-in／offer／PRA／list-perf-bench 皆綠。**不改 EXPLAIN 斷言。**

---

## 9–11. D/E. Schema / backup / rollback

Schema 在 process boot 無條件 `CREATE IF NOT EXISTS` + 守衛式 `ALTER`（`db.js` → demand / match indexes / wish offer / rental notify）。**不依 flag 決定是否建表。**

### 新增（additive）

- PR A：`demand_posts` 生命週期欄、partial unique（一人一則 open/draft）、`public_token`、`demand_replies` 相容
- PR B：`demand_match_generation`、district index、triggers
- PR C：`wish_offers`、idempotency、reports、events、`user_blocks`
- PR D：notify prefs / events / deliveries / digest / seen / cursors / share events / surveys / analytics daily

Idempotent：`IF NOT EXISTS`、`PRAGMA table_info` 再 `ALTER`、index/trigger try/catch。舊資料：legacy 多則 open 會先收斂再建立 unique；`legacy_numeric_share` 回填。

### Rollback

- Code rollback 對 additive schema：**可**（舊碼忽略新表／新欄）。
- 必須同時把 B/C/D / outbound flags 維持 OFF（PRA script 有 compensating rollback）。
- 若 lifecycle 已啟用後 rollback code：須審查 `lifecycle` / `expires_at` 資料，不可只換映像。
- 資料備份責任：`production-predeploy-check.yml` 線上 SQLite backup + integrity_check。本 Issue **不**操作正式資料。

---

## 12. F. Expected feature-flag snapshot

儲存在 `settings.rentalMarketplaceFlags` JSON。**沒有 env override。** 只有 `=== true` 才算 ON。Init / migration **不會**自動把 Production flag 變 ON。

### 部署本 RC 時預期（server-side）

| Flag | 預期 | 說明 |
|---|---|---|
| `rental_catalog_v2.enabled` | **ON（維持）** | PR A 已正式使用，禁止誤關 |
| `wish.lifecycle_enabled` | **ON（維持）** | PR A 已正式使用，禁止誤關 |
| `wish.owner_matching_enabled` | OFF | Stage 1 |
| `wish.offer_enabled` | OFF | Stage 2 |
| `wish.public_share_v2_enabled` | OFF | Stage 3 |
| `wish.owner_notifications_enabled` | OFF | Stage 4 文件旗標 |
| `wish.notifications_enabled` | OFF | **實際 in-app notify 閘門** |
| `wish.digest_enabled` | OFF | Final outbound |
| `wish.outbound_mail_enabled` | OFF | Final outbound |
| `wish.outbound_push_enabled` | OFF | Final outbound |

`publicRentalMarketplaceFlags()` 即使 DB 為 true，對外也強制 B/C/D / notify / digest / mail / push = false。只露出 catalog + lifecycle。

**Stage 4 注意：** runtime `isRentalNotificationsEnabled()` 讀的是 `notifications_enabled`，不是 `owner_notifications_enabled`。開 Stage 4 in-app 時必須把 **兩個** 都打開，且 digest / mail / push 維持 OFF。

PRA 啟用腳本只寫 catalog + lifecycle；本 PR 把 notify / digest / outbound 列入 reserved，啟動前若已髒會 fail-closed。

---

## 13–14. G. Worker safety matrix

間隔皆 5 分鐘。Notify 全家在同一 `BEGIN IMMEDIATE`、in-process `running`、batch 80。

| Worker | Flag | Batch | Non-reentrant | Retry / idempotency | Poison | Restart | Channel OFF |
|---|---|---|---|---|---|---|---|
| Wish lifecycle | `lifecycle_enabled` | 80 | in-process + IMMEDIATE | 重讀 + plan gate | 不適用則 skip | **無 cursor**（見風險） | 無 outbound |
| Offer expiry | `offer_enabled` | 80 | 同上 | version optimistic | 狀態變了 skip | `expires_at` 佇列自然排空 | 無 outbound |
| Lifecycle reminders | `notifications_enabled` | 80 + cursor | notify tick | `event_key` UNIQUE | window null skip | cursor wrap | prefs + channelAllowed |
| Match notify | matching + notifications | 80 subs；match page 20 | notify tick | episode + `rental_match_seen` | `matchFn` throw continue；hard-gate 關 episode | cursor wrap | instant 受 digest/outbound 抑制 |
| Digest | notifications **且** digest | 80 buckets；item 8 | notify tick | token + UNIQUE item | overflow 計數不插入 | 關昨日 bucket | digest OFF 不關 bucket |
| Delivery retry | notifications；mail/push 另旗 | 80 | notify tick | delivered 不重排 | 5 次 → `terminal_failed` | backoff ≤ 6h | mail/push flag OFF 不送 |
| Survey due | 完成 Wish 同步 emit | 單筆 | n/a | `completion_survey_due` key | n/a | UNIQUE wish | 走同一 queueDeliveries |
| Analytics / cleanup | notify tick 才 cleanup | 80+80 | notify tick | daily upsert | 有 queued delivery 不刪 | 180d events / 90d share | 無 outbound |

Outbound 在 `queueDeliveries` / `deliverQueuedNotifications` fail-closed。Channel OFF 不會寄信或推播。

---

## 15. H. Security / privacy

既有測試支持：

- 公開許願房只用 opaque `public_token`；public view 禁 `user_id` / email / phone / contact
- 非 open 公開頁只回 inactive stub（`noindex`、無條件／PII）
- 屋主 matching 404 若非自己的 listing；卡片無租客 PII、無 internal score
- stale match 不能 create offer（`match_no_longer_eligible`）；accept 再檢一次
- pending offer 無租客聯絡；accepted 才 Double Consent
- block 後 contact `contact_unavailable`；notify lookup 失敗當 blocked
- Admin analytics：`requireAdminApi`、範圍 ≤ 93 天、drill ≤ 50、只回 opaque ref
- notify `safePayload` 剝 PII keys

本 PR 補：`listMyBlocks` / `unblockByRef` 在 `offer_enabled` OFF 時 404 fail-closed。

---

## 16. I. Performance preflight（非正式環境）

| 路徑 | 既有門檻 |
|---|---|
| Match 80 candidates | < 1500ms + district index EXPLAIN |
| Match 801 page | < 5000ms |
| Aggregate 2005 | < 8000ms |
| 2 listing × 30 wishes | < 3000ms |
| Notify EXPLAIN | < 200ms |
| Notify cursors | 220 rows / 4 ticks |
| list-perf-bench | cached ≤ cold+5ms；paired p50 delta ≤ 5ms |

未放寬。CI 偶發 paired p50 +7.5ms 視為 runner 抖動，不是放行理由。

---

## 17. J. Production authenticated UAT checklist（只準備，不執行）

未來 UAT 必須綁定 **deployed exact SHA + flag snapshot**。至少：

1. Tenant 建立／確認 Wish
2. Wish lifecycle / canonical conditions
3. public share 無 PII
4. Owner listing match count
5. Owner matching detail
6. 匿名 match explanation
7. Owner 建立 Wish Offer
8. Tenant 收到 offer
9. pending 無 tenant PII
10. Tenant accept
11. Double Consent contact projection
12. block 後 contact 失效
13. report
14. complete Wish
15. survey
16. Admin analytics
17. 跨帳號 unauthorized access fail
18. opaque ref enumeration fail-safe
19. paused/completed Wish 不可新 offer
20. closed listing 不可 offer
21. duplicate / idempotency
22. refresh / back / multi-tab consistency
23. 375 / 768 / 1440

本 Issue **不**做正式 UAT。

---

## 18–22. K. Staged activation

UAT 全綠後仍分階段。每一階段只開下表，觀察至少一個業務週期再進下一階段。

### Stage 1 — owner matching

- 只開 `wish.owner_matching_enabled`
- 觀察：matching 4xx/5xx、summary/detail latency、privacy suppression、DB load、aggregate
- Kill switch：立刻把 `owner_matching_enabled=false`（offer 必須仍 OFF）

### Stage 2 — wish offer / double consent

- 再開 `wish.offer_enabled`
- 觀察：funnel、duplicate/idempotency、rate limit、contact projection、block/report
- Kill switch：`offer_enabled=false`（已 accepted 的 contact 會隨 flag 404；屬預期 fail-closed）

### Stage 3 — public share v2 / growth

- 再開 `wish.public_share_v2_enabled`（仍需 lifecycle ON）
- 觀察：bot/rate、CTA、attribution、privacy
- Kill switch：`public_share_v2_enabled=false`（公開許願房退回既有 PR A 投影）

### Stage 4 — in-app owner notifications

- 開 `wish.owner_notifications_enabled` **與** `wish.notifications_enabled`
- **不要**開 digest / mail / push
- 觀察：duplicate、worker backlog、dedup/suppression、dock delivery
- Kill switch：兩個 notify 旗標一起關

### Final outbound gate（另一次 Owner 批准）

- `digest_enabled` / `outbound_mail_enabled` / `outbound_push_enabled` **不**隨 Stage 4 自動開
- 必須另一次書面批准，且 notifications 已穩定

---

## 23. L. Kill-switch / observability

每個 Stage 第一動作若發現 privacy / contact 外洩：

1. 立刻關該 Stage flag（server-side `saveRentalMarketplaceFlags`）
2. 不要先 rollback code（additive schema + flag OFF 即可停新能力）
3. 只有 app-wide 迴歸（列表／登入／許願房 PR A）才走 `deploy-v3.yml` 回到先前 SHA+digest
4. Production state unknown → 停止後續 release（既有 workflow fail-closed）

既有指標（不新建監控平台）：

- `/api/health`
- worker log：`wish-lifecycle` / notify tick JSON（無 PII）
- admin rental-ops counters
- GitHub Actions deploy / predeploy evidence artifacts
- SQLite backup identity from predeploy

---

## Stage 1 fixture readiness（後續 gate，非本文件當時的 deploy 授權）

方案 B 已另開實作，見 `v3/STAGE1-FIXTURE-READINESS.md`。該變更只存在後續 PR：registry + 集中隔離 + 成熟度例外 + fixture workflow + Stage 1 failure evidence `always()` 上傳。**不在本文件授權 Production fixture 或 Stage 1 重跑。**

---

## 24. Blockers

1. **`docker.yml` 第四條 `:latest` 部署路徑**（master `ea1872b`）— 本 PR 已改 refuse-closed。
2. **master Tests run `35191081347` 紅燈** — 單一 `list-perf-bench` 抖動，不是功能回歸。本 PR 必須交出 same-SHA 綠燈（必要時重跑，不改門檻）。

沒有其他 workflow / flag-init / outbound 自動開啟的 blocker。

---

## 25. Non-blocking risks

- Wish lifecycle worker 無 cursor：若 `open|expired` 超過 80 且前 80 筆長期不變更，高 id 可能延後掃描。PR A 啟用時 posts 為 0；規模變大前應補 cursor。
- Survey API 不吃 notify flag（只要求 Wish completed）。無 outbound。
- `owner_notifications_enabled` 與 `notifications_enabled` 雙旗標，Stage 4 必須兩個一起開。
- `casaos-compose.yml` / `docker-compose.yml` 檔案預設仍寫 `:latest`；正式站靠 deploy-v3 digest override。
- Code rollback 後若 flags 仍 ON，舊碼行為未定義 — rollback 必須補償 flags。

---

## 26. Exact conclusion

對 **未含本 PR 的 master `ea1872b`**：

`PRODUCTION_RELEASE_BLOCKED`

原因：`docker.yml` 仍可用 `:latest` 部署；且該 SHA 的 Tests Actions 未綠。

對 **本 PR 合併進 master 且 same-SHA Tests 綠、docker.yml 已 refuse 之後的新 SHA**：

可再核一次 identity 後改判 `PRODUCTION_RELEASE_READY`（仍 **不得** 自行 deploy / 開 B/C/D / 開 outbound）。

本 Issue 到此 **STOP**，等 ChatGPT 獨立核對與 Owner 下一步批准。
