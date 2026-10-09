# 5151 PG agent-check responder（角色感知）

讓 HAProxy 的 `backend pg_primary` 從「**人工對調順序＝正確性**」改成「**角色自動判定**」：

- 每個 PG 節點各跑一份 responder（`5151-pg-agent`），poll **本機** PG 的
  `select pg_is_in_recovery()`，把結果快取成兩個純字串狀態：
  - **primary 埠（25436）**：本節點是 primary ⇒ `up`，否則 `down`
  - **standby 埠（25437）**：本節點是 standby ⇒ `up`，否則 `down`
- HAProxy 對 `pg_primary` 每台 server 加 `agent-check agent-port 25436 …`，
  就只會把寫入導到「回報自己是 primary」的那台。手動 promote 後**不必再對調 backend 順序**。
- 語意（見 `agent.mjs` 的 `roleStatus`）：
  - `pg_is_in_recovery() = f` ⇒ primary 埠 up、standby 埠 down
  - `pg_is_in_recovery() = t` ⇒ 反之
  - 查不到（連線失敗／逾時）⇒ 連續失敗未達 `PG_AGENT_FAIL_LIMIT` 維持上次狀態，
    達門檻後兩個埠都 down（fail-closed）

## 為什麼保留 `check`＋加 `agent-check`（雙保險）

`option pgsql-check user postgres` 只驗「這台 PG 接受連線」，**不驗 `pg_is_in_recovery()`**。
所以原本的 `backend pg_primary` 一定要人工把順序對調成「primary 在前」並 reload，
漏改就會把寫入打到已降級成唯讀的節點（2026-09-20／09-23 演練都踩過，見
`docs/runbooks/postgres-manual-failover.md` §6）。

因此：

- **`check`（pgsql-check）留著**：負責「連通性」。
- **新增 `agent-check`**：負責「角色」（primary 才回 `up`）。
- **拿掉 `backup`、加 `balance first`**：兩台都是「正式成員」，角色由 agent 決定；
  `balance first` 只在 agent 同分（例如 split-brain、兩台都報 up）時退回「清單第一台」，
  維持既有偏好順序當 fallback。順序不再決定正確性，但部署時仍建議把當下 primary 排前面。

## HAProxy 2.9.15 的 agent-check 語法限制（實測，務必照這個寫）

用一套臨時 HAProxy 2.9.15＋假後端實測（不碰 25433、不碰 DB）：

- server 行**只吃** `agent-check agent-port <埠> agent-inter <時間>`。
- **`agent-fall`／`agent-rise` 是 unknown keyword**（實測 `[ALERT] unknown keyword 'agent-fall'`）。
- backend 級的 `option agent-check` 也是 **unknown option**（實測報錯）。

⇒ **agent-check 沒有任何防抖（rise/fall）參數**。波動時「要不要翻路由」的屏障**完全落在
responder 端**：本包實作的「連續失敗未達 `PG_AGENT_FAIL_LIMIT` 維持上次狀態，達門檻才兩個埠都
down」不是可有可無的修飾，而是唯一的抗抖機制。別把 `PG_AGENT_FAIL_LIMIT` 調成 1（單次瞬斷就翻）。

實測切換延遲：`agent-inter 2s` 下，down→流量轉到另一台約 **1779／1992／2007ms**，復歸同量級。

## 徹底 fail-closed（這是我們要的語意）

當**所有** server 的 agent 都回 `down` 時，`balance first` 下**沒有可用後端、連線直接失敗**
（實測＝空回應）。也就是說：

- 不會把寫送錯到 standby（比「送錯」好）。
- 但代價是：**responder 全掛 ＝ 寫入全停**。

因此是**硬性部署要求**：

- responder 用 `restart: unless-stopped`（compose 已設）。
- 節點重開機後 responder 要跟著起來（docker 開機自動啟用該容器）；兩台都掛時 `pg_rw` 等同停機，
  這是設計上的 fail-closed，不是 bug。

## 環境變數（`.env`，不在版控內）

| 鍵 | 必填 | 說明 |
|---|---|---|
| `PG_AGENT_DIRECT_URL` | **是** | 直連**本機** PG 的 URI，形如 `postgresql://postgres:***@127.0.0.1:15432/postgres`。responder 用 `network_mode: host` 直連 `127.0.0.1:15432`（兩台都實測 host `0.0.0.0:15432` 可直連）。資料庫會被固定成 `postgres`（不連 `5151_shadow`，避免還原／redo 期間探測失敗誤判）。**含 `:25433` 或 host 是 25433 埠 ⇒ 直接拒絕啟動**（那是 HAProxy，會自己探測自己）。 |
| `PG_AGENT_IMAGE` | **是** | 釘住 digest 的映像（**不准 `:latest`**），例如 `ghcr.io/fyun48/5151@sha256:…`。 |
| `PG_AGENT_PRIMARY_PORT` | 否 | 預設 `25436` |
| `PG_AGENT_STANDBY_PORT` | 否 | 預設 `25437` |
| `PG_AGENT_INTERVAL_MS` | 否 | 預設 `2000` |
| `PG_AGENT_QUERY_TIMEOUT_MS` | 否 | 預設 `1500` |
| `PG_AGENT_CONNECT_TIMEOUT_MS` | 否 | 預設 `1000` |
| `PG_AGENT_FAIL_LIMIT` | 否 | 預設 `2`（唯一抗抖屏障，見上） |

> 兩台的 `.env` 只有 `PG_AGENT_DIRECT_URL` 的 host 可能不同（都是 `127.0.0.1:15432` 或各自的
> `192.168.0.140/192.168.0.220:15432`），`PG_AGENT_IMAGE` 兩台同一顆。

## 部署順序（responder 先、HAProxy 後）

**先別動 HAProxy**，等兩台 responder 都驗證過角色再改，否則 agent-check 會先把節點判 DOWN。

1. 在兩台節點建立 `.env`（`PG_AGENT_IMAGE`＋`PG_AGENT_DIRECT_URL`）。
2. 安裝 responder（會先備份 `.bak-$(date +%Y%m%d-%H%M)` 再覆寫，`docker compose config -q`
   通過才 `up -d`，失敗自動還原）：
   ```bash
   bash v3/scripts/pg-agent-install.sh casa   # casa-nas → /opt/5151-shadow/pg-agent/
   bash v3/scripts/pg-agent-install.sh syn    # syn-nas  → /var/services/homes/tori/5151-shadow/pg-agent/
   ```
3. 驗收（下節）：兩台各回報「自己是 primary 的那個埠＝up」。
4. 改 HAProxy（下一節那幾行）並 reload。
5. 驗證經 `25433` 的寫入只到 primary。

## HAProxy 要加的幾行（`deploy/shadow-ha/haproxy/haproxy.cfg` 的 `backend pg_primary`）

```haproxy
backend pg_primary
    option pgsql-check user postgres
    balance first
    server pg-a ${CASAOS_HOST}:15432 check inter 3s fall 3 rise 2 agent-check agent-port 25436 agent-inter 2s
    server pg-b ${SYNOLOGY_HOST}:15432 check inter 3s fall 3 rise 2 agent-check agent-port 25436 agent-inter 2s
```

- 每台 server 加：`agent-check agent-port 25436 agent-inter 2s`（25436＝該節點 responder 的
  **primary 埠**）。**不要寫 `agent-rise`／`agent-fall`**——2.9.15 會報 unknown keyword。
- 拿掉原本的 `backup`；加 `balance first` 當同名條件的 fallback。
- `pg_ro`（25434）的 `backend pg_standby_first` **本包不動**（見下方已知限制）。

## 驗收指令

> `psql -h 127.0.0.1 -p 25436` **不可能成功**：25436/25437 說的是 HAProxy agent 協定
> （一行 `up`／`down`），不是 PostgreSQL wire protocol。請用 `nc` 或 node 一行讀。
> 埠位已實測：`25434` 被 `frontend pg_ro` 占用，`25433` 是 `pg_rw`；agent 埠是 **25436／25437**。

在 responder 所在節點（或任何可達該節點的機器）上：

```bash
# nc（各發行版旗標略異：-q1 是 GNU nc，Synology 可能要換 -w1 或省略）
printf '' | nc -q1 127.0.0.1 25436   # primary 埠：本機是 primary 應回 up
printf '' | nc -q1 127.0.0.1 25437   # standby 埠：本機是 standby 應回 up

# node 一行（最可靠；可在 5151-pg-agent 容器內執行，network_mode:host 可直接摸到 127.0.0.1）
node -e "const s=require('net').connect({host:'127.0.0.1',port:25436},()=>{});s.on('data',d=>process.stdout.write(d));s.on('error',e=>{console.error(e.message);process.exit(1)})"
```

預期：primary 節點上 25436 回 `up`、25437 回 `down`；standby 節點上相反。
（跨機驗證就把 `127.0.0.1` 換成該節點 IP；注意 agent 埠會綁 host 網路的所有介面，
只答 up/down、不回任何資料，但仍建議用防火牆只放行 HAProxy 主機。）

> 已知 HAProxy 行為（實測）：讀完第一行就會 **RST 連線**。responder 已為每個 socket 掛
> `error` handler，並有 `uncaughtException`／`unhandledRejection` 兜底（只記 log、不退出），
> 不會被 RST 打掛。

## 已知限制

- **`pg_ro`（25434）本包不動**：`backend pg_standby_first` 的 standby 優先路由維持原樣。
  未來若要用 agent-check 做讀取路由，standby 埠（25437）已備好，但那不是本包的範圍。
- 本包只提供「角色判定」的資料源（responder）＋安裝入口＋規格；**實際改 HAProxy、reload 與
  演練由人執行**，本包不代為執行、不碰 NAS、不碰正式 DB、不觸發任何發版 workflow。
