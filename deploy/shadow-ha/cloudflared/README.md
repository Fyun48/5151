# Cloudflare Tunnel connectors（5151 正式站／shadow／OPS 控制面）

三條**不同**的 tunnel，名稱很像、不要混用：

| tunnel | id | 誰加入 | ingress（指向） | 用途 |
|---|---|---|---|---|
| **`5151-b`**（正式站） | `f36d61e6-bc8a-4535-8187-d0e34b2111c9` | CasaOS `591-tracker-tunnel`、Synology `591-tracker-tunnel-b` | `jibbyrenth → http://127.0.0.1:25153` | **公開站入口** |
| `5151-shadow-web-b`（測試） | `7d50bfb7-d463-468a-98a5-aa056cefe59e` | CasaOS `5151-cloudflared-A`、Synology `5151-cloudflared-B` | `shadow-jibbyrenth → http://192.168.0.140:25153` | shadow 測試 hostname |
| **`ops`**（控制面） | `53792c2f-8798-4492-9afa-6b0e18fdc079` | CasaOS `5151-ops-cloudflared`（project `5151-ops`） | `ops.reversalplay.me → http://127.0.0.1:5154` | OPS Console 專屬，**不被吉比連坐** |

> **2026-10-07 改了兩件事：**
> 1. OPS 從吉比的 tunnel 搬到自己那條（Owner 原則：控制面不因單一專案故障而進不去）。
> 2. 吉比兩條 tunnel **換新的**：`5151`→`5151-b`、`5151-shadow-web`→`5151-shadow-web-b`。
>    原因：舊 token 曾出現在容器 argv（`docker inspect` 讀得到）。Cloudflare 的 `rotate` 端點對我這把
>    API token 回 404（無權限），所以改走「建新 tunnel → 換 connector token → 搬 DNS CNAME → 刪舊 tunnel」，
>    舊 token 隨舊 tunnel 刪除而作廢。過程與零中斷順序見 `docs/handoffs/20261007-tunnel-token-rotation.md`。
> 3. 現在**四台 connector 全部**走 `TUNNEL_TOKEN_FILE` 掛檔（`:ro`）＋映像釘 digest；argv 明文那種寫法**不要再用**。
>    定義檔：`docker-compose.yml`（CasaOS 公開站）、`docker-compose.public-b.yml`、`docker-compose.shadow-a.yml`、
>    `docker-compose.shadow-b.yml`（皆在本目錄）。

為什麼「兩個 connector」是必要的：connector 用 `network_mode: host`，ingress 的 `127.0.0.1`
是**該台主機自己**。所以每台要服務公開站的主機，都要有（1）一個加入 `5151-b` 的 connector
＋（2）本機 25153 有東西聽（＝該台的 HAProxy）。

## Synology 端（`591-tracker-tunnel-b`）

```bash
# 目錄：~/5151-shadow/cloudflared-public/
# compose：deploy/shadow-ha/cloudflared/docker-compose.public-b.yml（本 repo）
# .env：TUNNEL_TOKEN=<正式站 tunnel token>（chmod 600，不進版控）
cd ~/5151-shadow/cloudflared-public
/usr/local/bin/docker compose up -d
/usr/local/bin/docker logs --tail 20 591-tracker-tunnel-b | grep -i registered
```

- token 與 CasaOS 的 `591-tracker-tunnel` 是**同一條 tunnel**（正式站機密，要保管好）。
- 它靠 `~/5151-shadow/haproxy/`（container `5151-haproxy-B`）提供本機 25153；兩者要一起在。
- Synology 的 `docker` 在 `/usr/local/bin`（非登入 shell 不在 PATH）；單檔 bind mount 的 inode
  陷阱、`scp`/SFTP 未開（要傳檔用 `ssh 'cat > file'`）等環境事實見
  `docs/runbooks/postgres-manual-failover.md` §6 與 `web/README.md`。

## 入口層演練（2026-09-24 實測）

在任一台用 curl 連續打公開站，然後停掉**另一台**的 connector：

```bash
# 停 CasaOS 的 connector（約 30 秒）
ssh casa-nas 'docker stop 591-tracker-tunnel'
# 觀察公開站：應全數 200（由 Synology 的 connector 接手）
curl -s -o /dev/null -w '%{http_code}\n' https://jibbyrenth.reversalplay.me/api/health
ssh casa-nas 'docker start 591-tracker-tunnel'
```

實測結果：**停 30 秒期間公開站 32/32 次全部 200** ✓（`docker stop` 後 Cloudflare 邊緣會把請求
送到另一個實例；`docker start` 後兩個實例都回來，tunnel 的連線數 4→8）。
驗證 connector 實例數：Cloudflare API `GET /accounts/{id}/cfd_tunnel/{tunnel_id}`
—— 每個 cloudflared 實例註冊 **4 條連線**，所以「connectors=8」＝ 2 個實例。
