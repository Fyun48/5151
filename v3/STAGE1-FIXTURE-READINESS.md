# Stage 1 fixture readiness（方案 B + P1-A/B/C）

本文件是 Stage 1 fixture 的 repo 實作規格。**不是 Production fixture 建立授權，也不是 Stage 1 activation 授權。**

- 不 merge、不 deploy、不建立／修改 Production fixtures
- 不改 Production feature flags
- Stage 2–4 / email / push / digest 持續 OFF

## 為什麼需要 registry

現有 postcheck `LIMIT 80` 最新自刊／最舊會員不是可重複 selector。新測試帳號不會落在 oldest 80。open self listing 與 open wish 在現行模型會進一般曝光；`deleteUser` 只軟刪帳號。

## Schema（additive / idempotent）

- `stage1_fixture_registry`：namespace / run_id / kind / role / row_id / created / expires / cleaned / status
- `listings.fixture_namespace`、`demand_posts.fixture_namespace` nullable
- TTL 72 小時；cleanup 只依 registry exact row identity + namespace，禁止 email LIKE

## P1-A 成熟度例外

- 正常會員維持 24h invariant
- 只有 active、未過期、未 cleanup 的 registry user，才能在 fixture-only helper 用 `authorizeFixtureMaturity()`（Symbol token）
- public HTTP / user-controllable field 無法開啟
- 所有 created / published / expires 寫真實 current time

## P1-B 集中式隔離

`v3/src/stage1FixtureIsolation.js` 是產品面 source of truth：

- 一般 browse / search / stats / map / detail / share / go **看不見** fixture listing/wish
- fixture owner 只能在 `owner_self` 表面讀自己的 listing / matches
- Match Engine：normal↔normal、同 namespace fixture↔fixture；禁止交叉
- 過濾在 SQL candidate selection 完成；aggregate/summary 不含 fixture
- 非 fixture actor 走 direct URL 時與不存在資源相同 404

## Fixture 最小集合

| 角色 | 內容 |
|---|---|
| A | 專用屋主 + 1 筆 open 未過期 self listing（士林 `1-8`） |
| B | 第二帳號 + draft wish（inactive） |
| T | completed + paused + active（條件相同，只差 lifecycle） |
| hard-conflict | T 的 `need_pet=want` 控制組，selector 必須拒絕 |

建立／狀態轉換／關閉／刪除走 `registerUser`、`createSelfListing`、`createDemandPost`、`applyWishLifecycleAction`、`closeSelfListing`、`deleteUser`。

Cleanup：close listing → pause/complete open wish → soft-delete fixture users → verify 無曝光 → mark cleaned。失敗回報 `FIXTURE_CLEANUP_FAILED`，且不得刪非 fixture 列。fixture workflow **不改 flags**；readiness PASS 時 `owner_matching` 必須仍為 false。

## Workflow

`.github/workflows/prepare-rental-marketplace-stage1-fixtures.yml`

- `workflow_dispatch` only、`production-deploy` concurrency
- confirmation `STAGE1-FIXTURES-PRODUCTION`
- `AUTHORIZE-STAGE1-FIXTURES:<mode>:<sha>:<digest>:<backup_id>:<backup_hash>`
- mode：`prepare` / `verify` / `cleanup` / `reap-stale`
- 禁止改任何 feature flag
- 本 PR **不 dispatch**

## Review P1-1／P1-2：帳號不可重用已知 credential

- repo 不得有 fixture plaintext password；prepare 用 `crypto.randomBytes` 高熵密碼，只在 process memory 交給 `registerUser`
- evidence / log / registry 只留 `email_hash`，不含 password / `Fx!` prefix
- post-activation probe 用 server-side `sessionCookie`，不需要保存密碼
- fixture email 由 `run_id + role` 的 SHA-256 短 hash 派生 `stage1.fixture.<role>.<hash>@jibby.test`
- 不得改一般會員 `signup_count` / 重註冊規則；下一 run 用新 email，不受前 run residue 影響

## Review P1-3：建立當下即隔離

- `fixture_namespace` 必須在 `createSelfListing` / `createDemandPost` 的同一 INSERT 寫入
- 只能由 server-only `authorizeFixtureIsolation()` Symbol token 啟用；HTTP / user input 的 `fixture_namespace` 被忽略
- prepare 先以預定 `row_id` 寫 pending registry，再在同一 create 路徑 INSERT（帶 namespace）；`registered: true` 避免事後 stamp
- 中斷時未 tagged 列不得公開；fault-injection 覆蓋 register / before-insert / after-insert

## Review P1-4：run isolation（方案 B）

固定 namespace `stage1-fix`。prepare 前 `assertPrepareRunExclusive`：若已有其他 uncleaned active/stale run 必須先 cleanup / reap。verify / cleanup / postcheck / evidence 綁唯一 `run_id`。不得靠固定 email 當 isolation。

## P1-C / Review P1-5／P1-6 Stage 1 evidence

- Authorization step `id: authorize`，全部 auth checks 通過後才寫 `authorized=true`
- NAS evidence pull：`always() && steps.authorize.outputs.authorized == 'true' && (remote outcome success|failure)`
- 未授權 run 只寫本地、無 secrets 的 fail artifact，不得碰 NAS
- success artifact 必須重建 PR #330 等價 contract：identity、`backup_verified`、`src_manifest_verified`、durable receipt、`verify_only`、receipt_path、digest 格式、after flags（PR A ON、owner_matching ON、Stage2–4/outbound OFF）、post_activation、禁止用 pre-activation UAT 替代
- rollback / failure artifact 可以不完整，但 Conclude 不得 PASS

## Stage 1 重跑條件（尚未授權）

1. 本 PR 經 ChatGPT / Owner 審查後合併
2. 未來部署含本 SHA 的 image（另一次 Owner deploy gate）
3. fixture prepare + verify 獨立 PASS，且 flags 仍為 PR A ON、Stage 1–4 / outbound OFF
4. 才可再申請既有 Stage 1 activation workflow
