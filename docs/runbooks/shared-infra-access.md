# 共享基礎設施存取手冊（跨專案）

> 這份是**所有專案共用**的存取入口說明：兩台 NAS、Cloudflare Tunnel／Access、SSH 走法、資料庫、
> 機密存放位置、以及「代理人可以代操作到哪」。
> 新專案請先讀本檔 + `.cursor/rules/infra-access.mdc`，**產品站**不要另開 tunnel、不要另開第二條通道。
> （唯一例外：OPS 控制面走自己的 tunnel 與自己的 compose project，Owner 明示 2026-10-07，見 `AGENTS.md` 與本檔 §2.3。）
>
> 最後更新：2026-09-22（PG 切換完成後、CF SSH + service token 上線同日）

## 1. 主機總表

| 代稱 | 機器 | 區網 IP | sshd 埠 | 登入者 | 用途 |
|---|---|---|---|---|---|
| **casa-nas** | CasaOS NAS | `192.168.0.140` | `54722` | `root` | v3 生產容器、PG、OPS Console、Cloudflare connectors |
| **syn-nas** | Synology NAS | `192.168.0.220` | `58722` | `tori` | 舊資料/備份、OPS 相關 workflow 目標 |

- 兩台的 sshd **直接聽在 54722 / 58722**（不是 22，也不是路由器轉 22）。
- 公網 IP `114.34.73.76` 上，路由器**已於 2026-09-23 移除 `54722`／`58722` 的轉發**（先前是待退場的路徑）。
  對外一律走 Cloudflare Access（見 §2.2）＋ service token；實測 `public 54722 / 58722 = closed`、
  區網 sshd 與 tunnel ingress 不受影響，且關閉後 v3／ops 的 read-only predeploy 與 deploy 都照常成功
  （證據：`evidence/ops-synology-cf-bridge/README.md`）。

## 2. 三種連線方式（依身份選一種）

### 2.1 代理人（Cline／VS Code 內）— 區網金鑰，免密碼
```bash
ssh syn-nas      # tori@192.168.0.220:58722
ssh casa-nas     # root@192.168.0.140:54722
```
- 金鑰：`~/.ssh/nas_cline`（ed25519、無 passphrase），已加入兩台 `authorized_keys`。
- 別名定義在 `~/.ssh/config`。代理人環境在區網內，**不需要**走 Cloudflare。

### 2.2 使用者（PuTTY／Windows，外網）— Cloudflare Tunnel + Access Service Token
| 目標 | CF hostname | tunnel id | connector 容器 | ingress |
|---|---|---|---|---|
| Synology | `ssh-tori.reversalplay.me` | `8757c57f-cd70-4f5c-81c9-d3b6ba3f49f7` | `cf-ssh-tori` | `ssh://192.168.0.220:58722` |
| CasaOS | `ssh-casa.reversalplay.me` | `771768cb-a153-41a9-8477-36a97ea09132` | `cf-ssh-casa` | `ssh://192.168.0.140:54722` |

Access 應用：
- `ssh-casa-ci`（**`type: ssh` 基礎設施應用**）＝ `ssh-casa-ci.reversalplay.me` → **唯一支援 service token 的端點**（CI 與免 OTP 的 PuTTY 都用它）。
- `ssh-casa` / `ssh-tori`（`self_hosted`）＝ 原始 hostname，**只支援 email OTP**（`self_hosted` 應用不接受 service token，2026-09-22 實測：cloudflared 仍要求瀏覽器登入）。
- 政策：每個應用都有 `email`（allow，`acefengyun@gmail.com`）＋ `service-auth`（`non_identity`，綁 service token）。
- ⚠️ 方案限制：**只能有 1 個 `type: ssh` 應用**，所以 Synology 目前沒有 token 端點。

Service token（帳號層級）：
- 名稱 `nas-ssh-putty-2`，效期至 2027-09-22；**token 的 `id` = `0bc1b387-b1f5-4b44-b8eb-91f868eb870d`**（政策用），
  **`client_id` = `1b234b5d8b5b6aa20c38ea12ff2aa8a7.access`**（客戶端標頭／`--service-token-id` 用）。
- **Client Secret 不寫進 repo**：存使用者的密碼管理器（要換就到 Zero Trust → Access → Service Auth 重建）。
- 舊 token `9881d66a-…`（nas-ssh-putty，`client_id` `9c169af387e06489414008d981926ba4.access`）已不再使用，可在 Zero Trust 手動刪除。

### 2.2.1 service token 結論（2026-09-22，**已更正**）

**service token 可用 ✅** —— CI 與使用者的 PuTTY 都靠它免 OTP。
> 本節一度寫成「token 不被採用／只能 OTP」，那是**誤判**：測試時把 token 的 `id` 當成 Client ID 送出 ❌。

| 用途 | 要用哪個值 |
|---|---|
| Access **政策** `include`（Service Auth 政策） | token 的 **`id`**（`0bc1b387-…`） |
| `CF-Access-Client-Id`／`cloudflared --service-token-id` | token 的 **`client_id`**（`…access`） |
| `CF-Access-Client-Secret`／`--service-token-secret` | client secret（建立時只顯示一次） |

實測證據：
- 探針應用（政策**只**放 service-auth、無 email）：帶**正確 `client_id`** → 通過 Access（502 = 後端回應）；帶 `id` → 302；不帶 → 302。
- `ssh-casa.reversalplay.me` ＋正確 `client_id` ＋真 cloudflared → 取得 `SSH-2.0-OpenSSH…` ✅。
- `production-predeploy-check`（master，`54722` 已關閉）→ **SUCCESS**，`SSH smoke test OK`（走 `ssh-casa`，無公網回退）✅。

政策設計：每個應用＝ `email`（allow，人的備援）＋ `service-auth`（`non_identity`，綁 token `id`）。
確定所有客戶端都用 token 後可刪 `email`（代價：失去瀏覽器登入退路）。

- ⚠️ **不要**再建立 `type: ssh`／infrastructure 應用或註冊 target：`ssh-casa`／`ssh-tori`（`self_hosted` ＋ service token）已足夠，
  動它會讓 API 回 `access.api.error.invalid_request: domain not included in destinations`。
- 這**不是**付費問題：Zero Trust Free（$0，50 使用者內）已含 Access／service token／client-side cloudflared。



**方法 A（建議）本機轉發**：開一個 cmd 保持開著
```cmd
cloudflared access tcp --hostname ssh-tori.reversalplay.me --service-token-id <ID> --service-token-secret <SECRET> --url 127.0.0.1:2222
```
PuTTY：Host `127.0.0.1`、Port `2222`、Proxy `None`、`Connection → Data → Auto-login username = tori`
（CasaOS：`--url 127.0.0.1:2223`、username `root`）

**方法 B** PuTTY 自己叫 cloudflared：Proxy type `Local`，Command =
`"C:\Program Files (x86)\cloudflared\cloudflared.exe" access ssh --hostname %host --service-token-id <ID> --service-token-secret <SECRET>`，
Host = CF hostname、Port `22`、Auto-login username 同上。

> 金鑰登入：使用者自己的電腦各一把（`~/.ssh/id_ed25519`）；PuTTY 需用 PuTTYgen 轉成 `.ppk` 掛在
> `Connection → SSH → Auth → Credentials`。`authorized_keys` 的註解用 `putty-owner-company` / `putty-owner-home`
> 以便日後只撤銷某一台。

### 2.3 網站入口（2026-10-07 起：三條 tunnel、四台 connector）

| 站點 | CF hostname | tunnel（現行 id） | connector 容器 | ingress service |
|---|---|---|---|---|
| 吉比 v3（產品站） | `https://jibbyrenth.reversalplay.me` | **`5151-b`**（`f36d61e6…`） | casa `591-tracker-tunnel` ＋ syn `591-tracker-tunnel-b` | 各該台本機 `http://127.0.0.1:25153`（＝該台 HAProxy） |
| 吉比 shadow（測試入口） | `https://shadow-jibbyrenth.reversalplay.me` | **`5151-shadow-web-b`**（`7d50bfb7…`） | casa `5151-cloudflared-A` ＋ syn `5151-cloudflared-B` | `http://192.168.0.140:25153`（固定指 casa 的 HAProxy） |
| OPS Console | `https://ops.reversalplay.me` | **`ops`**（`53792c2f…`） | casa `5151-ops-cloudflared`（project `5151-ops`） | `http://127.0.0.1:5154` |

- **產品站**照舊「一站一條 tunnel」，不准再另開；**OPS 的例外只給 OPS**（Owner 明示 2026-10-07：控制面不因單一專案故障而進不去）。
- **四台 connector 一律用 `TUNNEL_TOKEN_FILE` 掛檔（唯讀），不准把 token 寫進容器 command line。**
  舊寫法 `command: tunnel run --token …` 會讓任何有 docker 權限的身分用 `docker inspect`／`ps` 直接讀到 token；
  2026-10-07 已全部改掉（連同因此外洩的兩條 tunnel 都換新、舊的已刪除）。
- token 檔位置與權限（**值只寫進憑證庫，不進 repo／對話**）：

  | 用途 | 主機路徑 | owner／mode | 憑證庫檔名 |
  |---|---|---|---|
  | `5151-b`（吉比公開站） | casa `/mnt/Storage1/docker/591-tracker-tunnel/secrets/token` | `65532:65532`／目錄 700、檔 400 | `cloudflare/tunnel-5151-token.txt` |
  | `5151-b`（吉比公開站） | syn `/var/services/homes/tori/5151-shadow/cloudflared-public/secrets/token` | `tori:users`／700、400（容器以 `user: 1026:100` 跑） | 同上（一份兩台） |
  | `5151-shadow-web-b` | casa `/mnt/Storage1/docker/5151-cloudflared-A/secrets/token` | `65532:65532`／700、400 | `cloudflare/tunnel-5151-shadow-web-token.txt` |
  | `5151-shadow-web-b` | syn `/var/services/homes/tori/5151-shadow/cloudflared/secrets/token` | `tori:users`／700、400（`user: 1026:100`） | 同上（一份兩台） |
  | `ops` | casa `/mnt/Storage1/docker/5151-ops/secrets/ops-tunnel-token` | `65532:65532`／700、400 | `cloudflare/ops-tunnel-token.txt` |

  ⚠️ Synology 上 tori **沒有免密 sudo**，不能 `chown 65532` → 改讓容器以 tori 自己跑（`user:`），
  這樣 token 檔可以維持 0400，不用放寬成世界可讀。CasaOS 有 root，直接 chown 給影像 uid `65532`。
  **目錄也要能進**（只 chown 檔、留目錄 700 root 會 `Failed to read token file`）。

- 要換 token（或 rotate 端點無權限時）的**零中斷順序**：
  ① 建新 tunnel ＋寫好 ingress；② 新 token 先讓**過渡 connector** 註冊上去（兩台都要有連線，用 API 的 `connections` 確認＝2）；
  ③ 才 PATCH DNS CNAME 到新 id（`<new-tunnel-id>.cfargotunnel.com`；**ingress 裡寫 hostname 不等於會建 DNS 記錄**）；
  ④ 驗證公網 200；⑤ 把正式 connector 換成新 token、拆掉過渡；⑥ **刪除舊 tunnel**（外洩的舊 token 才真的作廢）。
  先搬 connector 再搬 DNS 會造成一輪混合 200／530（CF 邊緣沿用舊 CNAME 快取），本次實測約 1～2 分鐘自己退；
  依上面 ② 的順序做就不會發生。

## 3. Cloudflare 帳號資源（非機密，供查詢／代操作）

- Domain：`reversalplay.me`
- Account ID：`7ac3111d0c4b44eb092139bceca17294`
- Zone ID：`732111e1eaa4e1f69c57122c42006d44`
- 既有 connector 容器都跑在 CasaOS 上，且**必須用 host network**；ingress 只能寫 **區網 IP**，
  寫 `localhost` 會導致「Remote side unexpectedly closed network connection」（2026-09-22 踩過）。

## 4. 資料庫（PostgreSQL，2026-09-21 已切換）

| 項目 | 值 |
|---|---|
| 驅動 | `DB_DRIVER=postgres` |
| 連線 | `PG_URL=postgres://…@192.168.0.140:25433/5151_shadow` |
| 遷移來源 | 舊 SQLite `data-v3/v3.db`（2,017,228 rows；現已不再寫入） |
| 代理人測試憑證 | `~/.config/5151-pg.env`（600，`PG_TEST_URL` / `PG_TEST_STANDBY_URL`） |

## 5. 機密存放位置（**一律不得進版控**）

| 機密 | 位置 / 來源 |
|---|---|
| NAS 密碼（Synology／CasaOS） | 對話中曾出現 → **待輪替**；輪替後存密碼管理器 |
| NAS 金鑰（代理人） | `~/.ssh/nas_cline`（私鑰）、兩台 `authorized_keys`（公鑰） |
| NAS 金鑰（使用者） | 各人電腦 `~/.ssh/id_ed25519` + PuTTY `.ppk` |
| CF API token | 對話中曾出現 → **待輪替**；建議改存 Cline secret |
| CF Access Service Token | Zero Trust → Access → Service Auth（User 密碼管理器） |
| PG 密碼 | `~/.config/5151-pg.env`（代理人）、CasaOS `/root/pgtest/pg.env`（**臨時檔，建議刪除**） |
| GitHub Actions | `secrets.NAS_HOST/PORT/USER`、`secrets.OPS_SYNOLOGY_*`、SSH 私鑰 |


### 5.1 跨專案共用憑證庫（cline-server，2026-09-23 起）

Owner 指示：**所有專案的帳號密碼／token 一律集中在共享目錄**，新舊專案都直接調用，不要再各自散落。

| 視角 | 路徑 |
|---|---|
| NAS（`tori@192.168.0.220`） | `~/code-server/workspace/cline-server/home/.secrets` |
| code-server 容器 | `/home/cline/.secrets` |
| cline-dev 容器（代理人） | `/home/cline/.secrets` |

- 內容清單（只記檔名與鍵名，不含值）：`INDEX.md`；用法與鐵則：`README.md`；重抓：`sync.sh`。
- 權限：目錄 700／檔案 600，且**不在任何 workspace root 內**（不會被誤 commit）。
- 覆蓋範圍：兩台 NAS 的 compose `.env`、影子站 PG、Gitea、code-server、各專案（5151 / mbriapi / bnplloan / yourfavorestore）、GitHub token。
- 尚未納入：NAS 登入密碼、CF API token、CF Access client secret（見 §5 表與 `INDEX.md` 的「還沒拿到」）。
- 引用機密時只寫**檔名與鍵名**（例：`/home/cline/.secrets/postgres/shadow-primary.env` 的 `PG_SUPER_PASSWORD`），不要把值貼進 repo／PR／對話。

## 6. 公網 SSH 埠現況（2026-09-22 更新）

| 公網埠 | 狀態 | 說明 |
|---|---|---|
| CasaOS `54722` | **已關閉** ✅ | 12 條 CasaOS 目標 workflow 已改走 Cloudflare；關埠後實跑 `production-predeploy-check` **SUCCESS**（log 顯示 `SSH smoke test OK` ＋ `ssh-casa-ci.reversalplay.me`，無回退）。回復方式＝把路由器轉發加回來。 |
| Synology `58722` | **仍開啟**（待驗證一條 ops workflow 後即可關閉）⚠️ | `deploy-ops-synology.yml`／`predeploy-ops-synology.yml` 現已改走 `ssh-tori` ＋ service token（見 §2.2.1）；實跑驗證通過後即可請 Owner 關閉路由器轉發。 |

關埠後仍正常：使用者 PuTTY（走 CF tunnel，NAS 對外主動連線，與路由器轉發無關）、代理人區網金鑰、PG `25433`、公開站與 OPS Console。
唯一失效的是 CI 的「公網回退」保險：若 CF 路徑異常，workflow 會直接失敗（不再靜默走公網），需重跑或暫時把轉發加回。


## 7. 安全基線

- **CasaOS**：`fail2ban` 已安裝並啟用（2026-09-22），jail `sshd`：`mode=aggressive`、`maxretry=4`、
  `findtime=10m`、`bantime=1h`，設定檔 `/etc/fail2ban/jail.d/sshd.local`；啟用當下已封鎖 10 個暴力破解來源。
- **Synology**：無 fail2ban，改用「控制台 → 安全性 → 帳號 → 自動封鎖」。
- **口令登入退場計畫**：等**所有**使用者電腦都裝好金鑰並實測免密碼登入後，才在兩台設
  `PasswordAuthentication no` + `PermitRootLogin prohibit-password`（順序顛倒會把人鎖在外面）。
- **待輪替**：兩台 NAS 密碼、CF API token（皆曾在對話中出現）。

## 8. 代理人可代操作範圍

可以：CF API（zones / tunnels / Access apps & policies / service tokens）、`ssh syn-nas` / `ssh casa-nas`
（讀寫 NAS 上的 compose／容器／日誌、**操作 Synology 的 docker**：`tori` 在 `docker` 群組，`/usr/local/bin/docker`
要打全路徑；也能用 `docker exec -u 0` 取得容器 root 來 chown／改容器內檔案）、GitHub Actions `workflow_dispatch`、
開 PR／合併（依 owner 規則）。

不可代做（需使用者本人）：路由器設定（含關閉埠轉發）、**Synology 主機層設定**（`tori` 沒有 sudo →
sysctl／DSM 設定都動不了，例：inotify 上限，見 §9）、密碼與 token 輪替、
在公司/家用電腦上安裝金鑰（可提供指令，由使用者執行）、CF 帳號層級的計費或成員設定。

## 9. Synology 主機層設定（代理人做不到、需 Owner 執行）

- **`tori` 的權限**：`uid=1026`、群組 `users`(100) / `administrators`(101) / `docker`(65537)。
  → 可以操作 docker（`docker compose` v2.20.1；`docker` 不在 PATH，要用 `/usr/local/bin/docker`）；
  **沒有 sudo**（需要密碼）→ 主機 sysctl 與 DSM 設定只能在 GUI／root 下做。

- **inotify 額度（2026-09-22 量測、2026-09-23 已調高）**：主機原本只有 `fs.inotify.max_user_watches=8192`、
  `fs.inotify.max_user_instances=128`（VS Code 建議 524288 / 512）。這是
  「`Unable to watch for file changes`」的根因（專案有 `node_modules` 時必爆）。
  這兩個 sysctl **不是 namespaced** → 容器內寫不進去、`docker run --sysctl …` 也被拒
  （實測 `sysctl 'fs.inotify…' is not allowed`），只能在主機做：

  ```bash
  # DSM 管理員帳號 ssh 進去後（或走 GUI：「觸發的任務 → 開機」，見下）
  sudo -i
  /usr/sbin/sysctl -w fs.inotify.max_user_watches=524288
  /usr/sbin/sysctl -w fs.inotify.max_user_instances=1024
  ```

  ✅ **2026-09-23 已完成**：DSM → 控制台 → 任務排程器 → 新增 → 觸發的任務 → **開機**（使用者 `root`、
  任務名稱 **`inotify-limits`**、已啟用）→「執行命令」填上面兩行 → 按「執行」即刻生效
  （**不必重開機、不必重啟容器**：上限是全域值，容器內立即可見）。實測三個視角一致：
  host／`5151-code-server`／`cline-dev` 皆為 **`max_user_watches=524288`、`max_user_instances=1024`**。
  ⚠️ `5151-code-server` 與 `cline-dev` 自 2026-09-22 起**同 uid 1001 → 共用同一份 inotify 額度**，更需調高。
  容器側仍保有減壓設定：兩邊 VS Code 設定都加了 `files.watcherExclude` / `search.followSymlinks: false`。

- **2026-09-23 清理**：所有 GitHub workflow 的 `cf-ssh-bridge` fallback 參數已移除（bridge 失敗即 fail-closed，
  action 本身仍保留能力）；刪除未使用的 repo secrets `CURSOR_API_KEY`／`NOTIFICATION_WEBHOOK`、
  environment secret `OPS_SYNOLOGY_HOST`／`OPS_SYNOLOGY_PORT`，以及舊 service token `nas-ssh-putty`（`9881d66a…`）。
  ⚠️ `.gitea/workflows/*` 仍以公網 `NAS_HOST`／`NAS_PORT` 為 SSH 目標 —— **刻意保留**（Gitea 暫停中），
  復活前必須改走 CF bridge 或區網，否則會因公網埠關閉而失敗。

- **`5151-code-server` ↔ `cline-dev` 自 2026-09-22 起共用同一組路徑**（兩容器皆 **uid 1001**，
  所以能被同一顆 NAS 目錄接受；詳見 `deploy/code-server/README.md`）：
  - code-server `/workspace` ＝ `cline-dev` `/workspace/repos` ＝ NAS `~/code-server/workspace/cline-server/repos`
  - code-server `/home/cline` ＝ `cline-dev` `/home/cline` ＝ NAS `…/cline-server/home`
  - code-server `/home/coder/.cline/data` ＝ `…/cline-server/home/.cline/data`（Cline session／settings／db 共用一份）
  → **要再加掛 NAS 目錄時，owner/uid 必須是 1001**（或 DSM 加 ACL），否則新檔會有一邊寫不進去。
  `/home/cline` 這一條是必要的，不是方便：共用資料裡的 session `cwd`／`workspace_root` 與
  `cline_mcp_settings.json` 的 chrome／figma 路徑都是 `/home/cline/…`。
