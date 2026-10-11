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
  正常的判讀：`pg_primary/pg-b = DOWN (agent)` 是**預期**（待命庫被踢出寫入池），
  同一台在 `pg_standby_first` 是 `UP bck=1`；`pg_primary/pg-a` 應為 `UP`。

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
  同一組「有效行」的規則也適用於 compose：兩份 haproxy compose 的有效行必須逐字一致
  （只有 `-b` 後綴不同）且都不含 `command:`。
- ⛔ **PG 段絕不能被 repo 檔整份覆蓋**：`backend pg_primary`（`balance first` ＋ 兩條
  `agent-check agent-port 25436 agent-inter 2s`、**pg-b 不帶 `backup`**）、`backend pg_standby_first`
  與 `listen internal_stats` 是**寫入路由與角色判定**的核心。正式機上可能還有尚未同步回 repo 的
  Owner 核准設定，**整份複製 repo 檔上去等於把它們無聲退回舊版**（語法合法、不報錯，只是行為變了）。
  一律「只改你要改的那幾行」，改完把變更逐字同步回 repo 檔（本檔就是為此存在的鏡像）。
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

# (1) 改動前先備份「正本」，並驗備份自己的內容是乾淨的（兩個期望值都要對才往下走）
cp -a haproxy.cfg haproxy.cfg.bak-weight-$(date +%Y%m%d)
grep -c "agent-check" haproxy.cfg.bak-weight-*                 # 期望 2
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
grep -c "agent-check" haproxy.cfg.bak-weight-*                 # 期望 2
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

回滾後立刻做 §4 的驗證（重點：兩台仍 UP、`hrsp_5xx` 沒有增加、weight 回到 1／1）。

> ⚠️ **回滾時不要刪 `stick-table`／`stick on`**（Owner 2026-10-10 核准的訪客黏滯），
> 也不要把 `option redispatch`／`retry-on` 一起拿掉——那兩條是 2026-09-23 演練的成果。
> 也**不要**把 `backend pg_primary` 的 `balance first`／`agent-check` 拿掉（角色判定會失效），
> 更不要把 `backup` 加回 `pg-b`。

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
# 寫入路由也要看：pg_primary/pg-a=UP、pg_primary/pg-b=DOWN(agent)、pg_standby_first/pg-b=UP(bck=1)

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
     `pg_primary` 有 `balance first` ＋ 兩條 `agent-check`、**且不含 `backup`**；
   - `listen internal_stats` 存在、容器內 `bind :8404`、`stats admin if FALSE`；
   - 最後一個 test 用突變（拿掉 weight／50-50／歸零／刪 server／對調）證明這個檢查**真的會紅**。

   改壞 50/50 的驗證方式：把兩條 server 行的 weight 拿掉後跑
   `node --test test/haproxy-web-nodes-weight.test.js`，第一個 test 會以
   `no explicit "weight <n>"` 失敗。
3. **兩份 compose 的一致性** `test/haproxy-compose-parity.test.js`（2026-10-12 新增）：

   - 兩份 haproxy compose（casa／syn）的**有效行數必須相同、逐條逐字相同**（只允許 `-b` 後綴差異）；
   - **兩份都不准出現 `command:`**（live 兩台都用 `haproxy:2.9-alpine` 的映像預設命令）。
   - 紅的證明：把 `command:` 加回 casa 那份再跑
     `node --test test/haproxy-compose-parity.test.js`，第一個 test 會以
     `deploy/shadow-ha/haproxy/docker-compose.yml: 不該有 "command:"（…）` 與
     `有效行數不同：…=14 行 vs …=13 行` 失敗（exit 1）。
