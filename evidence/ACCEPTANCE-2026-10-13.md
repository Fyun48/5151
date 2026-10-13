# 5151 同屋源折疊（PR #728）可追溯驗收 dossier｜2026-10-13
分支 `fold-role-component`｜HEAD `6924e0e`｜比較基準 `60cbd58`（master 侧 `14438e4`）
本檔目的：把每一條「我宣稱已達標」的結論，配上**可重跑指令＋原始輸出＋證據檔指紋**。帳本（本地 ledger）claim 172–177 全部 VERIFIED；帳本只證「我做過這個宣稱與當時的輸出」，**內文仍需你自己跑指令覆核**。
憑證一律只寫檔名與鍵名（`~/.secrets/postgres/5151-live-repro.env` 的 `PG_SNAPSHOT_REPRO2_URL`、`~/.secrets/apps/5151-prod-casaos.env` 的 `PG_URL`）。

## 0 兩顆量測基準（不准混用）
| 基準 | 位置 | 狀態 | 用途 |
|---|---|---|---|
| `repro2` | NAS syn-nas 容器 `prb-repro-pg`，`192.168.0.220:15434/repro2` | **保留 15 列過時 `fold_component_root`**，不准回填／不准覆寫 | 改前／改後前後對照（原樣基準） |
| `repro3` | 新容器 `prb-repro3-pg`，`192.168.0.220:15435/repro` | repro2 的 `pg_dump` 複本＋backfill ⇒ **drift=0** | 零容差三门的驗收基準 |
- 重建：`bash /home/cline/lab/5151-fold-parity-20261012/repro3-gen.sh`（`docker run`，`--network prb-repro-net -p 15435:5432`）；複核：`…/repro3-verify.sh`。已登記 `~/INFRA-INVENTORY.md`。
- repro3 指紋：`count=184754`｜`md5(string_agg(post_id||'|'||coalesce(fold_component_root::text,'-') order by post_id))=6f1ad553b76820002721cf9b842e0c4d`｜`pg_total_relation_size('listings')=274292736`｜`source=''`=0 列
- 白名單注意：DB 名必須是 `repro／repro2／tracker_test／crawl_sandbox` 之一（`assertPgTargetAllowed` fail-closed），故這顆叫 `repro`。

## 1 新鮮度（drift）
```
cd /tmp/5151-fold-078ed6c3 && set -a && . ~/.secrets/postgres/5151-live-repro.env && set +a \
 && DATA_DIR=/tmp/tmp.VhzM7rj4CP PG_URL=<PG_SNAPSHOT_REPRO2_URL 改 port=15435、path=/repro> \
   node v3/scripts/fold-root-drift-check.mjs    # 不加 --stamp，純唯讀
```
- repro3 實際輸出：`{"listings":184754,"groupMembers":91280,"mismatch":0,"ok":true,"stamped":false}` rc=0｜components=27951｜nonNullStored=97171
- repro2 實際輸出：`mismatch=15, ok=false` rc=1（同腳本同日兩度量得，ids 起於 21841020 21876102 21959307 22033898 22059465 22139928 22159871 22160355…）
- 證據檔指紋：`drift-after.json` 84665376efa5a7e1｜`drift-repro2.json` 213c7800fca59db2｜規劃層自跑 log `/tmp/drift-repro3-verify.log`（ledger claim 175）

## 2 一致性（零容差三门，都在 drift=0 基準上）
```
bash /home/cline/lab/5151-fold-parity-20261012/run-gates.sh repro3 15435 repro
```
| 門 | 指令 | 結果 | 證據檔（sha256 前 16） |
|---|---|---|---|
| 端點級 35 combo | `node v3/scripts/fold-endpoint-parity.mjs` | `total:35, allOk:true, failed:[]` rc=0（625s） | `gates-repro3/parity.log` fe3b3786a182b556 |
| 逐列對稱差 | `node v3/scripts/fold-endpoint-symmetric-diff.mjs` | 35 行逐 combo `onlyNode:[] onlySql:[]`；`onlyNodeTotal=0, onlySqlTotal=0` rc=0（960s） | `gates-repro3/symdiff.log` 13f721e86494bf9e |
| 分頁 | `node v3/scripts/fold-endpoint-pagination.mjs` | `allOk:true, total:6`，15 筆檢查 `dup=0 missing=0 extra=0`（746s） | `gates-repro3/pagination.log` 9d86c2cf3ddcc5b2 |
- **髒／乾淨對照（自己重算，不是採信轉述）**：兩庫 `parity.log` 逐 combo 比 `nodeTotal` → **17/35 個 combo 的顯示筆數不同**，差值全為正（髒庫多列），合計 94 列、最大單 combo 差 9（例 `baseline` 88,938→88,930；`excludeLowFloors=false` 100,580→100,571）。同庫內 `nodeTotal≠sqlTotal` 的 combo **兩邊都 0**。
- 逐列歸因：髒庫有 14/15 髒列以 `root=NULL ⇒ 單節點群` 之姿自己當代表被列出；乾淨庫只剩 6 列贏得群內比較。 ⇒ **兩條路徑在髒資料上會「一致地錯」**，所以「parity 綠」不等於「資料正確」（`L-0873`）。

## 3 語意等價（比較式各層逐位對齊）
- **比較式是權威、零改動**：`git diff 60cbd58..HEAD --numstat -- v3/src/match.js` → 空；`git diff a4cf0ee..HEAD --numstat -- v3/src/match.js` → 空。
- 軸一（tie-break 的 `source` 預設）：`listingSearchSql.js` ranked 第 5 鍵 = `COALESCE(NULLIF(e.source,''),'591') || ':' || COALESCE(NULLIF(e.source_id,''),NULLIF(e.url,''),NULLIF(e.post_id,0)::text,'') || ':' || COALESCE(e.post_id,0)::text`，對應 `match.js:447-451`。
- 軸二（資格層 `source=''`）：只改 **SQL 側** `elig` → `COALESCE(NULLIF(c.source,''),'591') = ANY(?)`（含 `<> 'houseprice'` 同段）。**方向理由**：改 Node 會動到正式站在跑的路徑；且 SQL 排除該列會讓它被判 `affiliate` 而**從公開列表消失**——把房子藏起來比多列一筆更糟。
- 零影響證明（逐 combo 比對）：
```
python3 - 逐筆比 results/gates-repro3/parity.log（軸一改前） vs evidence/round8/parity-r8.log（改後）
```
→ `combo 數 35/35`、**totalMatched 差異 0 筆**、同庫 `nodeTotal≠sqlTotal` 0 筆；加上 `repro3`／`repro2`／**正式庫**三者 `source` 為 `''` 或 NULL 均 **0 列**（正式庫 `total=194564|src_null=0|src_empty=0`，纯唯讀 SELECT）⇒ 對真實資料零影響。
- 軸三（collation，本輪量化）：`node v3/scripts/fold-tiebreak-collation-probe.mjs`（只讀）
  → `multi_member_groups=27638／rows=95322`；走到 `last_seen_at` 字串層 `4421 群／11100 列`；走到 tie-break key 字串層 **0 群／0 列**（SQL 交叉驗算 `key_layer_groups=0`）；`winnerDiffs` 四項（`pgDefault_vs_pgC`、`nodeLocaleCompare_vs_pgDefault`、`_vs_pgC`、`_vs_nodeCodePoint`）**皆 0**；`divergencesTotal=0`；`last_seen_at` **184,754 列全部 24 octets 定寬 ISO8601**（`notIsoFixedWidth=0`、`groupsWithMixedWidths=0`）⇒ 字串序＝時間序。非 ASCII key 全庫僅 1 列（`post_id=2414061000`，`fold_component_root IS NULL`＝孤列不進群內排名）。證據檔 `round8/collation-probe.log` 3ff29eef436f2a41 
- fixtures：`node v3/scripts/fold-shape-fixtures.mjs` → `allOk:true total:53 residualRows:0` rc=0（第 7 輪是 `residualRows:1`，代表殘餘軸被**真的修掉**而非標記）；⑨a `node=9100000031=sql`、⑨b `node=9100000021=sql`；`grep -c enabledSourcesWithEmpty = 0`（「把 `''` 塞進啟用清單」的 trick 已移除）。
- **反向對照（防空斷言）**：把 `listingSearchSql.js` 還原成改前版本 → `allOk:false`、⑨a 選 XN／⑨b 選 TN；CI 種子同理（修前 `rc=1`、修後 `rc=0`）。檔：`round8/negative-control-old-sql.log` 80c30f1d9499d67c ｜`round8/fold-ci-parity-negative-control.log` 78024d0ab2e305ee 

- 上面三個 `round8/*.log` 的 sha 是對 **repo 內 blob** 算的，审査者不依赖我这台机也能重算：`git cat-file blob f45280d:evidence/round8/collation-probe.log | sha256sum | cut -c1-16`（另兩檔同法）；其餘 `gates-repro3/*.log` 的 sha 來自本機 `~/lab/5151-fold-parity-20261012/results/`，路徑已寫在行內。
## 4 閘門與交易隔離（fail-closed）
- `publicListingSearchAsync.js:28`：`if (process.env.PUBLIC_LISTINGS_SQL_FIRST !== "1") return null` ⇒ **預設 off 未改**（本包不曾把它打開，正式庫也還沒有 `fold_component_root` 欄：實測回 `column "fold_component_root" does not exist`）。
- 開閘不就緒 ⇒ 結構化 `[fold-gate]` 告警＋HTTP 503 `SEARCH_UNAVAILABLE`，**絕不退回 Node 路徑**（Owner 2026-10-12 接受此取捨）。
- 戳記綁資料版本：`fold-root-drift-check.mjs --stamp` 寫 `dataVersion{rows,maxPostId,rootsMd5}`；線上每請求比 `rows/maxPostId`（成功判定 60s TTL、失敗永久記憶）；缺 `dataVersion` 的舊式戳記 ⇒ 拒開閘（`foldComponentRoot.js:257/:306/:333/:346`）。
- live 實測：注入 `maxPostId+1` ⇒ `gate_ok=false reason=fold_root_drift_stamp_stale rc=1`；重跑 `--stamp` 後 `ok=true`。
- 我親跑：`node --test v3/test/fold-sql-gate.test.js v3/test/fold-gate-transaction-live-pg.test.js` → `tests 12／pass 12／fail 0／skipped 0`（含「`BEGIN`→缺欄探測→同交易 `INSERT` 不得 aborted」）。
- **尚未實裝（不掩飾）**：①原地 UPDATE 只改 root、不改 `rows/maxPostId` ⇒ 線上看不見（需刷新鏈原子 bump 世代鍵，升級層 2026-10-13 已裁為**開閘硬條件**）②`rootsMd5` 未進線上 ③無排程（Owner 裁先人工）④`fold_refresh_kind=1` 隨請求 `now` 平移只寫進文件、無探針。

## 5 CI 與全量測試
- `gh api repos/Fyun48/5151/actions/runs/38270751435/jobs`：`Run Tests 9/9 steps success`；`Run Tests (PostgreSQL integration) 15/15 steps success`，含 `Same-house fold parity (synthetic seeds, gating)=success`、`PR-B complete page benchmark=success`、`Columns A/B=success`。
- 全量 `npm test`：交件那輪 `results/npm-test-r8-clean.log`（1,044,087B，89b47394085bd05f）→ `tests 4114／pass 3992／fail 0／skipped 122`、`not ok=0`。
- 規劃層另跑一輪得 `fail 4／rc=1`（我在全測期間自己併發跑了探針與單檔重跑，load 被我推到 8.87）；四條逐條**同 commit 低負載單獨重跑**：`public-sql-first-parity 6/6`、`mrt-walk-live 3/3`、`list-perf-bench 2/2`（`pairedP50` 實測 `-0.05ms`）；該檔本包 diff 為空。**判定程序**：單檔低負載重跑＋CI job 級兩者都綠才可歸因環境（`L-0899`）。

## 6 效能（**照實報：未達標**）
repro3、`member-list-benchmark.mjs`、`MEMBER_UID=1`、`RUNS=5`、單一進程串行；量測 load `3.46/5.20/9.33`。
| 情境 | list p50/p95 (ms) | stats p50/p95 (ms) | cold 總和 (ms) |
|---|---|---|---|
| default | 1147／1324 | 1517／**1726** | **4473** |
| 中山區 | 918／981 | 1742／**1876** | **2956** |
| rent 3000-8000 | 475／502 | 1229／1368 | 1777 |
| q=新莊 | 228／246 | 1783／1823 | 2053 |
| multi | 54／58 | 1625／1651 | **1914** |
- 逐門檻：`list ≤2.0s` **通過**；`stats ≤1.0s` **未達標**（兩側皆未達標，見上）；cold 總和 `≤3.0s` **未達標**（最差 4,473ms；交替三輪中 `cold>3.0s` 的情境數 before／after 皆在 1–2 個，同樣落在噪聲內）。門檻來源 D-0036。
- **既存債已證明（2026-10-13 補量，升級層建議①／③要求）**：同機、同協定（`RUNS=5`、`MEMBER_UID=1`、`repro3`、同一份 `node_modules` realpath `/workspace/repos/5151/node_modules`）、**交替串行三輪** `before(60cbd58)`↔`after(f45280d)`、每段間隔 30s、全程不重疊：
  - `stats p95` 的 Δ（after−before）**中位 +6ms、平均 −19ms**，15 格中 8 慢 7 快 ⇒ **符號不一致 ⇒ 本包對 stats 無可測影響**；Δ 範圍 `−1079 ~ +949ms` 就是這台共用機的噪聲頻帶（同期有四支不屬於我的 dev server 在跑）。
  - **兩側都爆門檻**：`before` 最差 `2467ms`、`after` 最差 `2806ms`（門檻 1.0s）⇒ 「`stats` 未達標屬既存債」**從宣稱變成實測結論**。`list p95` 逐組 Δ 中位 `+32/+79/−70ms` ⇒ 同樣是噪聲。
  - 我一度用**單輪**對照得出「+379／+530／+774ms 變慢、不能用雜音帶過」的結論，那個方法本身是錯的：單輪 p95（5 樣本取最大）在共用機上雜音敏感。**教訓＝前後對照必須交替重複、以符號一致性判讀**（已沉澱 `L-0922`）。
  - 复算指令（只讀 JSON，不碰 DB）：`cd /home/cline/lab/5151-fold-parity-20261012 && python3 tools/perf-pair-report.py results/bench-pair/alt`；原始六份 `results/bench-pair/alt/r{1,2,3}-{before,after}.json`，各段起始 load 記在 `alt/meta.txt`。

## 7 我（規劃層）覆核過的與我沒覆核過的
- 我親手跑過並逐項对上：drift（兩庫）、三门 log 逐行解析、17/35 重算、fixtures 53、collation 探針全部數字、閘門兩支測試 12/12、CI job 級、PR 狀態、正式庫 `source` 計數、`match.js` diff 為空、worktree porcelain。
- 我**沒有**覆核：分頁在 repro2 的重跑（沿用第 7 輪）；`fold-endpoint-bench.mjs` 的 off 模式全量耗時（自報 baseline p50 14,400ms）；SQLite 路徑本輪未另行驗（**2026-10-13 R12 已補核，見 §7.1①**）；效能 before／after 對照未做。

### 7.1 2026-10-13 R12 補核（交辦：§7 最後兩條證據缺口；基準 `origin/master=0d2e196`）
- **① SQLite 路徑＝已覆核；正確結論不是「同形 SQL 在 SQLite 也跑」，而是「SQLite 不跑折疊 SQL」**。以 worktree ＋ throwaway `node:sqlite` 檔 ＋ `prb-genkey-pg`(15447) 專用 schema `foldprobe_r12`（`search_path` 隔離，**不碰 `listings` 真表**）實測：
  - 折疊查詢**逐字**在 SQLite 跑不動：`unrecognized token: ":"`（PG-only：`ANY(?::text[])`／`?::bigint`；`IFNULL`／`MATERIALIZED`／`IS DISTINCT FROM`／window function 本體 SQLite 3.51.3 都吃）。僅機械去方言（`ANY(?::text[])`→`IN` 字面值、`?::bigint`→`?`、`::text`→`CAST(… AS TEXT)`）即可跑：`rowCount=9`、欄名 `[post_id, updated_at, rent, total_monthly_cost, total_count]`。
  - **SQLite driver 設計上不執行折疊 SQL**：`publicListingSearchAsync.js:72` 的 `driver !== "postgres"` 在折疊之前就 return；`db.js` 只 import `buildListingSearchSql`／`buildPublicListingSearchSql`；`fold_component_root` 只出現在 PG migration `v3/migrations/007_listings_fold_component_root.sql`，`writePath.js ensureFoldColumnsSqlite()` 只加四個 fold 數值欄。SQLite 端分組走 `buildSameHouseComponents` union-find、選主走 `match.js sortGroupListings`（`db.js:3820`）。
  - **代表選擇三方逐筆相等、分歧 0**：8 群（租金軸／更新時間軸／`source=''` tie-break 軸／單成員／`offline_confirmed=1` 排除／houseprice 未就緒排除／租金 NULL／`last_seen_at` 字串軸）在 PG(SQL `foldRoleCte` 原樣) ＝ SQLite(同段 SQL 去方言) ＝ Node(`sortGroupListings`) ⇒ `onlyA/onlyB` 皆空。
  - **閘門四態在 SQLite 與 PG 不一致，但該路徑不可達**：SQLite 四態一律 `fold_component_root_missing`（`pg_attribute` 不存在 ⇒ `foldRootRefreshReady()` 的 catch 回 false）；PG 四態為 `…_stamp_missing`／`…_gen_missing`／`…_gen_stale`／`ok:true`。兩邊都 fail-closed，且 SQLite 永不會走到 `foldSqlGateReady()`（driver 分派在前）⇒ **非缺陷**；列為觀察項（未來若新增 SQLite 折疊路徑，這裡的 reason 會誤導）。
  - 重跑：`PG_URL=<15447/repro> node /home/cline/lab/5151-verify-r12/a-fold-sqlite-vs-pg.mjs`（原始輸出 `a-out.json`）。
- **② `fold_refresh_kind=1` 的 `now` 平移探針＝已覆核**。新增唯讀探針 `v3/scripts/fold-now-shift-probe.mjs`（形狀仿 `fold-tiebreak-collation-probe.mjs`；全程只 SELECT，自帶 `writesSql` 自我掃描）。
  - repro3（15435／`repro`）實測：命中群 **18,940**（成員 ≥2、含 kind=1、且有成員更新時間落在 `now±6h`）；Δ=**13,840,968ms**（可翻轉配對 10 群，10／10 的配對先後真的被翻轉）。
  - 三時點 `now−Δ`／`now`／`now+Δ` 兩側選同一個 `post_id`：**100.0000%（18,940/18,940）×3**，分歧樣本 **0**；代表列隨 `now` 換人 **Node 0 群／SQL 0 群**。
  - 完整性：fold 欄 vs `listingRefreshParts`／`comparableRent` 不符 **0 列**（掃 74,428 列）；`writesSql=0`。
  - **正對照**（證明偵測器不是「量不到而回 0」）：`prb-genkey-pg` schema `foldnowctl_r12` 造兩成員群（kind=1 vs 絕對、臨界點距 `now` 10 分）⇒ 代表列由 A 換成 R，SQL 與 Node 都偵測到且三點一致（`all_agree:true`）。空結果輸出路徑亦實測（`--window-ms 1` ⇒ 顯式「沒有命中群…不是通過」）。
  - 結論：把規格結尾「只有 kind=1 與絕對時間列混用時才會變」量化為——在 repro3 這 18,940 個命中群上、±3h50m 的 `now` 平移下，代表列 **0 群換人**，兩側 **100% 一致**。
  - 重跑：`set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a; PG_URL=<15435/repro> node v3/scripts/fold-now-shift-probe.mjs`
- 本節未動 `v3/src/match.js`（一行未改）、未動 `v1/v2`、未開閘、未加排程、未寫 repro2／repro3／正式庫（全程 SELECT）。

## 8 升級層建議③的成品（**可裝但先不裝**，2026-10-13 09:5x）
- 唯讀探針：`~/lab/5151-fold-parity-20261012/tools/drift-probe.sh`（700）。`mismatch=0` 只記一行；`mismatch>0` 落告警檔並（未加 `--dry-alert` 時）用 `ask-owner` 發一封**要你准回填**的詢問。**不自動 backfill、不 `--stamp`、不寫正式庫。**
- 兩邊試跑：`repro3 → rc=0 mismatch=0`（無告警）；`repro2 → rc=1 mismatch=15`（告警檔 `~/.local/state/fold-drift/ALERT-20261013-0952.txt`，試跑加 `--dry-alert` 未送出）。狀態目錄與歷史檔 grep 連線字串樣式（scheme 帶帳號密碼、以及密碼欄位賦值樣式）各 0 命中。
- **裝載時機刻意往後**：正式庫目前查 `fold_component_root` 直接回 `column "fold_component_root" does not exist`，此刻進 crontab 等於每天必報錯的殭屍任務；cron 行寫在腳本註解裡，**等 007＋回填＋drift=0＋`--stamp` 完成後才裝**（那四步是你手動，`F-0001`）。
- 升級層同一句裡還有「批次後探測」＝要碰爬蟲寫入鏈的 code 改動，**不塞進本 PR**（會讓審查面從折疊擴大到寫入鏈），另開交辦。
