// 行政區聯通閉包「進程內 TTL 記憶」（策略 H-A）的 **A/B 等價證據**腳本。
//
// 為什麼有這一支：這一包的價值是「同一個請求別再重算 869–927ms 的 closure」，但**快取的風險
// 是語意漂移**（回傳的 id 集合和即時算不一樣）。所以這個腳本用**同一個入口、同一份資料、
// 同一個請求**跑兩側各 N 次（N=3）：
//   * `=0`：`MEMBER_DISTRICT_CLOSURE_MEMO=0` ⇒ 每次都即時算（基準）。
//   * `ON`：預設開關 ⇒ 第一次算，之後命中記憶。
// 然後逐筆比對兩側回傳的 **id 序列完全相同**（L-0845：兩側的差異集合都要列出來、都必須是空），
// 並報 `list_prepare_ms` 的中位數與 compute 的**實際呼叫次數**。
//
// 用法（**自建隔離庫**，L-0863：不得用 `search_path` 假隔離、不得動共用靶 `repro` 的既有物件）：
//   PG_URL=postgres://…/<自建庫> DB_DRIVER=postgres node v3/scripts/closure-memo-ab.mjs
//   可選：DISTRICTS="中山區,大安區"／MEMBER_UID=<id>／RUNS=3
//   連線字串只從環境變數讀；本腳本**不印出連線字串**（只印資料庫名），也**不寫任何 DB**。
//
// 隔離庫的建立／收尾由外面做（本腳本只讀它，不負責建庫；`CREATE DATABASE` 要在維護連線上做）：
//   建立：`CREATE DATABASE <前綴>_<pid>` 然後把基準資料複製進去
//         （實務上：`pg_dump -d repro | psql -d <前綴>_<pid>`，全程**只讀** repro）。
//   收尾：`DROP DATABASE <前綴>_<pid> WITH (FORCE)`——用完一定要收掉，不要留孤兒庫。
//
// 離開碼：任何一項等價比對不成立 ⇒ exit 1（這支是 gate，不是診斷）。
import { mkdtempSync } from "node:fs";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";

// import 任何應用模組之前先隔離 SQLite（`db.js` 會在模組頂層初始化資料檔）。
process.env.DATA_DIR = process.env.DATA_DIR || mkdtempSync(path.join(os.tmpdir(), "v3-closure-memo-ab-"));
process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";
// 會員列表的唯讀快照若被路由到待機庫，兩側就不在同一個資料集上 ⇒ 強制走 primary。
delete process.env.PG_RO_URL;

const PG_URL = process.env.PG_URL || process.env.DATABASE_URL || "";
if (!PG_URL) {
  console.error("closure-memo-ab：需要 PG_URL（指向**自建隔離庫**，不得指向共用靶）");
  process.exit(2);
}
const dbName = (() => { try { return new URL(PG_URL).pathname.replace(/^\//, ""); } catch { return "(unparsable)"; } })();

const RUNS = Math.max(1, Number(process.env.RUNS) || 3);
const DISTRICTS = String(process.env.DISTRICTS || "中山區,大安區").split(",").map(s => s.trim()).filter(Boolean);
const UID = Number(process.env.MEMBER_UID || 1) || 1;

const { sharedPgDriver, closeSharedPgDriver } = await import("../src/pgSharedDriver.js");
const { loadListingPage } = await import("../src/listingSearchPage.js");
const { districtClosureIds, districtClosureIdsMemoized } = await import("../src/listingSearchNodePg.js");
const { toPostgresSql } = await import("../src/sqlDialect.js");

const pg = await sharedPgDriver();
const ARGS = Object.freeze({
  filter: "all", kind: "", sources: "", q: "", sort: "newest",
  limit: 80, offset: 0,
  districts: DISTRICTS,
  userId: UID, matchVoteUserId: UID, sameHouse: true,
});

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

async function runSide(label, memoOn) {
  process.env.MEMBER_DISTRICT_CLOSURE_MEMO = memoOn ? "1" : "0";
  districtClosureIdsMemoized.clear();
  districtClosureIdsMemoized.resetStats();
  const runs = [];
  for (let i = 0; i < RUNS; i += 1) {
    const started = performance.now();
    const page = await loadListingPage(ARGS, { driver: "postgres", pgDriver: pg });
    const wallMs = Math.round(performance.now() - started);
    runs.push({
      wall_ms: wallMs,
      list_ms: Math.round(page.timing.query_ms),
      list_prepare_ms: page.timing.stats_stages?.list_prepare_ms ?? null,
      total_matched: page.timing.dataset ?? null,
      ids: (page.listings || []).map(row => Number(row.post_id)),
    });
  }
  const stats = districtClosureIdsMemoized.stats();
  return { label, memoOn, runs, stats };
}

/** L-0845：兩側差異集合都要列出來（不是只說「有差」）。 */
function symmetricDiff(a, b) {
  const inB = new Set(b);
  const inA = new Set(a);
  return {
    a_only: a.filter(id => !inB.has(id)),
    b_only: b.filter(id => !inA.has(id)),
    same_order: a.length === b.length && a.every((id, i) => id === b[i]),
  };
}

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

console.log(`MemoAB-DB database=${dbName} districts=${DISTRICTS.join("+")} uid=${UID} runs=${RUNS}`);

const off = await runSide("=0 (即時算)", false);
const on = await runSide("ON (TTL 記憶)", true);

// ── 1. 時間：list_prepare_ms 中位數 ────────────────────────────────────────────────
const prepareValues = (side) => side.runs.map(r => r.list_prepare_ms).filter(v => Number.isFinite(v));
for (const side of [off, on]) {
  if (prepareValues(side).length !== RUNS) {
    failures.push(`${side.label}：list_prepare_ms 有 ${RUNS - prepareValues(side).length} 次是 null（共趟未成立 ⇒ 這組情境證明不了 closure 的那一段）`);
  }
}
const offMedian = median(prepareValues(off));
const onMedian = median(prepareValues(on));
console.log(`MemoAB-TIME list_prepare_ms off_runs=[${prepareValues(off).join(",")}] off_median=${offMedian} | on_runs=[${prepareValues(on).join(",")}] on_median=${onMedian}`);
console.log(`MemoAB-TIME wall_ms off=[${off.runs.map(r => r.wall_ms).join(",")}] | on=[${on.runs.map(r => r.wall_ms).join(",")}]`);
console.log(`MemoAB-COMPUTE compute_calls off=${off.stats.computes} on=${on.stats.computes} (hits=${on.stats.hits} misses=${on.stats.misses} shared=${on.stats.shared} size=${on.stats.size})`);

// ── 2. 等價：逐筆比對兩側回傳的 id 序列 ───────────────────────────────────────────
for (let i = 0; i < RUNS; i += 1) {
  const diff = symmetricDiff(off.runs[i].ids, on.runs[i].ids);
  console.log(`MemoAB-IDS run${i + 1} off_n=${off.runs[i].ids.length} on_n=${on.runs[i].ids.length} same_order=${diff.same_order} off_only=[${diff.a_only.join(",")}] on_only=[${diff.b_only.join(",")}]`);
  check(diff.a_only.length === 0, `run${i + 1}：=0 有、ON 沒有的 id ${diff.a_only.length} 筆`);
  check(diff.b_only.length === 0, `run${i + 1}：ON 有、=0 沒有的 id ${diff.b_only.length} 筆`);
  check(diff.same_order, `run${i + 1}：兩側 id 序列順序不同`);
  check(off.runs[i].total_matched === on.runs[i].total_matched, `run${i + 1}：totalMatched 不同（${off.runs[i].total_matched} vs ${on.runs[i].total_matched}）`);
}

// ── 3. 更細一層：closure 陣列本身逐筆比對（會員形狀與訪客形狀各一組）────────────
process.env.MEMBER_DISTRICT_CLOSURE_MEMO = "1";
districtClosureIdsMemoized.clear();
const exec = (sql, params = []) => pg.query(toPostgresSql(sql), params).then(r => r.rows);
for (const shape of [
  { label: "guest(userId=0)", options: { districtNames: DISTRICTS, userId: 0, relatedOnly: false } },
  { label: `member(userId=${UID},relatedOnly)`, options: { districtNames: DISTRICTS, userId: UID, relatedOnly: true } },
]) {
  process.env.MEMBER_DISTRICT_CLOSURE_MEMO = "0";
  const live = await districtClosureIds(exec, shape.options);              // 原函式：即時算（基準）
  process.env.MEMBER_DISTRICT_CLOSURE_MEMO = "1";
  districtClosureIdsMemoized.clear();
  const cold = await districtClosureIdsMemoized(exec, shape.options);     // 冷：實算
  const warm = await districtClosureIdsMemoized(exec, shape.options);     // 暖：命中
  const dCold = symmetricDiff(live ?? [], cold ?? []);
  const dWarm = symmetricDiff(live ?? [], warm ?? []);
  const nulls = [live, cold, warm].map(v => (v === null ? "null" : `n=${v.length}`)).join(" / ");
  console.log(`MemoAB-CLOSURE ${shape.label} live/cold/warm ${nulls} cold_same_order=${dCold.same_order} cold_off_only=[${dCold.a_only.join(",")}] cold_on_only=[${dCold.b_only.join(",")}] warm_same_order=${dWarm.same_order} warm_off_only=[${dWarm.a_only.join(",")}] warm_on_only=[${dWarm.b_only.join(",")}]`);
  check((live === null) === (cold === null) && (live === null) === (warm === null), `${shape.label}：null 與非 null 的契約不一致`);
  check(dCold.a_only.length === 0 && dCold.b_only.length === 0 && dCold.same_order, `${shape.label}：冷啟動結果與即時算不同`);
  check(dWarm.a_only.length === 0 && dWarm.b_only.length === 0 && dWarm.same_order, `${shape.label}：命中結果與即時算不同`);
}

// ── 4. 計數的事實檢查（不是效能判準，只是確認開關真的生效）───────────────────────
check(off.stats.computes === RUNS, `=0 側的 compute 次數應為 ${RUNS}（每次請求各算一次），實得 ${off.stats.computes}`);
check(on.stats.computes <= RUNS, `ON 側的 compute 次數不得超過 ${RUNS}，實得 ${on.stats.computes}`);

await closeSharedPgDriver?.();

console.log(`MemoAB-RESULT ${failures.length === 0 ? "PASS" : "FAIL"} failures=${failures.length}`);
for (const message of failures) console.log(`MemoAB-FAIL ${message}`);
process.exit(failures.length === 0 ? 0 : 1);
