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

## Review P1-7：mutation 前強制 fixture readiness

`activate-rental-marketplace-stage1-remote.sh` 在 `run_domain activate` 之前先跑 fail-closed pre-activation fixture gate：

- 重複使用 `stage1FixtureOps.verifyStage1Fixtures`（read-only，同一 Match Engine helper）
- 確認 owner_matching 仍 false、exactly one uncleaned run、A/B/T + open listing + active/paused/completed/inactive + hard-conflict control 齊備、namespace 正確、product isolation 成立
- 產出唯一 `fixture_run_id` 與 `fixture_readiness_at`
- 任一失敗直接 `fail-before-save`，絕不呼叫 `saveRentalMarketplaceFlags` / `run_domain activate`

## Review P1-8：activation 成功後的 fixture cleanup 閉環

新增 fixture domain mode `cleanup-activated`（`owner_matching=true`、不改 flags）。remote.sh 在 post-activation probes 全 PASS 後、寫最終 `ACTIVATION_OK` receipt 前：

1. exact `fixture_run_id` cleanup（只 fixture exact identities）
2. verify 無 open/active fixture listing/wish、產品面不可見
3. cleanup 成功才寫最終 receipt（含 `fixture_cleanup=true`）
4. cleanup 失敗 → `FIXTURE_CLEANUP_FAILED` → 既有 compensating rollback 把 `owner_matching=false`
5. cleanup 本身不關 Stage 1 flag；只有 cleanup failure 的 compensation 才 rollback

## Review P1-9：per-run unique durable evidence

- activation core / rollback / fixture core 改 per-run path：含 `GITHUB_RUN_ID` + `GITHUB_RUN_ATTEMPT`
- core / rollback / fixture core 內含 `workflow_run_id` / `workflow_attempt`
- workflow 只 pull current-run exact path；`write-stage1-activation-artifact.py` 驗證 evidence run identity 與本次一致
- stale prior-run file 不得滿足本次 `evidence_available`
- durable backup receipt 標示 `original_run_id`/`original_attempt` 與 `verification_run_id`/`verification_attempt`

## Release-gate P2：帳號建立與 registry 綁定必須原子

`prepareStage1Fixtures` 的帳號建立改走 `createAtomicFixtureUser`：`registerUser` 與 `registerFixtureRow` 包在**同一個 `BEGIN IMMEDIATE`**，任一失敗即 `ROLLBACK`。

- crash 在 `registerUser` 與 `registerFixtureRow` 之間不會留下沒有 registry 的 verified fixture account
- 同一 run 重試 deterministic、不被 orphan 阻擋
- cleanup / reap 只依 registry exact identity，**永遠不會動到一般會員**
- 回歸：`P2 fixture user creation and registry binding are atomic (no orphan, retry unblocked)`、`P2 cleanup and reap never delete a normal user`
- **不**修改一般會員 registration / signup_count 規則

## Review P1-10：verify-only 不得因 fixture 已被 cleanup 而回滾

第一次成功 activation 的流程是 `post-activation probes → cleanup-activated → ACTIVATION_OK receipt`，會把 fixture registry 標記 cleaned。若之後 Stage 1 已 ON、durable receipt 相符而進入 `PATH_KIND=verify-only`，舊流程仍呼叫 fixture-dependent 的 post-activation probes，會在 fixture 已被清掉時失敗並 `compensate_and_fail`，把健康的 `owner_matching=true` 誤回滾為 false。

修正：`hydrate_runtime_on` 新增 `mode` 參數（`activate` / `verify-only`）：

- `verify-only` **不**呼叫 `run_post_activation_probes`（fixture-dependent）
- 驗證 durable receipt 身分 + 先前 `fixture_run_id` + 先前 `fixture_cleanup=true` + runtime `owner_matching=true`
- 保留原本 activation 的 authenticated post-activation 證據（標記 `current_run_is_verification`、`fixtures_cleaned_by_prior_run`、`original_run_id`、`verification_run_id`）
- 仍做 current-run 檢查：health、landing/login、public flags、aggregate/exposure、unauth 401、5xx/SQLITE_BUSY、image/revision、Stage2–4/outbound OFF
- verify-only 走 `fail`（**不呼叫** `compensate_and_fail` / `run_domain rollback`）；只有 activation 路徑才用 compensating rollback
- 回歸：`P1-10 verify-only recovery never rolls back merely because fixtures were cleaned`、`P1-10 verify-only still fails closed on identity, runtime or UAT substitution`、`P1-10 a cleaned fixture run leaves zero active rows so the fixture-dependent selector cannot run`

## Review P1-11：cleanup 語意驗證失敗也必須補償

`run_fixture_domain cleanup-activated` 的 transport/process 失敗本來就有補償；但若它 exit 0、而複製回來的 JSON 損毀或語意檢查失敗（`mode != cleanup-activated`、`flags_mutated != false`、`owner_matching_enabled != true`、`result.ok != true`），原本的 `python3` 在 `set -e` 下會直接中止，**不經 `compensate_and_fail`**，導致 `owner_matching` 可能留在 ON 而 workflow 失敗、又沒有 durable receipt。

修正：語意驗證以 `set +e` 執行、捕捉 `CLEANUP_SEMANTIC_RC`，非 0 即 `compensate_and_fail "post-activation fixture cleanup evidence validation failed"`。

- 回歸：`P1-11 cleanup semantic-validation failure is compensated (Stage 1 never left ON)`

## Review P2-12：重複 verify-only 必須保留真正的 original run

verify-only 原本用 `prev.get("workflow_run_id")` 當 `original_run_id`。第一次 verify-only 改寫 receipt 後，`prev.workflow_run_id` 就變成那次驗證 run，第二次 verify-only 會把 `original_run_id` 往前推進，遺失真正把 Stage 1 打開的那個 run 身分。

修正：`original_run_id = prev.get("original_run_id") or prev.get("workflow_run_id") or run_id`（attempt 同理）。

- 回歸：`P2-12 repeated verify-only replays keep the original activation run`

## Review P2-13：整個 A/B/T 帳號建立階段一個交易

`createFixtureUserRow` 只在呼叫者的交易內建立單一帳號 + registry row；`prepareStage1Fixtures` 用 `withFixtureImmediateTx` 把 A/B/T **整個階段包成一個 `BEGIN IMMEDIATE`**。若 B 或 T 失敗，A 也會一起回滾，不會留下部分 registry 而讓同 run 重試卡在 `verifyStage1Fixtures`。

- 不修改一般會員 signup_count 規則、不動一般會員
- 回歸：`P2-13 the whole A/B/T account phase is one transaction (no partial accounts)`、`P2-13 a leftover run stays fail-closed for a different run until cleaned`

## Review P1-14：landing/login 必須真的驗 HTTP status

`hydrate_runtime_on()` 原本只確認 curl transport/5xx，卻在 runtime 證據無條件寫 `"landing": true, "login": true`；因此 landing/login 回 404 也會被記成 PASS。

修正：

- 解析 `land_probe` / `login_html_probe` 的 status，要求 **HTTP 200 且 response body 非空** 才 `land_ok` / `login_ok`
- runtime 證據與 core receipt 改由已驗證結果衍生（`"landing": land_ok`、`"login": login_ok`、receipt 用 `runtime.get("landing") is True`），不再硬編碼 true
- `activate-rental-marketplace-stage1-evidence.py` 的 `assert_runtime_contract` 新增 health/landing/login 必須為 true
- verify-only 共用同一組檢查，但失敗時**不回滾**（走 `fail`）
- 回歸：`P1-14 landing/login must be verified with HTTP 200 (no hardcoded PASS)`

## Review P2-15：hard-conflict 負控制必須 fail-closed

`activate-rental-marketplace-stage1-postcheck.mjs` 原本只在 `hard` registry row 存在時才檢查；若 role 缺失、wish row 消失或 listing 找不到，整個負控制會被跳過，卻仍可能寫入 `hard_conflict_rejected=true`。

修正為 fail-closed，要求全部成立才claim：

1. bound run 內**剛好一筆** `wish_hard_conflict` registry row
2. 對應 wish row 存在且 namespace 與 registry 相符
3. bound fixture listing 存在（且等於 selected listing）
4. 用正式 Match Engine counterfactual helper 實際執行並回傳 ineligible
5. hard-conflict wish 不在 selected/suppressed 可匹配集合

任一缺失/異常 → throw（initial activation 走既有 compensating rollback）
- 回歸：`P2-15 missing hard-conflict registry row fails the post-activation gate`、`P2-15 a hard-conflict registry row without its wish row fails the gate`、`P2-15 an unexpectedly eligible hard-conflict control fails the gate`

## Review P1-16：commute snapshot 必須走集中式 fixture 隔離

`listingCommutePatch()` 原本直接 `SELECT * FROM listings WHERE post_id = ?` 後回傳位置/通勤投影，沒有經過集中式 fixture 可見性政策，於是會員只要猜到／列舉 fixture `post_id`，就能透過 `/api/commute/snapshot?ids=...` 取得 fixture 物件存在與位置。

修正：`listingCommutePatch()` 在查得 row 後立即套用 `listingVisibleOnSurface(row, { surface: LISTING_SURFACE.MAP, viewerId: uid })`；fixture 列在 MAP 產品面一律回 `null`（等同不存在），不新增 ad-hoc namespace 字串比對。watcher 與正常通勤行為不受影響。

- 回歸：`P1-16 commute snapshot never reveals a fixture listing to ordinary members`、`P1-16 listingCommutePatch enforces the centralized MAP fixture policy (not ad-hoc SQL)`

## Issue #349：cleanup 先關閉再標 cleaned，並補 orphan recovery

CI 端 UAT cleanup 先把 listing／wish 的 registry 列標成 cleaned 才刪帳號，底層列仍是 open；runtime 的 cleanup／reap-stale 都只從 active registry 列進入，所以那些列只會被 `verifyCleanup()` 偵測到、卻永遠刪不掉（Production 上即 `FIXTURE_CLEANUP_FAILED: open fixture listings remain`）。此為孤立殘留，產品面由 `stage1FixtureIsolation.js` 擋住，不是產品可見的洩漏。

A. CI 端（`.github/scripts/production-uat-stages-wiring.mjs`，不部署）

`cleanupUatFixtures()` 改為 close → 標 cleaned → 刪帳號：

1. 先對本 run 的 listing 走 `closeSelfListing(..., { admin: true })`、wish 走 `applyWishLifecycleAction`（pause，失敗才 complete）
2. 重新讀回確認真的不再 open，否則 throw：fail closed、registry 列保持 uncleaned，同一 run 可重試
3. 才 `markRegistryRowCleaned`，最後才刪帳號
4. 只處理 fixture namespace 相符的列，不符即拒絕（一般會員列不可碰）
5. 結果多回報 `closed_listings` / `closed_wishes`

B. runtime（`v3/src/stage1FixtureOps.js`，需部署）

新增 `listOrphanFixtureRows()`：找出掛在 fixture namespace、但已無 active／uncleaned registry 列的 open 列。`cleanup` / `reap-stale` / `cleanup-activated` 在處理 registry 列之後、刪帳號之前，額外關閉這些孤兒列，並把 `orphan_recovered_count` / `orphan_recovered` 寫進 cleanup evidence。

- prepare 與 verify 完全不會走到這段，不會取得 orphan recovery 權限
- 仍然 registry exact identity + namespace 比對；沒有 wildcard delete users/listings/wishes
- 一般會員列沒有 fixture namespace，永遠不會被選中
- orphan 列若無法關閉即 `FIXTURE_CLEANUP_FAILED`（fail closed）
- outbound（digest / mail / push）為 ON 時，所有 cleanup 模式仍然拒絕
- 仍然不改任何 feature flag

C. 失敗也要有可診斷的 durable evidence（`.github/scripts/stage1-fixture-remote.sh` + `prepare-rental-marketplace-stage1-fixtures.yml`）

domain 失敗時仍寫入 per-run core：

- node 輸出存成 log 並印出 tail；失敗訊息附上 exit code
- core 寫入 `posture`（partial result 有就用）、去識別化的 `failure_reason`、`ok=false`、`evidence_available=false`、`domain_exit_code`
- 保留 `workflow_run_id` / `workflow_attempt`，P1-9 的當 run 身分檢查語意不變
- workflow Write step 帶出 `failure_reason`；Conclude step 先印出失敗原因才做 fail-closed 契約檢查；`evidence_available` 仍只在成功 core 時為 true
- 失敗 run 仍然不得 PASS

- 回歸：`#349 UAT cleanup closes every fixture row before it books the registry row cleaned`、`#349 UAT cleanup fails closed when a fixture row cannot be closed and stays retryable`、`#349 UAT cleanup fails closed when a listing silently stays open`、`#349 cleanup reclaims a namespace-bound row whose registry entry was booked cleaned first`、`#349 orphan recovery never closes a normal member row`、`#349 prepare and verify never reclaim an orphan row implicitly`、`#349 an outbound channel that is ON refuses every cleanup mode`、`#349 orphan recovery adds no wildcard delete and no flag mutation path`、`#349 a failed fixture domain run still publishes posture and the failure reason`

## Review P2-17：整個 prepare 必須可 replay（same-run resume）

P2-13 只讓 A/B/T 帳號階段原子；listing / wish / lifecycle 仍是各自獨立步驟。若中途失敗：A/B/T 已提交、部分 registry / fixture 列殘留、同 run 重試會直接進 `verifyStage1Fixtures` 而因 bundle 不完整失敗、不同 run 又被 run exclusivity 擋住。

由於 `createSelfListing` / `createDemandPost` / `applyWishLifecycleAction` 各自會開自己的 `BEGIN IMMEDIATE`（無法外層包一個大交易），改採 **deterministic same-run resume**：

- 以 `listActiveRegistryRows` 為 source of truth，逐角色判斷
- 帳號：只建立缺少的 A/B/T（單一交易）
- listing / wish：若 registry row 存在但 domain row 不存在（中斷的 pre-registration），以 `markRegistryRowCleaned` 釋放該筆 reservation，再建立
- wish lifecycle：用 `mapLegacyLifecycle` + `canSelfTransition` 對照每個角色的目標狀態（hard/completed → `completed`、paused → `paused`、active → `active`、inactive → `draft`），未達標就套用既有 domain transition；無法安全 reconcile 則 fail-closed
- 不刪除既有 fixture 帳號（避免 signup_count 被消耗）；不動一般會員；部分失敗期間 fixture 仍維持隔離
- 不同 run 在 incomplete run 完成或清理前仍 fail-closed
- 回歸：`P2-17 retry of the same run completes after an aborted listing registration`、`P2-17 retry of the same run completes after an aborted wish registration`、`P2-17 retry reconciles a wish whose lifecycle transition did not complete`

## Review P1-18：member-visible 總數不得洩漏 fixture

`stats().dbTotal` 原本用 `listingCount()`（`SELECT COUNT(*) FROM listings`），所以 fixture listing 存在時，一般會員可透過 `/api/listings` 的 `dbTotal` 觀察到它。

修正：新增 `productListingCount()`，用共用的 `sqlExcludeFixtureRows(db, "listings")` 排除 fixture；`stats().dbTotal` 改用它。**raw `listingCount()` 保持不變**（watcher 等維運用）。

- 回歸：`P1-18 product-visible totals exclude fixture listings`

## Review P2-19：landing/login 需驗證頁面內容

除 200 + 非空外，需驗證頁面專屬 marker：

- landing：`<title>吉比租房物件追蹤</title>`
- login：`<title>登入 · 吉比租房物件追蹤</title>` + `<form id="loginForm">` + `type="password"`

- 回歸：`P2-19 landing/login evidence requires the intended page markers`

## Review P2-20：hard-conflict 必須證明是 `condition:need_pet`

不再只看 boolean；改用 `evaluateCounterfactualMatch()` 的結果檢查 `hard_conflicts`：

1. 必須包含 `condition:need_pet`
2. 不得含任何其他衝突（district / budget / fixture_namespace / listing_status / lifecycle…）
3. `eligible` 必須為 false

- 回歸：`P2-20 the hard-conflict control must expose the intended condition:need_pet code`（valid / district / budget / 相容 / 多餘衝突）

## Review P2-21：listing INSERT 後的中斷必須可回滾重試

`createSelfListing()` 在**沒有** idempotency key 時不走 `withImmediate`，故 `onAfterInsert` 失敗會留下半寫入的 fixture listing。

修正：`listingFixtureInput()` 帶入 deterministic per-run `idempotency_key`（`stage1-fix-listing-<hash>`），使 `createSelfListing()` 走既有 `withImmediate(db, run)` 原子路徑；`onAfterInsert` 失敗會回滾 listing 及後續部分寫入，pre-registered registry reservation 再由 resume 邏輯釋放/重建。

- 回歸：`P2-21 an onAfterInsert crash rolls the fixture listing back and retry recovers`
