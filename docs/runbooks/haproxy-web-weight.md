# Runbook：HAProxy `backend web_nodes` 加權（web-a 30 ／ web-b 70）

> 適用對象：要在**正式機**上套用或回退 `deploy/shadow-ha/haproxy/haproxy.cfg` 加權的人（planner）。
> 本檔是 2026-10-12 那次量測與改動的正式程序；**程式面改動只有一個檔案**（那份 cfg），
> 這個 runbook 不含任何 `v3/src` 的修改。
> ⚠️ 本 PR **只改 repo 與文件**，不碰正式機；下面的指令一律由 planner／Owner 執行。

## 0. 先確認「要套用的檔」與「現行檔」差在哪

repo 的 `deploy/shadow-ha/haproxy/haproxy.cfg` 是權威來源，但 NAS 上的兩份現行檔（見 §1）先前有
**未被同步回 repo 的 Owner 核准設定**（2026-10-10 的訪客黏滯 `stick-table`／`stick on`）。
本 PR 已把它逐字同步回 repo，因此現在：

- **repo 檔 ＝ 現行檔 ＋ 這次的 `weight 30`／`weight 70`**（其餘逐字相同）。
- 套用前**務必先 diff 一次**，確認除了 `weight` 沒有別的差異（若多了別的差異，先停下來問，不要直接覆蓋）：

```bash
# 在 NAS 上（唯讀，先不看內容只看差異清單）
diff -u /opt/5151-shadow/haproxy/haproxy.cfg deploy/shadow-ha/haproxy/haproxy.cfg
```

| 現行檔位置 | 主機 | 容器 | 掛載方式 |
|---|---|---|---|
| `/opt/5151-shadow/haproxy/haproxy.cfg` | casa-nas（192.168.0.140） | `5151-haproxy` | 掛成 `…/haproxy.cfg.tmpl`，容器啟動時由 `render-and-run.sh` 展開成 `/tmp/haproxy.cfg` |
| `~/5151-shadow/haproxy/haproxy.cfg` | syn-nas（192.168.0.220） | `5151-haproxy-B` | 直接掛成 `…/haproxy.cfg`（已在機上展開過） |

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

## 2. 套用步驟（零中斷）

> **兩個前提先確認**：① §0 的 diff 只有 `weight` 的差；② 下面的「就地改寫」務必用會**改同一個 inode**
> 的方式（python `open(path,'w')`）。用 `awk … > f.new && mv f.new f` 換檔，容器仍看到舊 inode，
> 改了等於沒改（`docs/runbooks/postgres-manual-failover.md` §6 有完整踩坑記錄）。

### 2.1 casa-nas（`5151-haproxy`）

```bash
# (1) 就地改寫主機上的正本：只改這兩個 server 行（同 inode）
docker exec 5151-haproxy python3 - <<'PY'
import re, shutil, time
p = "/usr/local/etc/haproxy/haproxy.cfg.tmpl"
s = open(p).read()
shutil.copy2(p, f"{p}.bak-weight-{time.strftime('%Y%m%d%H%M%S')}")
s2 = re.sub(r"(server web-a \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 30", s)
s2 = re.sub(r"(server web-b \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 70", s2)
open(p, "w").write(s2)          # 就地覆寫，不改 inode
print("web-a:", re.search(r"server web-a.*", s2).group(0))
print("web-b:", re.search(r"server web-b.*", s2).group(0))
PY

# (2) 因為容器只掛到 .cfg.tmpl，不能在容器內用 .cfg 驗證（那是舊的、且是尚未展開的 template）：
#     用 render-and-run.sh 的同一組 sed 展開到暫存檔再驗。
docker exec 5151-haproxy sh -c '
  sed -e "s|\${CASAOS_HOST}|192.168.0.140|g" -e "s|\${SYNOLOGY_HOST}|192.168.0.220|g" \
      /usr/local/etc/haproxy/haproxy.cfg.tmpl > /tmp/haproxy.cfg.check
  haproxy -c -f /tmp/haproxy.cfg.check && echo "RENDER-CHECK OK"'

# (3) 就地改寫「正在跑的那份」（/tmp/haproxy.cfg）——重載時 haproxy 讀的是它，不是 template
docker exec 5151-haproxy python3 - <<'PY'
import re
p = "/tmp/haproxy.cfg"
s = open(p).read()
s = re.sub(r"(server web-a \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 30", s)
s = re.sub(r"(server web-b \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 70", s)
open(p, "w").write(s)
print([l.strip() for l in s.splitlines() if l.strip().startswith("server web-")])
PY

# (4) 零中斷 reload（PID 1 = haproxy master-worker，SIGUSR2=零中斷換設定）
docker exec 5151-haproxy kill -s USR2 1 && sleep 1
docker exec 5151-haproxy sh -c 'tail -5 /proc/1/fd/1 2>/dev/null || true'
```

> 若 (4) 之後 `docker logs 5151-haproxy --tail 20` 出現設定錯誤，**立刻執行 §3 回滾**；
> 真的 reload 不過時，最後手段是 `docker compose -f /opt/5151-shadow/haproxy/docker-compose.yml
> up -d --force-recreate`（容器 entrypoint 會重新 render 並啟動，用 (1) 改好的 template）——
> 這招會短暫斷 25433/25434 的 PG 連線（數秒），只在 reload 失敗時用。

### 2.2 syn-nas（`5151-haproxy-B`）

這台是**直接掛 `.cfg`**，所以只要就地改寫再接 HUP：

```bash
python3 - <<'PY'
import re, shutil, time
p = "/var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg"
s = open(p).read()
shutil.copy2(p, f"{p}.bak-weight-{time.strftime('%Y%m%d%H%M%S')}")
s = re.sub(r"(server web-a \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 30", s)
s = re.sub(r"(server web-b \S+ check inter 3s fall 3 rise 2)(?! weight)", r"\1 weight 70", s)
open(p, "w").write(s)
print([l.strip() for l in s.splitlines() if l.strip().startswith("server web-")])
PY

docker exec 5151-haproxy-B haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && \
docker exec 5151-haproxy-B kill -s USR2 1
```

## 3. 回滾（把 weight 拿掉，回到 roundrobin）

「拿掉 weight」就等於回退這次改動（其餘設定完全沒動）：

```bash
# casa-nas：主機正本 + 正在跑的那份都要改（否則下次重啟或 reload 又會生效）
docker exec 5151-haproxy python3 - <<'PY'
import re
for p in ("/usr/local/etc/haproxy/haproxy.cfg.tmpl", "/tmp/haproxy.cfg"):
    s = open(p).read()
    s2 = re.sub(r"(server web-[ab] \S+ check inter 3s fall 3 rise 2) weight \d+", r"\1", s)
    open(p, "w").write(s2)
    print(p, [l.strip() for l in s2.splitlines() if l.strip().startswith("server web-")])
PY
docker exec 5151-haproxy sh -c '
  sed -e "s|\${CASAOS_HOST}|192.168.0.140|g" -e "s|\${SYNOLOGY_HOST}|192.168.0.220|g" \
      /usr/local/etc/haproxy/haproxy.cfg.tmpl > /tmp/haproxy.cfg.check
  haproxy -c -f /tmp/haproxy.cfg.check && echo "RENDER-CHECK OK"'
docker exec 5151-haproxy kill -s USR2 1

# syn-nas
python3 - <<'PY'
import re
p = "/var/services/homes/tori/5151-shadow/haproxy/haproxy.cfg"
s = re.sub(r"(server web-[ab] \S+ check inter 3s fall 3 rise 2) weight \d+", r"\1", open(p).read())
open(p, "w").write(s)
print([l.strip() for l in s.splitlines() if l.strip().startswith("server web-")])
PY
docker exec 5151-haproxy-B haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && \
docker exec 5151-haproxy-B kill -s USR2 1
```

回滾後立刻做 §4 的驗證（重點：兩台仍 UP、0 個 5xx、weight 回到 1／1）。
回滾也別忘了把 repo 檔一起退（否則下次套用又會加回來）：`git revert <本 PR 的 merge commit>`，
或手動把那兩行改回 `server web-a … rise 2`／`server web-b … rise 2` 並開一個 PR。

> ⚠️ **回滾時不要刪 `stick-table`／`stick on`**（Owner 2026-10-10 核准的訪客黏滯），
> 也不要把 `option redispatch`／`retry-on` 一起拿掉——那兩條是 2026-09-23 演練的成果。

## 4. 驗證（套用與回滾都要跑同一套）

```bash
# (1) 語法（casa-nas 用展開後的暫存檔；syn-nas 直接驗 .cfg）——必須 "Configuration file is valid"
docker exec 5151-haproxy sh -c 'sed -e "s|\${CASAOS_HOST}|192.168.0.140|g" -e "s|\${SYNOLOGY_HOST}|192.168.0.220|g" /usr/local/etc/haproxy/haproxy.cfg.tmpl > /tmp/c && haproxy -c -f /tmp/c'

# (2) 唯讀 stats（宿主只綁 127.0.0.1:25154）：看兩台的 weight／status／平均耗時
#     輸出是 CSV，長相：表頭 `# pxname,svname,…`，之後 proxy 列 `web_nodes,FRONTEND,…`、
#     server 列 `,web-a,…`（第一欄空、第二欄才是 server 名）。先依表頭找欄號再解析。
echo "show stat" | nc -q1 127.0.0.1 25154 | awk -F, '
  NR==1 { for (i=1;i<=NF;i++) if ($i=="weight"||$i=="status"||$i=="rtime"||$i=="svname") h[i]=$i; next }
  ($1=="web_nodes" && $2!="FRONTEND") || $1=="" {
    printf "svname=%s status=%s weight=%s rtime=%s\n", $2, $18, $19, $62 }'

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

## 5. 離線守護（CI）

`test/haproxy-web-nodes-weight.test.js`（`npm test` 會跑）靜態檢查這份 cfg：

- `web_nodes` 必須正好兩條 `server`、**每條都有非 0 的 `weight`**，且 `web-b` 的 weight 必須大於 `web-a`；
- `option redispatch`／`retry-on`／`httpchk`／`stick-table`／`stick on` 不得被覆蓋；
- template 展開後不得殘留 `${...}`；`pg-a`／`pg-b` 不得出現 `weight`；
- 最後一個 test 用突變（拿掉 weight／50-50／歸零／刪 server／對調）證明這個檢查**真的會紅**。

改壞 50/50 的驗證方式：把兩條 server 行的 weight 拿掉後跑
`node --test test/haproxy-web-nodes-weight.test.js`，第一個 test 會以
`no explicit "weight <n>"` 失敗（本 PR 的紅→綠證據就是這樣產生的）。
