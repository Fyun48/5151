// 會員列表 `dbTotal` 的精準計數器：**讀取端**（待機可用）＋自我對帳 ＋ fail-safe。
//
// 這一支取代 `repository/listingStats.js` 每個請求那條
//   `SELECT COUNT(*) AS n FROM listings WHERE (fixture_namespace IS NULL OR fixture_namespace = '')`
//（正式站單請求窗口實測 1 次／99.6–215.2ms；爬蟲讓 `data_revision` 每秒換代 ⇒ 版本化快取
// 從未命中）。計數值由寫入端**在同一個交易**維護（見 `listingTotalsPgWrite.js`），
// 這一支只負責：
//   1. 讀（沒有計數器／`usable=0`／數值不合法 ⇒ 一律退回原本那條真 COUNT）；
//   2. 有界自我對帳（每 `LISTING_TOTALS_RECONCILE_MS`，預設 300s，一次真 COUNT 覆蓋）；
//   3. 繞過收口點的寫入偵測（`pg_stat_user_tables` 的 `n_tup_ins／n_tup_del` 當**偵測器**：
//      只拿來觸發對帳，**不是**拿來當沿用快取的前置條件 —— D-0045／續九十八 的坑）。
//
// ⚠️ 紅線（今天剛踩過，不准重犯）：結構指紋（統計計數）**不得**當成「能不能沿用計數器」的
//   前置條件。這裡的規則是「預設沿用、指紋只在發現異常時觸發一次對帳」，所以指紋的統計落後
//   不會讓每個請求都判定不可沿用（那正是 D-0045 的失效模式）。
//
// ⚠️ 對帳只在 **primary** 上跑（`pg_is_in_recovery()` 判定；待機是 read-only，寫不進去也
//   不該由每次讀取觸發）。待機上的讀取只讀複製過來的計數器 ⇒ 待機完全不會因此多打 COUNT。
import {
  DEFAULT_LISTING_TOTALS_BUCKET,
  DEFAULT_LISTING_TOTALS_PREDICATE,
  listingTotalsBucketForIsolation,
  listingTotalsDdlStatements,
  listingTotalsEnsureBucketStatement,
  normalizeListingTotalsPredicate,
  LISTING_TOTALS_TABLE,
} from "./listingTotalsPgSchema.js";
import { toPostgresSql } from "./sqlDialect.js";

/** 「可整條關掉」的開關（比照 `MEMBER_DISTRICT_PREFILTER`）：關掉＝逐字回到現行那條 COUNT。 */
export const LISTING_TOTALS_COUNTER_ENV = "LISTING_TOTALS_COUNTER";
/** 自我對帳的最小間隔（毫秒）。有界：預設 5 分鐘一次。 */
export const LISTING_TOTALS_RECONCILE_MS_ENV = "LISTING_TOTALS_RECONCILE_MS";
export const DEFAULT_RECONCILE_INTERVAL_MS = 300_000;
/** 對帳失敗後的重試間隔（毫秒）：失敗時**不做**每次請求都重試（避免 COUNT 風暴）。 */
export const LISTING_TOTALS_RETRY_MS_ENV = "LISTING_TOTALS_RETRY_MS";
export const DEFAULT_RETRY_INTERVAL_MS = 60_000;
/** 背景對帳器的啟動延遲（毫秒）：讓服務先站起來，再開始第一次真 COUNT。 */
export const LISTING_TOTALS_RECONCILE_START_DELAY_MS_ENV = "LISTING_TOTALS_RECONCILE_START_DELAY_MS";
export const DEFAULT_RECONCILE_START_DELAY_MS = 5_000;

/** 統計落地誤差容忍值：`n_tup_ins／n_tup_del` 是累計的近似值（約 1 秒落後）。 */
export const STAT_DRIFT_TOLERANCE = 4;

export function listingTotalsCounterEnabled(env = process.env) {
  const raw = env?.[LISTING_TOTALS_COUNTER_ENV];
  if (raw == null || raw === "") return true;
  return !["0", "false", "off", "no"].includes(String(raw).trim().toLowerCase());
}

function envInt(env, name, fallback) {
  const raw = Number(env?.[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

export function reconcileIntervalMs(env = process.env) {
  const value = envInt(env, LISTING_TOTALS_RECONCILE_MS_ENV, DEFAULT_RECONCILE_INTERVAL_MS);
  return value === 0 ? 0 : Math.max(1_000, value);
}

export function reconcileRetryMs(env = process.env) {
  const value = envInt(env, LISTING_TOTALS_RETRY_MS_ENV, DEFAULT_RETRY_INTERVAL_MS);
  return value === 0 ? 0 : Math.max(1_000, value);
}

/**
 * 執行器：把「PG driver（有 `query`／`exec`／`withTransaction`）」與「注入的 exec
 * （測試／`loadInputs` 既有慣例：回傳列陣列）」正規化成同一組介面。
 */
function makeExec(pgDriver = null, exec = null) {
  const rows = async (sql, params = []) => {
    if (typeof exec === "function") {
      const out = await exec(sql, params);
      return Array.isArray(out) ? out : (out?.rows || []);
    }
    if (pgDriver?.query) {
      const res = await pgDriver.query(sql, params);
      return res?.rows || [];
    }
    throw new Error("listingTotals requires a PG driver or an injected exec");
  };
  return { rows };
}

/** 已確保的 (driver, bucket) 配對：桶是**逐述詞**的，不能只用 driver 當 key。 */
const ensuredDrivers = new WeakMap();
/** 行程內擋住並行的對帳（避免同一請求尖峰同時打好幾條 COUNT）。 */
let reconcileInFlight = null;
/** 對帳失敗後的暫停時間（毫秒時間戳）；成功時清掉。 */
let reconcileBackoffUntil = 0;
/** 最近一次的對帳結果（診斷用）。 */
let lastReconcile = { at: 0, bucket: null, value: null, drift: 0, error: null };

export function resetListingTotalsForTests() {
  reconcileInFlight = null;
  reconcileBackoffUntil = 0;
  lastReconcile = { at: 0, bucket: null, value: null, drift: 0, error: null };
}

export function lastListingTotalsReconcile() {
  return { ...lastReconcile };
}

/**
 * 冪等確保（建表＋桶列）。**可以失敗**：呼叫端一律 fail-soft（退回真 COUNT），
 * 但成功過一次就以 driver 為 key 記住，之後不再打 DDL。
 *
 * ⚠️ DDL 走 `exec`（無參數）；**帶參數**的那一句一定要走 `query` ——
 * `dbDriverPostgres` 的 `exec` 只吃一句 SQL，參數會被默默丟掉（實測 `42P02 there is no parameter $1`）。
 */
export async function ensureListingTotalsReady(pgDriver, { bucketKey = DEFAULT_LISTING_TOTALS_BUCKET, predicateSql, now = Date.now() } = {}) {
  if (!pgDriver?.query) throw new Error("ensureListingTotalsReady requires a PG driver");
  let buckets = ensuredDrivers.get(pgDriver);
  if (!buckets) {
    buckets = new Set();
    ensuredDrivers.set(pgDriver, buckets);
  }
  if (buckets.has(bucketKey)) return true;
  for (const statement of listingTotalsDdlStatements()) {
    await pgDriver.query(statement);
  }
  await pgDriver.query(listingTotalsEnsureBucketStatement(), [bucketKey, predicateSql]);
  buckets.add(bucketKey);
  void now;
  return true;
}

/** 測試／回退用：忘掉「已確保」的快取（例如表被 `DROP TABLE` 之後）。 */
export function forgetListingTotalsEnsured(pgDriver = null) {
  if (pgDriver) ensuredDrivers.delete(pgDriver);
  else ensuredDrivers.clear?.();
}

/**
 * 「先確保 schema，再做那件事；表若在行程運行中被移除（例如 `dropListingTotalsStatements()`
 * 的回退實測）就重跑一次確保並重試」。**只重試一次**，第二次失敗照原樣往外丟。
 */
async function withEnsuredTable(pgDriver, bucketKey, predicateSql, operation) {
  try {
    return await operation();
  } catch (error) {
    const code = String(error?.code || "");
    // 42P01＝表不在（回退 DROP TABLE）；bucket-missing＝桶列不在（別的分支刪過）。
    if (code !== "42P01" && !/bucket row missing/.test(String(error?.message || ""))) throw error;
    ensuredDrivers.delete(pgDriver);
    await ensureListingTotalsReady(pgDriver, { bucketKey, predicateSql });
    return operation();
  }
}

/** 單一桶的計數器列（讀；待機上也安全）。查不到／查失敗回 `null`（呼叫端退回真 COUNT）。 */
export async function readListingTotalsBucket({ pgDriver = null, exec = null, bucketKey, predicateSql }) {
  const io = makeExec(pgDriver, exec);
  const out = await io.rows(
    toPostgresSql(`SELECT bucket_key, predicate_sql, total, row_count, usable, ensured_at, last_reconcile_at,
              last_reconcile_value, reconcile_count, drift_count,
              stat_baseline_ins, stat_baseline_del, stat_baseline_total, stat_baseline_at, stat_drift_ins, stat_drift_del
       FROM ${LISTING_TOTALS_TABLE} WHERE bucket_key = ?`),
    [bucketKey],
  );
  const row = out[0] || null;
  if (!row) return null;
  // 述詞不同 ⇒ 計數器描述的是另一組述詞（不得沿用）。兩邊都以正規形比較。
  if (predicateSql != null
    && normalizeListingTotalsPredicate(row.predicate_sql) !== normalizeListingTotalsPredicate(predicateSql)) return null;
  return row;
}

/**
 * 熱路徑**一次查詢**同時拿「能不能用」與「要不要對帳」。`last_reconcile_at` 是**成功對帳**
 * 的時間；失敗只寫 `usable=0`、不動它 ⇒ 失敗期間不會被讀取端當成「剛對帳過」。
 */
export async function listingTotalsFastState({ pgDriver = null, exec = null, bucketKey, predicateSql = null }) {
  const io = makeExec(pgDriver, exec);
  const out = await io.rows(
    toPostgresSql(`SELECT predicate_sql, total, usable, last_reconcile_at FROM ${LISTING_TOTALS_TABLE} WHERE bucket_key = ?`),
    [bucketKey],
  );
  const row = out[0] || null;
  if (!row) return { exists: false, usable: false, total: null, lastReconcileAt: 0 };
  const predicateMatches = predicateSql == null
    || normalizeListingTotalsPredicate(row.predicate_sql) === normalizeListingTotalsPredicate(predicateSql);
  const usable = Number(row.usable) === 1 && predicateMatches;
  return {
    exists: true,
    usable,
    total: usable ? Number(row.total) : null,
    lastReconcileAt: Number(row.last_reconcile_at) || 0,
  };
}

/**
 * 自我對帳（**有界**）：
 *   • 只有在 primary 上跑（待機是 read-only）；
 *   • 距上次對帳 < `LISTING_TOTALS_RECONCILE_MS` ⇒ 直接跳過（不發 COUNT）；
 *   • 同一行程同時只允許一條；
 *   • 失敗後 `LISTING_TOTALS_RETRY_MS` 內不再重試；
 *   • 成交條件：只跑**真的需要**的那一個桶（呼叫端指定）。
 *
 * 對帳＝「真 COUNT ⇒ 覆蓋計數器（`usable=1`）並記錄」。不一致時記 `drift_count`，
 * 這是「有寫入繞過收口點」的直接證據。
 */
export async function reconcileListingTotalsBucket({
  pgDriver,
  bucketKey = DEFAULT_LISTING_TOTALS_BUCKET,
  predicateSql,
  params = [],
  now = Date.now(),
  intervalMs = reconcileIntervalMs(),
  retryMs = reconcileRetryMs(),
  force = false,
} = {}) {
  if (!pgDriver?.query) return { skipped: "no-primary-driver" };
  if (now < reconcileBackoffUntil) return { skipped: "backoff" };
  if (reconcileInFlight) return { skipped: "in-flight" };
  const job = (async () => {
    try {
      // 表可能還不存在（第一次啟動）⇒ 先確保 schema／桶，再讀狀態。
      await ensureListingTotalsReady(pgDriver, { bucketKey, predicateSql, now });
      const state = await withEnsuredTable(pgDriver, bucketKey, predicateSql, () =>
        listingTotalsFastState({ pgDriver, bucketKey, predicateSql }));
      if (!force && state.lastReconcileAt && now - state.lastReconcileAt < intervalMs) {
        return { skipped: "interval", lastReconcileAt: state.lastReconcileAt };
      }
      const countRow = (await pgDriver.query(toPostgresSql(`SELECT COUNT(*) AS n FROM listings WHERE ${predicateSql}`), params)).rows?.[0];
      const value = Number(countRow?.n) || 0;
      const report = await runReconcileScan(pgDriver, { bucketKey, predicateSql, params, value, now });
      reconcileBackoffUntil = 0;
      lastReconcile = { at: now, bucket: bucketKey, value, drift: Number(report.drift) || 0, error: null };
      return { ok: true, bucket: bucketKey, value, drift: report.drift };
    } catch (error) {
      reconcileBackoffUntil = now + retryMs;
      lastReconcile = { at: now, bucket: bucketKey, value: null, drift: 0, error: String(error?.message || error) };
      throw error;
    }
  })();
  reconcileInFlight = job;
  try {
    return await job;
  } finally {
    if (reconcileInFlight === job) reconcileInFlight = null;
  }
}

/** 對帳的交易體：取 advisory lock ⇒ 寫統計基線 ⇒ 真 COUNT 覆蓋 ⇒ 更新 drift 計數。 */
async function runReconcileScan(pgDriver, { bucketKey, predicateSql, params, value, now }) {
  return pgDriver.withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), 5151)", [`listing_totals:${bucketKey}`]);
    const before = (await client.query(
      `SELECT total, row_count, last_reconcile_at, last_reconcile_value, drift_count, reconcile_count,
              stat_baseline_ins, stat_baseline_del, stat_baseline_total,
              stat_drift_ins, stat_drift_del
         FROM ${LISTING_TOTALS_TABLE} WHERE bucket_key = $1 FOR UPDATE`,
      [bucketKey],
    )).rows?.[0];
    const stats = (await client.query(
      "SELECT COALESCE(n_tup_ins, 0) AS ins, COALESCE(n_tup_del, 0) AS del FROM pg_stat_user_tables WHERE relname = 'listings'",
    )).rows?.[0];
    const ins = Number(stats?.ins) || 0;
    const del = Number(stats?.del) || 0;
    // 「第一次建立這一列」不算 drift（`total` 只是 0 的起始值，沒有『先前的答案』可以不一致）。
    // 只有「**真的對帳過**、而且與真值不同」才是「有寫入繞過收口點」的證據。
    const previouslyReconciled = Number(before?.last_reconcile_at) > 0;
    const drift = previouslyReconciled && Number(before.total) !== value ? 1 : 0;
    const statDriftIns = Number(before?.stat_drift_ins) || 0;
    const statDriftDel = Number(before?.stat_drift_del) || 0;
    const updated = await client.query(
      `UPDATE ${LISTING_TOTALS_TABLE} SET
          total = $2,
          usable = 1,
          ensured_at = $3,
          last_reconcile_at = $3,
          last_reconcile_value = $2,
          reconcile_count = COALESCE(reconcile_count, 0) + 1,
          drift_count = COALESCE(drift_count, 0) + $4,
          stat_baseline_ins = $5,
          stat_baseline_del = $6,
          stat_baseline_total = $2,
          stat_baseline_at = $3,
          stat_drift_ins = $7,
          stat_drift_del = $8
        WHERE bucket_key = $1`,
      [bucketKey, value, now, drift, ins, del, statDriftIns, statDriftDel],
    );
    // 桶列不存在時 UPDATE 會**靜默命中 0 列**（對帳看起來成功、其實什麼都沒寫）⇒ 明確失敗，
    // 由 `ensureListingTotalsReady()` 補建後重跑（見 `withEnsuredTable`）。
    const written = Number(updated?.rowCount ?? updated?.rows?.length ?? 0) || 0;
    if (written !== 1) throw new Error(`listing totals bucket row missing on reconcile: ${bucketKey}`);
    // 只有預設桶順便記「整表物理列數」（診斷用；不是產品數字）。
    if (bucketKey === DEFAULT_LISTING_TOTALS_BUCKET) {
      const rowCount = Number((await client.query("SELECT COUNT(*) AS n FROM listings")).rows?.[0]?.n) || 0;
      await client.query(`UPDATE ${LISTING_TOTALS_TABLE} SET row_count = $2 WHERE bucket_key = $1`, [bucketKey, rowCount]);
    }
    void predicateSql;
    void params;
    return { drift };
  });
}

/**
 * 對帳掃描的**偵測器**（`n_tup_ins／n_tup_del` 當偵測器，**不當門檻**）。
 *
 * 「沒有 data_revision 紀錄、也沒被收口點算到的列增減」＝有人直接 INSERT／DELETE
 * `listings`（批次下架腳本、維運指令、別的服務寫同一個庫）。偵測到的效果只有一個：
 * **提早觸發一次對帳**；沒偵測到也不會讓計數器被判定不可用（D-0045 的坑）。
 *
 * ⚠️ `pg_stat_user_tables` 有大約 1 秒的統計落地延遲（`listingDistrictPrefilter.js` 已記載
 * 同一個限制）⇒ 這裡是「提早發現」，硬上界仍然是 `LISTING_TOTALS_RECONCILE_MS` 的週期對帳。
 */
export async function listingTotalsScanDue({ pgDriver, bucketKey = DEFAULT_LISTING_TOTALS_BUCKET } = {}) {
  const row = await readListingTotalsBucket({ pgDriver, bucketKey });
  if (!row) return { due: true, reason: "missing" };
  if (Number(row.usable) !== 1) return { due: true, reason: "unusable" };
  if (row.stat_baseline_ins == null || row.stat_baseline_del == null) return { due: false, reason: "no-baseline" };
  const stats = (await pgDriver.query(
    "SELECT COALESCE(n_tup_ins, 0) AS ins, COALESCE(n_tup_del, 0) AS del FROM pg_stat_user_tables WHERE relname = 'listings'",
  )).rows?.[0];
  const ins = Number(stats?.ins) || 0;
  const del = Number(stats?.del) || 0;
  // 自上次對帳以來的「物理列變化」與「計數器自認的變化」。
  const physical = (ins - (Number(row.stat_baseline_ins) || 0)) - (del - (Number(row.stat_baseline_del) || 0));
  const counted = Number(row.total) - (Number(row.stat_baseline_total) || 0);
  const skew = physical - counted;
  if (Math.abs(skew) > STAT_DRIFT_TOLERANCE) {
    return { due: true, reason: "stat-drift", physical, counted, skew };
  }
  return { due: false, reason: "ok", physical, counted };
}

/**
 * 熱路徑：取得桶的計數器值；**任何不確定都回 `null`**（呼叫端退回真 COUNT）。
 *
 * `exec` 是呼叫端（`repository/listingStats.js`）**已經在用**的那個執行器 ——
 * 也就是同一個請求、同一條快照連線、同一組述詞。計數器因此與候選列來自同一個 snapshot，
 * 不會出現「計數器已含新列、候選列還沒有」這種同一個回應內部自相矛盾的畫面。
 *
 * ⚠️ 這裡**不**發任何寫入／不對帳：對帳由行程層的背景對帳器（primary）負責，
 * 所以待機上的請求不會（也不能）觸發對帳。
 */
export async function readListingTotalsForStats({ exec, isolation, now = Date.now(), onDiagnostics = null, pgDriver = null } = {}) {
  const started = typeof performance !== "undefined" ? performance.now() : 0;
  const finish = (value, reason) => {
    if (onDiagnostics) {
      onDiagnostics.db_total_source = reason;
      // `db_total_ms`（整個 dbTotal 的取得成本）由 `countProductListings()` 量；這裡量的是
      // **計數器自己那一段**（探測＋讀），方便分辨「機制成本」與「退回真 COUNT 的成本」。
      if (started) onDiagnostics.db_total_probe_ms = Math.round(performance.now() - started);
    }
    return value;
  };
  if (!listingTotalsCounterEnabled()) return finish(null, "disabled");
  const bucket = listingTotalsBucketForIsolation(isolation);
  if (!bucket) return finish(null, "unsupported-predicate");
  // 只有**預設（產品可見）桶**走計數器：那是唯一的熱路徑（每請求 99.6–215.2ms）。
  // 具名 fixture 桶不是熱路徑，走真 COUNT 才不會多一種「誰負責維護它」的狀態。
  if (bucket.bucketKey !== DEFAULT_LISTING_TOTALS_BUCKET) return finish(null, "non-default-bucket");
  const runRows = typeof exec === "function" ? exec : null;
  if (!runRows && !pgDriver?.query) return finish(null, "no-executor");
  const query = runRows || ((sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows));
  try {
    // ① 先探測表在不在（`to_regclass` 是**不會失敗**的查詢）。
    //    為什麼要探測而不是「直接查、失敗就算了」：讀取端跑在**唯讀快照交易**裡，
    //    一句失敗的 SELECT 會讓整個交易變成 aborted，後面所有查詢都 25P02 ⇒ **整個頁面 500**。
    //    計數器壞掉絕對不可以弄壞會員列表，所以「表不存在」要在不打失敗查詢的前提下就知道。
    if (!(await listingTotalsTablePresent(query, now))) return finish(null, "no-table");
    // ② 再把計數器查詢包在 SAVEPOINT 裡：其他任何失敗（欄位缺、權限、連線）都只回捲這一段，
    //    不會污染呼叫端的交易。
    const state = await withSavepoint(query, "listing_totals", () =>
      listingTotalsFastState({ exec: query, bucketKey: bucket.bucketKey, predicateSql: bucket.predicateSql }));
    if (state.usable && Number.isFinite(state.total) && state.total >= 0) return finish(state.total, "counter");
    return finish(null, state.exists ? "unusable" : "missing");
  } catch {
    return finish(null, "error");
  }
}

/** 表在不在（行程內快取 60 秒；`to_regclass` 不會失敗，所以放進唯讀快照是安全的）。 */
const TABLE_PRESENCE_TTL_MS = 60_000;
let tablePresence = { at: 0, present: null };

export function resetListingTotalsPresenceForTests() {
  tablePresence = { at: 0, present: null };
}

async function listingTotalsTablePresent(query, now = Date.now()) {
  if (tablePresence.present != null && now - tablePresence.at < TABLE_PRESENCE_TTL_MS) return tablePresence.present;
  const rows = await query(toPostgresSql(`SELECT to_regclass('${LISTING_TOTALS_TABLE}') IS NOT NULL AS present`), []);
  const raw = rows?.[0]?.present;
  const present = raw === true || raw === "t" || raw === 1 || raw === "1";
  tablePresence = { at: now, present };
  return present;
}

/**
 * 在呼叫端的交易裡用 SAVEPOINT 隔離一段讀取：失敗只回捲這一段，之後仍可以 `RELEASE`。
 * （`SAVEPOINT`／`ROLLBACK`／`RELEASE` 都在 PG 唯讀快照的允許語句集合內，見
 * `pgReadSnapshot.js` 的 `SNAPSHOT_ALLOWED_KEYWORDS`。）
 */
async function withSavepoint(query, name, fn) {
  let opened = false;
  try {
    await query(`SAVEPOINT ${name}`, []);
    opened = true;
  } catch {
    opened = false; // 沒有交易（單獨連線）時沒有 SAVEPOINT 可用 ⇒ 直接跑
  }
  if (!opened) return fn();
  try {
    const value = await fn();
    await query(`RELEASE SAVEPOINT ${name}`, []);
    return value;
  } catch (error) {
    try {
      await query(`ROLLBACK TO SAVEPOINT ${name}`, []);
      await query(`RELEASE SAVEPOINT ${name}`, []);
    } catch { /* 交易真的壞了就交給外層 */ }
    throw error;
  }
}

/**
 * 背景對帳器（**不阻擋請求、失敗只 warn**）。這是「自我對帳」的唯一驅動者。
 *
 * `pgDriverFactory` 預設是**行程共用的 primary pool**（`pgSharedDriver()`：它讀 `PG_URL`，
 * 也就是寫入那一側）；會員列表的唯讀快照可能走待機，但對帳永遠在 primary 上做。
 *
 * 契約：
 *   1. 啟動時跑一次（`LISTING_TOTALS_RECONCILE_START_DELAY_MS`，預設 5 秒）、之後每
 *      `LISTING_TOTALS_RECONCILE_MS`（預設 300 秒＝5 分鐘）一次 —— **有界**；
 *   2. 先問 `pg_is_in_recovery()`：待機（`PG_URL` 指向待機節點）**不對帳、不寫**；
 *   3. `unref()`：計時器不會讓行程留在活著；
 *   4. 失敗只 warn，下一個週期再試 —— 讀取端在這段期間走真 COUNT（正確、只是慢）。
 */
let reconcilerTimer = null;

export function startListingTotalsReconciler({
  env = process.env,
  log = console,
  intervalMs = reconcileIntervalMs(env),
  startDelayMs = envInt(env, LISTING_TOTALS_RECONCILE_START_DELAY_MS_ENV, DEFAULT_RECONCILE_START_DELAY_MS),
  primaryDriverFactory = defaultPrimaryDriver,
} = {}) {
  if (reconcilerTimer) return reconcilerTimer;
  if (!listingTotalsCounterEnabled(env)) return null;
  const runOnce = async () => {
    try {
      const pgDriver = await primaryDriverFactory();
      if (!pgDriver?.query) return;
      const recovery = (await pgDriver.query("SELECT pg_is_in_recovery() AS in_recovery")).rows?.[0];
      if (recovery?.in_recovery === true) return; // 待機：不寫、不對帳
      const state = await withEnsuredTable(pgDriver, DEFAULT_LISTING_TOTALS_BUCKET, DEFAULT_LISTING_TOTALS_PREDICATE, () =>
        listingTotalsFastState({ pgDriver, bucketKey: DEFAULT_LISTING_TOTALS_BUCKET, predicateSql: DEFAULT_LISTING_TOTALS_PREDICATE }));
      const now = Date.now();
      const force = state.usable !== true;
      const due = force || !state.lastReconcileAt || now - state.lastReconcileAt >= intervalMs;
      if (!due) return;
      await reconcileListingTotalsBucket({
        pgDriver,
        bucketKey: DEFAULT_LISTING_TOTALS_BUCKET,
        predicateSql: DEFAULT_LISTING_TOTALS_PREDICATE,
        now,
        force,
      });
    } catch (error) {
      log?.warn?.("[listing-totals] 週期對帳失敗（讀取端會退回真 COUNT，下一週期再試）：", error?.message || error);
    }
  };
  const timer = setInterval(() => { void runOnce(); }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  const kick = setTimeout(() => { void runOnce(); }, startDelayMs);
  if (typeof kick.unref === "function") kick.unref();
  timer.kick = kick;
  reconcilerTimer = timer;
  return timer;
}

export function stopListingTotalsReconciler() {
  if (!reconcilerTimer) return;
  clearInterval(reconcilerTimer);
  if (reconcilerTimer.kick) clearTimeout(reconcilerTimer.kick);
  reconcilerTimer = null;
}

/**
 * 預設的 primary driver（行程共用的那一個 pool；`PG_URL` 那一側）。
 *
 * ⚠️ `sharedPgDriver()` 是 async ⇒ **一定要 await**（少一個 await 會拿到 Promise，
 * 之後 `pgDriver.query is not a function`）。`v3/test/server-module-wiring.test.js` 會靜態
 * 掃這一條（第五十四批的 Promise 型缺陷），所以這裡刻意寫 `return await`。
 */
async function defaultPrimaryDriver() {
  const { sharedPgDriver } = await import("./pgSharedDriver.js");
  return await sharedPgDriver();
}

/** 一次性對帳（測試／診斷用）：`force` 預設 true（不受週期節流）。 */
export async function reconcileListingTotalsOnce({
  pgDriver,
  bucketKey = DEFAULT_LISTING_TOTALS_BUCKET,
  predicateSql = DEFAULT_LISTING_TOTALS_PREDICATE,
  params = [],
  now = Date.now(),
} = {}) {
  return reconcileListingTotalsBucket({ pgDriver, bucketKey, predicateSql, params, now, force: true });
}

/** `readListingTotalsForStats()` 的別名（呼叫端語意：有可信計數器回數字，否則回 `null`）。 */
export const listingTotalsOrNull = readListingTotalsForStats;
