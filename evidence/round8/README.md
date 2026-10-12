# 第 8 輪（最後一輪）：§6.10 兩條殘餘軸收乾淨 — 可重跑證據

- 分支：`fold-role-component`，基準 commit `a4cf0ee`（第 7 輪）。
- 目標庫：`prb-repro3-pg` 的 `repro`（`192.168.0.220:15435/repro`，`listings` 184,754 列）。
- 憑證：只從 `/home/cline/.secrets/postgres/5151-live-repro.env` 取，值不進 repo。下列指令的
  `PG_URL` 由該檔的 `PG_SNAPSHOT_REPRO2_URL` 換 port／db 產生：

```bash
cd /tmp/5151-fold-078ed6c3
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_URL=$(node -e 'const u=new URL(process.env.PG_SNAPSHOT_REPRO2_URL); u.port="15435"; u.pathname="/repro"; process.stdout.write(u.toString())')
export DATA_DIR=$(mktemp -d)
```

## 1. 軸一：形狀 fixture（Node vs SQL，資格軸＋tie-break 軸）

```bash
cd /tmp/5151-fold-078ed6c3 && node v3/scripts/fold-shape-fixtures.mjs
```

- 結果：`rc=0`、`{"allOk":true,"total":53,"residualRows":0}`（→ `fold-shape-fixtures.log`）。
- ⑨a 資格軸（XE：`source=''`＋`source_id` 有值＋租金 10000；對端 `source='591'`＋租金 30000，
  同群）：`node=9100000031 sql=9100000031 ok=true`（**自然啟用清單，不含 `''`**；「把 `''` 塞進
  啟用清單」的 trick 已從 fixture 移除）。
- ⑨b tie-break 軸（TE／TN 租金＋更新時間＋`last_seen_at` 全平手）：`node=9100000021 sql=9100000021 ok=true`。

### 1b. 反向對照（證明這兩條斷言會擋）

把 `v3/src/listingSearchSql.js` 暫時還原成修前版本（`git show HEAD:v3/src/listingSearchSql.js`）
再跑同一支：`rc=1`、`allOk:false`，⑨a `sql=9100000032`（選到 XN）、⑨b `sql=910000021`（選到 TN）
（→ `negative-control-old-sql.log`）。跑完已還原（md5 與備份相同）。

## 2. 軸一：真實資料零影響（35 combo 逐筆比對）

```bash
cd /tmp/5151-fold-078ed6c3 && node v3/scripts/fold-endpoint-parity.mjs
```

- `rc=0`、`{"total":35,"allOk":true,"failed":[]}`（→ `parity-r8.log`）。
- 與第 7 輪參考 `parity.log`（→ `parity-reference-a4cf0ee.log`）逐筆比對：
  `totalMatched_diff_combos=0`、`missing=[]`、`extra=[]`（35/35 `nodeTotal` 與 `sqlTotal` 完全相同）。
- 理由：`repro3` 上 `source` 為空字串或 NULL 共 **0 列** ⇒ 這條修改對真實資料必須零影響。

## 3. 軸二：collation 量化（唯讀）

```bash
cd /tmp/5151-fold-078ed6c3 && node v3/scripts/fold-tiebreak-collation-probe.mjs
```

→ `collation-probe.log`：

- 多成員群 27,638 群／95,322 列；勝負由 `last_seen_at` 字串層決定 4,421 群／11,100 列；
  由 tie-break key 字串層決定 **0 群／0 列**。
- `winnerDiffs` 全 0：`pgDefault_vs_pgC=0`、`nodeLocaleCompare_vs_pgDefault=0`、
  `nodeLocaleCompare_vs_pgC=0`、`nodeLocaleCompare_vs_nodeCodePoint=0`；`divergencesTotal=0`。
- `last_seen_at` 格式：寬度直方圖只有 `{octets:24, n:184754}`、`notIsoFixedWidth=0`、
  `groupsWithMixedWidths=0` ⇒ 定寬 ISO8601，字串序＝時間序。
- 純 SQL 交叉驗算（與逐群 JS 判定獨立）：`multi_member_groups=27638`、
  `seen_layer_groups_any_position=9201`、`key_layer_groups=0`。

## 4. CI 守門（合成種子）

```bash
cd /tmp/5151-fold-078ed6c3 && DATA_DIR=$(mktemp -d) node v3/scripts/fold-ci-parity.mjs
```

- `rc=0`、`{"total":16,"failed":[],"allOk":true}`（→ `fold-ci-parity.log`）；新增 4 條：
  ⑫ tie-break 軸、⑬ 資格軸、⑭ collation 軸 ×2（`A-B` vs `AB`、`x.y` vs `xy`）。
- 反向對照（修前 SQL）：`rc=1`、`allOk:false`，⑫ `sql=920000041`、⑬ `sql=9200000052`
  （→ `fold-ci-parity-negative-control.log`）。

## 5. Drift 與離線測試

```bash
cd /tmp/5151-fold-078ed6c3 && node v3/scripts/fold-root-drift-check.mjs        # 不加 --stamp
cd /tmp/5151-fold-078ed6c3 && node --test v3/test/fold-sql-gate.test.js v3/test/fold-gate-transaction-live-pg.test.js v3/test/same-house-fold-sql.test.js
```

- drift：`rc=0`、`{"listings":184754,"nonNullStored":97171,"components":27951,"mismatch":0,"ok":true,"stamped":false}`
  （→ `fold-root-drift-check.log`）。
- 三支測試：`rc=0`、`tests 20 / pass 20 / fail 0`（→ `unit-three.log`）。

## 6. npm test（開閘門檻，load < 6 才跑）

第一次跑（`npm-test-r8.log`）是**無效的**：我在同一個 shell 先 `export PG_URL` 再 `npm test`，
`v3/src/runtimeGuards.js` 的 `assertRuntimeDbGuard` 看到 `PG_URL` 但 `DB_DRIVER` 預設 sqlite ⇒
任何呼叫 `runWatch` 的測試在啟動就 throw（6 條假紅，錯誤字串都是
`[runtime-guard] 啟動拒絕：偵測到 PG 連線環境變數（PG_URL）…`）；
另有 1 條 `PR A src manifest matches git tree`，那是 `v3/src` 的 manifest 閘門
（`.github/scripts/pra-src-manifest.py` 比對工作樹 vs git HEAD）在**尚未 commit** 時必然紅。

乾淨重跑（`load_before=4.53` < 6、`unset PG_URL`、已 commit `e7d0e96`）：

```bash
cd /tmp/5151-fold-078ed6c3 && unset PG_URL; export DATA_DIR=$(mktemp -d); npm test
```

- `rc=0`、`# tests 4114 / # pass 3992 / # fail 0 / # cancelled 0 / # skipped 122`、
  `duration_ms 1281014`（→ `npm-test-r8-clean.log`）。
- 兩條假紅的逐條歸因與單檔重跑：
  | 檔名 | test 名 | 第一次實測 | 低負載單獨重跑 |
  |---|---|---|---|
  | `v3/test/crawl-round-integration.test.js` | runWatch 真的跑完一輪／來源被擋到停工／階段預算用盡／591 覆蓋階段到點停手（4 條） | runtime-guard（PG_URL 污染） | `rc=0`、8/8 pass |
  | `v3/test/crawl-round-telemetry.test.js` | 加 log 不改變行為／下架掃描小預算（2 條） | runtime-guard（PG_URL 污染） | `rc=0`、8/8 pass（與上列同一次） |
  | `v3/test/activate-rental-marketplace-pra-workflow.test.js` | PR A src manifest matches git tree and fails closed… | `v3/src manifest mismatch: changed ["listingSearchSql.js"]`（未 commit） | commit 後 `rc=0`、11/11 pass |

## 7. CI（commit `e7d0e96`）

- `gh run view 38268026634`：workflow「Tests」**conclusion=success**（headSha `e7d0e96…`）。
- gating step：`Run Tests (PostgreSQL integration) → 8. Same-house fold parity (synthetic seeds, gating)
  → success`；該步 log 內 `{"script":"fold-ci-parity","total":16,"failed":[],"allOk":true}`，
  且 ⑫⑬⑭ 三組新種子逐條 `ok:true`。
- 另一支 workflow「Code review (advisory)」（run `38268026657`）亦 success。

