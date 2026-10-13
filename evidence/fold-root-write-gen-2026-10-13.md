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

（PR 開好後補：run id＋四項 job 狀態）
