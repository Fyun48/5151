# cline-server 遠端連線手冊（VS Code Desktop／Cline Desktop）

> 目的：讓 Owner 在**公司或家裡**的電腦，都能連到 cline-server（`cline-dev` 容器）工作。
> 這份文件把「兩條路徑」寫清楚，避免以後又要從 session 對話裡撈。
> 建檔：2026-09-24。最後更新：2026-09-24。

## 0. 30 秒版（我要連線時做什麼）

| 我要用什麼 | 走哪條路 | 一句話 |
|---|---|---|
| VS Code Desktop（含 Agents Window） | **PATH 2：Microsoft Dev Tunnel** | Remote 分頁 → Tunnels → 選 `cline-server`（要用 GitHub 帳號登入） |
| Cline Desktop | **PATH 1：Cloudflare Access SSH** | Settings → Remote 加主機（`cline` 使用者＋SSH 金鑰），走 `ssh-cline.reversalplay.me` |
| VS Code Remote-SSH（備援） | **PATH 1：Cloudflare Access SSH** | Remote-SSH 選既有別名 |

> ⚠️ **Cline Desktop 目前只支援 SSH**，官方文件（<https://docs.cline.bot/usage/cline-desktop-ssh>）寫明
> 「Add the host under Settings → Remote」、它會用系統 `ssh`（`BatchMode=yes`）連線、再以 `ssh -L`
> 轉發 hub 埠。**Dev Tunnel 沒有辦法給 Cline Desktop 用**，所以 Cline Desktop 一律走 PATH 1。

## 1. 主機事實

| 項目 | 值 |
|---|---|
| 主機 | Synology NAS 上的 Docker 容器 **`cline-dev`**（image `cline-dev-server:latest`） |
| 容器內身分 | user `cline`、uid **1001**、`HOME=/home/cline` |
| 容器啟動 | `tini -- /usr/local/bin/cline-entrypoint.sh`，最後 `exec sshd -D`（**容器內沒有 systemd**） |
| 工作區 | `/workspace/repos/<repo>`（NAS 上＝`~/code-server/workspace/cline-server/repos`） |
| 家目錄 | `/home/cline`（與 `5151-code-server` 容器共用同一份） |
| 網路 | 容器沒有對外發佈任何埠（`docker inspect cline-dev` → `22/tcp: null`） |

## 2. PATH 1 — Cloudflare Access SSH（Cline Desktop／Remote-SSH）

### 2.1 伺服器端（已存在，不需再動）

| 項目 | 值 |
|---|---|
| CF hostname | **`ssh-cline.reversalplay.me`** |
| tunnel | `cline-synology`（id `3f66c0e0-dc8d-47de-ada4-30f9f0412d12`，2026-09-24 實測 healthy／4 條連線） |
| ingress | `ssh://cline-dev:22`（cloudflared 在 NAS 上以 host network 跑，直接連容器名） |
| connector 容器 | `cline-cloudflared`（syn-nas） |
| Access | 有開（未帶憑證 → `302` 轉 `jibbyteam.cloudflareaccess.com` 登入） |
| sshd | 只允許 `cline` 使用者、只允許 publickey、`AllowTcpForwarding yes`（Cline Desktop 需要 `ssh -L`） |

身分驗證：`~/.ssh/authorized_keys` 內有 Windows 用戶端公鑰（註解 `cline-client-windows`）。

### 2.2 用戶端（公司／家裡各做一次）

Windows 的 `~/.ssh/config` 需要一個別名（Owner 目前已經有這一份在用）：

```sshconfig
Host cline-server
    HostName ssh-cline.reversalplay.me
    User cline
    IdentityFile ~/.ssh/cline_server
    ProxyCommand cloudflared access ssh --hostname %h
    IdentitiesOnly yes
```

- `ProxyCommand` 是本路徑的關鍵：**SSH 封包是交給 cloudflared 帶進 Cloudflare**，不是開新的對外埠。
- 第一次要先讓 cloudflared 取得 Access 授權（瀏覽器登入一次）：`cloudflared access login ssh-cline.reversalplay.me`。
  授權到期後 Cline Desktop 的 `BatchMode` 連線會失敗，**重新跑一次這個登入即可**（這是此路徑唯一需要人工的地方）。
- ⚠️ `ssh-cline` 是 `self_hosted` 類型的 Access 應用，**service token 只能用在 `type: ssh` 的應用**
  （目前那個名額被 `ssh-casa-ci` 用掉），所以這一條沒辦法用 service token 做成完全免登入。
  詳見 `docs/runbooks/shared-infra-access.md` §2.2.1。

### 2.3 VS Code Desktop（Remote-SSH）

Remote-SSH 選 `cline-server`（就是上面的別名）即可；這條與原本在用的完全相同，**本次沒有改動**。

### 2.4 Cline Desktop

1. `Settings → Remote → Add host`。
2. Host 填 **`cline-server`**（SSH config 別名，讓 `ProxyCommand` 生效）、User 填 `cline`、
   Identity file 指到 `~/.ssh/cline_server`。
3. 連上後在環境選單選該主機，workspace 路徑填 `/workspace/repos/<repo>`（例如 `/workspace/repos/5151`）。
4. 首次連線時 Cline Desktop 會把 helper 上傳到遠端 `~/.cline/remote/`，並用 `ssh -L` 轉發 hub 埠，
   不需要在伺服器安裝任何套件。


## 3. PATH 2 — Microsoft VS Code Dev Tunnel（VS Code Desktop／Agents Window）

### 3.1 伺服器端

| 項目 | 值 |
|---|---|
| tunnel 名稱 | **`cline-server`** |
| tunnel id | `quick-ant-cq4dxnf`（2026-09-24 重新登入後換發；先前為 `peaceful-shoe-h75hxl5`，見 §5.4） |
| relay cluster | `jpe1`（japaneast），公開 host（需驗證）：`quick-ant-cq4dxnf.devtunnels.ms` |
| 驗證方式 | **GitHub account**（device code，由 Owner 本人完成一次；`tunnel user show` → `logged in with provider GitHub Account`） |
| 匿名存取 | 沒有；不帶憑證只會拿到 diagnostic 靜態頁（實測 `302`） |
| 官方 CLI | `/home/cline/.local/share/microsoft-vscode-cli/code`（standalone CLI，不是 VS Code Server 內建那份） |
| launcher | `~/.local/bin/vscode-tunnel`（以絕對路徑呼叫 CLI，並設 `VSCODE_CLI_DATA_DIR`） |
| CLI 資料目錄 | `~/.local/share/microsoft-vscode-cli/cli-data`（`token.json` 600、目錄 700） |

### 3.2 用戶端（公司／家裡各做一次）

1. VS Code Desktop 以**同一個 GitHub 帳號**登入。
2. `New`（或 `Ctrl+N`）→ workspace 下拉 → **Remote 分頁 → Tunnels** → 選 **`cline-server`**（狀態 Online）。
3. 選遠端資料夾 **`/workspace/repos/5151`** → 輸入 prompt 開始 Remote Agent Session。
4. 瀏覽器替代方案：`https://insiders.vscode.dev/agents` → Continue with GitHub → hosts bar 選 `cline-server`。

> Agents Window 官方文件的前置條件就是「remote machine 上已有一條 dev tunnel 在跑」，**不需要**額外跑
> `code agent host --tunnel`（那支是備援；本機 agent host 已常駐在 `127.0.0.1:43886` 供 Remote-SSH 使用）。

### 3.3 日常檢查與手動啟動

```bash
~/.local/bin/vscode-tunnel tunnel status        # 要看到 "tunnel":"Connected"
bash ~/scripts/vscode-tunnel-start.sh           # 斷線時重拉（會等到服務回報 Connected 才結束）
tail -20 /tmp/vscode-tunnel.log                 # tunnel 日誌
```

## 4. 已知限制：**持久化還沒做到**（這條路徑目前不是 service）

- 官方做法是 `code tunnel service install`，但**這台容器沒有 systemd／dbus、也沒有 root**，
  實測（2026-09-24，CLI 1.139.0）直接失敗：
  `error Error creating dbus session. This command uses systemd for managing services…`
  → `tunnel status` 永遠回 `"service_installed": false`。
- 目前 tunnel 是用 `~/scripts/vscode-tunnel-start.sh`（`setsid` 啟動）跑起來的：**SSH 斷線不會影響它**
  （`ppid=1`、無 controlling tty），但**容器重啟就不會自己回來**（＝原驗收表的 TEST 2 FAIL）。
- 因此如果容器重啟、而您人在外面：先用 **PATH 1（Remote-SSH／Cline Desktop）** 進來，
  再執行 §3.3 的啟動指令即可恢復 PATH 2。

要真的做到「容器重啟後自動回來」，只有三個選項（都需要 Owner 決定，前兩項需要 NAS 的 root）：

| 選項 | 做法 | 代價 |
|---|---|---|
| P1（建議） | 在 `cline-dev` 的容器啟動流程（entrypoint 或 compose `command`）內，於 `exec sshd` 之前拉起 tunnel | 要改 NAS 上 root 專案的 `…/cline-server/project/`（目前 `tori` 無權限），並**重建容器**（會中斷現有 session，但 PATH 1／code-server 不受影響，可立刻重連） |
| P2 | 用 DSM 的官方「工作排程器」在開機與每 5 分鐘執行 `docker exec cline-dev …` 檢查 | 需要在 DSM 以管理者身分設定；屬於「排程器」而非原生 service |
| P3 | 維持現狀：手動／由下一個 session 啟動 | 容器重啟後不會自動回來 |

## 5. 故障排除（都是實際踩過的）

1. **絕對不要直接呼叫 `code tunnel`**：不帶 `VSCODE_CLI_DATA_DIR` 時，CLI 會去預設的 `~/.vscode/cli`
   找憑證，那裡沒有 → 卡在 `please log into https://github.com/login/device`，tunnel 永遠起不來
   （改用 `~/.local/bin/vscode-tunnel` 或 `~/scripts/vscode-tunnel-start.sh`）。
2. **不要同時跑兩份 tunnel**：會出現 `Another instance is still downloading the server; waited 1518 seconds`
   的死等迴圈，最後用戶端看到 `1006`。啟動腳本會先清掉同名的殘存行程與 `tunnel-*.lock`。
3. **憑證失效**（日誌出現 `log into https://github.com/login/device`）：
   跑 `~/.local/bin/vscode-tunnel tunnel user login --provider github`，把 device code 交給 Owner 輸入。
   憑證只會落在 `cli-data/token.json`（600），**不要貼到對話或文件裡**。
4. tunnel id 換發：2026-09-24 由 `peaceful-shoe-h75hxl5` 變成 `quick-ant-cq4dxnf`（重新登入後重建）；
   VS Code 的 Tunnels 清單若看到舊的離線項目，選**上線中的那一個**。
5. PATH 1 若 `BatchMode` 連不上，先確認 Access 授權沒過期（重跑 `cloudflared access login`）。

## 6. 這份文件沒有動到的東西（規格要求）

本次（含 2026-09-24 修復）**沒有**修改：`~/.ssh/config`、`~/.ssh/authorized_keys`、`sshd_config`、
Cloudflare Tunnel／Access 設定、`ssh-cline.reversalplay.me`、code-server 設定、Cline Hub，
也沒有新增對外公開埠、沒改 DNS／firewall、沒動 `/workspace/repos` 內的專案檔案。

## 7. 變更紀錄

- 2026-09-24：建檔。整理 PATH 1／PATH 2、實測現況、持久化缺口與三個選項。
