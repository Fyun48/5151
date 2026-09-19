# 5151 Shadow — Web Active/Active + Cloudflare Tunnel HA（Phase 16/17）

Config templates（**尚未上線**）。Web-A/Web-B 用 `APP_ROLE=web` 只跑 HTTP；
cloudflared-A/B 為**同一條 Cloudflare Tunnel 的兩個 connector**；HAProxy 各自
round-robin Web-A/Web-B。全部用 env，不硬編碼 LAN IP。

## 拓撲

```
CasaOS  (CASAOS_HOST=192.168.0.140)
├─ 5151-web-A        APP_ROLE=web   (127.0.0.1:15153 -> 5153)
├─ 5151-haproxy-A    (前 phase 的 haproxy.cfg，web 段)
└─ 5151-cloudflared-A  tunnel 同一 token

Synology (SYNOLOGY_HOST=192.168.0.220)
├─ 5151-web-B        APP_ROLE=web   (127.0.0.1:15153 -> 5153)
├─ 5151-haproxy-B
└─ 5151-cloudflared-B  tunnel 同一 token
```

- 正常時兩台 Web 分擔；一台掛掉，另一個 connector + HAProxy + Web 繼續服務。
- **不切正式 traffic**：本 shadow 用獨立測試 hostname（例如 `shadow-jibbyrenth.reversalplay.me`），
  正式 `jibbyrenth.reversalplay.me` 指向不動。

## 必備 env（兩台 Web 一致）

- `SESSION_SECRET`：**必須一致**，否則 session 在輪流落到兩台 Web 時失效。
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

- 實際 `docker compose up`（需 Owner 授權 + 測試 hostname）。
- `SESSION_SECRET` 目前 code 是否已讀 env 未查證（若無，需補 session secret 注入）。
- Web active/active 的 SQLite 共享磁碟（NFS）設定；或等 PostgreSQL adapter 接線。
