# Evidence: clipboard patch 改為「container 啟動時先執行」— 2026-09-22

接續 `EVIDENCE-20260922.md`（同一根因、同一 patch）。本檔針對「消除 race window」的架構改善：
把自我修復從 `~/.bashrc`（要等使用者開 Terminal）改成**容器啟動時、code-server 之前**。

## 0. 為什麼不用改 image / 不用改 entrypoint

code-server 官方 image 的 `/usr/bin/entrypoint.sh`（**未修改**）本來就有啟動前 hook：

```sh
if [ -d "${ENTRYPOINTD}" ]; then
  find "${ENTRYPOINTD}" -type f -executable -print -exec {} \;
fi
exec dumb-init /usr/bin/code-server "$@"
```

`ENTRYPOINTD` 預設是 image 內的 `/entrypoint.d`（`docker inspect`：`ENTRYPOINT=["/usr/bin/entrypoint.sh","--bind-addr","0.0.0.0:8080","."]`、`USER=1001:1001`、
`RESTART=unless-stopped`、image `codercom/code-server:latest`）。
→ 只要把 `ENTRYPOINTD` 指到**持久化掛載內**的目錄，並在裡面放可執行的 prestart 腳本即可。
**不動 entrypoint、不動 command、不動 volumes、不動 image、不動 network。**

## 1. 變更（host compose）

```text
NAS 路徑 : ~/code-server/docker-compose.yml
備份     : ~/code-server/docker-compose.yml.bak-clipboard-prestart-20260922-214646
before   : md5 6b47a2ed88c2944901574272e14f073b  (8808 bytes)
after    : md5 9a2257cf9e96ef2fb8671cbd056bca36  (9673 bytes)
diff     :
  +      # 2026-09-22：code-server 官方 image entrypoint 會在啟動 code-server 之前執行 $ENTRYPOINTD …
  +      ENTRYPOINTD: /home/coder/.local/share/code-server/entrypoint.d
驗證     : cd ~/code-server && docker compose -f docker-compose.yml.new config -q   → rc=0（真正 compose 引擎驗證）
         : 套用後 docker compose config -q                                    → rc=0
         : 容器未被重建（docker ps: Up 55 minutes 不變）
```

容器內新增（**持久化掛載** `./data:/home/coder`，重建容器不會掉）：

```text
~/.local/share/code-server/entrypoint.d/50-clipboard-failopen.sh   (755, 2249 bytes)
~/.local/share/code-server/tools/clipboard-failopen.sh             (patcher, 不變)
```

`~/.bashrc`：移除執行 patch 的那 3 行 → 改成註解說明 + 一行「備援用」註解版（**沒有任何 active 行**）。

## 2. 模擬「container recreate → 不開 Terminal → 瀏覽器 served bundle 已是 fail-open」

```text
step A  還原成 image 原版 bundle（＝剛重建完的狀態）
        md5 957c461dfd2e67bd6ff90a31ef1a718c
        同時間真實 server（:8080）served bytes: clipboard-fail-open=0, 'Retry' toast 標籤=1
        → 這就是 race window 的狀態（未修）

step B  跑真正的啟動路徑（image entrypoint + ENTRYPOINTD，clean env、isolated port/state）：
        env -i HOME=/home/coder PATH=… TERM=xterm \
          ENTRYPOINTD=/home/coder/.local/share/code-server/entrypoint.d \
          /usr/bin/entrypoint.sh --bind-addr 127.0.0.1:9999 --auth none \
          --user-data-dir /tmp/sim-cs-data --extensions-dir /tmp/sim-cs-ext /tmp/sim-ws

        hook log :
          2026-09-22 13:49:19 prestart[entrypointd]: container start (before code-server)
          2026-09-22 13:49:19 rc=0 PATCHED workbench.js (334 chars replaced)
          2026-09-22 13:49:19 rc=0 PATCHED workbench.web.main.internal.js (334 chars replaced)
          2026-09-22 13:49:19 prestart[entrypointd]: patcher rc=0 -> patched or already patched
        code-server :
          [2026-09-22T13:49:20.317Z] info  code-server 4.138.0 59c988c7…
          [2026-09-22T13:49:20.333Z] info  HTTP server listening on http://127.0.0.1:9999/

        ↑ patch 完成（13:49:19）比 code-server 開始服務（13:49:20）早 ~1 秒；全程沒有開任何 Terminal。

step C  直接抓「瀏覽器會拿到的那一份」（該實例的第一個請求）：
        curl http://127.0.0.1:9999/…/workbench/workbench.js
          http=200 bytes=19228013
          clipboard-fail-open marker        = 1
          fail-open log line                = 1
          old Retry toast label d(20494,null) = 0
          md5 = 00fa0a1ece0bef6317d4bb7778181395  == 磁碟上已補檔案的 md5
        → 新容器「還沒有人開 Terminal」時，瀏覽器拿到的就已經是 fail-open 版本。

step D  收尾：kill 模擬實例、刪 /tmp 模擬資料；真實容器未受影響
        (PID1 dumb-init /usr/bin/code-server 持續 running，/login 200)
```

## 3. Fail-safe（pattern 不符 / 補丁腳本不見）

```text
Test 3-1 pattern 不符（把 marker 換成 d(99999,null) 模擬未來 VS Code 版本，透過真正的啟動 hook）：
  hook exit=0                                  ← 一定不擋 code-server 啟動
  file untouched by patcher : YES（md5 與 staged 檔完全相同）
  no stamp written          : no stamp -> will retry（下次啟動再試）
  log：
    2026-09-22 13:50:09 rc=1 NO-MARKER /usr/lib/…/workbench.js
    2026-09-22 13:50:09 prestart[entrypointd]: WARNING patcher rc=1 -> pattern not matched / skipped;
                                                  FILE LEFT UNTOUCHED, code-server starts normally
  （另有實測：`find -exec` 對回傳非 0 的 hook 仍回 0，所以連 find 層也不會中斷；
    我們的 hook 另外保證 exit 0，雙重保險。）

Test 3-2 補丁腳本不存在（暫時 mv 走）：
  hook exit=0
  log：2026-09-22 13:50:00 prestart[entrypointd]: WARNING patcher not found at …（nothing applied）
  之後已還原腳本。
```

## 4. `.bashrc` 依賴移除驗證

```text
還原 image 原版 → 連開 3 個 shell（bash -ic / bash -ic / bash -lc）：
  md5 after 3 shells = 957c461d…（UNCHANGED）
  → .bashrc 已經不再 patch（PASS）
接著只跑 container-start hook：
  md5 after hook = 00fa0a1ece0bef6317d4bb7778181395（PATCHED）
shell 啟動成本：interactive 5 ms / non-interactive 4 ms（不再有 per-shell patch 工作）
~/.bashrc 內 active 的 clipboard 行數 = 0（只剩註解 + 備援註解行）
```

## 5. 回歸確認（沒有破壞既有服務）

```text
真實 code-server      : PID1 持續 running（未重啟、未重建）；/login 200
真實 served bundle    : 00fa0a1ece0bef6317d4bb7778181395（fail-open）
Cloudflare Tunnel     : https://cocodeco.reversalplay.me → 302 Cloudflare Access（不變）
SSH                   : NAS 114.34.73.76:58722 TCP connect OK（只讀探測，未改任何設定）
Cline / extensions    : saoudrizwan.claude-dev-4.1.19 + kroperuk.vscode-github-actions（不變）
volumes / image       : 未動（沒有 down、沒有 -v、沒有 pull）
container start 生效點 : 下一次 `docker compose up -d`（compose 變更需重建才會套用到 entrypoint env）；
                        在那之前的 `docker restart` 不會掉 patch（patch 在容器 writable layer，重啟保留）
```
