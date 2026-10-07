# 2026-10-07｜吉比兩條 Cloudflare Tunnel 的 token 外流與換新（實戰紀錄）

## 0. 一句話
吉比公開站與 shadow 入口的 tunnel token 出現在容器 **command line**（argv），因此可能被任何有 docker
權限的身分讀走；我把兩條 tunnel **整條換掉**（新 tunnel ＋ 新 secret ＋ DNS 改指 ＋ 刪舊 tunnel），
順手把**四台 connector 全數改成掛檔**、映像釘 digest，並補了兩台 `docker run` 孤兒容器的 compose 來源。

## 1. 暴露面有多大（實查，不是猜）
用「`docker ps` 逐台看 `.Config.Cmd` 是否含 `--token`」掃兩台 NAS，命中 **13 台**：

| 主機 | 含 argv token 的容器 |
|---|---|
| casa-nas | `cf-ssh-casa`、`5151-cloudflared-A`、`591-tracker-tunnel`、`mock-briapi-tunnel` |
| syn-nas | `qwendsh-cloudflared`、`estoregv-cloudflared`、`591-tracker-tunnel-b`、`cf-ssh-tori`、`cline-cloudflared`、`5151-cloudflared-B`、`jgitea-tunnel`、`ecpapi-tunnel`、`mock-briapi-tunnel` |

**本輪只動 5151 自己的 4 台**（`591-tracker-tunnel`、`591-tracker-tunnel-b`、`5151-cloudflared-A`、
`5151-cloudflared-B`）。其餘 9 台屬別的專案／甚至這個 GUI 自己走的 `qwendsh-cloudflared`，
重啟會切到自己的連線，**不在這次授權內**，留成獨立的待辦（見 §6）。

## 2. 為什麼不是「rotate」而是「換一條 tunnel」
Cloudflare 的輪替端點（`POST/PUT /accounts/{A}/cfd_tunnel/{T}/rotate`）對我這把 API token 回
**HTTP 404 空回應**，但同一把 token 對同一 id 的 `GET` 是 `success=true` → 是**權限沒有這項動作**，
不是 id 打錯。我不重試同一招超過三次，改走可行路徑：

`POST /cfd_tunnel`（新 secret，32 bytes base64）→ `PUT /cfd_tunnel/{id}/configurations`（ingress）→
**先讓過渡 connector 把新 tunnel 連線養起來** → `PATCH /zones/{Z}/dns_records/{rid}`（CNAME 指
`<new-id>.cfargotunnel.com`）→ 驗公網 200 → 正式 connector 換新 token → 拆過渡 →
`DELETE /cfd_tunnel/{old}`（舊 token 隨之作廢）。

**順序很重要**：我先做「兩台 connector 都換新 token」才搬 DNS，結果舊 tunnel 瞬間 0 連線而 DNS 還指它 →
公網出現**混合 200／530**（`error code 1033`，CF 邊緣沿用舊 CNAME 快取）約 1～2 分鐘。
當時我是「用備份的舊 token 起一條過渡 connector」把舊路徑補住；shadow 那條我改成
**先起過渡 connector → 再搬 DNS**，實測**零中斷**（連續 6 次全 200）。這個順序已寫進 runbook §2.3。

## 3. 換掉的東西（對照表）
| | 舊 | 新 |
|---|---|---|
| 公開站 tunnel | `5151`（`3adb90bf…`）**已刪除** | `5151-b`（`f36d61e6-bc8a-4535-8187-d0e34b2111c9`） |
| shadow tunnel | `5151-shadow-web`（`4c70b226…`）**已刪除** | `5151-shadow-web-b`（`7d50bfb7-d463-468a-98a5-aa056cefe59e`） |
| DNS | CNAME `3adb90bf…cfargotunnel.com`（id 前綴 `db51c823`） | 同記錄 PATCH 成 `f36d61e6…`（沒有新建記錄，避免殘缺） |
| token 位置 | 容器 argv（`.env` 的 `TUNNEL_TOKEN` 插值進去） | 掛檔 `:ro` ＋ `TUNNEL_TOKEN_FILE`，目錄 700／檔 400 |
| connector 映像 | `cloudflare/cloudflared:latest` | 釘 digest：casa `sha256:0aa26e28…`、syn `sha256:e39ee8da…`（都是 2026.8.2） |
| A／B 兩台 | `docker run` 建的，**查無重建方式**（違反規則六） | 各自有 compose：`/mnt/Storage1/docker/5151-cloudflared-A/docker-compose.yml`、`/var/services/homes/tori/5151-shadow/cloudflared/docker-compose.yml`；repo 對應 `deploy/shadow-ha/cloudflared/docker-compose.shadow-a.yml`／`.shadow-b.yml` |

憑證庫新增兩檔（值不進 repo／PR／對話）：`cloudflare/tunnel-5151-token.txt`、
`cloudflare/tunnel-5151-shadow-web-token.txt`，皆 600。

## 4. 過程中我自己犯的 5 個錯（都已修正並留證據）
1. **拿 `.Image` 當 digest 去 pull** → `unknown: manifest schema unsupported`。`.Image` 是 config digest；
   要用 `docker image inspect -f '{{index .RepoDigests 0}}'` 的 **RepoDigest**。
2. **覆寫 0400 的 token 檔** → `PermissionError`：連擁有者都不能對 0400 檔 `open(w)`；要先 `chmod 600` 或先 `remove`。
3. **只 chown 檔、忘記 chown 目錄** → 容器 `Failed to read token file: permission denied`
   （目錄 700 root:root 時 uid 65532 連「進得去」都沒有）。这是 L-0211 的老坑，我又踩了一次半。
4. **`docker compose up -d <service>` 沒加 `--no-deps`**：吉比 compose 的 `cloudflared` 有
   `depends_on: 591-tracker-v3`，不带 `--no-deps` 的話，compose 會照「base＋override 之外沒渲染到的
   開發版定義」把**吉比正式容器**一起重建（`:latest`＋`--watch-path`＋宿主舊碼）。
   我在腳本裡硬寫 `--no-deps`，並在前後比對 `591-tracker-v3` 的 `com.docker.compose.config-hash` 與
   `State.StartedAt`，證明**完全沒動**（`310dbe69…|2026-10-07T04:51:16Z` 前後相同）。
5. **遠端指令分批時忘了每條都要 export PATH**（非互動 ssh 的 PATH 不含 docker，L-0051）→ 過渡 connector
   那輪 `docker: command not found`，容器根本沒建起來，我误以為是 token 問題。
   另外一次 `case` 少尾 `*` 的自我誤殺同類問題，也已另記教訓。

## 5. 最終驗證（全部可重跑）
```bash
# 四台 connector 都沒有 argv token（應各別回 0）
ssh casa-nas 'export PATH=/usr/local/bin:/bin:/usr/bin:$PATH; for c in 591-tracker-tunnel 5151-cloudflared-A; do docker inspect -f "{{.Name}} {{join .Config.Cmd \" \"}}" $c | grep -c -- "--token"; done'
ssh syn-nas  'export PATH=/usr/local/bin:/bin:/usr/bin:$PATH; for c in 591-tracker-tunnel-b 5151-cloudflared-B; do docker inspect -f "{{.Name}} {{join .Config.Cmd \" \"}}" $c | grep -c -- "--token"; done'
# 三條 tunnel 與連線數（5151-b=2、shadow=2、ops=1）
# 公網四處
for u in https://jibbyrenth.reversalplay.me/ https://jibbyrenth.reversalplay.me/api/health \
         https://shadow-jibbyrenth.reversalplay.me/api/health https://ops.reversalplay.me/console.html \
         https://ops.reversalplay.me/ops/api/feedback; do printf "%s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$u")"; done
```
實測結果：argv token 命中 **0 台**；`jibbyrenth` 200、`/api/health` 200、`shadow-jibbyrenth/api/health` 200、
`ops/console.html` 200、`ops/ops/api/feedback` 401（未登入，正確）。
吉比容器 `591-tracker-v3`（project `591-tracker`）與 `5151-web-A`、`5151-ops`、`5151-ops-cloudflared` 狀態未變。

## 6. 還沒做的（老實列）
- 其餘 9 台 argv-token 容器（含 `qwendsh-cloudflared`＝這個 GUI 的入口、`cf-ssh-casa`／`cf-ssh-tori` SSH 閘道、
  `estoregv`／`ecpapi`／`mock-briapi`／`jgitea`／`cline`）：**同一套寫法要改，但要分專案、逐台驗**，
  而且換 token 等於要各專案的 Owner 授權。建議排一次「全系統 connector 掛檔」的專項，一次一台、每台驗公網。
- 吉比 NAS 上 `.env` 的 `TUNNEL_TOKEN=` 是已作廢的舊值，我**尚未刪除該鍵**（怕有別處插值用到；實查吉比 compose
  已不再引用）。下次收尾時用 `grep -rn 'TUNNEL_TOKEN' /mnt/Storage1/apps/5151` 確認後再刪，並留備份。
- 憑證庫的 `apps/containers-env-casaos.txt`（各容器 env 快照）內含舊 token 值，**尚未重新擷取**；
  舊值已隨 tunnel 刪除作廢，但快照該更新以免誤導。
- OPS 的 `${OPS_TUNNEL_IMAGE:-cloudflare/cloudflared:latest}` 預設仍是 `:latest`（可覆寫）；
  要完全釘死就在 `.env` 寫入 digest（發版腳本已有「`:latest` 一律拒絕」的檢查只管 runtime 映像，未管 tunnel 映像）。
