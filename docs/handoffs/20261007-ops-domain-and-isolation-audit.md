# OPS 網域遷移 ＋ 三原則稽核（2026-10-07）

Owner 给的三條原則（原話整理）：

- **(a) 獨立系統**：OPS 不该因為某個專案出錯就一起不能運作。
- **(b) 不需要登入權限劃分**：一套 Owner 身分就夠，別做角色層。
- **(c) 不要用 CF proxy 的 email 認證當門**：那類通行證可以撐很久（「1 個月」），反而變成攻擊面。

本檔記錄：網域已搬遷、三條逐項核對的結果（含**不符合項**）、以及需要 Owner 裁定的衝突。

---

## 1. 已完成：`jibbyrentops.reversalplay.me` → `ops.reversalplay.me`

| 步驟 | 動作 | 結果 |
|---|---|---|
| 1 | `PUT /accounts/{acct}/cfd_tunnel/3adb90bf…/configurations` 新增 `ops → http://127.0.0.1:5154`（保留原三條） | success |
| 2 | zone 新增 CNAME `ops` → `3adb90bf….cfargotunnel.com`（proxied，id 前綴 `efa667a5`） | success |
| 3 | 驗證新名可用後，再由 ingress **移除** `jibbyrentops` | success |
| 4 | 刪除 `jibbyrentops` DNS 記錄（id 前綴 `8f86fdd8`） | success |

**踩到的坑（記下來）**：這條 tunnel 的 public hostname **不會自動建立 DNS 記錄**。只做步驟 1 時
`https://ops.reversalplay.me` 回 `000`（DNS 解析不到）；必須補步驟 2。反向做也一樣：撤名稱要同時撤
ingress 與 DNS，留一半會變成「解析得到但 tunnel 不認識」的 404。

**為什麼搬遷幾乎零成本**（先查過才動手）：
- 程式端**零硬碼**：`ops/src/*.js`、`ops/public/*.js`、`v3/src/*.js` 搜 `jibbyrentops`／`reversalplay.me` 皆 0 命中；
  ingest URL 只讀 `OPS_INGEST_URL` 環境變數。
- 資料庫不存網域：掃 `/data/ops.db` 全部表的文字欄位，**沒有一欄**含 `reversalplay`。
- 鑑權不綁名字：CSRF 的同源檢查是拿**請求自己的 Host** 組 `proto://host`（`ops/src/auth.js:205`）。
- 時機因素：`OPS_INGEST_URL` 目前是空的、`product_ingest_credential` 0 筆 → 沒有任何一端記著舊網域。

**驗證**：`ops.reversalplay.me/` 200、`/console.html` 200、`/ops/api/feedback` 未登入 401（與舊名同行為）；
`jibbyrenth.reversalplay.me` 全程 200；偽造 `Origin` 的登入請求被拒。

**唯一副作用**：`ops_session` 是 host-only cookie（無 `Domain=`），換名後要**重新登入一次**。

**未動 anything**：沒有新增／重建容器、沒有改 compose、沒有改連接埠、沒有部署。
變更已記進 `/home/cline/INFRA-INVENTORY.md`（2026-10-07 條目）。

---

## 2. 稽核結果：(b) 與 (c) 已符合，(a) **不符合**

### (b) 不需要登入權限劃分 —— ✅ 本來就是這樣
`ops/src/auth.js` 只產生 `role: "owner"` 一種身分，守門是 `requireOwner`／`requireOwnerMutation`
（全檔 90 處 gate），沒有 admin／operator／viewer 之類的角色層。
**結論：無需改碼，也無需補 RBAC。**

### (c) 不靠 CF email 認證 —— ✅ 已符合，且**我先前的建議是錯的**
- 目前 CF **沒有**任何 Access 應用程式涵蓋 OPS（8 個 Access app 全是別的项目；實測
  `/console.html` 200、回應中 `cdn-cgi/access` 出現 0 次）。
- OPS 自己的 session 政策比 Access 的 email OTP 更嚴：
  `ABSOLUTE_MS = 12 小時`、`IDLE_MS = 2 小時`（`ops/src/auth.js:18-19`）。
- 暴力破解由**應用程式自己擋**：`LOGIN_MAX_FAILS = 8`，觸發後鎖 `15 分鐘 × 2^(cycles-1)`，上限 6 小時，
  key 是 `ip|email`（`ops/src/auth.js:20-22, 69-101`）。

**所以「幫 OPS 加 Cloudflare Access」那條建議與原則 (c) 相反，正式撤銷。**
若日後要加一層，正確的位置是 **CF 的 WAF rate-limit 規則**（只限速、不發通行證，不會產生長效 session），
而不是 Access。

### (a) 獨立系統 —— ❌ 三處不符合，這才是真正的工作項
| # | 耦合點 | 證據 | 後果 |
|---|---|---|---|
| a-1 | **共用對外 tunnel** | `ops.reversalplay.me` 與 `jibbyrenth.reversalplay.me` 都在 tunnel `5151`（`3adb90bf…`）的 ingress 裡；該 tunnel 由 `591-tracker-tunnel`（CasaOS）＋ `591-tracker-tunnel-b`（Synology）承載（見 `deploy/shadow-ha/cloudflared/README.md`） | 吉比的 tunnel 容器掛掉／被誤停，OPS 一起失去對外入口，**連登入頁都看不到** |
| a-2 | **浮動映像** | `5151-ops` 跑 `ghcr.io/fyun48/5151:latest`；兩台 web 釘的是 digest `sha256:378d8f7a…` | 吉比下一次 build 會決定「OPS 下次重啟跑到什麼碼」；吉比壞版推上去，OPS 重啟就可能起不來 |
| a-3 | **同 repo 同映像** | OPS 原始碼在吉比 repo 的 `ops/` 子目錄，與產品共用同一張 image | 回滚吉比 = 連帶回滚 OPS 程式；兩者無法各自發版 |

已存在的**正面**因素（不必重做）：
- 容器進程本來就分離：`5151-ops`（`node ops/src/server.js`）是獨立容器、只綁 `127.0.0.1:5154`。
  實測對照：兩台 web 因部署 `Up 2 hours`，`5151-ops` 仍 `Up 2 weeks` → 吉比重啟不會打斷 OPS。
- 資料庫分離：`/data/ops.db`（`ops/src/opsDb.js:11` 註明「與產品 v3 的 v3.db 完全分離」）。
- 運行時方向分離：BLUEPRINT 是「站 → OPS 單向抄送，**OPS 不在對方頁面渲染路徑上**」→ 吉比前台不依賴 OPS。
  （反向只有 `V3_OPS_COMMAND_APPLY_URL` 這個 site-command 通道，目前**未設定**，所以 v3 掛掉也不會拖垮 OPS。）

---

## 3. 需要 Owner 裁定的衝突

**`AGENTS.md` 現有白字黑字：「禁止另開 tunnel／第二條通道」「不要另開 tunnel」。**
但原則 (a) 要的是 OPS 有自己的對外通道。兩條話现在互相矛盾，必須由您決定走哪邊：

- **選項 1（維持一条 tunnel）**：接受 a-1 殘留。OPS 與吉比共用對外通道，只修 a-2／a-3。
  好處：不違反現有規則、改動最小。壞處：吉比的 cloudflared 出事，OPS 照樣看不到。
- **選項 2（為 OPS 開獨立 tunnel）**：符合 (a) 的原意。需要
  ① 新建 CF tunnel、② casa-nas 多一個 `ops-cloudflared` 容器與 compose、③ 更新 `AGENTS.md` 那句
  「不要另開 tunnel」為「**產品站**不得另開 tunnel；OPS 控制面走自己的 tunnel」。
  同時建議把 token 改成 `TUNNEL_TOKEN_FILE` 掛檔（現行兩台 cloudflared 把 token 寫在 **command line**，
  `docker inspect`／`ps` 看得到全文——這是既存衛生問題，新隧道不要複製它）。
- **不管選哪個都建議修的 a-2**：把 `5151-ops` 的映像由 `:latest` 改為**釘 digest**，
  並讓 OPS 有自己的發版節奏（a-3 的最後一步是把 `ops/` 拆成獨立 repo／獨立 image，那是更大的工程，可延後）。

**我的建議**：先做 a-2（釘 digest，半小時內可完成、零風險），再把 a-1 依選項 2 處理；
a-3 拆 repo 等有第二個專案真的入驻 OPS 時再動，避免現在就背上兩套發版管線。

---

## 4. 尚未接通的管線（與本次網域搬遷無關，但不能忘）
- `5151-web-A` 仍缺 `OPS_FEEDBACK_DELIVERY`／`OPS_INGEST_URL`／`OPS_INGEST_SECRET`。
- OPS DB：`ingested_feedback` **0 筆**、`product_ingest_credential` **0 筆** → 訂閱雖寫 `connected`，實線未接。
- 接法：先在 Console「新增產品」發行一組 ingest 憑證（`POST /ops/api/products` 回 `ingest_secret`），
  再補 v3 那三個 env（`OPS_INGEST_URL` 現在填 **`https://ops.reversalplay.me/ops/api/ingest/feedback`**）。
- 目前 `v3` 訂閱的 capabilities：`feedback_copy: true`，其餘
  （`crm_sync`／`stats`／`cross_site_insight`／`followup_service`／`retain_after_exit`）**皆 false**。
