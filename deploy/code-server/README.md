# 5151 code-server（瀏覽器版 VS Code）

「隨時關掉分頁、隨時打開都還在」的雲端 IDE —— 這是 Owner 要的 Cursor-agent-web 體感（P2 選項 2）。

- 容器：`5151-code-server`（CasaOS 那台以外，跑在 **Synology**；與 Gitea 同一台）
- 對外：`https://cocodeco.reversalplay.me`（走既有 `jgitea-tunnel`，dashboard 上顯示為 connector **`gitea`**）
- 只綁 `127.0.0.1:8484`（不對 LAN 開放），因此對外一律經 Cloudflare
- 密碼：NAS `~/code-server/.env` 的 `PASSWORD`（compose 以 `env_file: .env` 讀入；600，不進 repo；`CODE_SERVER_PASSWORD` 保留為向後相容）
- 資料：`~/code-server/data`（設定＋已安裝擴充套件）、`~/code-server/workspace/cline-server/repos`（工作區＝
  Cline Server 的 repos，與 agent／Desktop 共用同一份；2026-09-22 起直接掛成 IDE 的 `/workspace`）

## 一次性設定：加 Cloudflare Public Hostname

`jgitea-tunnel` 是 **token（遠端管理）模式**，本機沒有 `config.yml`，所以新 hostname 只能用
Zero Trust 後台或 API 加。**後台（建議，6 下）**：

1. <https://one.dash.cloudflare.com> → 選帳號 **Acefengyun@gmail.com's Account**
2. **Networks → Tunnels** → 點 connector **`gitea`**（tunnel id `7cc60ae6-…`）
3. 上方 **Public Hostname** 分頁 → **Add a public hostname**
4. 填：Subdomain `cocodeco`、Domain `reversalplay.me`、Type `HTTP`、URL `localhost:8484` → **Save**
   （DNS CNAME 會自動建立在 `cocodeco.reversalplay.me` → `7cc60ae6-….cfargotunnel.com`）
5. 等 ~10 秒，開 <https://cocodeco.reversalplay.me> 應出現 code-server 登入頁

**或用 API**（需要一顆有 **`Account → Cloudflare Tunnel → Edit`**（建立 DNS 另外需要 `Zone → DNS → Edit`）的 token；
現有那顆是**唯讀** ✗ —— 實測：DNS create → 403 Authentication error、tunnel config → 401 Not authorized）：

```bash
cd ~/code-server
docker run --rm --network host \
  -e CF_API_TOKEN=<token with Tunnel:Edit> \
  -e CF_ACCOUNT_ID=7ac3111d0c4b44eb092139bceca17294 \
  -e CF_TUNNEL_ID=7cc60ae6-1dab-4ebe-85b1-9dd397ebe6e7 \
  -e PUBLIC_HOSTNAME=cocodeco.reversalplay.me -e SERVICE=http://localhost:8484 \
  -v "$PWD/cf-tunnel-add.mjs:/cf.mjs:ro" node:22-bookworm-slim node /cf.mjs
```

> 註：帳號 ID 要從 API 讀（`GET /accounts`）—— 從 tunnel token 手動 base64 解碼很容易錯一個字元 ✗
> （實測踩過：解成 `…a92139beca…`，正確是 `…092139bceca…`）。

## 進去之後怎麼用

1. 開 <https://code.reversalplay.me> → 輸入 `~/code-server/.env` 裡的密碼
2. **File → Open Folder → `/workspace/5151`**
   `/workspace` 現在**直接就是 Cline Server 的 repos 根目錄**（2026-09-22 起）→
   IDE 內的 `/workspace/<repo>` 與「Cline Desktop 用 SSH 連 cline-server 工作」看到的是
   **同一份 working tree**（agent 容器內是 `/workspace/repos/<repo>`），remote 已設好，可直接
   `git pull` / `push` ✓
3. 內建終端機（Ctrl+`）可直接跑 `npm test`、`git status`；容器與 `gitea:3000` 同網路，`git` 對內網穩定 ✓
4. 想用 AI：**Extensions → 搜 `Cline`**（code-server 走 Open VSX；若搜不到就用 `.vsix` 安裝）→
   **它的對話歷史與 Cline Server 共用同一份**（2026-09-22 起，見下一節），所以 Desktop 開的 session
   在這裡的 RECENT 就看得到。Provider 設定：
   - Base URL：`https://api.deepseek.com`
   - API Key：DeepSeek key（見 Gitea repo variable `DEEPSEEK_API_KEY`）
   - Model：`deepseek-chat`（也可 `deepseek-reasoner` / `deepseek-flash` / `deepseek-v4-pro`）
5. **關掉分頁不會中斷**：容器與 VS Code server 持續在 NAS 上跑；下次打開分頁會回到同一個工作區與狀態。
   終端機裡的長指令建議用 `tmux`（若要關分頁後繼續跑）。

## 專案區：直接就是 Cline Server 的 repos（2026-09-22 起）

`/workspace` = NAS `~/code-server/workspace/cline-server/repos` = agent 容器（`cline-dev`）內的
`/workspace/repos`。**只有這一份 working tree**，不再有第二份 clone。

| IDE 內 | NAS | agent 容器內 |
|---|---|---|
| `/workspace/5151` | `~/code-server/workspace/cline-server/repos/5151` | `/workspace/repos/5151` |
| `/workspace`（預設開啟） | `…/cline-server/repos` | `/workspace/repos` |

目前有 **18 個 repo**（＝2026-09-20 從 GitHub 搬進 Gitea 後 clone 的全部）：
`5151`、`your-remit-01`、`your-remit-erp01`、`your-remit-erp02`、`your-remit-erpdev`、
`yourremit-accounting-system`、`yourfavorestore`、`ForumSeeksDLer`、`bnplloan`、`MBRIAPI`、`ECPAPI`、
`my-erp-mobile`、`cnndemo`、`hsihung_php`、`hsihung_php2`、`tori`、`HeyWorld`、`Fyun48`
（`HeyWorld`／`Fyun48`／`hsihung_php2`／`tori` 是**空 repo**：clone 會成功但沒有任何 commit）。

> ⚠️ 原本 code-server 自己那 18 份 clone（`~/code-server/workspace/<repo>`）已於 2026-09-22 **刪除**
> （刪前逐一驗證 `git status` 乾淨、無未推送 commit）；當時放在裡面的 `_uploads`（2 個 .md）
> 已搬到 NAS `~/inbox/code-server-old-_uploads/`。

三種用法：

1. **一次看全部（預設，`compose` 最後一個參數就是 `/workspace`）** → Source Control 會列出多個 repo ✓
2. **只看 5151**：File → Open Folder → `/workspace/5151`；
   或在網址後面加參數：`https://cocodeco.reversalplay.me/?folder=/workspace/5151` ✓
3. **用工作區檔**：File → Open Workspace from File… → `/workspace/5151-projects.code-workspace`
   （已建好，內含 18 個資料夾）；要自己的組合就 File → Save Workspace As… ✓

**再加新專案**：建議在 cline-server 那一側做（這樣 Desktop 與瀏覽器兩邊才同時看得到）：

```bash
# IDE 內建終端機（＝在 code-server 容器裡）
cd /workspace
git clone http://JimmyGOD:<token>@gitea:3000/JimmyGOD/<repo>.git   # 自己的 Gitea（容器內可直達）
git clone https://github.com/<user>/<repo>.git                     # 外部 repo（私有需 access token）
```

然後 File → **Add Folder to Workspace…** 加進來 ✓（或用 agent／Desktop 在 `/workspace/repos` 底下 clone）

## 常見問題：`Unable to watch for file changes`

**現象**：打開 IDE 常常跳出 `⚠ Unable to watch for file changes.`。

**根因（已實測）**：Synology 主機的 inotify 額度是預設值 —— `fs.inotify.max_user_watches = 8192`、
`max_user_instances = 128`（VS Code 建議 ≥ 524288 / 512）。專案裡有 `node_modules`（動輒上萬檔）時，
遞迴 watcher 一下就爆掉。另外 code-server 與 `cline-dev` 現在**同 uid 1001 → 共用同一份 inotify 額度**。

**永久解（需要 DSM 的 root；`tori` 沒有 sudo）**：

```bash
# 以 DSM 管理員帳號 ssh 進去後
sudo -i
sysctl -w fs.inotify.max_user_watches=524288
sysctl -w fs.inotify.max_user_instances=1024
cat /proc/sys/fs/inotify/max_user_watches   # 應顯示 524288
```

（`fs.inotify.*` 不是 namespaced 的 sysctl → 容器內改不動、`docker --sysctl` 也不允許，只能在主機做。）

**重開機後保留**：DSM → **控制台 → 任務排程器 → 新增 → 觸發的任務 → 開機** → 使用者選 **root**
→ 自訂指令碼填上面兩行 `sysctl -w …` → 儲存。

**已做的減壓（治標）**：容器內的 VS Code 使用者設定與 repo 的 `.vscode/settings.json` 都加了
`files.watcherExclude`（`node_modules`、`.git/objects`、`*.db`、`data-v3`…），以及
`search.followSymlinks: false`；`cline-dev` 的 VS Code server（Desktop 遠端那個）也加了同一組，
避免兩個容器一起把額度吃光。

## Cline 對話紀錄：與 Cline Server 共用同一份（2026-09-22 起）

**背景**：NAS 上其實有**兩套 Cline**，天生各有各的 data dir，所以以前「在 Cline Desktop 連 `cline-server`
開的 session」不會出現在 code-server 的 Cline 面板（反之亦然）——
Cline 的歷史存在該 core 的 data dir（`sessions/<id>/*.messages.json` + `db/sessions.db`），
**不會跨 data dir 同步，也沒有雲端同步**。

| 誰 | 容器 | data dir（NAS 路徑） |
|---|---|---|
| 瀏覽器版 IDE 的 Cline 擴充 | `5151-code-server` | ~~`~/code-server/data/.cline/data`~~（舊；2026-09-22 起改用下面那條）|
| Cline Server ← Cline Desktop 遠端連的那台 | `cline-dev` | `~/code-server/workspace/cline-server/home/.cline/data` ← **兩邊共用這一份** |

**2026-09-22 起改成兩邊共用同一份**（compose 動三件事）：

1. `user: "1001:1001"` ← 與 `cline-dev` 的 `cline` 同 uid。Cline 建檔是 `0666 & ~umask`，
   **不同 uid 光靠群組/ACL 是不夠的：後建的那個檔一定有一邊寫不進去** → 同 uid 才穩。
   （容器啟動時 `fixuid` 會把 `coder` 對映到 1001，所以 `id` 顯示 `uid=1001(coder)` ✓）
2. `group_add: ["100"]` ← 保留 `users` 群組，才能繼續寫 `~/inbox`（`/nas-inbox` 是 2775 root:users）。
3. `CLINE_DATA_DIR=/home/coder/.cline/data` ＋ 把 `cline-server/home/.cline/data` 掛到 `/home/coder/.cline/data`
   ← **兩個容器指到同一份** sessions／settings／db。

**結果**：code-server 的 Cline 面板「RECENT／歷史」＝ Cline Desktop 接 `cline-server` 的同一份清單；
在 code-server 開的 session，Desktop 那側也看得到。**工作可以在任一邊接續，不用怕漏掉紀錄。**

### ⚠️ 共用之後必踩：終端機跳 `Starting directory (cwd) "/home/cline" does not exist.`

共用的是「**cline-server 視角**」的資料，所以裡面會出現一堆 cline-server 的絕對路徑（`/home/cline/…`）。
code-server 容器裡本來沒有那個目錄，症狀與根因（2026-09-22 實測，Cline 擴充 log 在
`~/code-server/data/.local/share/code-server/logs/<ts>/exthost1/output_logging_*/1-Cline.log`）：

| 症狀 | 根因 |
|---|---|
| Cline 一執行指令就跳 `The terminal process failed to launch: Starting directory (cwd) "/home/cline" does not exist.` | `[TerminalManager] Looking for terminal in cwd: /home/cline` ← 終端 cwd 取自**該 session 的 `workspace_root`**，而共用資料裡的 workspace 就是 cline-server 的家目錄 |
| `chrome-devtools`／`figma` 等 MCP 起不來（`npx` 起來了但瀏覽器／輸出目錄找不到） | `settings/cline_mcp_settings.json` 寫死 `--executablePath /home/cline/.local/bin/chrome-no-sandbox`、`LD_LIBRARY_PATH /home/cline/.local/chrome-deps/…`、figma 輸出 `/home/cline/.cline/figma-images` |

**修法（compose 的第 4 件事）**：把 cline-server 的**家目錄**以同一路徑掛進來 ——

```yaml
- /volume1/homes/tori/code-server/workspace/cline-server/home:/home/cline
```

→ IDE 內 `/home/cline` ＝ NAS `…/cline-server/home` ＝ `cline-dev` 內 `/home/cline`
（同一份、同 uid 1001 可寫），於是那些絕對路徑全部指回真身：
session 的 `cwd`／`workspace_root`／`messages_path`、終端 cwd、MCP 的 chrome／fontconfig／figma。
**邏輯與 `/workspace` 相同**：不是複製、是同一個目錄。

```bash
# 驗證（NAS 上）：用同一個 uid、以那個 cwd 起 login shell ＝ VS Code ptyHost 建終端的動作
docker exec -u 1001 -w /home/cline 5151-code-server bash -lc 'pwd && ls | head'
# 兩條掛載必須是同一個 inode（proof：同一份，不是兩份）
docker exec 5151-code-server sh -c 'stat -c "%d:%i %n" /home/cline/.cline/data/sessions /home/coder/.cline/data/sessions'
docker exec 5151-code-server sh -c 'test -x /home/cline/.local/bin/chrome-no-sandbox && echo CHROME_OK'
```

**權衡**：這等於把 agent 的家目錄（含 `.ssh`、`.cline/remote`、`.bash_history`）開給 IDE 容器讀寫。
同 uid、同 owner、IDE 有 Cloudflare Access ＋ 密碼，且它原本就讀得到 `/private` 與共用 Cline 資料
（`secrets.json` 內的 API key）。要縮小範圍就改成只掛工具鏈子目錄：`.local`、`.agents`、
`.cline/figma-images`、`Documents`（**不掛 `.ssh`**）；但那樣「終端 cwd」與舊 session 的路徑還是不存在，
得接受點到舊 session 會跳錯。

### ⚠️ 同一個道理：`/workspace/repos/<repo>`（agent 的路徑）也要成立

**症狀**（2026-09-22 實測，使用者端連跳兩次）：

```
The terminal process failed to launch: Starting directory (cwd) "/workspace/repos/5151" does not exist.
```

**根因**：兩個容器對「同一棵 repos」用了**不同的路徑**，而 session 記的是**建立它的那個容器**的路徑：

| | code-server（IDE） | `cline-dev`（agent／Cline Server） |
|---|---|---|
| repos 根目錄 | `/workspace` | `/workspace/repos` |
| 5151 這個 repo | `/workspace/5151` | `/workspace/repos/5151` |

（`WORKFLOW.md` 定的專案位置就是 `/workspace/repos/<repo>` —— Desktop 建 session 時填的那個。）
同一個原因也會讓**在 IDE 裡跑的 agent 自己的終端機**開不起來（pty 的 cwd 正是這個路徑）。

**修法（一行；IDE 內建終端機執行，不用重建容器）**：

```bash
ln -s . /workspace/repos        # 建立 /workspace/repos → 指回自己（= repos 根目錄）
cd /workspace/repos/5151 && pwd && git log --oneline -1   # 應與 /workspace/5151 完全相同
```

- 連結落在 NAS `~/code-server/workspace/cline-server/repos/repos` → 兩邊容器看到的是**同一個目錄**
  （`cline-dev` 那側是 `/workspace/repos/repos`，指回自己＝無害）；因為在共用目錄裡，**重建後仍在**。
- 搜尋不受影響（`search.followSymlinks: false` 已設）；要在 Explorer 藏掉那個 `repos` 項目：
  設定 → 搜尋 `files.exclude` → 加 `"/repos": true`。

**選項 B（真實掛載；需 `docker compose up -d`，可完全不用符號連結）**：把 `/workspace` 改成
cline-server 根目錄、再多掛一次 repos，兩邊路徑就完全對稱：

```yaml
- /volume1/homes/tori/code-server/workspace/cline-server:/workspace
- /volume1/homes/tori/code-server/workspace/cline-server/repos:/workspace/repos
```

代價：IDE 開的根目錄變成 cline-server 根目錄 → `5151-projects.code-workspace` 的 18 條路徑要改成
`/workspace/repos/<repo>`，`command` 最後的 `/workspace` 要改成 `/workspace/repos`，
且 `/workspace/home`（agent 家目錄）會多一份路徑 → 要加進 `files.watcherExclude`。

### 驗證指令

```bash
# NAS 上：兩邊看到的 session 數要一樣
docker exec 5151-code-server sh -c 'ls ~/.cline/data/sessions | wc -l'
ls ~/code-server/workspace/cline-server/home/.cline/data/sessions | wc -l

# code-server 的 Terminal（CLI 已持久化安裝在 ~/.npm-global；找不到就重開 Terminal）：
cline history --limit 5             # 列出共用的歷史
cline -i -c /workspace/5151         # TUI 接續同一份 session（＝ agent 的 /workspace/repos/5151）
# ⚠️ CLI 的預設 provider 是 `cline`（走 Cline Credits，餘額 0 會直接 Insufficient balance）；
#    要用你自己的 DeepSeek key 請明示：
cline -P deepseek -m deepseek-flash -c /workspace/5151 "你的提示詞"
```

### ⚠️ 注意事項（本次實測踩到的）

- **兩邊 Cline 版本要一致**（目前 extension/core `4.1.19`、CLI `3.0.6x`）。升一邊就要升另一邊，
  否則共用 data dir 時 schema migration 會互打；升完要 `docker compose up -d` 重建容器。
- 共用 `globalState.json`／`providers.json`（＝API key、auto-approve、語言設定兩邊一致）；
  **code-server 的 core 不會用到 Desktop remote helper 的狀態**：它的 data dir 是
  `CLINE_DATA_DIR=/home/coder/.cline/data`、`$HOME=/home/coder`，所以 `…/cline-server/home/.cline/remote`
  雖然透過 `/home/cline` 看得到，卻不是它在讀的那份（Desktop helper 專用）。
- 只有「同時在兩邊跑 zen／背景任務」才會有兩個 hub daemon 寫同一顆 `hub-events-hub-production.db`；
  一般對話不受影響（hub 只在背景任務出現）。
- 舊的、只屬於 code-server 的 6 條 session 已封存（檔案還在，只是不再出現在 UI 清單）：
  `~/code-server/data/.cline/data-code-server-archive-20260922-2006`。
- 容器身分是 **uid 1001**（以前是 1000）：之後要再掛 NAS 目錄，記得 `chown 1001:1001`（或在 DSM 加 ACL），
  否則容器會 `Permission denied`。
- 回滾（回到「code-server 用自己那份 clone」的舊架構）：
  `cp ~/code-server/docker-compose.yml.bak-20260922-workspace ~/code-server/docker-compose.yml`
  → `docker exec -u 0 5151-code-server chown -R 1000:1000 /home/coder`
  → `cd ~/code-server && docker compose up -d`
  （**不要**對 `…/cline-server/repos` 做 chown 回 1000：那份是 cline-server／agent 在用的，owner 必須維持 1001。
  若要「只退回共用 data dir、保留新工作區」，用 `…bak-20260922-clineshare`。）

### 工作區：現在只有**一份** working tree

`/workspace`（IDE）＝ `~/code-server/workspace/cline-server/repos`（NAS）＝ `/workspace/repos`（agent 容器）。
原本 code-server 自己那份獨立 clone（曾落後 `master` 57 個 commit）已於 2026-09-22 刪除，
所以「在瀏覽器改的檔案」與「agent／Desktop 改的檔案」現在是同一棵樹，不會再各改各的。


## 上傳 / 存取檔案（2026-09-20 補：為什麼檔案對話框只看得到容器路徑）

**根因**：code-server 跑在**容器裡**，所以 VS Code 的 `File → Open File…`、`Save As…` 這些對話框
看到的是**容器內**的檔案系統，不是你電腦的。要在兩者之間搬檔案，用下面三種方式：

1. **從你的電腦上傳（最常用）**：在左側 Explorer 對目標資料夾按右鍵 → **Upload…**
   （開的是**你電腦**的檔案選擇視窗），或直接把檔案／整個資料夾**拖進 Explorer**。
   檔案會落在你開的那個資料夾底下（例如 `/workspace/5151/…`）。
   ⚠️ **不要**用 `File → Open File…`／`Save As…` 來上傳，那兩個永遠只看得到容器內的路徑。
2. **檔案已經在 NAS 上**：丟進 NAS 的 `~/code-server/workspace/cline-server/repos/`（Synology File Station、
   SMB 網路磁碟、或 `scp` 都行）→ IDE 內立刻看到（＝ `/workspace/…`，同一個資料夾）。反向也一樣：
   IDE 裡寫的檔案就躺在 NAS 的那個路徑上。
3. **IDE 內建終端機**：`curl -O`、`wget`、`git clone` 都可以（容器網路是通的）。

### 把「你電腦的檔案」附給 Cline（`+` 只會看到容器）

Cline 輸入框左下角的 `+`（Add Files & Images）用的是 **VS Code 的檔案對話框**，所以瀏覽器版
（code-server）只會列出**容器內**的路徑 —— 看不到你電腦的資料夾（瀏覽器不可能讓網頁瀏覽本機檔案）。

> ⚠️ **2026-09-20 更正**：輸入框底部那句 `hold shift to drag in files/images` 只對**圖片**成立。
> 從桌面拖**非圖片**檔（pdf/zip/csv/xlsx…）會立刻跳紅字
> `Files other than images are currently disabled`（3 秒後自動消失），而且檔案不會被附上。
> 這不是設定問題，是瀏覽器 + Cline 網頁版的先天限制（見下表）。

實作依據：Cline **4.1.19** 原始碼 `apps/vscode/webview-ui/src/components/chat/ChatTextArea.tsx`
（`onDrop` L1263-1340、`handlePaste` L855-949；容器內 4.1.19 bundle 內同一段已核對）：

| 你怎麼丟 | Cline 收不收 | 為什麼 |
|---|---|---|
| 桌面拖**圖片**（png/jpeg/webp）進輸入框 | ✅ | 瀏覽器拖放只給「檔案內容」，圖片可以 base64 內嵌 |
| `Ctrl+V` 貼**圖片**（截圖） | ✅ | 同上：`clipboardData.items` 拿得到圖片資料 |
| 桌面拖**非圖片**檔 | ❌ 跳那句紅字 | 瀏覽器給的 `File` 物件**沒有本機路徑**，Cline 只能走「路徑 → `@` context」那條，於是擋掉 |
| 桌面複製檔案後 `Ctrl+V` | ❌ | 同上（瀏覽器不會把檔案放進 `clipboardData.items`） |
| 貼**文字**／貼網址 | ✅ | 走 `dataTransfer.getData("text")` 那條 |
| 從 **Explorer 側邊欄**拖檔進輸入框 | ✅（桌面版已驗證；瀏覽器版未實測） | 走 `resourceurls` / `application/vnd.code.uri-list`，**帶的是路徑**，任何檔案都能變 `@path` |

**結論**：非圖片檔案要**先讓檔案進到容器看得到的地方**，再讓 Cline 用路徑讀它：

1. **上傳（最直覺）**：Explorer 對 `/nas-inbox/` 按右鍵 → **Upload…**
   （VS Code 內建指令 `explorer.upload`，code-server 4.138.0 的 web workbench 已確認有）→
   開的是**你電腦**的檔案視窗。也可以直接把檔案**拖進 Explorer**（同功能的 drop 版）；上游有已知
   bug [code-server#7886](https://github.com/coder/code-server/issues/7886)，拖失敗就改用 **Upload…**。
   （舊的 `/workspace/_uploads/` 已於 2026-09-22 移除：工作區改成 agent 的 repos 根目錄後，
   上傳落到 repo 裡會污染版本控制；舊檔已搬去 NAS `~/inbox/code-server-old-_uploads/`。
   現在要「先落地再引用」就用 `/nas-inbox/` ✓）
2. **從 NAS 丟（不用上傳，推薦）**：檔案丟進 NAS 的 `~/inbox`（Synology File Station／SMB 網路磁碟／
   `scp` 皆可）→ IDE 內就是 `/nas-inbox/<檔名>`。
3. **在對話裡引用**：按 `+` 選剛上傳／剛丟進去的檔，或直接把路徑打在對話裡、用 `@`（工作區檔案）。
   容器內路徑（例：`/nas-inbox/report.pdf`）Cline 讀得到。
4. **純文字檔的小抄**：在電腦上打開 → 全選複製 → 輸入框 `Ctrl+V`（文字那條 ✓）。

> 反向（Cline 產生的檔案要拿回你電腦）：Explorer 對檔案右鍵 → **Download…**。
> 圖片是 base64 進 context，太大的圖會吃 token —— 大圖建議先存成檔案、用路徑引用。

### 容器內看得到哪些掛載（2026-09-22 現況）

| 容器內路徑 | NAS 實際位置 | 權限 | 用途 |
|---|---|---|---|
| `/workspace` | `~/code-server/workspace/cline-server/repos` | **rw** | 專案區（18 個 repo，＝ Cline Server／agent 的同一份 working tree）；內含 `repos/` 符號連結指回自己，讓 agent 的 `/workspace/repos/<repo>` 也成立（見上一節）|
| `/nas-inbox` | `~/inbox` | **rw** | **上傳到 NAS 的落地區**（IDE 寫、NAS 端看／搬）|
| `/nas-docker` | `/volume1/docker` | **ro** | 各容器 compose／.env（5151-ops、ecpapi、mbriapi…）|
| `/private` | `~/code-server/private` | **ro** | `INFRA-CREDENTIALS.md` 等憑證 |
| `/home/coder` | `~/code-server/data` | **rw** | code-server 自己的設定／已安裝擴充 |
| `/home/coder/.cline/data` | `…/cline-server/home/.cline/data` | **rw** | Cline 的 session／settings／db（與 cline-dev 共用）|
| `/home/cline` | `…/cline-server/home` | **rw** | cline-server 的**家目錄**；讓共用資料裡的 `/home/cline/…` 絕對路徑指回真身（終端 cwd、MCP 工具鏈、舊 session 路徑），見上一節 |

### ⚠️ 為什麼「家目錄 / 整個 /volume1」不能直接掛

- Synology 的 **ACL 會蓋掉 Unix 777**：`/volume1/homes/tori`、`~/code-server` 顯示為 `drwxrwxrwx+`，
  但 ACL 只列 `user:tori` 與 `group:administrators`、**沒有 others** → 容器身分（2026-09-22 起為
  uid **1001**，之前是 1000）連 `ls` 都被拒（實測 `Permission denied`）。
- **bind mount 會繞過上層目錄的 ACL，但不會繞過被掛那一個目錄自己的 ACL** —— 所以
  `~/code-server/workspace/cline-server/repos`（無 ACL、owner 1001）能掛，`~/` 或 `~/code-server` 不行。
- 也**不要**掛整個 `/volume1`：VS Code 會對它建 file watcher／索引，11TB 的共享會把 NAS 的 CPU
  與 inotify 額度吃光（`files.watcherExclude` 能少看很多目錄，但主機的 inotify 上限才是關鍵，見上方 FAQ）。
- **例外／補充**：`/home/cline`（＝ `…/cline-server/home`）是**可以**掛的 —— 它沒有 Synology ACL、
  owner 就是容器身分 1001，符合上面那條規則（不是特例，是同一個理由）。**不要**掛的是 `~/` 本身
  （`/volume1/homes/tori`，有 ACL、且會把整個家目錄 11TB 拉進來）。
- 要再開放其他路徑有兩條：**① 用 root 建目錄 ＋ `chown 1001:users` ＋ `chmod 2775`**
  （`~/inbox` 就是這樣做的：容器可寫、`tori` 也能刪／搬，因為容器身分的補充群組就有 `users`）；
  **② 在 DSM 加 ACL** 給容器用的 uid。掛其他共享（`MOVIE`、`NAKIVO_Repository`…）建議加 `:ro`。


## Cloudflare Access（強烈建議；含每個欄位要填什麼）

為什麼要做：這個網址**公開**、目前只靠一組密碼保護，而容器內還讀得到 `/private/INFRA-CREDENTIALS.md`。
Access 會在最前面多一層「只有你的 email 能進來」的閘門（免費方案 50 人內 ✓）。

### 0. 一次性初始化（只有第一次需要）
1. 開 <https://one.dash.cloudflare.com>
2. 若還沒用過 Zero Trust，會先要你取一個 **team name**（例：`acefengyun`）→ 之後登入網域是
   `acefengyun.cloudflareaccess.com`
3. 方案選 **Free**（一個 team 免費，涵蓋 50 users）→ Continue

### 1. 建 Application
1. 右上選帳號 **Acefengyun@gmail.com's Account**
2. 左側 **Access → Applications** → 右側 **Add an application** → 選 **Self-hosted**
3. **Application configuration** 這一頁填：
   | 欄位 | 填什麼 |
   |---|---|
   | Application name | `cocodeco code-server` |
   | Session Duration | `24 hours`（覺得常要重登可改 `1 week`）|
   | Public hostname → Subdomain | `cocodeco` |
   | Public hostname → Domain | `reversalplay.me`（下拉選）|
   | Public hostname → Path | **留空** |
4. 按 **Next**

### 2. 加政策（Policies）
1. 這一頁按 **Add a policy**（或 Create new policy），填：
   | 欄位 | 填什麼 |
   |---|---|
   | Policy name | `owner-only` |
   | Action | **Allow** |
   | Configure rules → **Include** → Selector | **Emails** |
   | Value | 你的 email（例：`acefengyun@gmail.com`；可加多個、逗號分隔）|
2. （可選）再加一條規則：**Require → Login method → One-time PIN**，確保只能用 email OTP
3. 按 **Save** → **Next**

### 3. 完成與測試
1. 下一頁是登入方式設定：**One-time PIN（email 驗證碼）預設就是開的 ✓** → 直接 **Add application**
   （要用 Google 登入才需另外到 `Authentication → Login methods` 設 OAuth，非必要）
2. 用**無痕視窗**開 <https://cocodeco.reversalplay.me>：
   - 應該**先**看到 Cloudflare Access 的登入頁（輸入 email → 收 6 碼 PIN）✓
   - 通過後**才**是 code-server 的密碼頁（原本那組 `CODE_SERVER_PASSWORD`）✓ 兩層都對才進得去
3. 未登入時 `curl -I https://cocodeco.reversalplay.me` 會回 **302** 轉到
   `acefengyun.cloudflareaccess.com`（而不是 code-server 的 302 → `/login`）—— 可用這招確認有沒有生效

### 注意
- 加了 Access 之後，**未帶 Access cookie 的自動化**（curl/API）會被擋在前面 —— 目前沒有這種用途；
  之後若要做，可在同一 Application 加 **Service Auth** 政策 + Service Token。
- websocket 正常支援（VS Code 走 WSS）✓，不必額外設定。
- Access 這層與 code-server 自己的密碼是**兩道獨立**的門，建議兩者都留著。

## 安全與維運

- **沒有掛 docker socket** ✓（只是編輯器，不給它動 host 的能力）
- 對外唯一入口是 Cloudflare tunnel + code-server 密碼；建議再開 **Cloudflare Access**（Zero Trust → Access →
  Applications → 加 `code.reversalplay.me`，用 email OTP 或 Google 登入）多一層 ✓
- 生命週期：`cd ~/code-server && docker compose up -d`（密碼由 `.env` 的 `PASSWORD` 提供；更新：`docker compose pull && up -d`）
- 日誌：`docker logs --tail 50 5151-code-server`
- 資料備份：`~/code-server/data`（設定/擴充）＋ `~/code-server/workspace/cline-server/`（程式碼＝agent 的 repos；
  程式碼本身也可從 GitHub/Gitea 重拉，但 **Cline 的對話紀錄（`home/.cline/data`）只有這裡有，要備**）

---

## ⚠️ Clipboard 讀取失敗會卡住 Agent（`Retry` 那個錯誤）— 2026-09-22 已修

### 症狀（你回報的那張截圖）

在 code-server 用 VS Code Web 時右下角跳出：

```text
ⓧ Unable to read from the browser's clipboard. Please make sure you have granted
   access for this website to read from the clipboard.        [Retry]  [Learn More]
```

而且 **Cline Agent 會停在原地**，要人工去按 `Retry` 或把那個 toast 關掉才會繼續。

### 根因（不是猜測；位置在 VS Code 前端 bundle 裡）

code-server 4.138.0（VS Code core 1.138.0）內建的 `BrowserClipboardService.readText()`：

```js
async readText(e) {
  try { let t = await navigator.clipboard.readText(); return t; }
  catch {                                             // ← Chromium 拒絕讀剪貼簿時
    return new Promise(i => {                         // ← 回傳一個「不會自己 resolve」的 Promise
      let n = new A, r = this.notificationService.prompt(Ct.Error,
        d(20492,null),                                // "Unable to read from the browser's clipboard…"
        [{ label: d(20494,null), run: async()=>{ n.dispose(); i(await this.readText(e)); } },  // Retry
         { label: d(20493,null), run: ()=> this.openerService.open("…linkid=2151362") }],       // Learn More
        { sticky: !0 });
      n.add(K.once(r.onDidClose)(()=>i("")));          // ← 只有「人」動作才會 resolve
    });
  }
}
```

也就是：**clipboard 讀取失敗時，VS Code 不是 fail-open，而是把 Promise 掛在那裡等真人按
`Retry`**。任何 `await` 這個 read 的呼叫端都會一起卡住 —— 終端機/編輯器貼上、擴充功能，
以及 **Cline 擴充的 `env.clipboardReadText` RPC**（`vscode.env.clipboard.readText()`）。
Chromium 為什麼拒絕不是重點（權限沒給、document 沒有 focus、沒有 user activation、
之前按過「封鎖」…在 Cloudflare Access + 重載/切分頁的情境下很常見），重點是
**失敗時不該把 Agent 的 control flow 綁在這種互動上**。

> 順帶排除的兩個懷疑點：對外回應 `permissions-policy: clipboard-read=(self), clipboard-write=(self)`
> 是 Cloudflare Access 加的，`(self)` 是預設允許值（不是 deny）；webview iframe 的
> `allow="clipboard-read; clipboard-write;"` 也是正常允許。兩者都不是根因。

### 修法：只把那個 catch 改成 fail-open（最小 patch）

```diff
- catch { return new Promise(i=>{ …prompt(Retry / Learn More)… }) }
+ /*clipboard-fail-open*/catch(__clipErr){
+   this.logService.error("clipboard read failed (fail-open, no Retry gate):",__clipErr);
+   return "";
+ }
```

改完之後：clipboard 讀不到 → 只記一筆 warning → 立刻回 `""` → **不跳 toast、不會有 pending
Promise、Agent 繼續跑**。寫入端（`writeText`）本來就有 `execCommand` fallback + `console.error`，
本來就是 fail-open，沒有動它。

### 改了哪兩個檔案（容器內路徑）

| 檔案 | 說明 |
|---|---|
| `/usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js` | **瀏覽器實際載入的那一份**（`workbench.html` 的 `<script src>`）|
| `/usr/lib/code-server/lib/vscode/out/vs/workbench/workbench.web.main.internal.js` | 同一段程式碼的另一份 build artifact（一起補，避免換路徑時漏掉）|

兩個檔都只有那 334 個字元被換掉，其餘 byte-for-byte 相同（有驗證腳本可證明，見下）。

### 自我修復（container 重建後不會消失）

patch 在容器內，所以容器被重建（`docker compose up -d --force-recreate`、換 image）就會不見。
因此把「補丁腳本 + 觸發點」放在**持久化掛載**上：

| 項目 | 位置（容器內） | 對應 NAS 主機 |
|---|---|---|
| 補丁腳本 | `~/.local/share/code-server/tools/clipboard-failopen.sh` | `~/code-server/data/.local/share/code-server/tools/clipboard-failopen.sh` |
| 觸發點 | `~/.bashrc`（在開頭，每個 shell 都會跑一次）| 同左（`~/code-server/data/.bashrc`）|

腳本是 idempotent：已經補過就只做「讀 stamp + `stat` 兩個 bundle」的 fast path（約 1–11 ms），
不會拖慢 shell。原始檔在補之前會備份到 `~/.backups/clipboard-failopen-auto/`。

驗證自我修復（模擬容器重建）：

```bash
# 1) 把某個檔案還原成 image 原版（模擬重建後的狀態）
BK=$(ls -dt ~/.backups/clipboard-failopen-* | head -1)
sudo cp "$BK/workbench.js.orig" /usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js
# 2) 開一個互動式 shell（＝平常打開 Terminal 的動作）
bash -ic true
# 3) 應該已被自動補回（log 會出現 PATCHED …）
grep -c clipboard-fail-open /usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js   # → 1
tail -3 ~/.local/share/code-server/tools/clipboard-failopen.log
```

### 驗證（已經做過的）

```bash
# 1) 語法：patch 後仍然是合法 JS（19MB bundle）
/home/coder/.local/node/bin/node --check /usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js
# 2) 最小性：除了那 334 字元，前後都與 image 原版逐 byte 相同
node verify-clipboard-patch.cjs "$(ls -dt ~/.backups/clipboard-failopen-* | head -1)/workbench.js.orig" \
     /usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js
# 3) 伺服器實際吐給瀏覽器的內容 == 磁碟上補過的檔案（md5 相同）
curl -s -b <登入後的 cookie> http://127.0.0.1:8080/stable-<commit>/static/out/vs/code/browser/workbench/workbench.js | md5sum
# 4) 行為：用「真的 bundle 裡的那段程式碼」＋一個會丟 NotAllowedError 的 clipboard 跑：
#    before → 400ms 後仍在 pending、跳出 Retry toast；after → 立刻回 ""、只記 warning、無 toast
node clipboard-behaviour-test.cjs <orig-bundle> <patched-bundle>   # → OVERALL: PASS
```

### 使用者端要做的一次動作

那個 `<script src="…/workbench.js">` 的回應是 `Cache-Control: public, max-age=31536000`，
所以**舊分頁會快取舊的（會卡 Retry 的）bundle**。改完後請做一次 **硬重新整理
`Ctrl+Shift+R`**（之後瀏覽器快取的就是修好的版本）。

- 升級 code-server 版本時，URL 會因為版本/commit 而改變 → 新 bundle 會在**下一個 Terminal
  開啟時**被自動補上；同樣再硬重整一次即可。
- 想順手讓 clipboard 真的可用（不只 fail-open）：Chrome → 網址列左邊的圖示 → 網站設定 →
  「剪貼簿」→ 允許 `cocodeco.reversalplay.me`。這是加分項，**不是** Agent 能不能跑的條件。

### Rollback

```bash
BK=$(ls -dt ~/.backups/clipboard-failopen-* | head -1)   # 或 ~/.backups/clipboard-failopen-auto/
sudo cp "$BK/workbench.js.orig"                   /usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js
sudo cp "$BK/workbench.web.main.internal.js.orig" /usr/lib/code-server/lib/vscode/out/vs/workbench/workbench.web.main.internal.js
rm -f ~/.local/share/code-server/tools/.clipboard-failopen.stamp
# 移除 ~/.bashrc 裡 "clipboard-failopen" 那一段（備份：~/.bashrc.bak-clipboard-failopen-*）
# 最後硬重整瀏覽器分頁
```

### Cline 內部要不要用 OS clipboard？（檢查結果：沒有）

Cline 擴充 4.1.19 與 Cline CLI 3.0.64 的 bundle 內**沒有任何** `xclip`／`xsel`／`wl-copy`／
`pbcopy` 依賴；clipboard 只透過 VS Code API / webview 使用，且 webview 內每一處都是
`.catch(err => console.error(...))`（fail-open）。所以 Agent 的資料流本來就沒有依賴系統剪貼簿，
唯一的阻塞點就是上面那個 VS Code `readText()`。
