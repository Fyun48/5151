# 5151 Shadow — Web Active/Active + Cloudflare Tunnel HA（Phase 16/17）

Config templates（**尚未上線**）。Web-A/Web-B 用 `APP_ROLE=web` 只跑 HTTP；
cloudflared-A/B 為**同一條 Cloudflare Tunnel 的兩個 connector**；HAProxy 各自
round-robin Web-A/Web-B。全部用 env，不硬編碼 LAN IP。

## 拓撲

```
CasaOS  (CASAOS_HOST=192.168.0.140)
├─ 5151-web-A        APP_ROLE=web   (0.0.0.0:15153 -> 5153)
├─ 5151-haproxy      (haproxy.cfg，web 段；對外 0.0.0.0:25153)
└─ 5151-cloudflared-A  tunnel 同一 token（network_mode: host）

Synology (SYNOLOGY_HOST=192.168.0.220)
├─ 5151-web-B        APP_ROLE=web   (0.0.0.0:15153 -> 5153)
└─ 5151-cloudflared-B  tunnel 同一 token（network_mode: host）
```

- web 節點綁 **0.0.0.0**：另一台的 HAProxy health check 要連得到（綁 127.0.0.1 只有本機可見
  → 跨主機節點一律 DOWN）。

- 正常時兩台 Web 分擔；一台掛掉，另一個 connector + HAProxy + Web 繼續服務。
- **不切正式 traffic**：本 shadow 用獨立測試 hostname（例如 `shadow-jibbyrenth.reversalplay.me`），
  正式 `jibbyrenth.reversalplay.me` 指向不動。

## 必備 env（兩台 Web 一致）

- `SESSION_SECRET`：**必須一致**，否則 session 在輪流落到兩台 Web 時失效。
  （已查證：`v3/src/auth.js` / `captcha.js` / `oauth.js` 都讀 `process.env.SESSION_SECRET`；
  `v3/src/env.js` 在沒有 env 時會**每台各自**在 `DATA_DIR/session.secret` 產生一組隨機值 →
  兩台不一致，登入會隨機失效。所以一定要用 env 明確指定同一組。）
- `DB_DRIVER`：目前 `sqlite`（單檔，active/active 需把 `DATA_DIR` 放在共享磁碟/NFS）；
  待 Phase 5/6 PostgreSQL adapter 接線後改 `postgres` 指向 shadow Primary/Standby（DB_RW/DB_RO）。
- `TUNNEL_TOKEN`：Cloudflare Tunnel 的 token（同一 tunnel，兩 connector 共用）。

## 套用

```bash
# CasaOS
cd deploy/shadow-ha/web/web-a
SESSION_SECRET='<同一組>' TUNNEL_TOKEN='<token>' CASAOS_HOST=192.168.0.140 docker compose up -d
# Synology
cd deploy/shadow-ha/web/web-b
SESSION_SECRET='<同一組>' TUNNEL_TOKEN='<token>' SYNOLOGY_HOST=192.168.0.220 docker compose up -d
```

## 驗證

- 輪流打兩台 Web（login / search / settings / flags / wish / owner flow / SSE / logout）
  都正確（session 一致）。
- 停一台 Web → 另一台繼續；停一台 cloudflared → 另一 connector 繼續。

## 尚未做到

- Web active/active 的 SQLite 共享磁碟（NFS）設定；或等 PostgreSQL adapter 接線後改 `postgres`。
- `crawler` / `worker` shadow compose 尚未收進本目錄（實際已在跑，見下方「實際佈署狀態」），
  目前是手工 compose；要重現請照該節的 env/mount 建檔。

## 實際佈署狀態（2026-09-20，皆 `Up`）

| 主機 | container | role / 重點 |
|---|---|---|
| CasaOS | `5151-web-A` | `APP_ROLE=web`，`0.0.0.0:15153->5153`，`DATA_DIR=/data` ← `/opt/5151-shadow/web-a/data` |
| CasaOS | `5151-haproxy` | `0.0.0.0:25153->15153`、`25433`、`25434` |
| CasaOS | `5151-cloudflared-A` | `cloudflared tunnel --no-autoupdate run --token <TUNNEL_TOKEN>`（host net） |
| CasaOS | `5151-crawler` | `APP_ROLE=crawler`，共用 web-a 的 data（`/opt/5151-shadow/web-a/data`） |
| Synology | `5151-web-B` | `APP_ROLE=web`，`0.0.0.0:15153->5153`，data ← `~/5151-shadow/web-b/data` |
| Synology | `5151-cloudflared-B` | 同一 tunnel 的第二個 connector（host net） |
| Synology | `5151-worker` | `APP_ROLE=worker`，共用 web-b 的 data（SQLite 必須同檔） |

兩台 Web 的 `SESSION_SECRET` / `DB_DRIVER=sqlite` 一致；非 web 角色不提供 HTTP。
