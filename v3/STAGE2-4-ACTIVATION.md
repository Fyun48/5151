# Rental Marketplace Stage 2–4 分階段啟用（Production）

本文件說明 `.github/workflows/activate-rental-marketplace-stages.yml` 的設計、安全閘門與操作程序。
Stage 1（`wish.owner_matching_enabled`）仍由 `activate-rental-marketplace-stage1.yml` 負責，本框架不碰。

## 階段與 flag 對應

| Stage | flag | 使用者可見效果 |
| --- | --- | --- |
| 1（既有） | `wish.owner_matching_enabled` | 屋主配對 |
| 2 | `wish.offer_enabled` | 站內提案（`/api/wish-offers/*`） |
| 3 | `wish.public_share_v2_enabled` | 分享追蹤 v2（`/api/public/wish-room/:id/share-events`） |
| 4 | `wish.owner_notifications_enabled` + `wish.notifications_enabled` | 站內通知 |

`wish.digest_enabled`、`wish.outbound_mail_enabled`、`wish.outbound_push_enabled` **永遠不由此框架開啟**（outbound 另案）。

## 單調順序（monotonic ordering）

`activate-rental-marketplace-stages-domain.mjs` 在任何寫入前強制檢查：

1. `rental_catalog_v2.enabled === true` 且 `wish.lifecycle_enabled === true`（PR A 契約）。
2. 所有**較早**階段 flag 必須為 `true`。
3. 所有**較晚**階段 flag 必須為 `false`。
4. 所有 outbound flag 必須為 `false`。
5. 目標階段 flag 必須為預期的 `false`（activate）或 `true`（replay/rollback）。

任一項不符即中止，且**不執行任何寫入**。寫入只透過 `saveRentalMarketplaceFlags({ wish })`，不使用 raw SQL。

## 三種 domain mode

- `inspect`：只讀快照，不寫入。
- `activate`：目標階段 OFF → ON。若已是 ON 則為 `activate-already-on`（idempotent replay，不寫入）。
- `rollback`：只把**目標階段**的 flag 設回 `false`；已是 OFF 時為 `rollback-already-off`。

activate 後的驗證若失敗，會就地補償回滾；若補償本身也失敗，狀態為 `PRODUCTION_STATE_UNKNOWN` 並停止（**不以 raw SQL 修補**）。

## verify-only 重播

`activate-rental-marketplace-stages-path.py` 決定 `activate` 或 `verify-only`：

- 目標階段 OFF → `activate`。
- 目標階段 ON → 只有在 durable receipt（`<backup_id>/stage<N>-activation-receipt.json`）的
  `source_sha` / `image_digest` / `backup_id` / `backup_hash` / `src_tree_sha256` / `target_stage`
  全部相符且 `ACTIVATION_OK === true` 時才是 `verify-only`；否則停止。

verify-only 不做任何 mutation，但仍必須通過 post-activation probes。

## Post-activation probes

`activate-rental-marketplace-stages-postcheck.mjs` 在容器內以 `docker exec` 執行（不 restart），
合併兩個獨立訊號：

1. **執行中 process 的 flag cache**（`getRentalMarketplaceFlags()`），即服務實際使用的值；
2. **對 live listener 的真實 HTTP gate 探針**：

| 探針 | 關閉時 | 開啟時 |
| --- | --- | --- |
| `GET /api/demand/aggregate` | 404 `owner_matching_disabled` | 200 |
| `GET /api/wish-offers/owner` | 404 `wish_offer_disabled` | 401（需登入） |
| `POST /api/public/wish-room/<sentinel>/share-events` | 404 `share_disabled` | 非 `share_disabled` |
| `GET /api/rental-notify/prefs`（帶 session） | `enabled:false` | `enabled:true` |

`share-events` 探針使用**不可能存在的 sentinel id**，因此不會寫入任何 share event；只取其 `share_disabled` 訊號。

Postcheck 產生六項必要檢查：`pr_a_flags_on`、`stage1_on`、`target_stage_on`、`later_stages_off`、
`outbound_off`、`privacy_redaction`。`privacy_redaction` 另外驗證探針回應不含電話／email／內部欄位，
且未帶 session 的受保護路由仍回 401。

> ⚠️ 已知能力：postcheck 會以 DB 中**既有帳號**（最低 `id`，唯讀查詢）簽發一個 session cookie 以執行
> 需登入的探針。該 email 只以 `opaqueId()` 出現在 evidence，回應內容不落地。這是刻意設計，
> 沿用 Stage 1 postcheck 對 fixture 帳號的相同模式。

## 授權與單次綁定

必須 `workflow_dispatch` 從 `refs/heads/master` 執行，且：

- `actor` 與 `triggering_actor` 都必須等於 `PRODUCTION_DEPLOY_ALLOWED_ACTOR`（`cursor` 無永久繞過）。
- `confirmation` 必須剛好是 `ACTIVATE-STAGE<N>-PRODUCTION`。
- `owner_authorization` 必須剛好是 `AUTHORIZE-STAGE<N>:<source_sha>:<image_digest>:<backup_id>:<backup_hash>`。
- `source_sha` 必須可從 `origin/master` 追溯。
- workflow 以 `github.sha` pinned checkout；candidate source 不會被 checkout 到 NAS。

Remote 端（NAS）另會驗證：running `Config.Image` digest pin、`RepoDigests` 精確等於
`image_digest`、OCI `revision` 等於 `source_sha`、容器 `/app/src` bind-mount 與 `source_sha`
的 `v3/src` manifest 相符（fail-before-save）、backup `v3.db` sha256 相符。

## 操作程序（每一個階段一次）

1. 確認上一階段已 ON、本階段仍 OFF、outbound 全 OFF。
2. 以 Owner 帳號從 `master` 觸發 workflow，填入 `target_stage`、目前 running 的 `source_sha`
   與 `image_digest`、最近一次 predeploy `backup_id` 與 `backup_hash`，以及對應的
   `confirmation` 與 `owner_authorization`。
3. 讀 `stages-activation-evidence` artifact：`class`、`stage_boundary`、`postcheck.ok` 必須全綠。
4. FAIL 時：artifact 仍會上傳（`always()`），並附補償回滾證據；
   `nas-stages-rollback-evidence.json` 若 `PRODUCTION_STATE_UNKNOWN` 為 `true`，立即人工介入（不要自行下 SQL）。
5. 通過後才進行下一階段。重複觸發同一階段是安全的（`verify-only` / `activate-already-on` 皆為 no-op）。

## 測試

- `v3/test/activate-rental-marketplace-stages-domain.test.js`：順序、later-ON 阻擋、outbound 阻擋、
  idempotent replay、只回滾目標階段、補償失敗、flag 對應表。
- `v3/test/activate-rental-marketplace-stages-workflow.test.js`：workflow 授權／SHA pin／remote 閘門、
  path classifier、evidence 契約與 postcheck 純函式（含 P1-22 電話邊界）。
  python 相關案例在沒有 `python3` 的主機上會 skip，於 CI 執行。
