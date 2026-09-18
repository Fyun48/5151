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

## 實跑後修正（3 個真實缺陷）

本框架第一次真正跑在 Ubuntu CI 與 Production 上時，暴露三個「單元測試用假 fixture 看不到」的缺陷；
三者都已修正並加上回歸守護：

1. `activate-rental-marketplace-stages-path.py` / `-evidence.py` 的 `EARLIER_FLAGS` 少了 key `4`，
   而 `-remote.sh` 內嵌的 `earlier` 對照表同樣缺 `4`。這會讓 **Stage 4 在 Production 直接
   `KeyError` 中止**（在任何寫入之前）。守護：`Staged scripts enumerate every target stage in every
   stage map`（純文字結構測試，任何主機都能跑，不需要 python）。
2. `-evidence.py` 的 `wish_of()` 只認得 `inspect` 快照的 `raw_flags` 形狀，因此 domain `activate`
   結果（`after_raw_flags` / `before_raw_flags`）一律解析成空的 wish，導致成功啟用被回報成一堆
   「flag was not ON/OFF」。守護：domain 測試對每個階段明列 `earlierStageFlags()` /
   `laterStageFlags()` 契約。
3. `-evidence.py` 把 `redaction` 的**每一個**條目都當成必須為 `true` 的布林檢查，但
   `-postcheck.mjs` 的 `leak_report` 是**洩漏清單（陣列）**；零洩漏（正確結果）時
   `leak_report = []` 是 falsy，於是啟用被誤判失敗。現在 `REDACTION_CHECKS` 與
   `REDACTION_REPORTS` 分開處理：報告必須是**明確的空陣列**，非空即為硬失敗；未知的 key 必須是
   boolean 且為 true（fail-closed）。守護：`Staged evidence contract separates redaction checks
   from the leak report`，且 fixture 改為**直接呼叫真實的 `buildRedactionChecks()`**，形狀無法再漂移。

## 復原：啟用已成功但契約判定失敗時

若 remote 已印出 `STAGES_ACTIVATION_OK` 且 NAS 已有 durable receipt，代表 flag **確實已開啟**；
此時**不要** rollback（rollback 只在目標階段尚未開啟時使用）。正確做法是同 identity 重跑：

1. 修正契約缺陷並合併到 `master`。
2. 用**完全相同**的 `target_stage` / `source_sha` / `image_digest` / `backup_id` / `backup_hash` 重新
   `workflow_dispatch`。
3. path classifier 會因為 NAS 上已有相符 receipt 而歸類為 `verify-only`（`activate-already-on`
   no-op），只做驗證與證據，不重複寫入。

## 部署說明

本框架全部位於 `.github/` 與 `v3/test/`、`v3/*.md`；NAS 端的 helper 由本 workflow 自己以
`appleboy/scp-action` 從 master checkout 複製到 `/tmp/5151-stages-activate-helpers`。
因此**不需要**為了本框架而部署 v3；只有 `v3/src`、`v3/public` 有變更時才需要走
build → predeploy-check → deploy-v3，並以新的 digest / backup 重新取得 Owner 授權。

