# 交接：三節點本機資料對齊 ＋ 公開入口 HA（2026-09-24）

## 0. 一句話

公開站現在**入口與應用層都有冗餘**（tunnel 兩個 connector ＋ HAProxy 兩台 ＋ web 兩台），
但**「搜尋設定」等 SQLite 孤島還沒移植到 PG** —— 這是今晚「列表全空」的主因，也是 web 層 HA 的最後一塊。

## 1. 今晚（2026-09-23 深夜–09-24）發生什麼

### 1.1 現象
使用者在網頁上看到「0 全部／0 未瀏覽／0 已瀏覽、完全沒有物件」，且「設定檔不見、重建也留不住」。

### 1.2 診斷（逐項都有硬證據，資料沒有遺失）
- PG 完整：`listings=115,721`、`users=27`（id 1 = 使用者）、`user_listing_flags`（user 1 = 606）、
  `user_events`（user 1 = 4,406）、`user_search_profiles`（user 1 兩個，內容長度與 SQLite 相同）。
- `/api/public/listings` 200 且回得出真實物件（store 讀取正常）。
- **真因**：公開流量在 HAProxy 上**輪流到 web-A／web-B**，而 `v3/src/searchProfiles.js`（搜尋設定檔）
  **是純 SQLite、沒有 driver-aware 版本** → 兩台 web 各讀**自己的**本機 SQLite：
  - 正式站容器：`user_search_profiles` 3 筆（user 1 active，**今天 09:59 還更新過**）、settings 26 鍵
  - web-A：只有一筆 `id=live`（預設值）、settings 8 鍵 ← **輪到它回答時就是「資料全空」**
  - web-B：同理，各一份
  → 使用者的設定「看哪一台回答」而變，用空設定篩選 → 畫面 0 筆。

### 1.3 同一晚的另一件事：我發版把 2.4（provider／budget 島）推上正式站
- PG 的 `system_provider_configs` 全是 `is_enabled=0`、`provider_secrets` **0 筆** → 新版閘門
  （`providers/executeWithProvider.js`）把每次呼叫判為 `disabled_or_no_credential` 並走 fallback，
  19 分鐘內灌了約 500 筆 `provider_usage_logs`。
- **已回滾**：正式站 `v3/src`＋`v3/public` 回到發版前 `9e79b23b`（新版原始碼備份在 casa
  `/tmp/v3-src-new-*.tgz`），web-A／web-B 也回到發版前的 image digest `43bd376c…`。三台健康、公開站 200。
- **2.4 那包要重發之前**，必須先把 PG 的 provider 設定／憑證補正確（`system_provider_configs`
  的 `is_enabled`／`daily_limit_minor` 等 ＋ `provider_secrets`），否則正式站的 provider 呼叫會被短路。

### 1.4 處置（使用者選的方案：不動入口，讓三台一致）
1. 對正式站做 SQLite **熱快照**（`VACUUM INTO`，`integrity=ok`，455MB）＋ `member-media`／`self-photos`
   ＋ `auth.env`，換進 web-A（`/opt/5151-shadow/web-a/data`）與 web-B（`~/5151-shadow/web-b/data`），
   各自先備份原資料（`/tmp/data-before-align-*.tgz`）。三台現在 `profiles=3`、`settings=26` 一致。
2. **停用 `5151-crawler`**：它與 web-A **共用同一份 SQLite**（換檔時它握著鎖 → web-A `database is locked`
   起不來），且與正式站容器自身的爬蟲重複（同 `5151-worker` 的模式）。
3. 可重跑的工具與說明：`/home/cline/scripts/5151-align/README.md`
   （`make-snapshot.sh`、`align-node.sh`、`cmp-sqlite-profiles.mjs`）。
4. ⚠️ **寫入仍會分歧**：線上「儲存設定」或上傳媒體只會落在回應你的那一台。
   重跑對齊可治標；**治本是移植 SQLite 孤島到 PG**（見 §3）。

## 2. 公開入口 HA（完成，2026-09-24）

- 釐清兩條**不同** tunnel（名稱很像，容易誤判）：
  | tunnel | id | 成員 | 用途 |
  |---|---|---|---|
  | **`5151`** | `3adb90bf-…fca01` | `591-tracker-tunnel`（casa）、**`591-tracker-tunnel-b`（syn，新增）** | **公開站**（ingress `jibbyrenth → 127.0.0.1:25153`） |
  | `5151-shadow-web` | `4c70b226-…c9fb` | `5151-cloudflared-A`（casa）、`5151-cloudflared-B`（syn） | shadow 測試 hostname（ingress → `192.168.0.140:25153`） |
- 新增：Synology 的 `~/5151-shadow/haproxy/`（container `5151-haproxy-B`，25153 回 200）＋
  `~/5151-shadow/cloudflared-public/`（container `591-tracker-tunnel-b`，加入公開 tunnel）。
  正本 compose：`deploy/shadow-ha/haproxy/docker-compose.synology.yml`、
  `deploy/shadow-ha/cloudflared/docker-compose.public-b.yml`。
- **演練（實測）**：停掉 CasaOS 的 `591-tracker-tunnel` 約 30 秒 → 公開站 **32/32 次全部 200**
  （Synology 的 connector ＋ `5151-haproxy-B` 接手）；恢復後 tunnel 連線數 4→8（＝2 個實例）。
  步驟寫在 `deploy/shadow-ha/cloudflared/README.md`。
- 環境事實：`connectors=N` 其實是「連線數」，**每個 cloudflared 實例固定 4 條**，所以 8＝2 個實例。

## 3. 待辦（照序）

1. ~~**把 SQLite 孤島移植到 PG**（web 層 HA 的最後一塊）：`searchProfiles.js`（搜尋設定檔）~~
   → **已完成（2026-09-24，PR #476）**：新增 `v3/src/settingsAsync.js` ＋
   `v3/src/repository/memberSettings.js`，`getSettings／saveSettings／saveAsProfile／loadProfile／
   deleteProfile／armMemberExternalFetch` 全部 driver-aware，`/api/settings`（GET／POST）與
   `/api/profiles*` 改走 async 版；純判斷仍在 `settingsState.js`／`db.js`（兩個 driver 共用）。
   證據：`v3/test/settings-driver-parity.test.js` 離線 4/4 ＋ live 1/1（PG 寫入後讀回）。
   **媒體（member-media／self-photos）仍需要共享儲存**——那是 web 層 HA 剩下的最後一項。
2. **`5151-crawler` 與 `5151-worker` 已停用**；若日後要恢復，先確認它們不會再寫各節點自己的 SQLite。
2. **2.4（provider／budget）修好 PG provider 設定後再重發**（見 §1.3）。
3. 爬蟲「重新確認」量能長期偏低（過去 6 小時每 10 分鐘約 1 筆；24 小時內只確認 91 筆，
   但近 3 天新增 8,364 筆）→ 查 591 是否在擋。
4. `listings` 有 1 列 `last_checked_at` 內容壞掉（`post_id=2414061000`）。
5. `5155`（正式站容器的本機別名埠）仍只被 deploy 的健康檢查使用；要收回需同時改 workflow 與
   compose override（會重啟正式站），併入下一次發版。
6. **VS Code dev tunnel（`cline-server`）的 1006**：dev box（cline-dev）上 `/tmp/vscode-tunnel.log`
   顯示 `NoAttachedServerError` 多次、且同時存在兩個 server 版本（`Stable-7debcd0e…` 與
   `Stable-2242ebbb…`）。重啟 tunnel 會中斷目前連線，需使用者同意後再做。
