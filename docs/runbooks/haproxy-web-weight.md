# Runbook：HAProxy 權威設定（`deploy/shadow-ha/haproxy/haproxy.cfg`）的套用、加權與回滾

> 適用對象：要在**正式機**上套用或回退 `deploy/shadow-ha/haproxy/haproxy.cfg` 的人（planner／Owner）。
> ⚠️ CI **不會**把 repo 檔蓋到正式機（`.github/workflows/deploy-v3.yml` 只做部署後 health check），
> 套用一律手動：**就地改寫**（同一個 inode）＋容器內 `haproxy -c`＋`kill -s USR2 1`。
> 2026-10-12 起 repo 檔＝兩台正式機現行檔（拿掉註解與空行後**逐字相同、差異 0**）；
> 舊版本 runbook 寫的 `.cfg.tmpl`／`render-and-run.sh`／`/tmp/haproxy.cfg` 那一套**與現實不符，已作廢**。

## 0. 現況事實（2026-10-12 以 `docker inspect`／`ps` 實查）

| 現行檔位置 | 主機 | 容器 | 掛載方式 |
|---|---|---|---|
| `/opt/5151-shadow/haproxy/haproxy.cfg` | casa-nas（192.168.0.140） | `5151-haproxy` | **單檔 bind mount** → `/usr/local/etc/haproxy/haproxy.cfg` |
| `/var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg` | syn-nas（192.168.0.220） | `5151-haproxy-B` | **單檔 bind mount** → `/usr/local/etc/haproxy/haproxy.cfg` |

- 兩台容器命令都是 `haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg`，來源是 **`haproxy:2.9-alpine` 的映像預設**
  （planner 2026-10-12 以 `docker inspect -f "{{.Args}}"` 在兩台實讀核對；兩份 live compose **都沒有**顯式
  `command:`）⇒ repo 的兩份 compose 也**不准**寫 `command:`。
- 兩份 live compose 的**有效行完全相同**（只有 `name:`／service 名／`container_name:` 的 `-b` 後綴不同）：
  `image: haproxy:2.9-alpine`／`restart: unless-stopped`／
  `ports: 0.0.0.0:25433:25433、0.0.0.0:25434:25434、0.0.0.0:25153:15153、127.0.0.1:25154:8404`／
  `volumes: ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro`。
- **沒有** `.cfg.tmpl`、**沒有** `render-and-run.sh`、容器內**沒有** `/tmp/haproxy.cfg`。
  檔內一律**實體 IP**（`192.168.0.140`＝casa、`192.168.0.220`＝syn），沒有 `${CASAOS_HOST}` 這類佔位符，
  啟動時也沒有任何展開步驟 ⇒ **這份 cfg 不是 template**。
- `haproxy.cfg` 是**單檔 bind mount**（綁 inode），而且 compose 以 `:ro` 掛進容器：
  **改檔只能在宿主（NAS）上「就地改寫」**，`docker exec … > cfg` 會是 `Read-only file system`；
  `awk … > f.new && mv f.new f`／`sed -i`／`os.replace` 這類會換 inode 的作法，容器仍看到舊檔。
- 驗證語法要用**容器內路徑**：`docker exec <c> haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg`
  （給宿主路徑會 `Cannot open configuration file`）；⚠️ **通過時官方映像完全不吐字（只 exit 0）**，
  所以要自己 `&& echo "HAPROXY-C CHECK OK"` 才不會誤判成沒跑。
- 改設定後零中斷 reload：`kill -s USR2 1`（master/worker 換設定；只有**加／改埠映射**才需要重建容器）。
  正常的判讀（**2026-10-12 起兩池都是角色感知**）：`pg_primary/pg-a = UP`、
  `pg_primary/pg-b = DOWN (agent)`（待命庫被踢出寫入池，這是**預期**）；
  **`pg_standby_first` 只有自報待機的那一台 UP、另一台也要是 `DOWN (agent)`**。
  ⚠️ 舊版 runbook 寫的「同一台在 `pg_standby_first` 是 `UP bck=1`」是**改動前的症狀**：那代表這個 backend
  只問得到「PG 有沒有在答」、分不出角色（兩台都會答 ⇒ 讀取永遠落在 primary）。**看到讀取池兩台都 UP 要當異常**，
  不是正常。（`bck` 只是 stats 頁的欄位名，不代表現在還掛著 `backup`；以 `cfg` 為準。）

### 0.1 套用前必做：先確認「repo 檔」與「現行檔」沒有別的差異

```bash
diff <(ssh casa-nas "grep -avE '^\s*#|^\s*$' /opt/5151-shadow/haproxy/haproxy.cfg") \
     <(grep -avE '^\s*#|^\s*$' deploy/shadow-ha/haproxy/haproxy.cfg)      # casa vs repo
diff <(ssh syn-nas  "grep -avE '^\s*#|^\s*$' /var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg") \
     <(grep -avE '^\s*#|^\s*$' deploy/shadow-ha/haproxy/haproxy.cfg)      # syn vs repo
diff <(ssh casa-nas "grep -avE '^\s*#|^\s*$' /opt/5151-shadow/haproxy/haproxy.cfg") \
     <(ssh syn-nas  "grep -avE '^\s*#|^\s*$' /var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg")
```

- ✅ 預期：三個都**沒有輸出**（差異 0）。有輸出差異就先停下來查，不要直接覆蓋。
  **2026-10-12 planner 已實跑過這三條：casa vs repo＝0、syn vs repo＝0、casa vs syn＝0（各 45 行）。**
  ⏱️ **時效（2026-10-12 更新）**：那是 #722 收斂當下的狀態。**#722 之後 repo 檔與 live 已逐字一致**
  （含註解與空行），所以現在跑上面三條仍應為 0 —— 但**這個 0 只說明「當下沒有漂移」**，
  不改變下一條的鐵則：套用一律「只改你要改的那幾行」，**永遠不要整份覆蓋**。
  同一組「有效行」的規則也適用於 compose：兩份 haproxy compose 的有效行必須逐字一致
  （只有 `-b` 後綴不同）且都不含 `command:`。
- ⛔ **PG 段絕不能被 repo 檔整份覆蓋**（含 2026-10-12 起改好的讀取池）：`backend pg_primary`
  （`balance first` ＋ 兩條 `agent-check agent-port 25436 agent-inter 2s`、**pg-b 不帶 `backup`**）、
  `backend pg_standby_first`（兩條 `agent-check agent-port 25437 agent-inter 2s`、**不帶 `backup`**）
  與 `listen internal_stats` 是**寫入路由與角色判定**的核心。正式機上可能還有尚未同步回 repo 的
  Owner 核准設定，**整份複製 repo 檔上去等於把它們無聲退回舊版**（語法合法、不報錯，只是行為變了）。
  一律「只改你要改的那幾行」，改完把變更逐字同步回 repo 檔（本檔的 §2.4 就是照這個寫的）。
  `frontend pg_rw → backend pg_primary`、`frontend pg_ro → backend pg_standby_first` **不准改**。

## 1. 為什麼要加權（決策依據，2026-10-12 02:26–02:28 實測）

| 打誰 | 端對端中位 | `list;dur` | `stats;dur` |
|---|---|---|---|
| web-B（syn-nas，32GB，`5151-web-B`） | **3,915ms** | 1,141–1,662ms | 2,456–3,337ms |
| web-A（casa-nas，**4 核 Celeron N3450**，`5151-web-A`） | **5,240ms** | 1,731–2,408ms | 3,056–3,807ms |
| 公網入口（混合） | 5,379ms | ~1,850ms | ~3,200ms |

- 同一支腳本、同一分鐘、先量 B 再量 A；**同程式碼、同一個 PG**（primary 在 casa-nas）。
- 差距來源是**同機資源競爭**：casa-nas 上 `591-tracker-v3` 34.9% ＋ `5151-postgres-A` 約 46%
  ＋ `web-A` 27.6% CPU，4 核 `loadavg ≈ 4.0`。不是 web-A 的程式或設定比較差。
- 所以 `roundrobin`（50/50）等於把約一半的**新**訪客送去慢的那台 → 中位數被拉高約 25%。
- 結果：`backend web_nodes` 的 `server web-a … weight 30`／`server web-b … weight 70`
  （已生效，也在 repo 檔內）。

## 2. 套用／改動流程（零中斷；兩台都要做，順序：先 casa 再 syn）

> 底下這套是 **2026-10-12 planner 在兩台各實跑一次**的版本（USR2 reload 成功、`hrsp_5xx` 沒增加）。
> **三個不變式**：
> ① §0.1 的三個 diff 必須為 0；
> ② 改檔一律**在宿主**用 `io.open(path,"r+",encoding="utf-8")` ＋ `truncate()` **原地覆寫同一個 inode**
>    ——**不准** `mv`／`os.replace`／`awk … > f.new && mv`（換 inode ⇒ 容器仍看到舊檔），也**不准在容器內改**
>    （compose 是 `:ro` 掛載，容器內寫入會 `Read-only file system`）；
> ③ **先備份，而且備份本身要驗乾淨**（L-0688：壞掉的備份比沒有更糟）。

### 2.1 casa-nas（`5151-haproxy`）— 以 2026-10-12 的加權改動為範例

```bash
cd /opt/5151-shadow/haproxy

# (1) 改動前先備份「正本」，並驗備份自己的內容是乾淨的（三個期望值都要對才往下走）
cp -a haproxy.cfg haproxy.cfg.bak-weight-$(date +%Y%m%d)
grep -c "agent-check" haproxy.cfg.bak-weight-*                 # 期望 14（含註解行；有效行只有 4 條，見下一條）
grep -avE '^\s*#|^\s*$' haproxy.cfg.bak-weight-* | grep -c agent-check   # 期望 4（寫入池 2 ＋ 讀取池 2，2026-10-12 起）
grep -c "^    server pg-" haproxy.cfg.bak-weight-*             # 期望 4
if grep -avE '^\s*#|^\s*$' haproxy.cfg.bak-weight-* | grep -q backup; then
  echo "✗ 有效行內不該有 backup（pg_primary pg-b 與讀取池都不准有）"; exit 1
else echo "OK 有效行內沒有 backup"; fi
grep -avE '^\s*#|^\s*$' haproxy.cfg.bak-weight-* | wc -l       # 期望 45（＝live 的有效行數）

# (2) 只改要改的兩行，原地覆寫同一個 inode；任何不變式沒過就「不寫檔」直接退出
python3 - <<'PY'
import io, re
p = "/opt/5151-shadow/haproxy/haproxy.cfg"
orig = io.open(p, encoding="utf-8").read()

# 2a) 不可被碰到的行先抓出來：pg 段（角色判定）＋四條 Owner 核准／演練成果
pg_before = [l for l in orig.splitlines() if l.strip().startswith("server pg-")]
assert len(pg_before) == 4, f"server pg-* 應為 4 行，實際 {len(pg_before)}"
invariants = [
    "stick-table type string len 45 size 100k expire 30m",
    "stick on req.hdr(cf-connecting-ip) if { req.hdr(cf-connecting-ip) -m found }",
    "option redispatch",
    "retry-on conn-failure empty-response response-timeout",
]
missing = [x for x in invariants if x not in orig]
assert not missing, f"缺少不可被覆蓋的行：{missing}"

# 2b) 只改這兩行；錨點命中數必須＝2，否則不寫檔
new, n_a = re.subn(r"(server web-a \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 30", orig)
new, n_b = re.subn(r"(server web-b \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 70", new)
assert n_a + n_b == 2, f"錨點命中數應為 2，實際 {n_a + n_b} → 不寫檔"

# 2c) 寫回前再驗一次（pg 段逐字未變、四條不可覆蓋的行都還在）
assert [l for l in new.splitlines() if l.strip().startswith("server pg-")] == pg_before, "pg 段被改到了 → 不寫檔"
assert all(x in new for x in invariants), "改完少了不可覆蓋的行 → 不寫檔"

# 2d) 原地覆寫（同一個 inode）
with io.open(p, "r+", encoding="utf-8") as f:
    f.write(new); f.truncate()
print("WROTE", p, len(new), "bytes")
PY

# (3) 語法：用容器內路徑。⚠️ 通過時官方映像**完全不吐字**（只有 exit 0），所以自己印一行 OK，
#     否則會誤判成「沒跑」（planner 2026-10-12 差點被騙）
docker exec 5151-haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && echo "HAPROXY-C CHECK OK (casa)"

# (4) 零中斷套用（-W ＝ master/worker；USR2 換設定、既有連線不掉）
docker exec 5151-haproxy kill -s USR2 1 && sleep 1
docker logs 5151-haproxy --tail 20
# 期望：新 worker 起來（"New worker forked"）＋"Loading success"
# 判讀：`Server pg_primary/pg-b is DOWN, reason: Layer7 wrong status, info: "via agent : down"`
#      是**預期**（agent-check 把待命庫擋在寫入池外），不是故障；pg_primary/pg-a 應為 UP。
```

### 2.2 syn-nas（`5151-haproxy-B`）

同一套步驟與斷言，只有三處不同：`export PATH=/usr/local/bin:$PATH`（Synology 的 docker 不在非登入
shell 的 PATH）、檔案在 `/var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg`、容器名 `5151-haproxy-B`。

```bash
export PATH=/usr/local/bin:$PATH
cd /var/services/homes/tori/5151-shadow/haproxy
cp -a haproxy.cfg haproxy.cfg.bak-weight-$(date +%Y%m%d)
grep -c "agent-check" haproxy.cfg.bak-weight-*                 # 期望 14（含註解行）
grep -avE '^\s*#|^\s*$' haproxy.cfg.bak-weight-* | grep -c agent-check   # 期望 4
grep -c "^    server pg-" haproxy.cfg.bak-weight-*             # 期望 4
grep -avE '^\s*#|^\s*$' haproxy.cfg.bak-weight-* | wc -l       # 期望 45

python3 - <<'PY'
import io, re
p = "/var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg"
orig = io.open(p, encoding="utf-8").read()
pg_before = [l for l in orig.splitlines() if l.strip().startswith("server pg-")]
assert len(pg_before) == 4, f"server pg-* 應為 4 行，實際 {len(pg_before)}"
invariants = [
    "stick-table type string len 45 size 100k expire 30m",
    "stick on req.hdr(cf-connecting-ip) if { req.hdr(cf-connecting-ip) -m found }",
    "option redispatch",
    "retry-on conn-failure empty-response response-timeout",
]
assert all(x in orig for x in invariants), "缺少不可被覆蓋的行 → 不寫檔"
new, n_a = re.subn(r"(server web-a \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 30", orig)
new, n_b = re.subn(r"(server web-b \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 70", new)
assert n_a + n_b == 2, f"錨點命中數應為 2，實際 {n_a + n_b} → 不寫檔"
assert [l for l in new.splitlines() if l.strip().startswith("server pg-")] == pg_before, "pg 段被改到了 → 不寫檔"
with io.open(p, "r+", encoding="utf-8") as f:
    f.write(new); f.truncate()
print("WROTE", p, len(new), "bytes")
PY

docker exec 5151-haproxy-B haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && echo "HAPROXY-C CHECK OK (syn)"
docker exec 5151-haproxy-B kill -s USR2 1 && sleep 1
docker logs 5151-haproxy-B --tail 20
```

### 2.3 只有「加／改埠映射」才需要重建容器（例：`127.0.0.1:25154:8404` 的 stats）

```bash
# 會短暫中斷 25433/25434/25153 數秒；改 cfg 本身不要用這招
cd /opt/5151-shadow/haproxy && docker compose up -d --force-recreate      # casa
cd ~/5151-shadow/haproxy    && docker compose up -d --force-recreate      # syn
```

> `docker logs <c> --tail 20` 若出現設定錯誤（`unknown keyword`／`unable to find`…），**立刻執行 §3 回滾**。
> 另外：兩份 compose 的**有效行必須逐字一致**（只有 `-b` 後綴不同）、且**都不含 `command:`**（live 兩台都
> 用 `haproxy:2.9-alpine` 的映像預設命令）；`test/haproxy-compose-parity.test.js` 會擋「只在一邊加東西」。

### 2.4 讀取池改成角色感知（2026-10-12；決策 D-0040）— 可直接照抄的「先驗證 → 改 → reload → 後驗證」

要改的只有 `backend pg_standby_first` 那三行（`option pgsql-check` 不動；兩條 server 各加
`agent-check agent-port 25437 agent-inter 2s`、並**移除 `backup`**）。`backend pg_primary`、
`frontend pg_rw`／`pg_ro`、`web_nodes`、`listen internal_stats` **一個字都不准動**（§0.1 的鐵則）。

> ⚠️ 前提：兩台的 **25437 responder 必須已經在跑**（照 `deploy/shadow-ha/pg-agent/README.md` 的
> 「部署順序」先驗 responder，再改 HAProxy）。否則新設定一 reload，讀取池就沒有 UP server
> ⇒ 新連線全被拒（fail-closed，程式會退回 primary，但你不會想要在沒驗過 responder 的情況下撞上它）。
> ⚠️ 兩台的 cfg 路徑不同：casa `/opt/5151-shadow/haproxy/haproxy.cfg`、
> syn `/var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg`（容器 `5151-haproxy`／`5151-haproxy-B`）。

**步驟 ①：先驗證（改之前；兩個鏡像都要）**

```bash
# (0) repo 檔（＝本檔的來源）必須已經是「讀取池吃 25437／兩池都不帶 backup」
grep -avE '^\s*#|^\s*$' deploy/shadow-ha/haproxy/haproxy.cfg | grep -c "agent-port 25437"   # 期望 2
grep -avE '^\s*#|^\s*$' deploy/shadow-ha/haproxy/haproxy.cfg | grep -n "backup"             # 期望：無輸出

# (1) 驗 responder：standby 那台 25437 回 up；primary 那台 25437 回 down
printf '' | nc -q1 192.168.0.220 25437    # 期望 up   （syn 現在＝待機）
printf '' | nc -q1 192.168.0.140 25437    # 期望 down （casa 現在＝primary）
printf '' | nc -q1 192.168.0.140 25436    # 期望 up   （primary 埠對照）

# (2) 驗現況（改之前）：讀取池還是「兩台都 UP」＝分不出角色（就是本節要修的）
curl -s http://127.0.0.1:25154/stats;csv | awk -F, '
  NR==1 { for (i=1;i<=NF;i++) h[$i]=i; next }
  $1=="pg_standby_first" { printf "%s status=%s weight=%s scur=%s\n",$2,$h["status"],$h["weight"],$h["scur"] }'
# 期望（改之前）：pg-a status=UP、pg-b status=UP（且 bck 欄為 1）← 舊狀態

# (3) 三個 diff 必須為 0（見 §0.1）：casa vs repo、syn vs repo、casa vs syn
diff <(ssh casa-nas "grep -avE '^\s*#|^\s*$' /opt/5151-shadow/haproxy/haproxy.cfg") \
     <(grep -avE '^\s*#|^\s*$' deploy/shadow-ha/haproxy/haproxy.cfg)
diff <(ssh syn-nas  "grep -avE '^\s*#|^\s*$' /var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg") \
     <(grep -avE '^\s*#|^\s*$' deploy/shadow-ha/haproxy/haproxy.cfg)
# 期望：三條都無輸出
```

**步驟 ②：改（先 casa 再 syn；就地改寫同一個 inode）**

```bash
# casa
cp -a /opt/5151-shadow/haproxy/haproxy.cfg /opt/5151-shadow/haproxy/haproxy.cfg.bak-pgro-$(date +%Y%m%d-%H%M)
python3 - <<'PY'
import io
p = "/opt/5151-shadow/haproxy/haproxy.cfg"          # syn：/var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg
orig = io.open(p, encoding="utf-8").read()

# (a) 不可被碰到的行先抓出來；少一條就不寫檔
must = [
    "server pg-a 192.168.0.140:15432 check inter 3s fall 3 rise 2 agent-check agent-port 25436 agent-inter 2s",
    "server pg-b 192.168.0.220:15432 check inter 3s fall 3 rise 2 agent-check agent-port 25436 agent-inter 2s",
    "balance first",
]
missing = [x for x in must if x not in orig]
assert not missing, f"寫入池核心行不在檔案裡（或已被改動）→ 不寫檔：{missing}"

# (b) 只改讀取池那兩行（含 `backup` 的舊版與已改過的版本都吃）
SUFFIX = " check inter 3s fall 3 rise 2"
for addr, name in (("192.168.0.140", "pg-a"), ("192.168.0.220", "pg-b")):
    old = f"server {name} {addr}:15432{SUFFIX} backup"
    new2 = new.replace(old, f"server {name} {addr}:15432{SUFFIX} agent-check agent-port 25437 agent-inter 2s")
    assert new2 != new, f"{addr}: 找不到「⋯{SUFFIX} backup」那一行（可能已經改過）→ 不寫檔"
    new = new2

# (c) 寫回前驗：25437 恰好 2 條、25436 恰好 2 條、有效行內沒有 backup
eff = [l for l in new.splitlines() if l.strip() and not l.lstrip().startswith("#")]
assert sum("agent-port 25437" in l for l in eff) == 2, "25437 不是 2 條 → 不寫檔"
assert sum("agent-port 25436" in l for l in eff) == 2, "25436 不是 2 條（寫入池被動到了）→ 不寫檔"
assert not [l for l in eff if "backup" in l], "有效行內還有 backup → 不寫檔"

# (d) 原地覆寫（同一個 inode；絕對不要 mv／os.replace）
with io.open(p, "r+", encoding="utf-8") as f:
    f.write(new); f.truncate()
print("WROTE", p, len(new), "bytes")
PY
# syn：同一支程式，只把 p 改成 /var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg
```

**步驟 ③：reload（容器的 `haproxy -c` 先過再 reload）**

```bash
# ⚠️ 通過時官方映像不吐字（只 exit 0），所以自己印一條 OK，否則會誤判成「沒跑」
docker exec 5151-haproxy   haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && echo "HAPROXY-C CHECK OK (casa)"
before_ts=$(date +%s)
docker exec 5151-haproxy   kill -s USR2 1 && sleep 1
docker logs 5151-haproxy --since "@$before_ts" 2>&1 | grep -E "New worker forked|Loading success"
# 期望：兩條都出現（New worker forked ＋ Loading success）
# syn：容器名換 5151-haproxy-B（同一套步驟）
```

**步驟 ④：後驗證（兩台都要做；這是「有沒有真的生效」的判準）**

```bash
# (1) 語法（兩台；容器內路徑）
docker exec 5151-haproxy   haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && echo "HAPROXY-C CHECK OK (casa)"
docker exec 5151-haproxy-B haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && echo "HAPROXY-C CHECK OK (syn)"

# (2) 讀取池只剩「自報待機」那台 UP；另一台必須是 DOWN (agent)
curl -s http://127.0.0.1:25154/stats;csv | awk -F, '
  NR==1 { for (i=1;i<=NF;i++) h[$i]=i; next }
  $1=="pg_standby_first" { printf "%s status=%s weight=%s scur=%s\n",$2,$h["status"],$h["weight"],$h["scur"] }'
# 期望（2026-10-12，syn 是待機）：pg-a status=DOWN（reason=Layer7 via agent : down）、pg-b status=UP
# 寫入池不准被影響：pg_primary/pg-a=UP、pg_primary/pg-b=DOWN(agent)
curl -s http://127.0.0.1:25154/stats;csv | awk -F, '
  NR==1 { for (i=1;i<=NF;i++) h[$i]=i; next }
  $1=="pg_primary" { printf "%s status=%s\n",$2,$h["status"] }'

# (3) 經 HA 連線：讀取池必須落在**待機**（沒有 psql client 也能驗；用 node ＋ 佔位字串）
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a   # 只為拿帳密，不印出值
PG_URL='postgres://user:password@127.0.0.1:25434/5151_shadow' \
  node -e 'const u=process.env.PG_URL;const {Client}=require("pg");(async()=>{const c=new Client({connectionString:u});await c.connect();const r=await c.query("SELECT pg_is_in_recovery() AS standby");console.log("25434 → pg_is_in_recovery()=",r.rows[0].standby);await c.end()})().catch(e=>{console.error("ERR",e.message);process.exit(1)})'
# 期望：25434 → pg_is_in_recovery()= true        （改之前是 false ＝ 打到 primary）
PG_URL='postgres://user:password@127.0.0.1:25433/5151_shadow' node -e '…同上…'
# 期望：25433 → pg_is_in_recovery()= false

# (4) 角色互換情境（在下次 promote 後跑同一組）：syn 變 primary、casa 待機時
#     pg_standby_first 應該變成 pg-a=UP／pg-b=DOWN，且經 25434 連線仍回 true（＝當時的待機）
```

**回滾**：把 §3 的指令換成這次的備份（`haproxy.cfg.bak-pgro-<日期>-<時間>`）整份覆蓋回去，
`haproxy -c` ＋ `kill -s USR2 1` 即可（回到「兩台都可能 UP」的舊行為）。
⚠️ **不要把 `backup` 加回去**，也不要用「手動對調 server 順序」當解法。

## 3. 回滾

```bash
# (a) 用備份整份回退（`cat … > 正本` 是就地覆寫同一個 inode；`mv` 不行）＋重新驗證＋USR2
# casa：ls -t /opt/5151-shadow/haproxy/haproxy.cfg.bak-* 挑一份
cat /opt/5151-shadow/haproxy/haproxy.cfg.bak-weight-<日期> > /opt/5151-shadow/haproxy/haproxy.cfg
docker exec 5151-haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && echo "HAPROXY-C CHECK OK (casa)"
docker exec 5151-haproxy kill -s USR2 1

# syn
cat /var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg.bak-weight-<日期> \
  > /var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg
docker exec 5151-haproxy-B haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && echo "HAPROXY-C CHECK OK (syn)"
docker exec 5151-haproxy-B kill -s USR2 1

# (b) 只回退「加權」這一項（＝回 roundrobin：weight 拿掉就是預設 1／1），兩台都要做。
#     用與 §2 同一支「原地覆寫」程式（r+ / truncate），只拿掉 weight；錨點命中數必須＝2，否則不寫檔。
python3 - <<'PY'
import io, re
for p in ("/opt/5151-shadow/haproxy/haproxy.cfg",                              # casa
          "/var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg"):        # syn
    orig = io.open(p, encoding="utf-8").read()
    new, n = re.subn(r"(server web-[ab] \S+ check inter 3s fall 3 rise 2) weight \d+", r"\1", orig)
    assert n == 2, f"{p}: 錨點命中數應為 2，實際 {n} → 不寫檔"
    with io.open(p, "r+", encoding="utf-8") as f:      # 同一個 inode
        f.write(new); f.truncate()
    print("REVERTED WEIGHT", p)
PY
# 之後各自 haproxy -c ＋ kill -s USR2 1（同 §2）
```

回滾後立刻做 §4 的驗證（重點：兩台仍 UP、`hrsp_5xx` 沒有增加、weight 回到 1／1；
**讀取池回退後會變回「兩台都可能 UP」**——那是舊行為，不是故障，但別忘了把 repo 檔同步回去）。

> ⚠️ **回滾時不要刪 `stick-table`／`stick on`**（Owner 2026-10-10 核准的訪客黏滯），
> 也不要把 `option redispatch`／`retry-on` 一起拿掉——那兩條是 2026-09-23 演練的成果。
> 也**不要**把 `backend pg_primary` 的 `balance first`／`agent-check` 拿掉（角色判定會失效），
> 更不要把 `backup` 加回 `pg-b`；**讀取池（`pg_standby_first`）也一樣不准加回 `backup`**——
> 它只會讓「自報 down（＝現任 primary）」的那台在沒有 UP 成員時接到讀取，等於把 2026-10-12 修掉的病種回去。

## 4. 驗收（套用與回滾都要跑同一套）

```bash
# (1) 語法（兩台都用**容器內路徑**；⚠️ 通過時不吐字、只 exit 0 ⇒ 一定要自己印 OK）
docker exec 5151-haproxy   haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && echo "HAPROXY-C CHECK OK (casa)"
docker exec 5151-haproxy-B haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && echo "HAPROXY-C CHECK OK (syn)"

# (2) 唯讀 stats（宿主只綁 127.0.0.1:25154）：讀 web_nodes 兩台的 weight／status／hrsp_2xx／hrsp_5xx
#     表頭形如 `# pxname,svname,…`；不要背欄位位置，先依表頭找欄號再解析
curl -s 'http://127.0.0.1:25154/stats;csv' | awk -F, '
  NR==1 { for (i=1;i<=NF;i++) h[$i]=i; next }
  $1=="web_nodes" && ($2=="web-a" || $2=="web-b") {
    printf "%s status=%s weight=%s hrsp_2xx=%s hrsp_5xx=%s\n",
           $2, $h["status"], $h["weight"], $h["hrsp_2xx"], $h["hrsp_5xx"] }'
# 寫入路由也要看：pg_primary/pg-a=UP、pg_primary/pg-b=DOWN(agent)
# 讀取路由（2026-10-12 起）：pg_standby_first **只有自報待機的那台 UP**、另一台 DOWN(agent)
curl -s 'http://127.0.0.1:25154/stats;csv' | awk -F, '
  NR==1 { for (i=1;i<=NF;i++) h[$i]=i; next }
  $1=="pg_standby_first" { printf "%s status=%s\n", $2, $h["status"] }'

# (3) 端到端：狀態碼要**逐字列**，不要把「非 200」一律當故障
for i in $(seq 1 20); do printf "%s " "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:25153/api/health)"; done; echo
for i in $(seq 1 10); do printf "%s " "$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:25153/api/listings?limit=20')"; done; echo
# 期望：health 20/20 ＝ 200；listings **未帶 cookie 回 401 是預設行為**（要登入），不是 5xx、不是故障。
# 判故障只看兩件事：health 出現非 200、或任何路徑出現 5xx（出現就回滾）。

# (4) 分流量要「換 cf-connecting-ip」才量得到 30/70：
#     每次請求換一個 203.0.113.x ⇒ 產生「新的 stick 條目」（否則黏滯會把後續請求都送回同一台），
#     再比兩台 hrsp_2xx 的**增量**。
for i in $(seq 1 40); do
  curl -s -o /dev/null -w '%{http_code} ' -H "cf-connecting-ip: 203.0.113.$i" http://127.0.0.1:25153/api/health
done; echo
curl -s 'http://127.0.0.1:25154/stats;csv' | awk -F, '
  NR==1 { for (i=1;i<=NF;i++) h[$i]=i; next }
  $1=="web_nodes" && ($2=="web-a" || $2=="web-b") { printf "%s hrsp_2xx=%s\n", $2, $h["hrsp_2xx"] }'
# 2026-10-12 實測：40 次全 200，web-b 的 hrsp_2xx 增量約 **69%**（weight 30/70 ⇒ 期望 70%）。
```

- 判讀重點：`weight` 應為 `30`／`70`（回滾後為 `1`／`1`，HAProxy 預設值）、兩台 `status=UP`、
  `hrsp_5xx` **不增加**；公網 p50 不會立刻變 3.9s——**黏滯 30 分鐘內的回訪者仍回到原本那台**
  （見 cfg 內註解 (b)），要看的是「新黏滯有沒有往 web-B 偏」（(4) 的方法）與漸進期後的中位數。
- 若 p50 沒改善，但 weight 正確、兩台都 UP、`hrsp_5xx` 沒增加，那不是失敗，是漸進期；隔 30 分鐘後再量一次。
- 端對端中位數基準與量法見 `docs/runbooks/web-latency-measurement.md`。

## 5. 離線守護（CI；不碰正式機）

`.github/workflows/test.yml` 的 `Run Tests` job 有一層語法守門，`npm test` 另有兩層靜態守門：

1. **真語法檢查**（2026-10-12 新增，步驟 `Validate HAProxy config`）——用官方映像離線跑：

   ```bash
   docker run --rm -v "$PWD/deploy/shadow-ha/haproxy:/cfg:ro" \
     haproxy:2.9-alpine haproxy -c -f /cfg/haproxy.cfg
   ```

   任何 `unknown keyword`／語法錯誤都會讓 PR 紅（`[ALERT] … unknown keyword 'agent-fall'` ⇒ exit 1）。
   注意：官方映像的 entrypoint 會把命令改寫成 `haproxy -W -db …`，**成功時完全不吐字**，所以該步驟
   另外自己印一行 `haproxy -c OK: …`（否則綠燈的 log 看不出到底驗過沒有）。
2. **靜態檢查** `test/haproxy-web-nodes-weight.test.js`（`npm test` 會跑）：

   - `web_nodes` 必須正好兩條 `server`、**每條都有非 0 的 `weight`**，且 `web-b` 的 weight 必須大於 `web-a`；
   - `option redispatch`／`retry-on`／`httpchk`／`stick-table`／`stick on` 不得被覆蓋；
   - 檔內不得殘留 `${...}`（本檔已是實體 IP，會殘留就代表有人把 template 版的檔案放回來）；
     `pg-a`／`pg-b` 不得出現 `weight`；
   - PG 路由：`frontend pg_rw → backend pg_primary`、`frontend pg_ro → backend pg_standby_first`，
     `pg_primary` 有 `balance first` ＋ 兩條 `agent-check agent-port 25436`、**且不含 `backup`**；
   - **讀取池角色感知**（2026-10-12）：`pg_standby_first` 的**兩條** server 都必須是
     `agent-check agent-port 25437 agent-inter 2s`、**且不含 `backup`**；兩池的 agent 埠**不可相同**
     （`pg_primary` 25436／`pg_standby_first` 25437）；檔內不得出現 `agent-fall`／`agent-rise`；
   - `listen internal_stats` 存在、容器內 `bind :8404`、`stats admin if FALSE`；
   - 最後兩個 test 用突變（拿掉 weight／50-50／歸零／刪 server／對調；以及拿掉 agent-check／
     埠抄錯／加回 `backup`）證明這些檢查**真的會紅**。

   改壞 50/50 的驗證方式：把兩條 server 行的 weight 拿掉後跑
   `node --test test/haproxy-web-nodes-weight.test.js`，第一個 test 會以
   `no explicit "weight <n>"` 失敗。

   這支檔案也接了變異測試（2026-10-12 新增；`HAPROXY_MUTATIONS` 直接改 `haproxy.cfg` 的 server 行）：

   ```bash
   node v3/scripts/mutation-check.mjs test/haproxy-web-nodes-weight.test.js   # 期望 SURVIVED 0
   ```
3. **兩份 compose 的一致性** `test/haproxy-compose-parity.test.js`（2026-10-12 新增）：

   - 兩份 haproxy compose（casa／syn）的**有效行數必須相同、逐條逐字相同**（只允許 `-b` 後綴差異）；
   - **兩份都不准出現 `command:`**（live 兩台都用 `haproxy:2.9-alpine` 的映像預設命令）。
   - 紅的證明：把 `command:` 加回 casa 那份再跑
     `node --test test/haproxy-compose-parity.test.js`，第一個 test 會以
     `deploy/shadow-ha/haproxy/docker-compose.yml: 不該有 "command:"（…）` 與
     `有效行數不同：…=14 行 vs …=13 行` 失敗（exit 1）。
