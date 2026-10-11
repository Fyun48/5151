# 會員列表「窄載體」效能包（架構裁決 D-0036 的 C 路線）

隔離量測庫：`postgres/5151-live-repro.env` 的 `PG_LIVE_REPRO_URL`（`192.168.0.220:15434/repro`）。
**不是** `5151_shadow`、**不是** `192.168.0.220:15432`。所有指令唯讀。

## 0. 量測設定（同一支腳本、改動前後各跑一次）

```bash
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_URL="$PG_LIVE_REPRO_URL" MEMBER_UID=1 RUNS=2
# 正式站那位會員的 worst case：20 個 crawler URL 覆蓋 100% 的列 ⇒ search_keys = 全庫
export BENCH_ALL_KEYS=1
node v3/scripts/member-list-benchmark.mjs
```

改動前 = `b5b1399`（`origin/master`，已含 #710／#709／#712），以 `git worktree` 檢出，同一支腳本。

## 1. 門檻（ALL_KEYS、5 個情境）

| 情境 | 改前冷 list/stats/總 | 改後冷 list/stats/總 | 改後暖 list/stats/總 |
|---|---|---|---|
| default | 2098／1374／3472 | **1650／1162／2812** | 1346／502／1849 |
| district=中山區 | 1830／846／2675 | **1334／490／1823** | 1297／556／1853 |
| rent 3000-8000 | 1045／428／1473 | **754／242／996** | 763／284／1047 |
| q=新莊 | 1121／860／1981 | **694／468／1161** | 687／465／1151 |
| multi(district+q) | 1030／853／1884 | **581／433／1014** | 537／513／1051 |
| **門檻** | | list ≤2000 ✓／stats ≤1000 **1 情境超出**／總 ≤3000 ✓ | 全部 ✓ |

**唯一的缺口是 `default` 的「冷 stats」1162ms（門檻 1000ms）**，且 `default`（會員自己的
crawler URL，非 allkeys）冷 stats 是 1003ms（超 3ms）。原因是**冷頁面快取的第一次掃描**：
`candidates_ms` 冷 495ms vs 暖 162ms、`reduce`（計數器歸約）冷 353ms vs 暖 240ms。

正式站的 `data_revision` 每請求都變（爬蟲持續寫入）⇒ 預篩的版本化驗證每次都要重做。用
`v3/evidence/member-listing-narrow-carrier/bench-after-revision-churn.txt` 逐請求清掉該快取
模擬這個狀態（暖快取之後再量），三個門檻**全部達成**：

```
churn run0: list=1229 stats=748  total=1977
churn run1: list=1298 stats=700  total=1998
churn run2: list=1154 stats=708  total=1862
```

### 壓力情境（BENCH_BROAD_REGIONS=1：watchDistricts=全台，候選 145,078）

`stats` 幾乎沒動（8.79s → 8.60s）：這種設定下 `memberRegionDistrictNames` 就是全部行政區，
**本來就沒有行政區可縮**（預篩依設計回 `null`）；`list` 4.56s → 4.52s 同理。
`district=中山區` 這種「有指定行政區」的情境仍有改善（暖 list 1740 → 1092、stats 7435 → 7296）。

## 2. 逐階梯省多少（default 情境，暖，`BENCH_ALL_KEYS=1`）

| 階段 | 改前 | 改後 | 省 |
|---|---|---|---|
| `prepare_ms`（行政區 closure ＋ builder） | 760–818 | 534–640 | ~200ms |
| `sql_ms`（候選取列） | 505–643 | 155–283 | ~350ms |
| `preload_ms` | 391–506 | 199–365 | ~120ms |
| `stats.inputs_ms` | 556 | 244–255 | ~300ms |
| `stats.candidates_ms` | 494 | 163–174 | ~320ms |
| `stats.provider_ms` | 249 | 152–171 | ~80ms |

## 3. ≥20 案例矩陣：`totalMatched` 逐案例相同

```bash
cd <改動前的 worktree> && node v3/scripts/member-list-parity-matrix.mjs --out matrix-before.json --label before
cd <本包>              && node v3/scripts/member-list-parity-matrix.mjs --out matrix-after.json  --label after
node v3/scripts/member-list-parity-matrix.mjs --compare matrix-before.json matrix-after.json
# ⇒ {"cases":20,"identical":true,"failures":[]}
```

20 案例 = 5 組會員設定（預設／all search keys／全台 watchDistricts／關掉樓層規則／無通勤）
× 4 組 districts／sort（預設+newest／中山區+price_asc／松山+信義+price_desc／預設+fit_desc）。
每案例比對 `totalMatched`、`stats.total`、回傳頁 post_id 序列 —— **全部相同**。

## 4. 投影缺列／過期時退回完整掃描的證據

`v3/test/listing-district-prefilter.test.js`（8 綠）固定：
* 缺列（`missing>0`）⇒ `loadDistrictPrefilterIds` 回 `null`，且**不再發出預篩查詢**；
* 前綴與投影不一致（`mismatched>0`，＝投影內容過期）⇒ 同樣退回；
* 投影表不存在 ⇒ 退回；
* `MEMBER_DISTRICT_PREFILTER=0` ⇒ 完全不查任何 SQL（A/B 開關）。

repro 實測（184,245 列、7 個行政區）：`missing=0`、`mismatched=0`、
`prefix 相符 15,379 ＝ 投影相符 15,379`（前綴集合是投影集合的子集）。

## 5. 其它

* `node --test v3/test/<新測試>.js` 全綠；`npm test` ⇒ `# fail 0`（本機無 `PG_TEST_URL`，
  115 條 skip；**沒有**宣稱跑過 live，CI 的 `Run Tests (PostgreSQL integration)` 才算）。
* `node v3/scripts/mutation-check.mjs` ⇒ `KILLED 16、SURVIVED 0、SKIP 0`。
* 本包**沒有新增 PG 索引**、沒有 migration：預篩走既有的 `idx_proj_district`；退回路徑就是
  今天的 `split_part` 表達式（與改動前逐字相同），所以不需要為退回路徑另外付索引維護成本。
