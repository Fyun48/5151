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
| a-2 | **浮動映像（機制跟我原本寫的不一樣，已更正）** | `5151-ops` 的 `image:` 是 `ghcr.io/fyun48/5151:latest`，而兩台 web 釘 digest。但 `Dockerfile` 只 `COPY v3/src ./src` 與 `COPY v3/public ./public`——**映像裡根本沒有 `ops/`**。所以浮動映像決定的是 **Node 執行環境與 npm 依賴**，不是 OPS 的邏輯 | 吉比壞版推上去、OPS 需要重建容器時，可能拿到壞的執行環境而起不來（不是「跑到吉比的碼」） |
| a-3 | **OPS 的碼是宿主上一份 git 未追蹤的手動複製**（原本的「同 repo 同 image」寫法是錯的） | 容器靠 bind mount `./ops:/app/ops:ro` 取碼，來源是 `/mnt/Storage1/apps/5151/ops`；該目錄在 NAS 上的 git  Checkout 停在 `ed62e71`（2026-08-28）且 `ops/` 狀態是 **`?? ops/`（未追蹤）**。逐檔比對 master：243 檔中 **241 檔位元組相同**，差的两檔是我今天改文案的 `ops/README.md`、`ops/BLUEPRINT.md` | 沒有版本、沒有重建途徑：那目錄被 `git clean -fdx` 或disk 故障带走，**映像救不回來**（映像沒備 ops）；也無法回答「正式 OPS 跑的是哪個 commit」 |

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

## 5. 執行紀錄（Owner 裁示「就照你建議的繼續」→ a-2 先、a-1 並行、a-3 延後）

### 已完成
| 項目 | 結果 |
|---|---|
| 域名 | `jibbyrentops.reversalplay.me` → **`ops.reversalplay.me`**（舊名 ingress 與 DNS 都已刪，不再留别名） |
| OPS 專屬 tunnel | 新建 `ops`（id `53792c2f…`），`ops.reversalplay.me → http://127.0.0.1:5154`；吉比的 `5151`（`3adb90bf…`）現在只剩 `jibbyrenth`＋catch-all |
| 對外通道容器 | 新容器 **`5151-ops-cloudflared`**（compose project `5151-ops`），token 走 `TUNNEL_TOKEN_FILE` 掛檔，**不在 argv** |
| 來源與執行環境 | OPS 改由 `releases/<git SHA>/ops` ＋ `current` symlink 提供（只讀掛 `/app/ops`）；runtime **釘 digest** `abe3933e…`（＝搬遷前容器在跑的那個，所以執行環境零變動） |
| 發版工具 | `docker-compose.ops.casaos.yml` ＋ `ops/scripts/deploy-ops-casaos.sh`（可重跑、`trap` 回滚、發版前後都驗） |
| 尺規 | `test/deploy-ops-casaos.test.js` 13 條（含 YAML 真的 parse、順序檢查、token 歸屬） |
| 現行正式版 | 最終 master `b4638c3`（共 9 支 PR #632→#640）；`console.html` 200、`/ops/api/feedback` 未登入 401、tunnel 最後一條事件＝註冊成功（4 條連線） |

### 踩過的四個坑（都已寫回腳本＋尺規，不是只改文件）
1. **API 的 hostname 不等於 DNS 記錄**：PUT ingress 成功但站點 `000`，要另外 `POST /zones/{Z}/dns_records` 建 CNAME `<tunnel-id>.cfargotunnel.com`。（lesson L-0204）
2. **`${VAR:?message}` 的 message 含「冒號＋空格」會炸 YAML**：`yaml: line 19: mapping values are not allowed in this context`。
   更糟的是腳本當時已先 `docker rm -f`，等於当场把 OPS 停掉約 30 秒（靠吉比 project 的舊定義回生）。
   → 對策：值加引號；**`docker compose config -q` 移到摘容器之前**；尺規改用 YAML parser 真的解析。
3. **`.env` 只寫值、漏鍵名**：下一次 `source` 時 shell 把整行 digest 當指令執行 → 腳本開頭就中止（所幸還在摘容器之前）。
   → 對策：寫成 `OPS_RUNTIME_IMAGE=…`；source 前只收 `^[A-Za-z_][A-Za-z0-9_]*=` 行。
4. **cloudflared 影像跑 uid 65532**：root:600 的 token 檔它讀不到，日誌一直 `Failed to read token file`，
   容器 Up 但 CF 端 tunnel 永遠 inactive——此時搬 hostname 只會拿到 530。
   → 對策：`chown 65532:65532` 目錄(700)與檔(400)，掛載 `:ro` 容器寫不進去；
   發版結尾改驗日誌 `Registered tunnel connection`（且**不用** `--since` 窄窗口：容器沒重建時窗口必然為空，我也误判过一次）。

### 尚未做／留給 Owner
- **a-3（把 `ops/` 拆成獨立 repo／獨立 image）**：刻意延後。現在 OPS 已經有「自己的 tunnel＋自己的 compose project＋釘版來源」，
  吉比 build 出錯不會再決定 OPS 重啟後的執行環境；拆 repo 的邊際收益要等第二個專案真的入驻才有實質意義。
- **v3 → OPS 的回饋遞交管線仍沒啟用**（`ingested_feedback` 0 筆、`product_ingest_credential` 0 筆）。
  要開需要：簽發 ingest credential，並在 `5151-web-A` 設 `OPS_FEEDBACK_DELIVERY=1`、`OPS_INGEST_URL`、`OPS_INGEST_SECRET` 後重啟 ⇒ **屬 Production 變更，需要 Owner 明確核准**（F-0001），金鑰值不進對話。
- 搬遷後 Cookie 是 host-only（無 `Domain=`），Owner 需用新域名**重新登入一次**（設計如此，不是故障）。

### 操作注意（本次故意**沒改**吉比的 compose）
吉比的 `/mnt/Storage1/apps/5151/docker-compose.yml` 裡**仍然留著 `5151-ops` 這個 service**（實查 3 處字串），
但容器已改由獨立 project `5151-ops` 擁有。所以：

- 若有人對吉比 project 跑 `docker compose up -d`（整站重建的常見手勢），Docker 會因
  `container_name` 衝突而**報錯失敗**——這是 fail-closed、看得见，不會靜悄悄把 OPS 改回舊定義（好事）。
- 要重建 OPS 只用這一條：
  `bash ops/scripts/deploy-ops-casaos.sh <git SHA> [runtime-digest 或 -]`
  （或 `docker compose -p 5151-ops -f /mnt/Storage1/docker/5151-ops/app/current/docker-compose.ops.casaos.yml up -d`）
- 我**刻意不去刪**吉比 compose 裡的 ops service：那份檔在 NAS 上是髒的／有 override，
  動它等於動吉比的發版路徑（超出這次授權）。下次要收尾時再單獨開 PR 處理，並同步 `test/v3-compose.test.js`。
- 舊碼來源 `/mnt/Storage1/apps/5151/ops`（11MB／243 檔）**保留未刪**，是回滚備援；
  確認新轨跑穩一段後可另行處置（不要在還沒備份 `releases/` 之前就删）。

### 追補：最後兩條也是我自己寫錯的檢查（都已鎖進尺規）
| # | 失誤 | 現象 | 教訓 |
|---|---|---|---|
| 5 | `case` 少了尾 `*` | `[FAIL] 最後一條事件不是註冊成功（實際：… Registered tunnel connection connIndex=3 …）` | bash 的 case pattern 是**錨定全字串**；`*"文字")` 變成「必須以它結尾」。檢查寫錯時 `trap` 仍會回滚，正式服務沒停在壞狀態（實測 current 退回 f43a7be、console=200）→ 「工具誤判」與「環境故障」要分開讀 |
| 6 | 只驗「歷史有沒有註冊過」 | 先成功、後來 token 壞會被掩蓋 | 改成看**最後一條事件**（`grep -E "A\|B" \| tail -1`），並將「帶尾 `*`」與「不帶尾 `*` 的寫法」都寫成斷言 |

**現行正式版**：`b4638c3a736463b4385b4238b46e2004f17aef84`（＝ 合併 PR #639 後的 master）。
本次一共 9 支 PR：#632（獨立 compose／釘版／TUNNEL_TOKEN_FILE）、#633（YAML 冒號＋先解析再摘容器）、
#634（.env 鍵名）、#635（token 交給容器 uid／驗註冊）、#636（註冊字串與時間窗）、#637（文件同步）、
#638（改看最後一條事件）、#639（case 錨定修正）、#640（本節追補）。
※ 部署的是 #639 的 `b4638c3`；#640 只動 `docs/handoffs/` 這一檔，**不在發版 tarball 的路徑內**
  （`git archive <SHA> ops docker-compose.ops.casaos.yml`）→ 兩者的 release 內容位元組相同，不必追版。
