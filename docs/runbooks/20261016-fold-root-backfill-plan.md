# 20261016 正式站 `listings.fold_component_root` 回填落地計畫

> 這份文件只描述**程序**，不含任何憑證值；憑證一律用「檔名 ＋ 鍵名」引用
> （正式庫：`/home/cline/.secrets/apps/5151-prod-casaos.env` 的 `PG_URL`；
> 隔離庫：`/home/cline/.secrets/postgres/5151-live-repro.env` 的 `PG_LIVE_REPRO_URL`，資料庫名 `repro`）。
>
> **紅線**：正式庫全程只准 SELECT；可寫的只有隔離庫。本文件的產生過程中，
> 我對正式庫只下過 SELECT（含正向控制），**沒有**對正式庫跑過回填、`--stamp` 或任何 DDL/DML。

---

## 0. 先講三個必須先知道的結論（其中兩個是對原始任務前提的更正）

1. **現在不是 503。** 2026-10-16 18:16（+08:00）我實測：正式站容器 `591-tracker-v3` 的
   `PUBLIC_LISTINGS_SQL_FIRST=0`（**閘門目前是關的**，該容器於 18:05:42 重建），
   `https://jibbyrenth.reversalplay.me/api/public/listings?limit=3` 回 **200**，
   而且本次容器啟動以來 `[fold-gate]` 告警行數是 **0**。
   任務背景描述的「訪客清單 503、`reason=fold_root_drift_stamp_stale`」在閘門開著時確實會發生
   （那個判定我這次用唯讀方式原樣重現了，見 §1.2），但**現在閘門已經被關掉**，所以症狀重現不到。

2. **「固化欄落後」不是閘門關閉的原因，回填也不是打開閘門的充分條件。**
   開閘前檢（`v3/src/foldComponentRoot.js` 的 `foldSqlGateReady()`）四項依賴裡，
   **沒有任何一項**重新檢查 drift；它檢查的是戳記 `settings.foldRootDriftStamp` 存在、
   `mismatches === 0`，以及戳記綁的 `rows`／`maxPostId`／`writeGen` 是否等於**當下**的實測值。
   現在擋住閘門的是 2026-10-14 寫下的舊戳記：
   戳記 `rows = 202,136`／`writeGen = 58`，線上 `rows = 213,675`／`writeGen = 7,292`
   ⇒ `reason = fold_root_drift_stamp_stale`。

3. **但回填是「拿到一張誠實新戳記」的前置條件。**
   `fold-root-drift-check.mjs --stamp` 在 mismatch ≠ 0 時**拒絕寫入**戳記
   （我在隔離庫實測到 `"stampSkippedBecause":"mismatch_nonzero"`，見 §6.4）。
   不回填，就只能沿用那張 10-14 的舊戳記，開閘當場就是 503。

> 成本效益一句話：回填本身很便宜（正式庫 119 列、預估 4～6 秒、冪等可重跑、閘門關閉時對訪客零影響），
> 但它**不會讓訪客清單自動恢復**——戳記會在幾分鐘內再次過期（§7.1、§7.4）。
> 要不要在「戳記重蓋策略」定案前先做這次回填，是 Owner 的取捨，不是技術阻礙。

---

## 1. 目的與現況

**目的**：把 `listings.fold_component_root`（同屋源連通分量的固化根）與「用同一份 union-find 重算的值」
對齊，使 §3 的 119 列落後消失；這是 SQL-first 折疊開閘後「同一個屋源被拆成兩列」的第二類成因
（第一類是補償條款，已由 PR #756 修掉並合併）。

### 1.1 唯讀防護先證明有效（**每個要用到的連線都要先跑這一步**）

正式庫的防護不是「記得不要寫」，而是「寫了一定失敗」。先做正向控制：

```bash
mkdir -p /tmp/5151-drill && ln -sfn "$PWD/node_modules" /tmp/5151-drill/node_modules
cat > /tmp/5151-drill/ro-guard.mjs <<'EOF'
// 唯讀防護正控制：CREATE TEMP TABLE 必須被擋（SQLSTATE 25006）
import pg from "pg";
const client = new pg.Client({ connectionString: process.env.PROBE_URL, application_name: "5151-ro-guard" });
await client.connect();
const ro = (await client.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only;
let block;
try { await client.query("CREATE TEMP TABLE probe_ro (x int)"); block = "ALLOWED"; }
catch (error) { block = `BLOCKED ${error.code}`; }
const n = (await client.query("SELECT count(*)::int AS n FROM listings")).rows[0].n;
console.log(JSON.stringify({ default_transaction_read_only: ro, create_temp_table: block, listings: n }));
await client.end();
EOF
cd /home/cline/lab/5151-backfill-plan        # 任何有 repo 內容與 node_modules 的目錄
set -a; . /home/cline/.secrets/apps/5151-prod-casaos.env; set +a
PROBE_URL="$PG_URL" PGOPTIONS="-c default_transaction_read_only=on" node /tmp/5151-drill/ro-guard.mjs
```

我實跑（正式庫）的輸出（`listings` 是即時列數，重跑時數字不同是正常的）：

```json
{"default_transaction_read_only":"on","create_temp_table":"BLOCKED 25006","listings":213618}
```

反向控制（證明「擋住」是 PGOPTIONS 造成的、不是伺服器本來就唯讀）我是在**隔離庫**做的
（避免在正式庫真的建出 temp table）：同一支腳本拿掉 `PGOPTIONS` 後回
`{"default_transaction_read_only":"off","create_temp_table":"ALLOWED",...}`。
**正式庫的反向控制我沒有做**，列為未實測（附錄 C 第 2 條）。

> 為什麼這樣就夠：node-postgres 8.23.0 會讀 `PGOPTIONS`
> （`node_modules/pg/lib/connection-parameters.js` 第 15 行 `process.env['PG' + key.toUpperCase()]`、
> 第 83 行 `this.options = val('options', config)`），所以 `PGOPTIONS="-c default_transaction_read_only=on"`
> 對 Node 腳本**有效**；上面的正向控制就是這條的實證。

### 1.2 現況（以下每個數字都是我在 2026-10-16 18:0x–18:1x（+08:00）當場重跑的）

指令（全部唯讀；`ALLOW_PRODUCTION_PG_TARGET=1` 是白名單閘門，因為正式庫名 `5151_shadow`
不在 `assertPgTargetAllowed` 的允許清單裡，唯讀查詢也要明確授權）：

```bash
cd /home/cline/lab/5151-backfill-plan
set -a; . /home/cline/.secrets/apps/5151-prod-casaos.env; set +a
export PGOPTIONS="-c default_transaction_read_only=on"
export ALLOW_PRODUCTION_PG_TARGET=1
time node v3/scripts/fold-root-drift-check.mjs
node v3/scripts/fold-gate-stamp-verify.mjs
node v3/scripts/projection-freshness-check.mjs 200 --read-only
curl -s -o /dev/null -w '%{http_code}\n' 'https://jibbyrenth.reversalplay.me/api/public/listings?limit=3'
ssh casa-nas "docker inspect 591-tracker-v3 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep PUBLIC_LISTINGS_SQL_FIRST"
```

實測結果：

| 項目 | 我實測的值 | 來源指令 |
|---|---|---|
| 線上列數 `listings` | **213,618**（18:02:20）→ **213,674**（18:14:01）→ **213,677**（18:18:04） | `fold-root-drift-check.mjs` 的 `listings` 欄；`impact.mjs` |
| `listing_group_members` | 116,762 | 同上 |
| 固化欄非 NULL 列數 | 122,392 | 同上 |
| 重算後應非 NULL 列數 | 122,509 | 同上 |
| 分量數（`fresh === post_id`） | 34,546 | 同上 |
| **`stored IS DISTINCT FROM fresh`（＝要 UPDATE 的列數）** | **119** | `fold-root-drift-check.mjs` 的 `mismatch`（rc=1） |
| **`stored IS NULL AND fresh IS NOT NULL`** | **117** | §1.3 的分類指令 |
| `stored IS NOT NULL AND fresh IS NULL` | **0** | 同上 |
| 兩邊都非 NULL 但不相等 | **2** | 同上 |
| 有 `match_post_id` 但 `stored IS NULL` | 2,260（其中重算後應非 NULL 者 **85**） | `PROBE_URL=… probe-sql.mjs "…"`（§1.3 同款連線） |
| 受影響分量數（這 119 列所屬的分量） | **84** 個（大小中位數 2～3 列） | §1.3 的分類指令 |
| 戳記 `settings.foldRootDriftStamp` | `at=2026-10-14T05:51:06Z`、`rows=202136`、`mismatches=0`、`writeGen=58`、`dataVersion={rows:202136,maxPostId:2699975575,rootsMd5:76281e3f9a3ce276937de7b534162827,writeGen:58}` | `fold-gate-stamp-verify.mjs` |
| 寫入世代鍵 `settings.foldRootWriteGen` | **7,291**（18:14:01）→ **7,292**（18:16:30）；**2.5 分鐘內自己 +1** | 同上 |
| 線上開閘前檢（真的呼叫 `foldSqlGateReady`） | `ok=false`、`reason=fold_root_drift_stamp_stale`、`detail={stamped:{rows:202136,maxPostId:2699975575}, live:{rows:213675,maxPostId:2699975575}}` | `fold-gate-stamp-verify.mjs`（rc=1） |
| 公開清單端點 | **200** | `curl` |
| 閘門開關 | `PUBLIC_LISTINGS_SQL_FIRST=0`；容器 `591-tracker-v3` 於 2026-10-16T10:05:42Z 啟動 | `ssh casa-nas docker inspect` |
| `projection-freshness-check` 的 `foldRoot` | `sampled=200`、`mismatch=0`（抽樣看不到 0.056% 的落後） | 同指令 |
| 同一支腳本的 `pass` | `false`（因為 `listings=213675` 但 `listing_search_projection=213683`，**與 foldRoot 無關**，見 §7.6） | 同上 |
| 全表指紋 SQL（`--stamp` 會跑的那條 md5 聚合）在 `statement_timeout=15000` 下 | `ok=true`、耗時 **848 ms** | `measure.mjs` 的 `fingerprint` 欄 |

耗時（正式庫、唯讀全表）：`fold-root-drift-check.mjs` 一次 **4.076 秒**（`time` 實測，同一條 HAProxy 連線）。

### 1.3 影響面分類指令（唯讀，會同時產生 §5 的回滾素材）

```bash
cat > /tmp/5151-drill/impact.mjs <<'EOF'
// 唯讀：把 mismatch 列分成「會變成自己一組」「摺進別的分量」「指向舊 root」三類，並列出受影響分量。
import pg from "pg";
const REPO = process.env.REPO || process.cwd();
const { componentRootMap, enabledSourcesFromPg } = await import(`${REPO}/v3/src/foldComponentRoot.js`);
const { toPostgresSql } = await import(`${REPO}/v3/src/sqlDialect.js`);
const client = new pg.Client({ connectionString: process.env.PROBE_URL, application_name: "5151-impact" });
await client.connect();
const exec = (sql, params = []) => client.query(toPostgresSql(sql), params).then((r) => r.rows);
await client.query("SET default_transaction_read_only = on");
try { await client.query("CREATE TEMP TABLE probe_impact (x int)"); console.log("正控制失敗：temp table 沒被擋"); process.exit(2); }
catch (error) { if (error.code !== "25006") throw error; }
const rows = await exec(`SELECT l.post_id, l.source, l.match_post_id, l.match_verdict, l.offline_confirmed,
        l.fold_component_root, COALESCE(p.display_ready, 0) AS prep_display_ready
   FROM listings l LEFT JOIN listing_prep p ON p.post_id = l.post_id ORDER BY l.post_id`);
const groupRows = await exec("SELECT post_id, group_id FROM listing_group_members ORDER BY post_id, group_id");
const gidOf = new Map(); for (const g of groupRows) gidOf.set(Number(g.post_id), String(g.group_id || ""));
const enabled = await enabledSourcesFromPg(exec);
const isNotDisplayReady = (row) => {
  const source = String(row?.source || "591") || "591";
  if (!enabled.has(source)) return true;
  if (source !== "houseprice") return false;
  return Number(row?.prep_display_ready) === 1 ? false : true;
};
const roots = componentRootMap({ rows, groupIdOf: (pid) => gidOf.get(Number(pid)) || "", splits: new Set(), isNotDisplayReady });
const freshRoots = new Set(); const members = new Map();
for (const row of rows) { const pid = Number(row.post_id); const fresh = roots.get(pid) == null ? null : Number(roots.get(pid));
  if (fresh != null) { freshRoots.add(fresh); members.set(fresh, (members.get(fresh) || 0) + 1); } }
const buckets = { becomes_own_group: [], folds_into_another_component: [], points_at_unknown_root: [], points_elsewhere_within_component: [] };
const affected = new Set();
for (const row of rows) {
  const pid = Number(row.post_id);
  const stored = row.fold_component_root == null ? null : Number(row.fold_component_root);
  const fresh = roots.get(pid) == null ? null : Number(roots.get(pid));
  if (stored === fresh) continue;
  const entry = { post_id: pid, stored, fresh, source: row.source };
  if (fresh != null) affected.add(fresh);
  if (stored == null) buckets.becomes_own_group.push(entry);
  else if (freshRoots.has(stored)) { entry.stored_component_size = members.get(stored) || 0; buckets.folds_into_another_component.push(entry); }
  else if (fresh != null) buckets.points_elsewhere_within_component.push(entry);
  else buckets.points_at_unknown_root.push(entry);
}
const dump = [...buckets.becomes_own_group, ...buckets.folds_into_another_component, ...buckets.points_at_unknown_root, ...buckets.points_elsewhere_within_component]
  .map((e) => ({ post_id: e.post_id, stored: e.stored }));
if (process.env.DUMP) { (await import("node:fs")).writeFileSync(process.env.DUMP, JSON.stringify(dump)); }
console.log(JSON.stringify({ at: new Date().toISOString(), listings: rows.length,
  totalMismatch: dump.length, counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
  affectedFreshComponents: affected.size,
  affectedComponentSizeHistogram: [...affected].reduce((acc, r) => { const n = members.get(r) || 0; acc[n] = (acc[n] || 0) + 1; return acc; }, {}),
  samples: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.slice(0, 3)])) }, null, 1));
await client.end();
EOF
cd /home/cline/lab/5151-backfill-plan
PROBE_URL="$PG_URL" REPO="$PWD" PGOPTIONS="-c default_transaction_read_only=on" node /tmp/5151-drill/impact.mjs
```

我實跑（正式庫，18:18:04）的輸出（節錄）：

```json
{"listings":213677,"totalMismatch":119,
 "counts":{"becomes_own_group":117,"folds_into_another_component":0,"points_at_unknown_root":0,"points_elsewhere_within_component":2},
 "affectedFreshComponents":84,
 "affectedComponentSizeHistogram":{"2":33,"3":27,"4":10,"5":8,"6":1,"7":2,"8":1,"11":1,"25":1}}
```

### 1.4 與任務背景數字的差異（都是「資料一直在動」造成的，不是我算錯）

| 項目 | 任務背景（planner） | 我實測（2026-10-16 18:0x–18:1x） |
|---|---|---|
| 線上列數 | 212,931／212,939 | 213,618 → 213,677（11 分 41 秒內 +56 列） |
| mismatch | 123 | **119** |
| 有 `match_post_id` 且 root 為 NULL 中「重算後應非 NULL」 | 87 | **85**（分母 2,262 → 2,260） |
| 「有 `match_post_id` 但 root 為 NULL」總數 | 2,262 | **2,260** |

另外要更正一個說法：任務背景把「有 `match_post_id` 但 root 為 NULL」的 2,262 列與「要 UPDATE 的列數」
混在一起了。實測的關係是：**要 UPDATE 的是 119 列 = 117（`stored IS NULL` → 應為非 NULL）
+ 2（非 NULL 但指向別的 root）**；而 117 列裡只有 85 列自己有 `match_post_id`。
剩下 32 列的歸因我也實測了（lab 腳本 `/tmp/5151-drill/attribution.mjs`，唯讀、同樣有 25006 正控制）：

```json
{"attribution":{"by_group_edge_only":0,"by_being_edge_target_only":0,"by_both":32,"by_neither":0}}
```

⇒ 這 32 列**同時**是「別列 match 邊的對端」與「`listing_group_members`（系統同屋源群組）的成員」，
它們的分量邊不是來自自己的 `match_post_id`。

---

## 2. 逐步執行清單

| # | 步驟 | 誰執行 | 連線 | 預估時間 | 可中斷重跑 |
|---|---|---|---|---|---|
| 0 | 唯讀防護正控制（§1.1） | 代理人 | 唯讀 | < 5 秒 | 是 |
| 1 | 回填前 DUMP 119 列舊值（§5.1） | 代理人 | 唯讀 | < 10 秒 | 是 |
| 2 | 回填 `fold-root-backfill.mjs`（§2.2） | **Owner**（正式庫寫入；代理人紅線禁止） | **必須可寫** | 4～6 秒 | 是（冪等） |
| 3 | 蓋新戳記 `--stamp`（§2.3） | **Owner** | **必須可寫** | 5～7 秒 | 是（冪等） |
| 4 | 驗證（§4，三支唯讀腳本） | 代理人 | 唯讀 | < 15 秒 | 是 |
| 5 | 開閘（§4.4，只有 Owner） | **Owner** | 主機 `.env` ＋ compose | 立即 | 可關閘 |

### 2.1 前置（唯讀）

```bash
cd /home/cline/lab/5151-backfill-plan        # 或任何同步到 master 的 checkout
git fetch origin master && git log --oneline -1 origin/master   # 確認是預期的版本
set -a; . /home/cline/.secrets/apps/5151-prod-casaos.env; set +a
export PGOPTIONS="-c default_transaction_read_only=on"
export ALLOW_PRODUCTION_PG_TARGET=1
node v3/scripts/fold-root-drift-check.mjs      # 期望 mismatch=119（數量會隨爬蟲變動，重點是「有幾列」）
```

### 2.2 回填（**Owner 執行；必須是可寫連線**）

```bash
cd /home/cline/lab/5151-backfill-plan
set -a; . /home/cline/.secrets/apps/5151-prod-casaos.env; set +a
unset PGOPTIONS                                 # 這一步**不可以**帶唯讀，帶了會 25006 失敗（見附錄 C 第 4 條）
ALLOW_PRODUCTION_PG_TARGET=1 PG_URL="$PG_URL" node v3/scripts/fold-root-backfill.mjs
```

- 這支腳本會先跑兩句冪等 DDL（`ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_component_root bigint`、
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_fold_component_root …`）。
  我唯讀查過正式庫：欄位（`bigint`）與索引 `idx_listings_fold_component_root` **都已存在**
  ⇒ 兩句應為 no-op；**DDL 這一步在正式庫上列為未實測**（附錄 C 第 3 條）。
- 期望輸出（數字會隨時間變動）：

  ```
  DDL ensured: 2 statements
  listings=… group_members=… enabledSources=591,ddroom,hbhousing,housefun,houseprice,self,sinyi batchSize=2000
  components=… members_materialized=… differ=119
  {"total":…,"batches":1,"written":119,"unchanged":…,"ms":…,"perRowMs":…}
  ```

- 全部列中有差的是 119 列，`batchSize` 預設 2000 ⇒ **只有 1 個非空批次 ⇒ `writeGen` 只 +1 一次**
  （腳本第 100-102 行：只有真的有寫入的批次才 `bumpFoldRootWriteGen`）。
- 中斷處理：直接重跑即可（冪等；已完成的部分第二次跑會是 `written=0`，我在隔離庫實測過，見 §6.5）。

### 2.3 蓋戳記（**Owner 執行；必須是可寫連線**）

```bash
unset PGOPTIONS
ALLOW_PRODUCTION_PG_TARGET=1 PG_URL="$PG_URL" node v3/scripts/fold-root-drift-check.mjs --stamp
```

期望：`{"mismatch":0,"ok":true,"stamped":true,"writeGen":<新的世代鍵>,"dataVersion":{"rows":…,"maxPostId":…,"rootsMd5":"…","writeGen":…}}`、rc=0。
若 `mismatch != 0`，這一步會**拒絕寫**戳記（`stamped:false`、`stampSkippedBecause:"mismatch_nonzero"`）
⇒ 回到 2.2 再回填一次。

---

## 3. 影響面

1. **會 UPDATE 的列**：119 列（= `stored IS DISTINCT FROM fresh`），分成
   117 列「NULL → 非 NULL」與 2 列「非 NULL → 另一個非 NULL」；`stored IS NOT NULL AND fresh IS NULL` 是 **0 列**。
   （指令與輸出見 §1.2／§1.3。）
2. **`settings.foldRootWriteGen` 會被 +1 一次**（`batches=1`，因為 119 < 2000）。
   這是刻意的：任何一次真的改到固化欄的寫入都會讓既有戳記失效（fail-closed）。
3. **對 `settings.foldRootDriftStamp` 的影響**：**必然失效**（回填會把 `writeGen` +1）。
   線上判定是**依序**的，所以實際會看到哪一個 `reason` 取決於戳記的新舊：
   - 針對**現在線上那張 10-14 的舊戳記**：`dataVersion.rows=202136` 對不上線上的 21 萬多列，
     判定在第一關就停住 ⇒ `reason=fold_root_drift_stamp_stale`（這就是我實測到的 reason）。
   - 針對**剛蓋好的新戳記**：若之後又發生原地改 root（列數與 `max(post_id)` 都不變），
     第一關會過、第二關的 `writeGen` 對不上 ⇒ `reason=fold_root_drift_stamp_gen_stale`（隔離庫實測）。
   ⇒ **回填後一定要接 2.3 的 `--stamp`**，否則閘門維持關閉。
   （這兩種失效我在隔離庫都實際跑了出來：§6.3／§6.6 的前兩列。）
4. **對 SQL-first 開閘的因果**（照程式碼順序講清楚）：
   - 閘門開關是 `PUBLIC_LISTINGS_SQL_FIRST=1`（`v3/src/publicListingSearchAsync.js:30`）。
   - 閘門開著但依賴不成立 ⇒ `foldSqlGateReady()` 回 `ok:false` ⇒
     丟 `ListingSearchUnavailableError` ⇒ HTTP **503**，並且**不降級**回 Node 路徑（`...:33-36`）。
   - 閘門**關著**（現在的情形）⇒ `tryPublicListingsSqlFirst()` 第一行就回 `null` ⇒
     訪客改走 Node 路徑（`v3/src/publicListingSearchAsync.js:90-96`），**不讀固化欄當分組鍵**
     （`v3/src/listingCandidateRow.js:52-54` 明言固化欄不進候選載體）
     ⇒ 這 119 列在閘門關閉時**對訪客清單沒有可見影響**。
   - 因此本次回填的「顧客可見」效益要等到閘門真的開著、而且戳記有效的那段時間才會出現。
   - 我**沒有**在正式站開閘實測這件事（紅線），列為未驗證（附錄 C 第 5 條）。
5. 附帶觀測：這 119 列裡 **0 列**會「摺進另一個分量」（`folds_into_another_component` = 0），
   2 列是「指向自己分量裡的舊 root」⇒ 這次落後的形狀是**把同一群拆開**，不是把不同屋源併在一起；
   影響面是 84 個分量會被多顯示列數（實際可見列數取決於篩選與 `offline` 狀態，未逐一驗證）。

---

## 4. 驗證

### 4.1 全量 drift 歸零（唯讀，**不** `--stamp`）

```bash
export PGOPTIONS="-c default_transaction_read_only=on" ALLOW_PRODUCTION_PG_TARGET=1
node v3/scripts/fold-root-drift-check.mjs
```
期望：`{"mismatch":0,"ok":true,"stamped":false}`、rc=0。非 0 ⇒ 回 2.2 重跑再驗。

### 4.2 開閘前檢（唯讀，四項一次驗完）

```bash
node v3/scripts/fold-gate-stamp-verify.mjs
```
期望 `checks` 全部 `true`：`column_present`、`stamp_present`、`stamp_mismatches_zero`、
`dataVersion_match`（`rows`／`maxPostId`／`rootsMd5` 三者逐項相同）、`writeGen_match`、`gate_ok`，rc=0。
我在隔離庫的實跑長相見 §6.7。

### 4.3 抽樣面（唯讀）

```bash
node v3/scripts/projection-freshness-check.mjs 200 --read-only
```
看 `foldRoot` 欄：期望 `{"sampled":200,"mismatch":0}`。
⚠️ 這支腳本的 `pass` 另外綁 `listings` 與 `listing_search_projection` 的**筆數相等**，
正式庫現在是 213,675 vs 213,683（差 8）⇒ `pass=false`、rc=1，**與 foldRoot 無關**（§7.6）。

### 4.4 抽樣 3 列前後值對照（隔離庫演練的實測；正式庫用同一條查詢）

```sql
SELECT post_id, fold_component_root FROM listings WHERE post_id IN (1174505, 2681139526, 2686685348) ORDER BY post_id;
```
隔離庫演練的實測（照 `post_id` 排序：1174505 / 2681139526 / 2686685348）：
回填前 `2681139526 / NULL / 2675228268` → 回填後 `NULL / 2681139526 / 2681139526`，與重算值一致。

### 4.5 開閘後（只有 Owner 做，**我未實測**）

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'https://jibbyrenth.reversalplay.me/api/public/listings?limit=3'
ssh casa-nas "docker logs --since 5m 591-tracker-v3 2>&1 | grep -c '\[fold-gate\]'"
```
期望 200 且 `[fold-gate]` 行數 0；關閘程序見 `docs/runbooks/5151_same_house_fold_deploy.md` §5.1。

---

## 5. 回復（rollback）

### 5.1 「回到舊值」怎麼做（**可執行**，正式庫版本標未實測）

回填是**冪等重算**，不是累加式的破壞；要回到舊值只能「把舊值寫回去」。分兩步：

**第 1 步：回填前先 DUMP（唯讀；代理人可跑）**

```bash
cd /home/cline/lab/5151-backfill-plan
set -a; . /home/cline/.secrets/apps/5151-prod-casaos.env; set +a
export PGOPTIONS="-c default_transaction_read_only=on"
PROBE_URL="$PG_URL" REPO="$PWD" DUMP=/tmp/5151-drill/mismatch-rows.json \
  node /tmp/5151-drill/impact.mjs > /tmp/5151-drill/impact-before.json
```

產出 `/tmp/5151-drill/mismatch-rows.json`＝119 筆 `{"post_id":…,"stored":…}`（**回填前**的值）。

**第 2 步：要回滾時（Owner 執行；必須可寫）**

```bash
cat > /tmp/5151-drill/rollback.mjs <<'EOF'
// 回滾：把 ARTIFACT（[{post_id, stored}]）的舊值寫回，並（--bump）把寫入世代鍵 +1。
import pg from "pg";
import fs from "node:fs";
const items = JSON.parse(fs.readFileSync(process.env.ARTIFACT, "utf8"));
const bump = process.argv.includes("--bump");
const client = new pg.Client({ connectionString: process.env.PROBE_URL, application_name: "5151-rollback" });
await client.connect();
const ro = (await client.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only;
if (ro !== "off") { console.log(JSON.stringify({ aborted: true, reason: "need_writable_session", ro })); process.exit(2); }
await client.query("BEGIN");
try {
  for (const item of items) {
    await client.query("UPDATE listings SET fold_component_root = $2 WHERE post_id = $1",
      [Number(item.post_id), item.stored == null ? null : Number(item.stored)]);
  }
  if (bump) await client.query("UPDATE settings SET value = CAST(COALESCE(CAST(value AS bigint), 0) + 1 AS text) WHERE key = 'foldRootWriteGen'");
  await client.query("COMMIT");
} catch (error) { await client.query("ROLLBACK"); throw error; }
const gen = (await client.query("SELECT value FROM settings WHERE key = 'foldRootWriteGen'")).rows[0]?.value ?? null;
console.log(JSON.stringify({ at: new Date().toISOString(), applied: items.length, writeGenBumped: bump, writeGenAfter: gen }));
await client.end();
EOF
unset PGOPTIONS                                 # 回滾必須是可寫連線
cd /home/cline/lab/5151-backfill-plan
set -a; . /home/cline/.secrets/apps/5151-prod-casaos.env; set +a
ALLOW_PRODUCTION_PG_TARGET=1 PROBE_URL="$PG_URL" ARTIFACT=/tmp/5151-drill/mismatch-rows.json \
  node /tmp/5151-drill/rollback.mjs --bump
```

最後那一句（`foldRootWriteGen` +1）是**必要**的：只寫回 root、不動世代鍵，線上開閘前檢會**完全看不到**
（實測：`mismatch=3` 但 `gate_ok=true`，見 §6.6 的 fail-open 證據）。它與程式用的是同一句 SQL
（`v3/src/foldComponentRoot.js` 的 `FOLD_WRITE_GEN_BUMP_SQL`）：

```sql
UPDATE settings SET value = CAST(COALESCE(CAST(value AS bigint), 0) + 1 AS text) WHERE key = 'foldRootWriteGen';
```

> 這一段的**機制已在隔離庫完整實測**（製造落後 → 回填 → 蓋戳記 → 回滾 → 觀察閘門，見 §6.6），
> 但**正式庫的回滾我沒有執行**（紅線），列為未實測（附錄 C 第 6 條）。

**另一條路（不建議）**：從 predeploy 的 PG 備份整庫還原
（`.github/workflows/production-predeploy-check.yml` 第 310 行「PostgreSQL backup from current primary」）。
代價是「整套庫回到 predeploy 當下、且會覆蓋 predeploy 之後的所有爬蟲資料」，
為了 119 列做這件事不成比例；而且**沒有 PITR**（`archive_mode=off`，見
`docs/handoffs/pg-wal-pitr-runbook-20260924.md` 第一節），所以無法「回到事故前一分鐘」。

### 5.2 無法回滾的東西（明列）

| 項目 | 為什麼無法回滾 | 可以怎麼補 |
|---|---|---|
| `settings.foldRootWriteGen` 已經 +1 | 單調遞增、沒有「減回去」的路徑；回滾若照 §5.1 再 +1，值只會更大 | 不需要回滾：它只是「戳記有效性」的憑證，值大不代表資料錯 |
| `settings.foldRootDriftStamp` 的舊內容被覆寫 | 由 `--stamp` 以 `ON CONFLICT DO UPDATE` 覆蓋 | 舊值我已記在本文件 §1.2 表格（`at=2026-10-14T05:51:06Z`、`rows=202136`、`writeGen=58`、`dataVersion.rootsMd5=76281e3f…`）；要人工寫回可以，但寫回舊戳記的線上效果仍然是 `stale` |
| 119 列的舊值 | 只存在於 §5.1 第 1 步的 dump | 沒先 dump 就只能靠 predeploy 備份整庫還原 |
| 「回填 ↔ 爬蟲寫入」的時序 | 期間爬蟲持續寫入，**不可能**回到「回填前的那一瞬間的整庫狀態」 | 這是取捨，不是缺陷 |

---

## 6. 在隔離庫的演練證據（**已實跑**）

環境：`prb-repro-pg` 的 `repro` 資料庫（`/home/cline/.secrets/postgres/5151-live-repro.env` 的 `PG_LIVE_REPRO_URL`），
184,754 列、91,299 筆群組成員（`listing_group_members`）、`enabledSources` 同正式庫。
演練用的製造／回滾腳本在我自己的 lab 目錄，**不在 repo**（本次 PR 只加這一份文件）。

### 6.1 基準（乾淨）

```
$ node v3/scripts/fold-root-drift-check.mjs
{"listings":184754,"groupMembers":91299,"nonNullStored":97184,"components":27955,"mismatch":0,"ok":true,"stamped":false}   rc=0
$ 讀 settings：foldRootWriteGen=4、foldRootDriftStamp={"at":"2026-10-12T10:58:47.946Z",…,"mismatches":0}（舊式戳記，沒有 dataVersion）
```

### 6.2 刻意製造三種落後（每種一列）

```
種類 1（應非 NULL 但被清成 NULL）：post_id 2681139526，原值 2681139526 ⇒ 改成 NULL
種類 2（指向別的 root）        ：post_id 2686685348，原值 2681139526 ⇒ 改成 2675228268
種類 3（應為 NULL 但被塞值）   ：post_id 1174505，原值 NULL ⇒ 改成 2681139526
```

### 6.3 修復前 → 修復後（**前後 mismatch 與耗時**）

```
$ PGOPTIONS="-c default_transaction_read_only=on" node v3/scripts/fold-root-drift-check.mjs
{"mismatch":3,"mismatchIds":[1174505,2681139526,2686685348],"ok":false}      rc=1    wall 1.985 s
$ env -u PGOPTIONS node v3/scripts/fold-root-backfill.mjs
DDL ensured: 2 statements
listings=184754 group_members=91299 batchSize=2000
components=27955 members_materialized=97184 differ=3
{"total":184754,"batches":1,"written":3,"unchanged":184751,"ms":1923,"perRowMs":0.0104}   rc=0  wall 2.009 s
$ PGOPTIONS="-c default_transaction_read_only=on" node v3/scripts/fold-root-drift-check.mjs
{"mismatch":0,"ok":true,"stamped":false}                                     rc=0    wall ~1.9 s
$ 讀 settings：foldRootWriteGen 4 → 5（只 +1，因為只有 1 個非空批次）
```

同樣的 3 列再跑一輪（第二次）：`differ=3 → written=3`（`ms=1982`、wall 2.067 s），`writeGen 5 → 6`，
`mismatch 3 → 0`。三列前後值對照：

| post_id | 造落後後 | 回填後 | 重算值（fresh） |
|---|---|---|---|
| 1174505 | 2681139526 | `NULL` | `NULL` |
| 2681139526 | `NULL` | 2681139526 | 2681139526 |
| 2686685348 | 2675228268 | 2681139526 | 2681139526 |

### 6.4 `--stamp` 在 mismatch ≠ 0 時拒絕寫入（實測）

```
$ env -u PGOPTIONS node v3/scripts/fold-root-drift-check.mjs --stamp
{"mismatch":3,"ok":false,"stamped":false,"stampSkippedBecause":"mismatch_nonzero"}          rc=1
$ 讀 settings：foldRootDriftStamp 仍是舊的 {"at":"2026-10-16T10:16:06.686Z",…,"writeGen":7}
```

### 6.5 冪等（沒有差的時候重跑）

```
$ env -u PGOPTIONS node v3/scripts/fold-root-backfill.mjs
{"total":184754,"batches":0,"written":0,"unchanged":184754,"ms":2024,"perRowMs":0.011}       rc=0
$ 讀 settings：foldRootWriteGen 沒有變（沒有非空批次 ⇒ 不 bump）
```

### 6.6 回填之後戳記的兩種失效 ＋ 「不 bump 世代鍵」的 fail-open（實測）

| 情境 | 觀察到的判定 |
|---|---|
| 回填後、尚未 `--stamp`（舊式戳記沒有 `dataVersion`） | `dataVersion_match=false`、`writeGen_match=false`、`gate.ok=false`、`reason=fold_root_drift_stamp_stale` |
| 蓋完新戳記後再做一次回填（列數與 `max(post_id)` 都不變、只有 root 原地改變） | `dataVersion_match=true`（`rootsMd5` 剛好相同）、`writeGen_match=false`、`gate.ok=false`、`reason=fold_root_drift_stamp_gen_stale`（`stampedWriteGen=6`、`liveWriteGen=7`） |
| **把 root 回滾成落後值、但故意不 bump 世代鍵** | `mismatch=3`，離線檢查 `dataVersion_match=false`（`rootsMd5` 變了），但 **`writeGen_match=true`、`gate_ok=true`（`reason=null`）** ⇒ 線上開閘前檢會**放行**一份已經落後的資料 |
| 補上世代鍵 +1 之後 | `writeGen_match=false`、`gate.ok=false`、`reason=fold_root_drift_stamp_gen_stale` |

> 第三列是這份文件最有價值的一條實測：**任何繞過 `bumpFoldRootWriteGen()` 的固化欄寫入都是 fail-open**。
> 這正是規格 §1.2「`rootsMd5` 沒有進線上檢查（全表聚合太貴）」的代價——
> 而 `fold-root-backfill.mjs` 與刷新鏈都有 bump，所以回填本身沒有這個問題；**手動回滾才有**。

### 6.7 演練收尾（戳記有效、閘門會放行）

```
$ env -u PGOPTIONS node v3/scripts/fold-root-drift-check.mjs --stamp
{"mismatch":0,"ok":true,"stamped":true,"writeGen":13,"dataVersion":{"rows":184754,"maxPostId":2699975575,"rootsMd5":"57e1a5fc…","writeGen":13}}   rc=0
（`--stamp` 的 wall 時間另一次實測是 2.315 s）
$ PGOPTIONS="-c default_transaction_read_only=on" node v3/scripts/fold-gate-stamp-verify.mjs
{"checks":{...全部 true…},"liveWriteGen":13,"gate":{"ok":true,"reason":null,...},"ok":true}    rc=0
```

### 6.8 用演練數字估正式庫的執行時間（**唯一可信的估計來源**）

| 量測 | 隔離庫（184,754 列） | 正式庫（213,6xx 列） |
|---|---|---|
| 全表重算＋逐列比對（drift-check） | 1.92～2.00 秒 | **4.076 秒（直接實測，唯讀）** |
| 全表回填（含 1 批 119 列 UPDATE） | 1.86～2.07 秒（`--stamp` 另加 md5 指紋） | 估 **4～6 秒**（＝實測的掃描時間 4.076 秒 ＋ 119 列 UPDATE；列數比 1.16 倍） |
| `--stamp`（drift-check ＋ 全表 md5 聚合） | 2.315 秒 | 估 **5～7 秒**（md5 那條在正式庫實測 848 ms、`statement_timeout=15000` 下不會逾時） |

⇒ 整個流程（回填 ＋ 蓋戳記）預估 **10～15 秒**；每一步都冪等、可中斷重跑。

---

## 7. 風險與未解

1. **回填只覆蓋「當下算出來的差」⇒ 一定會再落後。**
   落後的來源是邊集合改變（新 match 邊、群組成員進出、`display_ready`／來源啟停），
   爬蟲每輪都在製造這種改變。實測：正式庫 11 分 41 秒內 `listings` 從 213,618 增加到 213,674（+56 列）。
   ⇒ 回填是**一次性的資料修正**，不是「設好就不再落後」。
2. **爬蟲每 20 分鐘寫入（實測節奏：本輪抓取約 33 分鐘、每輪都有新增）**。
   只要新增任一列，戳記的 `rows` 就對不上 ⇒ 開閘狀態下的訪客清單會回到 503。
   ⇒ **「開閘」與「回填」之間的時間窗很短**，實務上必須先想清楚誰在幾分鐘內重蓋戳記。
3. **`writeGen` 與戳記的競態（不是理論，是實測）**：
   `settings.foldRootWriteGen` 在 18:14:01 → 18:16:30 之間從 7,291 變成 7,292（**2.5 分鐘 +1**），
   代表刷新鏈一直在原地改 root。戳記一旦寫下，任何一次刷新都會讓它變成 `gen_stale`（503）。
   ⇒ 目前「沒有排程重蓋戳記」（runbook §1.2 明列為未實裝、Owner 2026-10-12 裁示先人工）
   與「開閘要戳記有效」這兩件事**互相矛盾**；這是這個計畫真正的未解問題。
4. **開閘 vs 關閘的取捨**：
   - 關閘（現況）：訪客走 Node 路徑，回 200（實測），固化欄落後對訪客不可見；代價是捨棄 SQL-first 的效能優勢。
   - 開閘：SQL-first 上線，但依賴「戳記在當下有效」⇒ 依 §7.2／§7.3，訪客會**間歇性**拿到 503（fail-closed，不降級）。
   - 需要 Owner／架構方決定的是「戳記重蓋策略」（排程重蓋？縮短依賴？接受間歇 503？），
     而不是「要不要回填」——回填在兩邊都是便宜的（119 列、約 5 秒、閘門關閉時對訪客零影響）。
5. **未驗證的讀取端**：除了 SQL-first，`v3/src/repository/decorationData.js:468`（裝飾載體）與
   `v3/src/watchLimitsAsync.js:94`（追蹤數上限的群去重）也讀這一欄。
   這些路徑在閘門關閉時對 119 列的行為差異，我**沒有**逐一驗證 ⇒ 未驗證。
6. **另一個獨立觀測（與本計畫無關，只是照實記錄）**：
   正式庫 `listing_search_projection`（213,683）比 `listings`（213,675）**多 8 列**，
   因此 `projection-freshness-check.mjs` 的 `pass=false`、rc=1。
   這不是 foldRoot 的問題，我沒有追下去（超出本任務範圍）。
7. **正式庫的寫入步驟全部未實測**（回填、`--stamp`、回滾、開閘）：這是紅線造成的，
   不是遺漏；對應的機制都在隔離庫跑過（§6），並且我把「未實測」逐條列在附錄 C。

---

## 附錄 A：本文件每條指令的實測狀態

| 指令 | 對正式庫 | 對隔離庫 | 狀態 |
|---|---|---|---|
| §1.1 `ro-guard.mjs`（唯讀正控制） | 跑過（`BLOCKED 25006`） | 跑過（`BLOCKED 25006`；拿掉 PGOPTIONS 則 `ALLOWED`） | ✅ 實測 |
| §1.2 `fold-root-drift-check.mjs` | 跑過（mismatch=119、4.076 s） | 跑過 | ✅ 實測 |
| §1.2 `fold-gate-stamp-verify.mjs` | 跑過（`fold_root_drift_stamp_stale`） | 跑過（含四項全過） | ✅ 實測 |
| §1.2 `projection-freshness-check.mjs 200 --read-only` | 跑過（`foldRoot` 0/200、`pass=false`） | 未跑 | ✅ 實測（正式庫） |
| §1.2 `curl /api/public/listings`、`ssh … docker inspect` | 跑過（200、`=0`） | — | ✅ 實測 |
| §1.3 `impact.mjs`（影響面分類） | 跑過（119／117／2／84） | 未跑 | ✅ 實測（正式庫） |
| §2.2 `fold-root-backfill.mjs` | **未跑（紅線）** | 跑過（多輪，`differ=3 → written=3`） | ⚠️ 隔離庫實測、正式庫未實測 |
| §2.3 `fold-root-drift-check.mjs --stamp` | **未跑（紅線）** | 跑過（含拒寫情境） | ⚠️ 同上 |
| §5.1 `rollback.mjs` | **未跑（紅線）** | 跑過（含 fail-open 情境） | ⚠️ 同上 |
| §4.5 開閘後 curl／log 檢查 | **未跑（閘門是關的、且開閘只有 Owner 能做）** | — | ❌ 未實測 |
| predeploy 整庫備份還原 | 未跑 | 未跑 | ❌ 未實測 |

## 附錄 B：這次量測產生的證據檔（都在 cline-server 本機，不在 repo）

- `/home/cline/lab/5151-backfill-plan-probe/evidence/measure-prod.txt`（正式庫現況 ＋ 指紋）
- `…/measure-prod-impact.json`（119 列分類）
- `…/measure-prod-gate.json`（正式庫開閘前檢）
- `…/measure-prod-projection-freshness.json`
- `…/drill-*.txt`（隔離庫每一輪的完整輸出，含 `drill-3-backfill.txt`、`drill-10-stamp.txt`、
  `drill-14-gate-gen-stale.txt`、`drill-30-gate-fail-open.txt`、`drill-33-final.txt`）

## 附錄 C：明確未實測清單（不得含糊）

1. 正式庫的回填、`--stamp`、任何 DML／DDL——**一條都沒跑**（只跑 SELECT ＋ 一個必然失敗的 `CREATE TEMP TABLE`）。
2. 正式庫的「拿掉 PGOPTIONS ⇒ 允許寫入」反向控制（反向控制只在隔離庫做）。
3. 正式庫回填腳本的兩句 DDL 行為（我唯讀確認欄位與索引都已存在，但沒有實際執行那兩句）。
4. 「帶著唯讀 PGOPTIONS 去跑回填」會失敗的實測（推論來自 `CREATE TEMP TABLE` 的 25006；
   我沒有在正式庫真的試著回填）。
5. 開閘後的訪客清單 200／`totalMatched` 是否與關閘前相同（需要 Owner 開閘，且需要戳記在有效窗口內）。
6. 正式庫的回滾程序（機制在隔離庫驗證過）。
7. `decorationData`／`watchLimitsAsync` 兩條讀取端在固化欄落後時的行為差異。
8. 這 84 個受影響分量在真實訪客篩選條件下「會多顯示幾列」——只驗證了分類與分量大小，沒有跑端點對照。
