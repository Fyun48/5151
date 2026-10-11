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

- 兩台容器命令都是 `haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg`。
- **沒有** `.cfg.tmpl`、**沒有** `render-and-run.sh`、容器內**沒有** `/tmp/haproxy.cfg`。
  檔內一律**實體 IP**（`192.168.0.140`＝casa、`192.168.0.220`＝syn），沒有 `${CASAOS_HOST}` 這類佔位符，
  啟動時也沒有任何展開步驟 ⇒ **這份 cfg 不是 template**。
- `haproxy.cfg` 是**單檔 bind mount**（綁 inode），而且 compose 以 `:ro` 掛進容器：
  **改檔只能在宿主（NAS）上「就地改寫」**，`docker exec … > cfg` 會是 `Read-only file system`；
  `awk … > f.new && mv f.new f`／`sed -i` 這類會換 inode 的作法，容器仍看到舊檔。
- 驗證語法要用**容器內路徑**：`docker exec <c> haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg`
  （給宿主路徑會 `Cannot open configuration file`）。
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

> **兩個不變式**：① §0.1 的三個 diff 必須為 0；② 改檔一律**就地改寫同一個 inode**
> （`open(path,'w')` 截斷後重寫），**不要**用 `sed -i`／`awk > new && mv`（換 inode → 容器仍看到舊檔）。

### 2.1 casa-nas（`5151-haproxy`）

```bash
# (1) 在宿主就地改寫「正在掛載的那份」＋先留備份（備份是新檔，沒差；正本必須同 inode）
python3 - <<'PY'
import re, shutil, time
p = "/opt/5151-shadow/haproxy/haproxy.cfg"
shutil.copy2(p, f"{p}.bak-{time.strftime('%Y%m%d%H%M%S')}")
s = open(p).read()                                   # 只改下面這兩行（範例＝2026-10-12 加權）
s2 = re.sub(r"(server web-a \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 30", s)
s2 = re.sub(r"(server web-b \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 70", s2)
open(p, "w").write(s2)                               # 就地覆寫（同 inode）
print([l.strip() for l in s2.splitlines() if l.strip().startswith("server ")])
PY

# 宿主沒有 python3 時：用一次性容器改同一顆 inode（-v 綁的是宿主檔案，容器寫入＝宿主就地寫入）
# docker run --rm -i -v /opt/5151-shadow/haproxy:/cfg python:3-alpine python - <<'PY'
# p = "/cfg/haproxy.cfg"; s = open(p).read(); open(p, "w").write(s.replace(...)); print("ok")
# PY

# (2) 語法：容器內路徑（exit 0 ＝有效；2.9 通常會印 "Configuration file is valid"，以 exit code 為準）
docker exec 5151-haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg

# (3) 零中斷 reload，然後看日誌
docker exec 5151-haproxy kill -s USR2 1 && sleep 1
docker logs 5151-haproxy --tail 20            # 應看到 "New worker forked"／"Loading success"
```

### 2.2 syn-nas（`5151-haproxy-B`）

```bash
export PATH=/usr/local/bin:$PATH              # Synology 的 docker 不在非登入 shell 的 PATH
python3 - <<'PY'
import re, shutil, time
p = "/var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg"
shutil.copy2(p, f"{p}.bak-{time.strftime('%Y%m%d%H%M%S')}")
s = open(p).read()
s2 = re.sub(r"(server web-a \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 30", s)
s2 = re.sub(r"(server web-b \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 70", s2)
open(p, "w").write(s2)
print([l.strip() for l in s2.splitlines() if l.strip().startswith("server ")])
PY

docker exec 5151-haproxy-B haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && \
docker exec 5151-haproxy-B kill -s USR2 1
docker logs 5151-haproxy-B --tail 20
```

### 2.3 只有「加／改埠映射」才需要重建容器（例：`127.0.0.1:25154:8404` 的 stats）

```bash
# 會短暫中斷 25433/25434/25153 數秒；改 cfg 本身不要用這招
cd /opt/5151-shadow/haproxy && docker compose up -d --force-recreate      # casa
cd ~/5151-shadow/haproxy    && docker compose up -d --force-recreate      # syn
```

> `docker logs <c> --tail 20` 若出現設定錯誤（`unknown keyword`／`unable to find`…），**立刻執行 §3 回滾**。

## 3. 回滾

```bash
# (a) 用備份整份回退（cp 是就地覆寫，不是換 inode）＋重新驗證＋reload
# casa：ls -t /opt/5151-shadow/haproxy/haproxy.cfg.bak-* 挑一份
cat /opt/5151-shadow/haproxy/haproxy.cfg.bak-<TS> > /opt/5151-shadow/haproxy/haproxy.cfg
docker exec 5151-haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
docker exec 5151-haproxy kill -s USR2 1

# syn
cat /var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg.bak-<TS> \
  > /var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg
docker exec 5151-haproxy-B haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && \
docker exec 5151-haproxy-B kill -s USR2 1

# (b) 只回退「加權」這一項（等價於回 roundrobin：weight 拿掉＝預設 1／1），兩台都要做：
python3 - <<'PY'
import re
for p in ("/opt/5151-shadow/haproxy/haproxy.cfg",            # casa
          "/var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg"):  # syn
    s = open(p).read()
    s2 = re.sub(r"(server web-[ab] \S+ check inter 3s fall 3 rise 2) weight \d+", r"\1", s)
    open(p, "w").write(s2)
    print(p, [l.strip() for l in s2.splitlines() if l.strip().startswith("server web-")])
PY
# 之後各自 haproxy -c ＋ kill -s USR2 1（同 §2）
```

回滾後立刻做 §4 的驗證（重點：兩台仍 UP、0 個 5xx、weight 回到 1／1）。

> ⚠️ **回滾時不要刪 `stick-table`／`stick on`**（Owner 2026-10-10 核准的訪客黏滯），
> 也不要把 `option redispatch`／`retry-on` 一起拿掉——那兩條是 2026-09-23 演練的成果。
> 也**不要**把 `backend pg_primary` 的 `balance first`／`agent-check` 拿掉（角色判定會失效），
> 更不要把 `backup` 加回 `pg-b`。

## 4. 驗證（套用與回滾都要跑同一套）

```bash
# (1) 語法（兩台都用**容器內路徑**；exit 0 ＝有效；2.9 通常會印 "Configuration file is valid"，
#     以 exit code 為準）
docker exec 5151-haproxy   haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
docker exec 5151-haproxy-B haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg

# (2) 唯讀 stats（宿主只綁 127.0.0.1:25154）：看兩台的 weight／status／平均耗時
#     輸出是 CSV，長相：表頭 `# pxname,svname,…`，之後 proxy 列 `web_nodes,FRONTEND,…`、
#     server 列 `,web-a,…`（第一欄空、第二欄才是 server 名）。先依表頭找欄號再解析。
echo "show stat" | nc -q1 127.0.0.1 25154 | awk -F, '
  NR==1 { for (i=1;i<=NF;i++) if ($i=="weight"||$i=="status"||$i=="rtime"||$i=="svname") h[i]=$i; next }
  ($1=="web_nodes" && $2!="FRONTEND") || $1=="" {
    printf "svname=%s status=%s weight=%s rtime=%s\n", $2, $18, $19, $62 }'
# 另外確認寫入路由：pg_primary/pg-a=UP、pg_primary/pg-b=DOWN(agent)、pg_standby_first/pg-b=UP(bck=1)

# (3) 端到端連續打（0 個 5xx；兩台都還是 UP）
for i in $(seq 1 20); do printf "%s " "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:25153/api/health)"; done; echo
for i in $(seq 1 10); do printf "%s " "$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:25153/api/listings?limit=20')"; done; echo
# 期望：全部 200（health 20/20、listings 10/10），**0 個 5xx**；有任何 503 就回滾

# (4) 端對端中位數要往 3.9s 靠（公網入口會多走 CF，容器基線見 docs/runbooks/web-latency-measurement.md）
for i in $(seq 1 15); do curl -s -o /dev/null -w '%{time_total}\n' 'http://127.0.0.1:25153/api/listings?limit=20'; done | sort -n | awk '{a[NR]=$1} END {print "p50="a[int(NR/2)+1]"s n="NR}'
```

- 判讀重點：`weight` 應為 `30`／`70`（回滾後為 `1`／`1`，HAProxy 預設值）、兩台 `status=UP`；
  公網 p50 不會立刻變 3.9s——**黏滯 30 分鐘內的回訪者仍回到原本那台**（見 cfg 內註解 (b)），
  要看的是「新黏滯有沒有往 web-B 偏」，以及漸進期後的中位數。
- 若 p50 沒改善但 weight 正確、兩台都 UP，那不是失敗，是漸進期；隔 30 分鐘後再量一次。

## 5. 離線守護（CI；不碰正式機）

`.github/workflows/test.yml` 的 `Run Tests` job 有兩層守護：

1. **真語法檢查**（2026-10-12 新增，步驟 `Validate HAProxy config`）——用官方映像離線跑：

   ```bash
   docker run --rm -v "$PWD/deploy/shadow-ha/haproxy:/cfg:ro" \
     haproxy:2.9-alpine haproxy -c -f /cfg/haproxy.cfg
   ```

   任何 `unknown keyword`／語法錯誤都會讓 PR 紅。本步驟的紅→綠證據：把某行打成
   `agent-fall`（2.9.x 會報 `unknown keyword 'agent-fall'`）跑一次，再改回。
2. **靜態檢查** `test/haproxy-web-nodes-weight.test.js`（`npm test` 會跑）：

   - `web_nodes` 必須正好兩條 `server`、**每條都有非 0 的 `weight`**，且 `web-b` 的 weight 必須大於 `web-a`；
   - `option redispatch`／`retry-on`／`httpchk`／`stick-table`／`stick on` 不得被覆蓋；
   - 檔內不得殘留 `${...}`（本檔已是實體 IP，會殘留就代表有人把 template 版的檔案放回來）；
     `pg-a`／`pg-b` 不得出現 `weight`；
   - 最後一個 test 用突變（拿掉 weight／50-50／歸零／刪 server／對調）證明這個檢查**真的會紅**。

   改壞 50/50 的驗證方式：把兩條 server 行的 weight 拿掉後跑
   `node --test test/haproxy-web-nodes-weight.test.js`，第一個 test 會以
   `no explicit "weight <n>"` 失敗。
