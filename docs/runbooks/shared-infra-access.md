# 共享基礎設施存取手冊（跨專案）

> 這份是**所有專案共用**的存取入口說明：兩台 NAS、Cloudflare Tunnel／Access、SSH 走法、資料庫、
> 機密存放位置、以及「代理人可以代操作到哪」。
> 新專案請先讀本檔 + `.cursor/rules/infra-access.mdc`，不要另開 tunnel、不要另開第二條通道。
>
> 最後更新：2026-09-22（PG 切換完成後、CF SSH + service token 上線同日）

## 1. 主機總表

| 代稱 | 機器 | 區網 IP | sshd 埠 | 登入者 | 用途 |
|---|---|---|---|---|---|
| **casa-nas** | CasaOS NAS | `192.168.0.140` | `54722` | `root` | v3 生產容器、PG、OPS Console、Cloudflare connectors |
| **syn-nas** | Synology NAS | `192.168.0.220` | `58722` | `tori` | 舊資料/備份、OPS 相關 workflow 目標 |

- 兩台的 sshd **直接聽在 54722 / 58722**（不是 22，也不是路由器轉 22）。
- 公網 IP `114.34.73.76` 上，路由器目前仍把 `54722`／`58722` 轉到這兩台 —— **這是待退場的路徑**（見 §6）。

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

Access 應用：`ssh-tori`、`ssh-casa`（皆 self-hosted），policy 名 `email+token` =
**email `acefengyun@gmail.com`**（會寄 OTP，24h）**OR service token**。

Service token（帳號層級，兩台共用同一把）：
- 名稱 `nas-ssh-putty`，**Client ID** `9881d66a-3598-402b-ae38-3330d71ce61f`，效期至 2027-09-22。
- **Client Secret 不寫進 repo**：存在使用者的密碼管理器（需要時由 Zero Trust → Access → Service Auth 重設）。
- 兩個應用的 policy 都已 include 這把 token → 任一台都能用同一組 ID/Secret 免 OTP 登入。

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

### 2.3 其他網站入口（同一條 tunnel、同一台 v3 容器）
- 公開站 `https://jibbyrenth.reversalplay.me` → `http://127.0.0.1:5153`
- OPS Console `https://jibbyrentops.reversalplay.me` → `http://127.0.0.1:5154`（獨立容器，不是 v3）

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

## 6. 待辦：把自動化改走 Cloudflare，然後關掉公網 SSH 埠

⚠️ **在下列自動化改走 CF 之前，不要關路由器的 `54722` / `58722` 轉發**（會直接壞掉）：

| 公網埠 | 依賴 | 影響 |
|---|---|---|
| CasaOS `54722` | `secrets.NAS_HOST` / `NAS_PORT` | 11 條 workflow：`deploy-v3`、`production-predeploy-check`、`build-production-image` 的 NAS 步驟、`deploy-ops`、`activate-rental-marketplace-*`、`migrate-v3-data-volume`、`prepare-rental-marketplace-stage1-fixtures`、`production-rakuya-diagnostic`、`production-support-check`、`production-uat-stages-functional` |
| Synology `58722` | `secrets.OPS_SYNOLOGY_HOST` / `OPS_SYNOLOGY_PORT` | `deploy-ops-synology.yml` |

改造方式（已規劃、尚未執行）：workflow 內先跑
`cloudflared access tcp --hostname ssh-casa.reversalplay.me --service-token-id/secret --url 127.0.0.1:2222`
（背景），再把 `host: 127.0.0.1`、`port: 2222`；GitHub 端新增 `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`。
Synology 那條同理（`ssh-tori` / `2223`）。
驗證方式：實跑一次 `build → predeploy → deploy` 三條 workflow；全綠後才關埠（回復 ＝ 把轉發加回來）。

## 7. 安全基線

- **CasaOS**：`fail2ban` 已安裝並啟用（2026-09-22），jail `sshd`：`mode=aggressive`、`maxretry=4`、
  `findtime=10m`、`bantime=1h`，設定檔 `/etc/fail2ban/jail.d/sshd.local`；啟用當下已封鎖 10 個暴力破解來源。
- **Synology**：無 fail2ban，改用「控制台 → 安全性 → 帳號 → 自動封鎖」。
- **口令登入退場計畫**：等**所有**使用者電腦都裝好金鑰並實測免密碼登入後，才在兩台設
  `PasswordAuthentication no` + `PermitRootLogin prohibit-password`（順序顛倒會把人鎖在外面）。
- **待輪替**：兩台 NAS 密碼、CF API token（皆曾在對話中出現）。

## 8. 代理人可代操作範圍

可以：CF API（zones / tunnels / Access apps & policies / service tokens）、`ssh syn-nas` / `ssh casa-nas`
（讀寫 NAS 上的 compose／容器／日誌）、GitHub Actions `workflow_dispatch`、開 PR／合併（依 owner 規則）。

不可代做（需使用者本人）：路由器設定（含關閉埠轉發）、密碼與 token 輪替、在公司/家用電腦上安裝金鑰
（可提供指令，由使用者執行）、CF 帳號層級的計費或成員設定。
