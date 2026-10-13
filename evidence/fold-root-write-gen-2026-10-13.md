# `foldRootWriteGen` 世代鍵：原地寫入不再逃過戳記驗證（交付證據）｜2026-10-13

分支 `fold-gen-key`｜基準 `origin/master` = `eb9d4ff`（合併後的 master；**不是** f1ee214）
本檔＝可重跑的交付證據：每一條結論都附**指令＋原始輸出（關鍵片段）＋證據檔 sha256(16)**。
語意權威：`docs/same-house-fold-spec.md` §6.9；部署順序：`docs/runbooks/5151_same_house_fold_deploy.md` §1。

## 0 這一包解掉的開閘盲點

`evidence/ACCEPTANCE-2026-10-13.md` §4「尚未實裝①」：戳記的 `dataVersion` 只綁 `rows`／`maxPostId`，
而刷新鏈對 `listings.fold_component_root` 是**原地 UPDATE**（列數與 `max(post_id)` 都不變）
⇒ 一次已接受的零差戳記在 root 被改寫後仍「有效」，請求在**過時世代**下被放行。
升級層 2026-10-13 裁為**開閘硬條件**。本包把它補上：新增 `settings.foldRootWriteGen`（text 存整數），
每一條寫入 root 的路徑在同一交易 +1，戳記記下當時的世代，開閘前檢比對它。

## 1 寫入路徑清單（`grep` 為準，不是憑印象）

```bash
grep -rn "UPDATE listings SET fold_component_root" v3/ ; grep -rn "fold_component_root[[:space:]]*=" v3/
```

| 檔案 | 位置 | 角色 | 是否 bump |
|---|---|---|---|
| `v3/src/foldComponentRoot.js` | `refreshFoldComponentRoot()`（`:593` 區） | **生產**刷新漏斗（`match.js refreshFoldColumns` 唯一呼叫） | ✅ 同一個 `exec`（＝同一個連線／交易） |
| `v3/scripts/fold-root-backfill.mjs` | 每批 UPDATE 之後（`:94` 區） | **生產**全表回填（冪等、分批、每批一個交易） | ✅ 同一個 `client`／同一個交易 |
| `v3/scripts/fold-ci-parity.mjs` | `:214` 的種子寫入之後 | CI 合成種子（拋棄式庫） | ✅ 同一個 `exec` |
| `v3/scripts/fold-shape-fixtures.mjs` | `:249` 的 fixture 寫入之後 | 5 種折疊邊形 fixture（隔離庫） | ✅ 有真的改到列才 bump |
| `v3/migrations/007_...sql` | DDL | 加欄，不寫值 | — |
| `v3/src/db.js`、`listingCandidateRow.js`、`repository/decorationData.js`、`listingSearchSql.js` | 讀取端 | 只 SELECT | — |

`INSERT INTO listings (...fold_component_root...)`／`ON CONFLICT` 的寫入路徑：**0 筆**（同一輪 grep 的結果）。

## 2 一次性棄用 DB（建立／摧毀指令都在這裡，AGENTS §六）

- 容器 `prb-genkey-pg`（NAS syn-nas，`postgres:16-alpine`，DB 名 `repro`，**port 15447**）。
- **與交辦單的差異（唯一一處，理由）**：交辦單指定 port **15436**，但實測該埠已被 syn-nas 的
  `qdsh-postgres` 佔用（`netstat -tln`：`0.0.0.0:15436 LISTEN`，容器 `qdsh-postgres` 0.0.0.0:15436->5432）
  ⇒ 改用 **15447**（實測 1543x／1544x 區間唯一未被佔用者：15432／15434／15435／15436／15444／15445 都在聽）。
  其餘照交辦：新容器、DB 名 `repro`（`assertPgTargetAllowed` 白名單）、容器名 `prb-genkey-pg`。
- 建立（冪等；腳本＝`/home/cline/lab/5151-genkey-r9/genkey-pg-gen.sh`，照抄 `repro3-gen.sh` 的模式）：

```bash
bash /home/cline/lab/5151-genkey-r9/genkey-pg-gen.sh      # FORCE=1 重建、SKIP_DUMP=1 只檢查
```
- 摧毀（**本包不刪**，交規劃層決定去留）：

```bash
ssh syn-nas "/usr/local/bin/docker rm -f prb-genkey-pg; /usr/local/bin/docker volume rm prb-genkey-data"
```
- 來源資料＝`prb-repro3-pg` 的 `repro`（drift=0 基準）`pg_dump | psql`；密碼沿用 `prb-repro-pg` 的
  `POSTGRES_PASSWORD`（**值不落地**：只在 NAS 端的 shell 變數裡傳）。`repro2`（15434）與
  `repro3`（15435）全程**只讀**（只讀來源的 `pg_dump`）。
- 連線字串一律用 `node -e 'new URL(...)'` 改 port／pathname 組（不用 sed）：

```bash
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_URL=$(NEWPORT=15447 node -e 'const u=new URL(process.env.PG_LIVE_REPRO_URL); u.port=process.env.NEWPORT; u.pathname="/repro"; process.stdout.write(u.toString())')
```
- 建立 log：`/home/cline/lab/5151-genkey-r9/genkey-pg-gen.log` → `listings=184754`、
  `fold_root_nonnull=97171`、`write_gen=<absent>`（尚未寫入過）。指紋與 repro3 逐項相同（§3）。

## 3 驗證（全部在 15447/repro 上；原始 log 在 `/home/cline/lab/5151-genkey-r9/`）

### 3.1 全量 drift ＝ 0（唯讀；證明這顆是 repro3 的忠實複本）

```bash
node v3/scripts/fold-root-drift-check.mjs
```
```json
{"listings":184754,"groupMembers":91280,"nonNullStored":97171,"components":27951,"mismatch":0,"ok":true,"stamped":false}
```
`rootsMd5`（見下）＝ `6f1ad553b76820002721cf9b842e0c4d`，與 dossier §0 的 repro3 指紋**逐字相同**。
log：`drift-readonly.log`（sha256(16) 見 §6）｜rc=0｜耗時 5.4s。

### 3.2 `--stamp` 的 payload 現在有 `writeGen`（戳記捕捉當時的世代鍵）

```bash
node v3/scripts/fold-root-drift-check.mjs --stamp
```
```json
{"listings":184754,"mismatch":0,"ok":true,"stamped":true,"writeGen":0,
 "dataVersion":{"rows":184754,"maxPostId":2699975575,"rootsMd5":"6f1ad553b76820002721cf9b842e0c4d","writeGen":0}}
```
DB 內實際落地（`docker exec prb-genkey-pg psql -U postgres -d repro`）：
`foldRootDriftStamp = {"at":"2026-10-13T03:19:41.936Z","rows":184754,"components":27951,"mismatches":0,"writeGen":0,"dataVersion":{...}}`
（此時 `settings.foldRootWriteGen` 尚不存在 ⇒ 讀值 0。）log：`drift-stamp.log`。

### 3.3 開閘前檢六項全過（含新增的 `writeGen_match`）

```bash
node v3/scripts/fold-gate-stamp-verify.mjs
```
```json
{"checks":{"column_present":true,"stamp_present":true,"stamp_mismatches_zero":true,
 "dataVersion_match":true,"writeGen_match":true,"gate_ok":true},
 "liveWriteGen":0,"key":"foldRootWriteGen","gate":{"ok":true,"reason":null,...},"ok":true}
```
log：`gate-stamp-verify.log`｜rc=0。

### 3.4 端到端：原地 UPDATE ⇒ 下一句請求被拒（**不靠快取救回**）

`/home/cline/lab/5151-genkey-r9/inplace-gen-demo.mjs`（跑在真實 184,754 列上，用**生產寫入器**）：

1. request#1：戳記剛寫好 ⇒ `ok:true`（`writeGen:0`），快取存入 `gen=0`。
2. 造髒事件（兩列互指）→ `refreshFoldComponentRoot(exec, a)`：**原地 UPDATE** root
   （`changed=2`），`rows=184754／maxPostId=2699975575` **前後完全相同**，`writeGen 0→1`。
3. request#2（**同一個行程、不 reset 快取**）：
```json
{"ok":false,"reason":"fold_root_drift_stamp_gen_stale",
 "detail":{"stampedWriteGen":0,"liveWriteGen":1,"fix":"node v3/scripts/fold-root-drift-check.mjs --stamp"}}
```
log：`inplace-gen-demo.log`（rc=0，`ok:true`）。

**關鍵對照**：寫入後 drift 仍為 **0**（資料是對的），但戳記的世代已過時 ⇒ 閘門關上：

```bash
node v3/scripts/fold-root-drift-check.mjs          # → {"mismatch":0,"ok":true,...,"stamped":false}（nonNullStored 97,171→97,173）
node v3/scripts/fold-root-drift-check.mjs --stamp  # → {"stamped":true,"writeGen":1,"dataVersion":{"writeGen":1,...}}
node v3/scripts/fold-gate-stamp-verify.mjs         # → checks 全 true、gate_ok true、liveWriteGen 1
```
log：`drift-after-inplace.log`、`drift-restamp.log`、`gate-stamp-verify-after.log`。
⇒ 「回填／刷新之後必須重跑 `--stamp`」從**文件約定**變成**線上強制**。

### 3.5 測試（新檔＋既有檔更新）

```bash
node --test v3/test/fold-root-write-gen.test.js            # 9/9 pass
node --test v3/test/fold-sql-gate.test.js                  # 13/13 pass（八種結果＋快取語意）
PG_TEST_URL=<15447/repro> node --test v3/test/fold-root-write-gen-live-pg.test.js   # 1/1 pass
```
- 單元（`v3/test/fold-root-write-gen.test.js`）：bump 遞增（**真的 `node:sqlite` :memory: 跑同一句 SQL**）、
  戳記捕捉 gen、gen 相符放行／不符拒（`..._gen_stale`）／缺 gen 拒（`..._gen_missing`）、
  **成功快取以 gen 為鍵（寫入後的下一句被拒，不等 TTL）**、失敗永久記憶不變、
  四條寫入路徑都 bump（原始碼釘住）。
- live-pg（`v3/test/fold-root-write-gen-live-pg.test.js`，`PG_TEST_URL` gate）：在**自己的 schema**
  （`search_path`）裡造 3 列，用真 `refreshFoldComponentRoot()` 原地寫入 ⇒ 下一句 503
  `..._gen_stale`；重寫戳記 ⇒ 放行；拿掉 `writeGen` ⇒ `..._gen_missing`。
  **拒寫守衛**：`PG_TEST_URL` 的庫名不在 `repro／tracker_test／crawl_sandbox` ⇒ SKIP（永不寫 repro2／正式庫）。
- **反向對照（防空斷言）**：把 `foldComponentRoot.js` 的世代鍵檢查暫時停用 ⇒
  單元 `fail 3`（gen_stale／gen_missing／快取為鍵）、live `fail 1`；
  還原後 sha256 與停用前**逐位元相同**、測試全綠。
  log：`negative-control-unit.log`、`negative-control-live.log`、`foldComponentRoot.withgen.js`（停用前副本）。

### 3.6 全套 `npm test`（單次跑完，無並行重活）

見 §7（執行後補上 rc／tests／pass／fail／skipped 與 log sha256(16)）。

## 4 快取以 gen 為鍵（自證：程式碼行號＋語句）

`v3/src/foldComponentRoot.js`：

- `:287` `let foldSqlGateCache = null;` → `:384` `foldSqlGateCache = { result, at: Date.now(), gen: liveGen };`
  （`gen` ＝ 這一次判定成立時的寫入世代鍵）
- `:378-390`（成功快取命中前先讀當前世代，鍵不同就落到完整重驗）：

```js
if (age < FOLD_SQL_GATE_OK_TTL_MS) {
  let cachedGen = null;
  try { cachedGen = await readFoldRootWriteGen(exec); } catch { cachedGen = null; }
  if (cachedGen !== null && cachedGen === foldSqlGateCache.gen) return foldSqlGateCache.result;
}
```

- `:425-445`（第 4 條判定：缺欄／不符 ⇒ 兩個新 reason）
```js
liveGen = await readFoldRootWriteGen(exec);
const hasStampedGen = stampedGenRaw != null && Number.isFinite(Number(stampedGenRaw));
if (!hasStampedGen) → DRIFT_STAMP_GEN_MISSING
else if (Number(stampedGenRaw) !== liveGen) → DRIFT_STAMP_GEN_STALE
```

## 5 紅線自檢

| 紅線 | 檢查 | 結果 |
|---|---|---|
| 不碰 `v3/src/match.js` | `git diff origin/master --numstat -- v3/src/match.js` | 空（0 行） |
| 不碰 `v1/`／`v2/` | `git diff origin/master --numstat -- v1 v2` | 空 |
| 不開閘 | `grep -rn 'PUBLIC_LISTINGS_SQL_FIRST' v3/src/publicListingSearchAsync.js` | 仍是 `!== "1"` 第一行 return；repo 內沒有 `="1"` |
| 不加排程 | `git diff origin/master --stat -- .github/workflows` ／ crontab | 未動 `.github/workflows`；未動 crontab／systemd |
| 不觸發 workflow_dispatch | `gh run list` 只會有 PR 觸發的 CI | 見 §7 |
| 不寫正式庫 | 所有寫入只對 `15447/repro`（棄用容器）；`repro2`／`repro3` 只當 `pg_dump` 來源 | 見 §2 |
| 共用 checkout 停在 master | `git -C /workspace/repos/5151 status --porcelain` | 空；分支仍是 `master` |

## 6 檔案清單與 sha256(16)

`git diff --stat origin/master`（**不含**新增檔）：`5 files changed, 190 insertions(+), 37 deletions(-)`
＋新增 2 支測試 ＋本檔 ＋2 份文件更新。（實際數字見 PR）

| 檔案 | sha256(16) | 角色 |
|---|---|---|
| `v3/src/foldComponentRoot.js` | `f750392aa89e125b` | 世代鍵原語＋開閘前檢第 4 條＋快取以 gen 為鍵＋寫入路徑 bump |
| `v3/scripts/fold-root-drift-check.mjs` | `0f660fed30f13a37` | `--stamp` payload 加 `writeGen`（與 rows／maxPostId 同一句 SQL） |
| `v3/scripts/fold-root-backfill.mjs` | `e79d1b733362ae54` | 每批交易內 bump |
| `v3/scripts/fold-ci-parity.mjs` | `4ce5209e0502e92b` | 合成種子寫入後 bump |
| `v3/scripts/fold-shape-fixtures.mjs` | `387591534a4e3ef3` | fixture 寫入後 bump |
| `v3/scripts/fold-gate-stamp-verify.mjs` | `dd2bebcc7c4e0e53` | 唯讀複核加 `writeGen_match` |
| `v3/test/fold-sql-gate.test.js` | `23d0bdbf3eb70f2b` | 八種結果＋快取語意更新 |
| `v3/test/fold-root-write-gen.test.js`（新） | `ae00f8a658cc9cd5` | 離線單元 9 條 |
| `v3/test/fold-root-write-gen-live-pg.test.js`（新） | `50ee08d83f1d414b` | 真 PG 驗收（自有 schema、拒寫守衛） |
| `docs/same-house-fold-spec.md` | `4c45d036c955b47c` | §6.9 補第 4 條與新 reason |
| `docs/runbooks/5151_same_house_fold_deploy.md` | `57c9751aa27429ce` | §1.1／§1.2 把「未實裝①」改成已實裝 |
| `evidence/fold-root-write-gen-2026-10-13.md`（本檔） | 見 `/home/cline/lab/5151-genkey-r9/sha256-16.txt` | 交付證據 |

log 指紋（`/home/cline/lab/5151-genkey-r9/`，`sha256sum | cut -c1-16`）：

| 檔 | sha256(16) |
|---|---|
| `genkey-pg-gen.log` | 見同目錄 `sha256-16-logs.txt` |
| `drift-readonly.log` / `drift-stamp.log` | 同上 |
| `gate-stamp-verify.log` / `gate-stamp-verify-after.log` | 同上 |
| `inplace-gen-demo.log` | 同上 |
| `live-pg-test.log` | 同上 |
| `negative-control-unit.log` / `negative-control-live.log` | 同上 |
| `npm-test-r9.log` | 見 §7 |

## 7 CI

**round 9（PR #743，分支 `fold-gen-key`）**：已合併（`origin/master` = `0d2e196`）。

**round 11（PR #744，分支 `fold-gen-fix-tx`）**：下表是 **head `0ca0f83`** 的執行結果（那是含全部
程式碼改動的 head；後續 commit 只改本證據檔，`v3/` 一個位元組都沒動 ⇒ 下表對最終 head 同樣成立，
最終 head 的 run id 記在 PR #744 的 checks）：

| 檢查 | run／job | 結果 |
|---|---|---|
| Run Tests | run `38357850281`／job `115164804067` | ✅ pass（4m30s）：`# tests 4218 / # pass 4084 / # fail 0`；`fold-root-write-gen-live-pg` 在此 job 如常 **SKIP**（沒有 `PG_TEST_URL`，符合設計） |
| Run Tests (PostgreSQL integration) | run `38357850281`／job `115164804233` | ✅ pass（4m10s）：`# tests 325 / # pass 324 / # fail 0 / # skipped 1`；`ok 69 - 原地 UPDATE fold_component_root ⇒ 世代鍵過時 ⇒ 下一句就被拒`（＝含本輪 D／E 段的 live-pg 測試**真的跑了**）；**gate 步驟 `node v3/scripts/fold-ci-parity.mjs` 也跑過且通過**（`test.yml:163`）⇒ 本包改的顯式交易在 CI 有直接覆蓋 |
| Review diff with the configured model | run `38357850226` | ✅ pass（4s，**advisory**：`REVIEW_API_KEY` 未設定 ⇒ 該步直接 skip，不是真的審過） |
| GitGuardian Security Checks | — | ✅ pass（1s） |

## 8 round 11：關掉「一句話寬」的 fail-open 窗口（2026-10-13）

> **本節修正 §1 表格右欄的措辭**：那裡把四條寫入路徑一律寫成「同一個交易」，是**過分宣稱**——
> 只有 `fold-root-backfill.mjs` 真的有顯式交易；其餘三條當時是**自動提交的相鄰兩句**，而且順序是
> 「先 root UPDATE、後 bump」。以本節為準。

### 8.1 缺陷（窗口的一句話寬）

`refreshFoldComponentRoot()` 舊版是：

```
await exec("UPDATE listings SET fold_component_root = ? WHERE post_id = ?", …)   // :594
if (writes.length) await bumpFoldRootWriteGen(exec);                            // :600
```

兩句之間**沒有交易**（`match.js` 的 fold 漏斗也沒有外層交易 ⇒ autocommit）。行程若死在兩句之間：

- 舊版（bump 在後）：**root 已寫、世代未動** ⇒ 已接受的零差戳記仍然「有效」⇒ 請求在**過時世代**
  下被放行（**fail-open**）。這正是本輪要關的窗口。
- 新版（bump 在前）：**世代超前、root 未動** ⇒ 舊戳記當場失效、下一個請求走
  `fold_root_drift_stamp_gen_stale` 被拒；要有人重跑 `--stamp` 才放行，而 `--stamp` 會全量重算
  root、零差才寫 ⇒ **fail-closed**。

`fold-ci-parity.mjs` 更嚴重：它的 `BEGIN`(:160)–`COMMIT`(:175) 只是**種子 INSERT** 的交易，root UPDATE
與 bump 兩句都在交易**之外**，順序也相反；且它用的是 `drv.pool.query`（連線池）⇒ 連「同一條連線」
都不成立。`fold-shape-fixtures.mjs` 同樣是交易外的反序兩句。

### 8.2 四條路徑各自的改法（`origin/master` = `0d2e196` 基準）

| 路徑 | 改動 | 新位置 | 原子性 |
|---|---|---|---|
| `v3/src/foldComponentRoot.js` | **bump 移到 root UPDATE 之前**（原本兩句反序、無交易） | bump `:605`、UPDATE `:607` | 同一個 `exec`（呼叫端綁定的連線）相鄰兩句；**不宣稱原子**，靠順序把窗口變成 fail-closed |
| `v3/scripts/fold-root-backfill.mjs` | **未改動邏輯**，只加註解說明為何刻意不重排 | `BEGIN`(:88) → UPDATE(:92) → bump(:101) → `COMMIT`(:103) | 真的同一個顯式交易 ⇒ 整批 rollback（原子） |
| `v3/scripts/fold-ci-parity.mjs` | root UPDATE ＋ bump **收進同一條 `drv.pool.connect()` 連線的顯式交易**，`BEGIN`(:222) → **bump(:223)** → UPDATE(:226) → `COMMIT`(:228) | 同上 | 真交易（原本兩句在 `:160`–`:175` 那個交易之外、且走連線池） |
| `v3/scripts/fold-shape-fixtures.mjs` | 先算出「真的會改到列」的待寫清單，**bump 先送**(:259)、再送 UPDATE(:262) | 同上 | 兩句各自走 pool ⇒ **不宣稱同一連線**；靠順序 fail-closed |

`bump` 語句本身**沒有改**（沿用 #743 的 `CAST(COALESCE(CAST(value AS bigint), 0) + 1 AS text)` ＋
`ON CONFLICT(key) DO NOTHING` ensure；SQLite／PG 雙驅動語意不變）。

### 8.3 測試（離線 12 條；live-pg 1 條內含 A–E 五段）

`v3/test/fold-root-write-gen.test.js`（第 9 輪的 9 條全留、**沒有削弱**，新增 3 條）：

1. 原始碼**順序**斷言：`v3/src/foldComponentRoot.js`／`fold-ci-parity.mjs`／`fold-shape-fixtures.mjs`
   三條未交易路徑，`await bumpFoldRootWriteGen(` 的索引必須**小於** `UPDATE listings SET
   fold_component_root` 的索引（失敗訊息會印兩個 idx）。
2. 已交易路徑斷言：`fold-root-backfill.mjs` 的 BEGIN < UPDATE < bump < COMMIT（順序不影響原子性）。
3. 單元 bump-first 語意：真的 SQLite 跑 `bump`，listings／`pg_attribute` 用受控假值——
   先寫 gen=0 的零差戳記並放行；只送 bump（＝模擬死在兩句之間）⇒ 舊戳記**必須被拒**
   （`gen_stale`、`stampedWriteGen=0`、`liveWriteGen=1`）；重寫戳記成 gen=1 才放行。

`v3/test/fold-root-write-gen-live-pg.test.js`（真 PG、自有 schema `fold_genkey_live`、拒寫守衛不變，
新增 D／E）：

- **D**：`bumpFoldRootWriteGen()` 單獨送（＝bump 成功、root UPDATE 未跑）⇒ 世代超前 ⇒ 舊戳記被拒
  （fail-closed）。
- **E**：把 `exec` 包成「root UPDATE 一定失敗」的注入式 exec，呼叫**生產寫入器**
  `refreshFoldComponentRoot()`：斷言它**向上拋**、**root 沒被寫到**、而**世代仍前進 +1**
  ——這是「bump 在前」的**行為**證明，不是註解。

```
$ node --test v3/test/fold-root-write-gen.test.js
# tests 12 / # pass 12 / # fail 0 / # skipped 0

$ PG_URL=…15447/repro node --test v3/test/fold-root-write-gen-live-pg.test.js
ok 1 - 原地 UPDATE fold_component_root ⇒ 世代鍵過時 ⇒ 下一句就被拒（不靠快取救回）
# tests 1 / # pass 1 / # fail 0 / # skipped 0
```

**改過的 `fold-ci-parity.mjs` 真的跑得動**（CI 的 PostgreSQL job 會跑它，`test.yml:163`）。
在一次性容器上實跑（`DATA_DIR=$(mktemp -d)`）：

```
$ PG_URL=…15447/repro node v3/scripts/fold-ci-parity.mjs
rc=1  ← 但**不是**本包改動造成的：卡在 :300 的端點級查詢
error: column "source_published_at" does not exist        （code 42703）

$ git worktree add /tmp/5151-base-check 0d2e196 && PG_URL=<同一顆> node v3/scripts/fold-ci-parity.mjs
rc=1
error: column "source_published_at" does not exist        （code 42703，同樣在端點級查詢）
```

⇒ **改前／改後在同一顆容器上失敗在同一個錯誤**（該容器的 schema 是 repro3 的舊 dump，缺
`source_published_at`；CI 的 `tracker_test` 由 `pg-integration-setup.mjs` 現建，不會缺）。
本包改動的區塊（`BEGIN`(222) → bump(223) → UPDATE(226) → `COMMIT`(228)）**已成功提交**：同一顆容器
的 `settings.foldRootWriteGen` 由 `1` → `2`（`grep '^foldRootWriteGen'`＝`gen=2`），可重跑：

```bash
ssh syn-nas "/usr/local/bin/docker exec prb-genkey-pg psql -U postgres -d repro -tA \
  -c \"SELECT value FROM settings WHERE key='foldRootWriteGen'\""
```

完整 PG 整合（＝CI 的 `test-postgres` job 本地等價）另跑一次，見 §8.7。

### 8.4 負向對照（把 bump 移回 UPDATE 之後 ⇒ 兩條都會紅）

只把 `v3/src/foldComponentRoot.js` 的兩句換回舊序，其餘不動：

```
$ node --test v3/test/fold-root-write-gen.test.js
not ok 10 - 未交易的三條寫入路徑：bump 叫用必須在 root UPDATE 之前（round 11 關掉 fail-open 窗口）
  error: 'v3/src/foldComponentRoot.js：bump（idx 27083）必須排在 root UPDATE（idx 26976）之前——…'
# tests 12 / # pass 11 / # fail 1     ← 順序斷言如預期變紅

$ PG_URL=…15447/repro node --test v3/test/fold-root-write-gen-live-pg.test.js
not ok 1 - 原地 UPDATE fold_component_root ⇒ 世代鍵過時 ⇒ 下一句就被拒（不靠快取救回）
  error: 'bump 必須在 root UPDATE 之前落地——順序若反了，這裡會是 +0（＝root 已寫而世代未動的 fail-open 窗口）
    2 !== 3'
# tests 1 / # pass 0 / # fail 1       ← 行為斷言也變紅：root 寫了、世代 +0（＝fail-open 窗口本體）
```

還原後兩條都回綠（見 §8.5 的 `npm test` 與 §7 CI）。

### 8.5 檔案清單與 log 指紋（本輪）

`git diff --stat`（基準 `origin/master`= `0d2e196`，分支 `fold-gen-fix-tx`）：

| 檔案 | 行數 | sha256(16) |
|---|---|---|
| `v3/src/foldComponentRoot.js` | +13/−5 | `bf1edae74cc1018d` |
| `v3/scripts/fold-ci-parity.mjs` | +26/−3 | `af8fdd0b272d7a5b` |
| `v3/scripts/fold-shape-fixtures.mjs` | +10/−2 | `07bb95dbfc7d427b` |
| `v3/scripts/fold-root-backfill.mjs` | +3/−0 | `8949eeb623d5ccec` |
| `v3/test/fold-root-write-gen.test.js` | +82/−0 | `c8b2c401db943bde` |
| `v3/test/fold-root-write-gen-live-pg.test.js` | +31/−1 | `d30f810b2b96a4cc` |
| `docs/runbooks/5151_same_house_fold_deploy.md` | +18/−6 | `7fad77ebb8d71d6d` |

log（`/home/cline/lab/5151-genfix-r11/`，`sha256sum | cut -c1-16`）：

| 檔 | sha256(16) | 角色 |
|---|---|---|
| `npm-test-r11.log` | `9622e6701b50f7ca` | 全套 `npm test`（**commit 後**跑的乾淨那一次；`rc=0`、`# tests 4218 / # pass 4085 / # fail 0 / # skipped 133 / # cancelled 0`、946.7s） |
| `live-pg-test-r11.log` | `603bea738581ea36` | live-pg 測試原始輸出（A–E 全綠） |
| `negative-control-order.log` | `df4dece93a2a95c4` | 負向對照（順序斷言變紅，rc=1） |
| `negative-control-live-r11.log` | `23011320656bb930` | 負向對照（真 PG 行為斷言變紅，rc=1） |
| `uptime-before-npm-test.txt` | `2545d6bf7e949cbe` | 跑全套前的 `uptime`（無併行重活存證） |
| `foldComponentRoot.bumpfirst.js` | `bf1edae74cc1018d` | 負向對照的還原來源（＝本輪 `v3/src/foldComponentRoot.js` 的原樣備份） |
| `npm-test-r11-aborted-uncommitted.log` | `0b947bef30a6ff02` | **作廢的一跑**：在 commit **前**跑，`PR A src manifest matches git tree…` 因為「`v3/src` 工作樹 ≠ HEAD」這個測試工件紅 1 條（`changed:["foldComponentRoot.js"]`）——與本包改動無關，改以 commit 後那一次為準 |
| `pg-integration-r11.log` | `db0110e1eeee438f` | 完整 PG 整合（＝CI `test-postgres` job 本地等價），見 §8.7 |
| `fold-ci-parity-tracker-test-r11.log` | `4b8f5b884370a529` | 改過的 `fold-ci-parity.mjs` 在新鮮 `tracker_test` 上**全綠**（16/16） |
| `fold-ci-parity-r11.log` / `fold-ci-parity-baseline.log` | `12b1e60ee36f1087` / `a1c6b0b8d80e269d` | 在舊 schema 容器上的改前／改後同錯誤對照 |

### 8.7 完整 PG 整合（本地等價於 CI 的 `test-postgres` job）

CI 的 `test-postgres` job 有兩塊：`npm run test:pg`（`pg-integration-setup.mjs` 現建 schema ＋
79 支 PG_TEST_URL-gated 測試）與**單獨一步** `node v3/scripts/fold-ci-parity.mjs`（`test.yml:163`）。
兩塊都在一次性容器上跑過（**不動** `repro` 那顆 18.4 萬列的複本：在 `prb-genkey-pg` 內另開一個空的
`tracker_test` 資料庫，schema 由 setup 現建）：

```
$ docker exec prb-genkey-pg createdb -U postgres tracker_test          # 空的新庫（只在這顆可毀容器內）
$ PG_URL=…15447/tracker_test PG_TEST_URL=<同上> PG_LIVE_REPRO_URL=<同上> REQUIRE_PG=1 \
    DATA_DIR=$(mktemp -d) npm run test:pg
[pg] 執行 79 個整合測試檔
# tests 325 / # pass 324 / # fail 0 / # cancelled 0 / # skipped 1     rc=0（369.9s）

$ PG_URL=…15447/tracker_test DATA_DIR=$(mktemp -d) node v3/scripts/fold-ci-parity.mjs
{"script":"fold-ci-parity","total":16,"failed":[],"allOk":true}       rc=0
```

⇒ 含本包改動的 `BEGIN`(222)→bump(223)→UPDATE(226)→`COMMIT`(228) 區塊在**新鮮 schema** 上通過
（⑧ 固化欄逐列、⑪ 端點級逐群、⑫⑬⑭ tie-break／collation 軸全 `ok:true`）。
`repro2`(15434)／`repro3`(15435) 全程唯讀；`repro` 那顆複本未被改動。

### 8.6 紅線自檢（本輪）

```bash
$ git diff --stat origin/master -- v3/src/match.js v1/ v2/ .github/workflows
（空輸出，rc=0）                     # match.js 0 行、v1/v2 0、無 workflow 改動（未加 gating step）
$ git status --porcelain
 M docs/runbooks/5151_same_house_fold_deploy.md
 M evidence/fold-root-write-gen-2026-10-13.md
 M v3/scripts/fold-ci-parity.mjs
 M v3/scripts/fold-root-backfill.mjs
 M v3/scripts/fold-shape-fixtures.mjs
 M v3/src/foldComponentRoot.js
 M v3/test/fold-root-write-gen-live-pg.test.js
 M v3/test/fold-root-write-gen.test.js
```

未開閘（`PUBLIC_LISTINGS_SQL_FIRST` 仍 off／未設）、未 merge、未 dispatch、未加 cron／systemd；
寫入只落在一次性棄用容器 `prb-genkey-pg`（NAS 15447/repro）；`repro2`(15434)／`repro3`(15435) 全程唯讀。
