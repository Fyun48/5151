# 5151 code-server（瀏覽器版 VS Code）

「隨時關掉分頁、隨時打開都還在」的雲端 IDE —— 這是 Owner 要的 Cursor-agent-web 體感（P2 選項 2）。

- 容器：`5151-code-server`（CasaOS 那台以外，跑在 **Synology**；與 Gitea 同一台）
- 對外：`https://cocodeco.reversalplay.me`（走既有 `jgitea-tunnel`，dashboard 上顯示為 connector **`gitea`**）
- 只綁 `127.0.0.1:8484`（不對 LAN 開放），因此對外一律經 Cloudflare
- 密碼：NAS `~/code-server/.env` 的 `PASSWORD`（compose 以 `env_file: .env` 讀入；600，不進 repo；`CODE_SERVER_PASSWORD` 保留為向後相容）
- 資料：`~/code-server/data`（設定＋已安裝擴充套件）、`~/code-server/workspace`（工作區，已預先 clone `5151`）

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
2. **File → Open Folder → `/workspace/5151`**（已預先 clone，remote URL 已含 Gitea token，可直接 `git pull`/`push`）
   ⚠️ 這是 code-server **自己的 clone**，不是 agent 在用的那份；要跟 agent 同一份工作區請開
   `/workspace/cline-server/repos/5151`（見下面「Cline 對話紀錄」一節）。
3. 內建終端機（Ctrl+`）可直接跑 `npm test`、`git status`；容器與 `gitea:3000` 同網路，`git` 對內網穩定 ✓
4. 想用 AI：**Extensions → 搜 `Cline`**（code-server 走 Open VSX；若搜不到就用 `.vsix` 安裝）→
   **它的對話歷史與 Cline Server 共用同一份**（2026-09-22 起，見下一節），所以 Desktop 開的 session
   在這裡的 RECENT 就看得到。Provider 設定：
   - Base URL：`https://api.deepseek.com`
   - API Key：DeepSeek key（見 Gitea repo variable `DEEPSEEK_API_KEY`）
   - Model：`deepseek-chat`（也可 `deepseek-reasoner` / `deepseek-flash` / `deepseek-v4-pro`）
5. **關掉分頁不會中斷**：容器與 VS Code server 持續在 NAS 上跑；下次打開分頁會回到同一個工作區與狀態。
   終端機裡的長指令建議用 `tmux`（若要關分頁後繼續跑）。

## 加入其他專案（多專案工作區）

`/workspace` 這個掛載目錄就是「專案區」：放進去的每個 repo 都會出現在 IDE 左側。

**目前已預先 clone（2026-09-20，**18 個＝GitHub 上的全部**）**：
`5151`、`your-remit-01`、`your-remit-erp01`、`your-remit-erp02`、`your-remit-erpdev`、
`yourremit-accounting-system`、`yourfavorestore`、`ForumSeeksDLer`、`bnplloan`、`MBRIAPI`、`ECPAPI`、
`my-erp-mobile`、`cnndemo`、`hsihung_php`、`hsihung_php2`、`tori`、`HeyWorld`、`Fyun48`
（`HeyWorld`／`Fyun48`／`hsihung_php2`／`tori` 是**空 repo**：clone 會成功但沒有任何 commit）。

> 後 9 個（private）是 2026-09-20 第二輪從 GitHub 補搬進 Gitea 之後才 clone 進來的 ——
> 詳見 `evidence/runtime-modernization/GITEA-MIGRATION.md` §1.2。每個 clone 的 remote 都已內含
> Gitea token，可直接 `git pull`／`push`。

三種切換／新增方式：

1. **一次看全部（預設）**：File → Open Folder → `/workspace`
   → VS Code 會辨識底下每個 git repo，**Source Control 會同時列出多個** ✓
2. **用工作區檔**：File → Open Workspace from File… → `/workspace/5151-projects.code-workspace`
   （已替你建好，內含上面 **18 個** ✓）；要自己的組合就 File → Save Workspace As… ✓
3. **再加新專案**：IDE 內建終端機
   ```bash
   cd /workspace
   git clone http://JimmyGOD:<token>@gitea:3000/JimmyGOD/<repo>.git   # 自己的 Gitea（容器內可直達）
   git clone https://github.com/<user>/<repo>.git                     # 外部 repo（私有需 access token）
   ```
   然後 File → **Add Folder to Workspace…** 加進來即可 ✓

> 想改「預設打開什麼」：編輯 `docker-compose.yml` 最後那個參數（現在是 `/workspace`；
> 要固定單一專案就改成 `/workspace/5151`）→ `docker compose up -d`。
> 想在新分頁直接開某個資料夾，可試 URL 參數：`https://cocodeco.reversalplay.me/?folder=/workspace/5151` ✓

## Cline 對話紀錄：與 Cline Server 共用同一份（2026-09-22 起）

**背景**：NAS 上其實有**兩套 Cline**，天生各有各的 data dir，所以以前「在 Cline Desktop 連 `cline-server`
開的 session」不會出現在 code-server 的 Cline 面板（反之亦然）——
Cline 的歷史存在該 core 的 data dir（`sessions/<id>/*.messages.json` + `db/sessions.db`），
**不會跨 data dir 同步，也沒有雲端同步**。

| 誰 | 容器 | data dir（NAS 路徑） |
|---|---|---|
| 瀏覽器版 IDE 的 Cline 擴充 | `5151-code-server` | `~/code-server/data/.cline/data`（舊）|
| Cline Server ← Cline Desktop 遠端連的那台 | `cline-dev` | `~/code-server/workspace/cline-server/home/.cline/data` |

**2026-09-22 起改成兩邊共用同一份**（compose 動三件事）：

1. `user: "1001:1001"` ← 與 `cline-dev` 的 `cline` 同 uid。Cline 建檔是 `0666 & ~umask`，
   **不同 uid 光靠群組/ACL 是不夠的：後建的那個檔一定有一邊寫不進去** → 同 uid 才穩。
   （容器啟動時 `fixuid` 會把 `coder` 對映到 1001，所以 `id` 顯示 `uid=1001(coder)` ✓）
2. `group_add: ["100"]` ← 保留 `users` 群組，才能繼續寫 `~/inbox`（`/nas-inbox` 是 2775 root:users）。
3. `CLINE_DATA_DIR=/home/coder/.cline/data` ＋ 把 `cline-server/home/.cline/data` 掛到 `/home/coder/.cline/data`
   ← **兩個容器指到同一份** sessions／settings／db。

**結果**：code-server 的 Cline 面板「RECENT／歷史」＝ Cline Desktop 接 `cline-server` 的同一份清單；
在 code-server 開的 session，Desktop 那側也看得到。**工作可以在任一邊接續，不用怕漏掉紀錄。**

### 驗證指令

```bash
# NAS 上：兩邊看到的 session 數要一樣
docker exec 5151-code-server sh -c 'ls ~/.cline/data/sessions | wc -l'
ls ~/code-server/workspace/cline-server/home/.cline/data/sessions | wc -l

# code-server 的 Terminal（CLI 已持久化安裝在 ~/.npm-global；找不到就重開 Terminal）：
cline history --limit 5             # 列出共用的歷史
cline -i -c /workspace/cline-server/repos/5151   # TUI 接續同一份 session
# ⚠️ CLI 的預設 provider 是 `cline`（走 Cline Credits，餘額 0 會直接 Insufficient balance）；
#    要用你自己的 DeepSeek key 請明示：
cline -P deepseek -m deepseek-flash -c /workspace/cline-server/repos/5151 "你的提示詞"
```

### ⚠️ 注意事項（本次實測踩到的）

- **兩邊 Cline 版本要一致**（目前 extension/core `4.1.19`、CLI `3.0.6x`）。升一邊就要升另一邊，
  否則共用 data dir 時 schema migration 會互打；升完要 `docker compose up -d` 重建容器。
- 共用 `globalState.json`／`providers.json`（＝API key、auto-approve、語言設定兩邊一致）；
  **`~/.cline/remote` 沒有共用**（Desktop remote helper 專用，只掛 `data`）。
- 只有「同時在兩邊跑 zen／背景任務」才會有兩個 hub daemon 寫同一顆 `hub-events-hub-production.db`；
  一般對話不受影響（hub 只在背景任務出現）。
- 舊的、只屬於 code-server 的 6 條 session 已封存（檔案還在，只是不再出現在 UI 清單）：
  `~/code-server/data/.cline/data-code-server-archive-20260922-2006`。
- 容器身分是 **uid 1001**（以前是 1000）：之後要再掛 NAS 目錄，記得 `chown 1001:1001`（或在 DSM 加 ACL），
  否則容器會 `Permission denied`。
- 回滾：`cp ~/code-server/docker-compose.yml.bak-20260922-clineshare ~/code-server/docker-compose.yml`
  → `docker exec -u 0 5151-code-server chown -R 1000:1000 /home/coder /workspace/5151`
  → `cd ~/code-server && docker compose up -d`。

### 兩個 `5151` 是**不同的 clone**（很容易搞混）

| IDE 裡的路徑 | NAS 路徑 | 說明 |
|---|---|---|
| `/workspace/5151` | `~/code-server/workspace/5151` | code-server 自己的 clone（2026-09-22 時落後 `master` **57 個 commit**）|
| `/workspace/cline-server/repos/5151` | `~/code-server/workspace/cline-server/repos/5151` | **agent／Cline Server 實際工作的 clone**（＝ `cline-dev` 容器內的 `/workspace/repos/5151`）|

要跟 agent 用同一份工作區，就在 IDE 開 `/workspace/cline-server/repos/5151`（uid 1001 → 可寫 ✓）。


## 上傳 / 存取檔案（2026-09-20 補：為什麼檔案對話框只看得到容器路徑）

**根因**：code-server 跑在**容器裡**，所以 VS Code 的 `File → Open File…`、`Save As…` 這些對話框
看到的是**容器內**的檔案系統，不是你電腦的。要在兩者之間搬檔案，用下面三種方式：

1. **從你的電腦上傳（最常用）**：在左側 Explorer 對目標資料夾按右鍵 → **Upload…**
   （開的是**你電腦**的檔案選擇視窗），或直接把檔案／整個資料夾**拖進 Explorer**。
   檔案會落在你開的那個資料夾底下（例如 `/workspace/5151/…`）。
   ⚠️ **不要**用 `File → Open File…`／`Save As…` 來上傳，那兩個永遠只看得到容器內的路徑。
2. **檔案已經在 NAS 上**：丟進 NAS 的 `~/code-server/workspace/`（Synology File Station、
   SMB 網路磁碟、或 `scp` 都行）→ IDE 內立刻看到（同一個資料夾）。反向也一樣：IDE 裡寫的檔案
   就躺在 NAS 的那個路徑上。
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

1. **上傳（最直覺）**：Explorer 對 `/workspace/_uploads/` 或 `/nas-inbox/` 按右鍵 → **Upload…**
   （VS Code 內建指令 `explorer.upload`，code-server 4.138.0 的 web workbench 已確認有）→
   開的是**你電腦**的檔案視窗。也可以直接把檔案**拖進 Explorer**（同功能的 drop 版）；上游有已知
   bug [code-server#7886](https://github.com/coder/code-server/issues/7886)，拖失敗就改用 **Upload…**。
2. **從 NAS 丟（不用上傳，推薦）**：檔案丟進 NAS 的 `~/inbox`（Synology File Station／SMB 網路磁碟／
   `scp` 皆可）→ IDE 內就是 `/nas-inbox/<檔名>`。
3. **在對話裡引用**：按 `+` 選剛上傳／剛丟進去的檔，或直接把路徑打在對話裡、用 `@`（工作區檔案）。
   容器內路徑（例：`/nas-inbox/report.pdf`）Cline 讀得到。
4. **純文字檔的小抄**：在電腦上打開 → 全選複製 → 輸入框 `Ctrl+V`（文字那條 ✓）。

> 反向（Cline 產生的檔案要拿回你電腦）：Explorer 對檔案右鍵 → **Download…**。
> 圖片是 base64 進 context，太大的圖會吃 token —— 大圖建議先存成檔案、用路徑引用。

### 容器內看得到哪些掛載（2026-09-20 現況）



| 容器內路徑 | NAS 實際位置 | 權限 | 用途 |
|---|---|---|---|
| `/workspace` | `~/code-server/workspace` | **rw** | 專案區（18 個 repo）＝上傳的預設落點 |
| `/nas-inbox` | `~/inbox` | **rw** | **上傳到 NAS 的落地區**（IDE 寫、NAS 端看／搬）|
| `/nas-docker` | `/volume1/docker` | **ro** | 各容器 compose／.env（5151-ops、ecpapi、mbriapi…）|
| `/private` | `~/code-server/private` | **ro** | `INFRA-CREDENTIALS.md` 等憑證 |
| `/home/coder` | `~/code-server/data` | **rw** | code-server 自己的設定／已安裝擴充 |

### ⚠️ 為什麼「家目錄 / 整個 /volume1」不能直接掛

- Synology 的 **ACL 會蓋掉 Unix 777**：`/volume1/homes/tori`、`~/code-server` 顯示為 `drwxrwxrwx+`，
  但 ACL 只列 `user:tori` 與 `group:administrators`、**沒有 others** → 容器裡的 `coder`（uid 1000）
  連 `ls` 都被拒（實測 `Permission denied`）。
- **bind mount 會繞過上層目錄的 ACL，但不會繞過被掛那一個目錄自己的 ACL** —— 所以
  `~/code-server/workspace`（無 ACL、owner 1000）能掛，`~/` 或 `~/code-server` 不行。
- 也**不要**掛整個 `/volume1`：VS Code 會對它建 file watcher／索引，11TB 的共享會把 NAS 的 CPU
  與 inotify 額度吃光（`files.watcherExclude` 只擋搜尋、不擋 watcher）。
- 要再開放其他路徑有兩條：**① 用 root 建目錄 ＋ `chown 1000:users` ＋ `chmod 2775`**
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
- 資料備份：`~/code-server/data`（設定/擴充）＋ `~/code-server/workspace`（程式碼；程式碼也可從 Gitea 重拉）
