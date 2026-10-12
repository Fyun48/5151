// `dbTotal` 精準計數器（`listingTotalsPg*`）的**離線**契約：桶的判定、delta 的形狀、
// fail-safe 的每一條退路、以及 `countProductListings()` 的三層來源。
//
// 為什麼要單獨釘這些：這個計數器的錯誤全部是「**數字看起來合理但其實錯**」——
// 不會拋錯、不會紅、只會讓會員看到錯的總數。所以每一條「什麼時候可以沿用計數器／
// 什麼時候必須退回真 COUNT」都要有逐條斷言，而且**指紋（`pg_stat_user_tables`）永遠不
// 可以是沿用的前置條件**（D-0045／續九十八：指紋在寫入活躍的庫永遠不同 ⇒ 每請求都失效）。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "prb-listing-totals-"));
process.env.DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const {
  DEFAULT_LISTING_TOTALS_BUCKET,
  DEFAULT_LISTING_TOTALS_PREDICATE,
  listingTotalsBucketForIsolation,
  listingTotalsDdlStatements,
  listingTotalsEnsureBucketStatement,
  dropListingTotalsStatements,
  LISTING_TOTALS_TABLE,
} = await import("../src/listingTotalsPgSchema.js");
const {
  readListingTotalsForStats,
  resetListingTotalsPresenceForTests,
  listingTotalsScanDue,
  startListingTotalsReconciler,
  stopListingTotalsReconciler,
  resetListingTotalsForTests,
  listingTotalsCounterEnabled,
  reconcileIntervalMs,
} = await import("../src/listingTotalsPgCounter.js");
const {
  listingInsertImpact,
  listingDeleteImpact,
  listingUpsertDelta,
  listingTotalsDeltaSql,
} = await import("../src/listingTotalsPgWrite.js");
const { createListingStatsRepository, resetPgProductCountCache } = await import("../src/repository/listingStats.js");

const DEFAULT_ISOLATION = { sql: "(fixture_namespace IS NULL OR fixture_namespace = '')", params: [] };

beforeEach(() => {
  resetListingTotalsForTests();
  resetListingTotalsPresenceForTests();
  resetPgProductCountCache();
  stopListingTotalsReconciler();
  delete process.env.LISTING_TOTALS_COUNTER;
});

// ── 桶（述詞 → 桶）──────────────────────────────────────────────────────────────

test("桶的判定：預設述詞與具名 namespace 各自成桶；其它述詞一律不支援", () => {
  assert.deepEqual(listingTotalsBucketForIsolation(DEFAULT_ISOLATION), {
    bucketKey: DEFAULT_LISTING_TOTALS_BUCKET,
    predicateSql: DEFAULT_LISTING_TOTALS_PREDICATE,
    params: [],
  });
  const named = listingTotalsBucketForIsolation({ sql: "fixture_namespace = ?", params: ["ns-1"] });
  assert.equal(named.bucketKey, "fixture-ns:ns-1");
  assert.deepEqual(named.params, ["ns-1"]);
  // 已經正規化成 `$1` 形的呼叫端要對到**同一個**桶（否則會無故退回真 COUNT）。
  assert.equal(listingTotalsBucketForIsolation({ sql: "fixture_namespace = $1", params: ["ns-1"] }).bucketKey, "fixture-ns:ns-1");
  assert.equal(listingTotalsBucketForIsolation({ sql: "1=1", params: [] }), null);
  assert.equal(listingTotalsBucketForIsolation({ sql: "fixture_namespace = ?", params: [""] }), null);
  assert.equal(listingTotalsBucketForIsolation(null), null);
});

test("schema 語句：冪等 DDL、桶的 UPSERT 不覆蓋既有值、回退只有一句 DROP TABLE", () => {
  const ddl = listingTotalsDdlStatements();
  assert.ok(ddl.some((sql) => /CREATE TABLE IF NOT EXISTS listing_totals_counter/.test(sql)));
  assert.ok(ddl.every((sql) => /IF NOT EXISTS/.test(sql)));
  const bucket = listingTotalsEnsureBucketStatement();
  assert.match(bucket, /INSERT INTO listing_totals_counter/);
  assert.match(bucket, /ON CONFLICT \(bucket_key\) DO NOTHING/);
  assert.deepEqual(dropListingTotalsStatements(), [`DROP TABLE IF EXISTS ${LISTING_TOTALS_TABLE}`]);
});

// ── delta 的形狀 ────────────────────────────────────────────────────────────────

test("delta：INSERT／DELETE／fixture 的影響值，以及 upsert 的『新增還是更新』判讀", () => {
  assert.equal(listingInsertImpact({ fixtureNamespace: null }), 1);
  assert.equal(listingInsertImpact({ fixtureNamespace: "" }), 1);
  assert.equal(listingInsertImpact({ fixtureNamespace: "stage1-fix:x" }), 0);
  assert.equal(listingDeleteImpact({ fixtureNamespace: null }), -1);
  assert.equal(listingDeleteImpact({ fixtureNamespace: "stage1-fix:x" }), 0);
  // `xmax = 0` 由 PostgreSQL 回傳（true/false/'t'），更新（既有列）一律 0。
  assert.equal(listingUpsertDelta({ inserted: true, fixture_namespace: "" }), 1);
  assert.equal(listingUpsertDelta({ inserted: "t", fixture_namespace: "" }), 1);
  assert.equal(listingUpsertDelta({ inserted: false, fixture_namespace: "" }), 0);
  assert.equal(listingUpsertDelta({ inserted: true, fixture_namespace: "stage1-fix:x" }), 0);
  assert.equal(listingUpsertDelta(null), 0);
});

test("delta 語句是 UPSERT（列不存在也會建立），不會讓 delta 靜默掉在不存在的列上", () => {
  const sql = listingTotalsDeltaSql();
  assert.match(sql, /INSERT INTO listing_totals_counter/);
  assert.match(sql, /ON CONFLICT \(bucket_key\) DO UPDATE SET/);
  assert.match(sql, /total = listing_totals_counter\.total \+ \$1::bigint/);
  // 新桶遇到「刪除」要從 0 起算，不准出現負數。
  assert.match(sql, /GREATEST\(\$1::bigint, 0\)/);
});

// ── 讀取端的 fail-safe ─────────────────────────────────────────────────────────

function rowsExec(rows, { hasTable = true } = {}) {
  const calls = [];
  const exec = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/to_regclass\('listing_totals_counter'\)/.test(sql)) return [{ present: hasTable }];
    if (/^SAVEPOINT|^RELEASE SAVEPOINT|^ROLLBACK TO SAVEPOINT/.test(String(sql))) return [];
    if (/FROM listing_totals_counter/.test(sql)) return rows;
    return [];
  };
  return { exec, calls, dataCalls: () => calls.filter((c) => !/^SAVEPOINT|^RELEASE|^ROLLBACK TO SAVEPOINT/.test(String(c.sql))) };
}

test("讀取：usable=1 的計數器直接回值（沒有第二條查詢）", async () => {
  const { exec, calls } = rowsExec([{ predicate_sql: DEFAULT_LISTING_TOTALS_PREDICATE, total: "1234", usable: 1, last_reconcile_at: 1 }]);
  const diagnostics = {};
  const value = await readListingTotalsForStats({ exec, isolation: DEFAULT_ISOLATION, onDiagnostics: diagnostics });
  assert.equal(value, 1234);
  assert.equal(diagnostics.db_total_source, "counter");
  const data = calls.filter((c) => !/SAVEPOINT/.test(String(c.sql)));
  assert.equal(data.length, 2, "熱路徑＝一次存在探測 ＋ 一次小查詢（探測行程內快取 60 秒）");
  assert.ok(data.every((c) => !/SELECT COUNT\(\*\)/.test(c.sql)));
});

test("讀取：列不存在／usable=0／述詞不符／查詢失敗 一律回 null（呼叫端走真 COUNT）", async () => {
  assert.equal(await readListingTotalsForStats({ exec: rowsExec([]).exec, isolation: DEFAULT_ISOLATION }), null);
  assert.equal(await readListingTotalsForStats({
    exec: rowsExec([{ predicate_sql: DEFAULT_LISTING_TOTALS_PREDICATE, total: 9, usable: 0, last_reconcile_at: 0 }]).exec,
    isolation: DEFAULT_ISOLATION,
  }), null);
  assert.equal(await readListingTotalsForStats({
    exec: rowsExec([{ predicate_sql: "fixture_namespace = $1", total: 9, usable: 1, last_reconcile_at: 1 }]).exec,
    isolation: DEFAULT_ISOLATION,
  }), null, "述詞不同不得沿用");
  assert.equal(await readListingTotalsForStats({
    exec: async () => { throw new Error("boom"); },
    isolation: DEFAULT_ISOLATION,
  }), null);
  // 表不存在 ⇒ 連計數器查詢都不發（唯讀快照交易一旦 abort，整頁就 500）。
  resetListingTotalsPresenceForTests();
  const missing = rowsExec([], { hasTable: false });
  const diagnostics2 = {};
  assert.equal(await readListingTotalsForStats({ exec: missing.exec, isolation: DEFAULT_ISOLATION, onDiagnostics: diagnostics2 }), null);
  assert.equal(diagnostics2.db_total_source, "no-table");
  assert.ok(!missing.calls.some((c) => /FROM listing_totals_counter/.test(String(c.sql))));
});

test("讀取：LISTING_TOTALS_COUNTER=0 逐字回到現行行為（連查詢都不發）", async () => {
  assert.equal(listingTotalsCounterEnabled({ LISTING_TOTALS_COUNTER: "0" }), false);
  assert.equal(listingTotalsCounterEnabled({ LISTING_TOTALS_COUNTER: "off" }), false);
  assert.equal(listingTotalsCounterEnabled({}), true);
  process.env.LISTING_TOTALS_COUNTER = "0";
  const { exec, calls } = rowsExec([{ predicate_sql: DEFAULT_LISTING_TOTALS_PREDICATE, total: 1, usable: 1, last_reconcile_at: 1 }]);
  const diagnostics = {};
  assert.equal(await readListingTotalsForStats({ exec, isolation: DEFAULT_ISOLATION, onDiagnostics: diagnostics }), null);
  assert.equal(diagnostics.db_total_source, "disabled");
  assert.equal(calls.length, 0);
  delete process.env.LISTING_TOTALS_COUNTER;
});

test("讀取：具名 fixture 桶不走計數器（只有產品桶是熱路徑）", async () => {
  const { exec, calls } = rowsExec([{ predicate_sql: "fixture_namespace = $1", total: 5, usable: 1, last_reconcile_at: 1 }]);
  const diagnostics = {};
  assert.equal(await readListingTotalsForStats({
    exec,
    isolation: { sql: "fixture_namespace = ?", params: ["ns-1"] },
    onDiagnostics: diagnostics,
  }), null);
  assert.equal(diagnostics.db_total_source, "non-default-bucket");
  assert.equal(calls.length, 0);
});

// ── 偵測器（指紋只當偵測器，不當門檻）─────────────────────────────────────────

test("偵測器：物理列變化與計數器變化不一致 ⇒ 要求對帳；一致 ⇒ 不要求", async () => {
  const driver = {
    query: async (sql) => {
      if (/pg_stat_user_tables/.test(sql)) return { rows: [{ ins: 110, del: 0 }] };
      if (/FROM listing_totals_counter/.test(sql)) {
        return { rows: [{
          bucket_key: DEFAULT_LISTING_TOTALS_BUCKET,
          predicate_sql: DEFAULT_LISTING_TOTALS_PREDICATE,
          total: "105", row_count: 105, usable: 1,
          stat_baseline_ins: 100, stat_baseline_del: 0, stat_baseline_total: 100,
        }] };
      }
      return { rows: [] };
    },
  };
  const due = await listingTotalsScanDue({ pgDriver: driver });
  assert.equal(due.due, true);
  assert.equal(due.reason, "stat-drift");

  // 計數器有跟上（+5 = 物理 +5）⇒ 不要求對帳。
  const consistent = {
    query: async (sql) => {
      if (/pg_stat_user_tables/.test(sql)) return { rows: [{ ins: 105, del: 0 }] };
      if (/FROM listing_totals_counter/.test(sql)) {
        return { rows: [{
          bucket_key: DEFAULT_LISTING_TOTALS_BUCKET, predicate_sql: DEFAULT_LISTING_TOTALS_PREDICATE,
          total: "105", row_count: 105, usable: 1,
          stat_baseline_ins: 100, stat_baseline_del: 0, stat_baseline_total: 100,
        }] };
      }
      return { rows: [] };
    },
  };
  assert.equal((await listingTotalsScanDue({ pgDriver: consistent })).due, false);
});

// ── 背景對帳器（可注入；待機不對帳）───────────────────────────────────────────

test("對帳器：在 primary 上跑一次、在待機（in_recovery=true）完全不動", async () => {
  const seen = [];
  const standby = {
    query: async (sql) => {
      seen.push(sql);
      if (/pg_is_in_recovery/.test(sql)) return { rows: [{ in_recovery: true }] };
      return { rows: [] };
    },
    withTransaction: async () => { throw new Error("待機不得開交易"); },
  };
  const timer = startListingTotalsReconciler({ primaryDriverFactory: async () => standby, intervalMs: 60_000, startDelayMs: 0 });
  assert.ok(timer, "計時器要建立起來");
  await new Promise((resolve) => setTimeout(resolve, 25));
  stopListingTotalsReconciler();
  assert.ok(seen.some((sql) => /pg_is_in_recovery/.test(sql)), "待機判斷一定要先問");
  assert.ok(!seen.some((sql) => /CREATE TABLE/.test(sql)), "待機不得嘗試寫入（連 DDL 都不准）");
});

test("對帳器：primary 且桶不可用 ⇒ 會跑一次真 COUNT 覆蓋", async () => {
  const sqls = [];
  const driver = {
    query: async (sql) => {
      sqls.push(String(sql));
      if (/pg_is_in_recovery/.test(sql)) return { rows: [{ in_recovery: false }] };
      if (/FROM listing_totals_counter/.test(sql)) return { rows: [] };
      if (/SELECT COUNT\(\*\) AS n FROM listings WHERE/.test(sql)) return { rows: [{ n: 7 }] };
      return { rows: [] };
    },
    withTransaction: async (fn) => fn({
      query: async (sql) => {
        sqls.push(String(sql));
        if (/FOR UPDATE/.test(sql)) {
          return { rows: [{
            total: "0", row_count: 0, last_reconcile_at: 0, last_reconcile_value: null,
            drift_count: 0, reconcile_count: 0,
            stat_baseline_ins: null, stat_baseline_del: null, stat_baseline_total: null,
            stat_drift_ins: 0, stat_drift_del: 0,
          }] };
        }
        if (/pg_stat_user_tables/.test(sql)) return { rows: [{ ins: 0, del: 0 }] };
        return { rows: [{ n: 0 }], rowCount: 1 };
      },
    }),
  };
  startListingTotalsReconciler({ primaryDriverFactory: async () => driver, intervalMs: 60_000, startDelayMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  stopListingTotalsReconciler();
  assert.ok(sqls.some((sql) => /SELECT COUNT\(\*\) AS n FROM listings WHERE/.test(sql)), "必須有真 COUNT");
  assert.ok(sqls.some((sql) => /UPDATE listing_totals_counter/.test(sql)), "必須覆蓋計數器");
  assert.ok(reconcileIntervalMs({}) >= 1_000);
});

// ── `countProductListings()` 的三層來源 ───────────────────────────────────────

const DEPS = {
  resolveUserId: (value) => Number(value) || 0,
  getSettings: () => ({}),
  searchWhere: () => {},
  listingVisibilityClauses: () => {},
  appendDistrictCandidates: () => {},
  appendPriceCeilingCandidates: () => {},
  memberRegionDistrictNames: () => [],
  candidateColumns: "post_id",
  buildListingStatsRows: (options) => options.rows || [],
  summarizeListingStats: () => ({}),
};

const REQUEST_CONTEXT = {
  isolation: DEFAULT_ISOLATION,
  searchKeys: [],
  crawlSources: { items: [] },
  now: Date.now(),
  asOf: new Date().toISOString(),
  settingsForUser: () => ({}),
};

function statsExec({ counterRows = [], countValue = 4242, revisionOk = true } = {}) {
  const calls = [];
  const exec = async (sql, params = []) => {
    calls.push({ sql: String(sql), params });
    if (/to_regclass\('listing_totals_counter'\)/.test(sql)) return [{ present: true }];
    if (/^SAVEPOINT|^RELEASE SAVEPOINT|^ROLLBACK TO SAVEPOINT/.test(String(sql))) return [];
    if (/FROM listing_totals_counter/.test(sql)) return counterRows;
    if (/to_regclass\('data_revision'\)/.test(sql)) return [{ has_table: revisionOk }];
    if (/MAX\(id\) AS n FROM data_revision/.test(sql)) return [{ n: 1 }];
    if (/COUNT\(\*\) AS n FROM listings WHERE/.test(sql)) return [{ n: countValue }];
    return [];
  };
  return { exec, calls, countCalls: () => calls.filter((c) => /COUNT\(\*\) AS n FROM listings WHERE/.test(c.sql)).length };
}

function repo(exec) {
  return createListingStatsRepository({ driver: "postgres", exec, deps: DEPS });
}

test("來源①：計數器可用 ⇒ 完全不發那條全表 COUNT（連 data_revision 都不查）", async () => {
  const { exec, calls, countCalls } = statsExec({ counterRows: [{ predicate_sql: DEFAULT_LISTING_TOTALS_PREDICATE, total: "1234", usable: 1, last_reconcile_at: 1 }] });
  const inputs = await repo(exec).loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  assert.equal(inputs.dbTotal, 1234);
  assert.equal(countCalls(), 0, "計數器可用時不得再打 COUNT(*)");
  assert.ok(!calls.some((c) => /MAX\(id\) AS n FROM data_revision/.test(c.sql)), "也不該再問 data_revision 版本號");
});

test("來源②：計數器不可用 ⇒ 退回既有的 data_revision 版本化快取（行為不變）", async () => {
  const { exec, countCalls } = statsExec({ counterRows: [], countValue: 99 });
  const inputs = await repo(exec).loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  assert.equal(inputs.dbTotal, 99);
  assert.equal(countCalls(), 1);
});

test("來源③：計數器與 data_revision 都不可用 ⇒ 每次都現讀真 COUNT（正確優先）", async () => {
  const { exec, countCalls } = statsExec({ counterRows: [], countValue: 7, revisionOk: false });
  const repository = repo(exec);
  assert.equal((await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT })).dbTotal, 7);
  assert.equal((await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT })).dbTotal, 7);
  assert.equal(countCalls(), 2);
});

test("來源①只要有一絲不確定就退回（usable=0／述詞不符）", async () => {
  const stale = statsExec({ counterRows: [{ predicate_sql: DEFAULT_LISTING_TOTALS_PREDICATE, total: 5, usable: 0, last_reconcile_at: 0 }], countValue: 88 });
  const first = await repo(stale.exec).loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  assert.equal(first.dbTotal, 88);
  // 換一個情境前要清掉上一條留下的 `data_revision` 版本化快取（那是既有的行程內快取，
  // 這一包不改它的語意），否則量到的是它、不是計數器的行為。
  resetPgProductCountCache();
  const mismatch = statsExec({ counterRows: [{ predicate_sql: "fixture_namespace = $1", total: 5, usable: 1, last_reconcile_at: 1 }], countValue: 77 });
  assert.equal((await repo(mismatch.exec).loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT })).dbTotal, 77);
  assert.equal(mismatch.countCalls(), 1, "述詞不符時必須真的去讀真 COUNT");
});

// ── #734 的指紋缺陷（2026-10-12 正式站實測）────────────────────────────────
//
// 症狀：正式庫 `listing_totals_counter` 只有一列、`predicate_sql` 是**空字串**（寫入端的
// delta UPSERT 建出來的），於是讀取端的述詞比對永遠不合 ⇒ `db_total_source=unusable` ⇒
// **每個請求都退回一次全表 COUNT**（單請求窗口 Δcalls=1／Δms=173–465）。
// 值本身是準的（對帳會覆蓋 total），壞掉的只有指紋。
test("指紋缺陷：空 predicate_sql 的列在修復前不可用、修復後可用（值不變）", async () => {
  const {
    listingTotalsFastState,
    listingTotalsPredicateNeedsRepair,
    listingTotalsPredicateRepairSql,
  } = await import("../src/listingTotalsPgCounter.js");
  const row = (predicateSql) => async () => [{ predicate_sql: predicateSql, total: 193_418, usable: 1, last_reconcile_at: 1 }];
  // ① 修復前：列存在、usable=1、指紋是空字串 ⇒ fast-path 必須判定**不可用**（不得沿用）。
  const before = await listingTotalsFastState({
    exec: row(""), bucketKey: DEFAULT_LISTING_TOTALS_BUCKET, predicateSql: DEFAULT_LISTING_TOTALS_PREDICATE,
  });
  assert.equal(before.exists, true);
  assert.equal(before.usable, false, "空指紋不得被當成可用（正式庫 predicate_sql='' 的實測形狀）");
  assert.equal(before.predicateSql, "");
  assert.equal(
    listingTotalsPredicateNeedsRepair({ storedPredicateSql: before.predicateSql, expectedPredicateSql: DEFAULT_LISTING_TOTALS_PREDICATE }),
    true,
  );
  // ② 修復後：同一列換成正確指紋 ⇒ 可用，數字照舊。
  const after = await listingTotalsFastState({
    exec: row(DEFAULT_LISTING_TOTALS_PREDICATE), bucketKey: DEFAULT_LISTING_TOTALS_BUCKET, predicateSql: DEFAULT_LISTING_TOTALS_PREDICATE,
  });
  assert.equal(after.usable, true);
  assert.equal(after.total, 193_418);
  assert.equal(
    listingTotalsPredicateNeedsRepair({ storedPredicateSql: after.predicateSql, expectedPredicateSql: DEFAULT_LISTING_TOTALS_PREDICATE }),
    false,
  );
  // ③ 只有「空指紋」才修：有指紋但不合（例如 fixture 桶）不得被就地改寫。
  assert.equal(
    listingTotalsPredicateNeedsRepair({ storedPredicateSql: "fixture_namespace = $1", expectedPredicateSql: DEFAULT_LISTING_TOTALS_PREDICATE }),
    false,
  );
  // ④ 修復語句必須冪等：只碰空指紋、且已經是正確值時不寫（第二次執行 rowCount=0）。
  const sql = listingTotalsPredicateRepairSql();
  assert.match(sql, /UPDATE listing_totals_counter/);
  assert.match(sql, /btrim\(COALESCE\(predicate_sql, ''\)/);
  assert.match(sql, /IS DISTINCT FROM \$2/);
});

test("指紋修復：待機（pg_is_in_recovery=true）不得寫任何東西，且失敗只 warn", async () => {
  const { repairListingTotalsPredicateNow } = await import("../src/listingTotalsPgCounter.js");
  const seen = [];
  const standby = { query: async (sql) => { seen.push(sql); return { rows: [{ in_recovery: true }], rowCount: 0 }; } };
  const result = await repairListingTotalsPredicateNow({ pgDriver: standby, log: { warn() {} } });
  assert.equal(result.repaired, false);
  assert.equal(result.reason, "standby");
  assert.equal(seen.length, 1, "待機只准問一次 pg_is_in_recovery()，不准發 UPDATE");
  assert.match(seen[0], /pg_is_in_recovery/);
  assert.ok(!seen.some((sql) => /UPDATE/i.test(sql)), "待機上不得出現任何 UPDATE");
  // 沒有 driver ⇒ fail-soft，不丟例外。
  assert.equal((await repairListingTotalsPredicateNow({ pgDriver: null })).repaired, false);
});

test("寫入端：#734 的 delta UPSERT 不得再用空字串當 predicate_sql", async () => {
  const { listingTotalsDeltaSql } = await import("../src/listingTotalsPgWrite.js");
  const sql = listingTotalsDeltaSql();
  assert.ok(!/VALUES \(\$3, '', /.test(sql), "空字串會讓讀取端永遠 unusable（每個請求一次全表 COUNT）");
  assert.match(sql, /VALUES \(\$3, \$4, /, "predicate_sql 要走參數，值由 DEFAULT_LISTING_TOTALS_PREDICATE 提供");
});
