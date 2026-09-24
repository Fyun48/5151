# 5151 Shadow — Web Active/Active + Cloudflare Tunnel HA（Phase 16/17）

**2026-09-23 起已上線**：Web-A（CasaOS）與 Web-B（Synology）都跑 `APP_ROLE=web`、
`DB_DRIVER=postgres`（同一個 shadow PostgreSQL，經 HAProxy `pg-rw 25433`），
HAProxy round-robin 兩台；公開站經 Cloudflare Tunnel 進 CasaOS 的 `25153`。
實際容器、埠與 tunnel ingress 見 `docs/infra/containers.md`。

**發版（兩台必須同 digest）**：`deploy-v3.yml` 的
`Recreate A-group web node with the same digest`（SSH 進 CasaOS）與
`Recreate B-group web node with the same digest (Synology)`（Cloudflare Access bridge
`ssh-tori` + `V3_SYNOLOGY_*` 憑證）兩步會把 A/B 都換成同一個 digest 並各自健康檢查；
只改各節點 `.env` 的 `V3_IMAGE`，不動 compose。**只發一台＝failover 會跑到舊版**。

## 拓撲

```
CasaOS  (CASAOS_HOST=192.168.0.140)
├─ 5151-web-A            APP_ROLE=web   (0.0.0.0:15153 -> 5153)
├─ 5151-haproxy          web 段對外 0.0.0.0:25153（＋pg_rw 25433／pg_ro 25434）
├─ 591-tracker-tunnel    公開 tunnel（`5151`）的 connector #1
└─ 5151-cloudflared-A    shadow 測試 tunnel（`5151-shadow-web`）的 connector

Synology (SYNOLOGY_HOST=192.168.0.220)
├─ 5151-web-B            APP_ROLE=web   (0.0.0.0:15153 -> 5153)
├─ 5151-haproxy-B        同上，web 段對外 0.0.0.0:25153
├─ 591-tracker-tunnel-b  公開 tunnel（`5151`）的 connector #2（2026-09-24 補上）
└─ 5151-cloudflared-B    shadow 測試 tunnel 的 connector
```

> **公開入口（`jibbyrenth`）＝ tunnel `5151`（`3adb90bf-e31e-43ab-88af-5606b47fca01`）
> → `http://127.0.0.1:25153` → 各主機自己的 HAProxy → roundrobin web-a／web-b。**
> 兩台主機各有一個 connector 加入這條 tunnel，所以**任一主機整台掛掉都還有入口**。
> 2026-09-24 入口層演練：停掉 CasaOS 的 `591-tracker-tunnel` 約 30 秒，公開站 **32/32 次全部 200**
> （由 Synology 的 connector ＋ `5151-haproxy-B` 接手）；設定與可重跑步驟見
> `deploy/shadow-ha/cloudflared/`。
> ⚠️ `5151-cloudflared-A／B` 接的是**另一條** shadow 測試 tunnel（`5151-shadow-web`，ingress 指
> `192.168.0.140:25153`），與公開站無關，不要混用（名稱很像，容易誤判）。

- web 節點綁 **0.0.0.0**：另一台的 HAProxy health check 要連得到（綁 127.0.0.1 只有本機可見
  → 跨主機節點一律 DOWN）。

- 正常時兩台 Web 分擔；一台掛掉，HAProxy 會轉到另一台（`option redispatch` + `retry-on`）繼續服務。
  2026-09-23 web 層演練：停掉 web-A 期間 15 次請求有 14 次 200。
- **這組節點現在服務的是正式公開站**：2026-09-23 HA 切換後 `jibbyrenth.reversalplay.me` 走 tunnel →
  CasaOS `25153`（HAProxy）→ 輪詢 A/B。早期「shadow 用獨立 hostname、不碰正式 traffic」的說明已不適用。

## 必備 env（兩台 Web 一致）

- `SESSION_SECRET`：**必須一致**，否則 session 在輪流落到兩台 Web 時失效。
  （已查證：`v3/src/auth.js` / `captcha.js` / `oauth.js` 都讀 `process.env.SESSION_SECRET`；
  `v3/src/env.js` 在沒有 env 時會**每台各自**在 `DATA_DIR/session.secret` 產生一組隨機值 →
  兩台不一致，登入會隨機失效。所以一定要用 env 明確指定同一組。）
- `DB_DRIVER=postgres` ＋ `PG_URL`：指向 HAProxy 的 **`pg-rw`（`25433`）**，寫入才會落到當下的 primary
  （`pg-ro 25434` 給唯讀用途）。`SESSION_SECRET` 兩台必須同一組。
- `V3_IMAGE`：**digest pin**（`ghcr.io/fyun48/5151@sha256:…`），放在各節點目錄的 `.env`，
  由發版流程寫入；不要用 `:latest`（發版步驟會直接拒絕，比對 rendered image 與執行中容器的 Image）。
- tunnel connector：目前只有 CasaOS 的 `5151-cloudflared-A`（**單點**，見上面的拓撲註記）。
  要在 Synology 補第二個 connector 時才需要 `TUNNEL_TOKEN`。

## 套用（首次建置；**已上線，不要照抄重跑**）

> 這裡的 compose 是**去識別化模板**；實際在跑的是主機上的正本
> （CasaOS `/opt/5151-shadow/web-a/`、Synology `~/5151-shadow/web-b/`）。
> 重跑下面的指令會用模板覆蓋主機設定（含 secret），只在首次建置或重建節點時用。

```bash
# CasaOS
cd deploy/shadow-ha/web/web-a
SESSION_SECRET='<同一組>' PG_URL='postgres://…@<haproxy>:25433/<db>' CASAOS_HOST=192.168.0.140 docker compose up -d
# Synology（docker 在 /usr/local/bin，非登入 shell 不在 PATH）
cd deploy/shadow-ha/web/web-b
SESSION_SECRET='<同一組>' PG_URL='postgres://…@<haproxy>:25433/<db>' SYNOLOGY_HOST=192.168.0.220 /usr/local/bin/docker compose up -d
```

## 發版（release，2026-09-23 起自動化）

發版**不是**在這裡 `docker compose up`，而是跑 `deploy-v3.yml`（`workflow_dispatch`，需
`DEPLOY-PRODUCTION` 確認字串 + 不可變 digest）。它依序：

1. 正式站 `591-tracker-v3`（CasaOS）→ 以 digest pin 重建。
2. **A 組** `5151-web-A`（CasaOS）→ 寫 `.env` 的 `V3_IMAGE`、`docker compose up -d --force-recreate`，
   驗 rendered image／容器的 Image／`/api/health`。
3. **B 組** `5151-web-B`（Synology）→ 同一件事，走 Cloudflare Access bridge
   `ssh-tori.reversalplay.me`（runner 本機埠 2223）＋ v3 專屬憑證 `V3_SYNOLOGY_USER` /
   `V3_SYNOLOGY_SSH_KEY`（與 OPS 的 `OPS_SYNOLOGY_*` 分開）。

- compose 目錄不存在時兩步都**跳過**（`*_GROUP_SKIPPED reason=no_compose`）；但
  「rendered image ≠ 指定 digest」「執行中容器 Image ≠ 指定 digest」「健康檢查逾時」都是**直接失敗**
  （fail-closed，不留半套）。
- 手動補做（CI 通道不通時）：在該主機的 compose 目錄
  `printf 'V3_IMAGE=ghcr.io/fyun48/5151@sha256:…\n' > .env && docker compose up -d --no-build --force-recreate 5151-web-B`
  （Synology 用 `/usr/local/bin/docker`；發版步驟只重建 `5151-web-B`，profile 化的 `5151-worker` 不會被拉起）。
- 契約測試：`v3/test/deploy-v3-workflow.test.js`（A/B 兩步的 digest、`:latest` 拒絕、bridge 憑證、
  只重建 `5151-web-B`、ssh script 不含 `#` 且逐行以 `;` 串接仍是合法 bash）。

## 驗證

- 輪流打兩台 Web（login / search / settings / flags / wish / owner flow / SSE / logout）
  都正確（session 一致）。
- 停一台 Web → 另一台繼續（HAProxy redispatch；2026-09-23 實測 15 次 14 次 200）。
- 經 HAProxy 探測：`curl -fsS http://127.0.0.1:25153/api/health`（在 CasaOS 上）。

## 尚未做到

- **SQLite 孤島**：線上「儲存設定／搜尋設定檔」已於 2026-09-24 移植到 PG
  （`v3/src/settingsAsync.js` ＋ `repository/memberSettings.js`）→ 兩台 web 現在寫同一套 PG，
  不會再「看哪一台回答」而不一致。
- **媒體仍沒有共享儲存**：`member-media`／`self-photos` 上傳只落在處理請求的那台主機
  （2026-09-23 的暫時解法是把正式站的 `DATA_DIR` 對齊到兩台 web，工具在
  `/home/cline/scripts/5151-align/`）；這是 web 層 HA 剩下的最後一項。
- `crawler` 的 shadow compose 尚未收進本目錄（2026-09-23 已停用 `5151-crawler`：它與 web-A 共用
  同一份 SQLite 且與正式站容器自身的爬蟲重複）。Synology 的 `5151-worker` 也是 profile 關閉、未執行。

## 實際佈署狀態

容器、埠、tunnel ingress 的**權威清單**在 `docs/infra/containers.md`。要點：

| 主機 | container | 重點 |
|---|---|---|
| CasaOS | `5151-web-A` | `APP_ROLE=web`、`DB_DRIVER=postgres`、`0.0.0.0:15153->5153`、data ← `/opt/5151-shadow/web-a/data` |
| CasaOS | `5151-haproxy` | `0.0.0.0:25153->15153`、`25433`（pg-rw）、`25434`（pg-ro） |
| CasaOS | `5151-cloudflared-A` | 公開站的 tunnel connector（目前唯一一個） |
| CasaOS | `5151-crawler` | `APP_ROLE=crawler`，共用 web-a 的 data |
| Synology | `5151-web-B` | `APP_ROLE=web`、`DB_DRIVER=postgres`、`0.0.0.0:15153->5153`、data ← `~/5151-shadow/web-b/data` |
| Synology | `5151-worker` | `APP_ROLE=worker`，**profile 關閉、未執行**（2026-09-23） |

兩台 web 的 `SESSION_SECRET` 與 `V3_IMAGE`（digest）一致；非 web 角色不提供 HTTP。
