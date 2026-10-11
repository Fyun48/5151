// 會員列表「唯讀快照 → 待機節點（PG_RO_URL）」的路由、fail-safe、寫入守門與寫後新鮮期。
//
// 這一檔要釘住的六件事（對應 PR 的 A.1–A.5）：
//   1. `PG_RO_URL` **未設** ⇒ 走原路：連待機池都不建立，一條primary 連線跑完整條快照。
//   2. `PG_RO_URL` 有值 ⇒ 整條快照（list 段、stats 段、共趟掃描）都在**待機池**上，
//      且交易是 `BEGIN … REPEATABLE READ READ ONLY`。
//   3. 待機拿不到連線 ⇒ **整趟**退回 primary（fail-safe），記一條可搜尋的 warning，
//      而且不出現「一半 primary、一半待機」的混合快照。
//   4. 寫入語句企圖進入這條快照 ⇒ 應用層先擋（不是讓 PG 吐 `cannot execute … in a read-only
//      transaction` 這種沒有上下文的錯）。
//   5. 會員「剛寫過」⇒ 該 uid 的請求整趟走 primary（寫後新鮮期路由提示）。
//   6. live PG（`PG_TEST_URL`／`PG_LIVE_REPRO_URL`，需隔離庫）：`application_name` 與
//      `pg_stat_activity` 看得到讀在待機池上、待機連不上時整趟在 primary。
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import {
  createReadReplicaRouter, planSnapshotRoute, readReplicaConfigured, readReplicaUrl,
  readReplicaPoolOptions, sharedReadReplica, sharedReadReplicaStats, READ_REPLICA_FALLBACK_WARNING,
  SNAPSHOT_SOURCE_PRIMARY, SNAPSHOT_SOURCE_REPLICA, standbyConflictCode, isStandbyConflictError,
  READ_REPLICA_CONFLICT_WARNING, STANDBY_CONFLICT_CODES,
  DEFAULT_READ_REPLICA_CONNECT_TIMEOUT_MS, READ_REPLICA_APPLICATION_NAME_SUFFIX,
} from "../src/pgReadReplica.js";
import { createMemberWriteRecency, memberWriteRecency, markMemberWrite } from "../src/memberWriteRecency.js";

import { memberWriteMiddleware } from "../src/memberWriteMiddleware.js";
import {
  withPgReadSnapshot, assertSnapshotStatementAllowed, isReadOnlySnapshotViolation,
  READ_ONLY_SNAPSHOT_CODE,
} from "../src/pgReadSnapshot.js";

const READ_ONLY_BEGIN = "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY";
const SETTINGS = ["SET LOCAL jit = off", "SET LOCAL cursor_tuple_fraction = 1"];
const quietLog = { warn() {}, log() {} };

// ── 替身：pool／client 都只記「誰收到哪一句 SQL」─────────────────────────────
function fakeClient(name) {
  const queries = [];
  return {
    name,
    queries,
    released: null,
    async query(sql) {
      const text = typeof sql === "string" ? sql : sql.text;
      queries.push(text);
      // 回一列帶「我在哪個 client」的資料：用來證明重跑後的結果來自 primary 那一趟。
      return { rows: [{ who: name, sql: text }], fields: [], rowCount: 1 };
    },
    release(error) { this.released = error ?? null; },
    on() {},
    removeListener() {},
  };
}

/** 讓某個 client 在符合述詞的語句上丟出指定 SQLSTATE（模擬待機複製衝突）。 */
function failOnQuery(client, predicate, { code = "40001", message = "canceling statement due to conflict with recovery", wrap = false } = {}) {
  const original = client.query.bind(client);
  client.query = async (sql) => {
    const text = typeof sql === "string" ? sql : sql.text;
    if (predicate(text)) {
      // 語句確實送出去了（只是被伺服器取消）⇒ 仍然記進 queries。
      client.queries.push(text);
      const pgError = new Error(message);
      pgError.code = code;
      if (!wrap) throw pgError;
      // list／stats 管線會把 PG 錯誤包成 SEARCH_UNAVAILABLE（cause 鏈）——真實形狀。
      const wrappedError = new Error(`listing search unavailable on the postgres driver: ${message}`);
      wrappedError.name = "ListingSearchUnavailableError";
      wrappedError.code = "SEARCH_UNAVAILABLE";
      wrappedError.cause = pgError;
      throw wrappedError;
    }
    return original(sql);
  };
  return client;
}

function fakePool(name, client) {
  return {
    name,
    connectCalls: 0,
    async connect() { this.connectCalls += 1; return client; },
    on() {},
  };
}

function fakeDriver(name) {
  const client = fakeClient(name);
  const pool = fakePool(name, client);
  return { name, pool, client, candidateContent: null };
}

function failingPool(name, message = "ECONNREFUSED 192.168.0.220:25434") {
  return {
    name,
    connectCalls: 0,
    async connect() { this.connectCalls += 1; throw new Error(message); },
    on() {},
  };
}

function routerFor({ env, driver = null, pool = null, log = quietLog, now = () => Date.now() } = {}) {
  return createReadReplicaRouter({
    env,
    now,
    log,
    createDriver: async () => {
      if (driver) return driver;
      return { pool, candidateContent: null };
    },
  });
}

// ── 1. 純函式：路由決策 ────────────────────────────────────────────────────
test("planSnapshotRoute：未設 PG_RO_URL／非會員快照一律走 primary；設了才走待機", () => {
  assert.equal(planSnapshotRoute({ memberReadSnapshot: true, replicaConfigured: false }), SNAPSHOT_SOURCE_PRIMARY);
  assert.equal(planSnapshotRoute({ memberReadSnapshot: false, replicaConfigured: true }), SNAPSHOT_SOURCE_PRIMARY);
  assert.equal(planSnapshotRoute({ memberReadSnapshot: true, replicaConfigured: true }), SNAPSHOT_SOURCE_REPLICA);
  assert.equal(
    planSnapshotRoute({ memberReadSnapshot: true, replicaConfigured: true, memberWriteFresh: true }),
    SNAPSHOT_SOURCE_PRIMARY,
    "會員剛寫過 ⇒ 整趟走 primary（待機有複製延遲）",
  );
});

test("PG_RO_URL 未設＝空字串（連線字串判定），設了才視為已設定", () => {
  assert.equal(readReplicaUrl({}), "");
  assert.equal(readReplicaUrl({ PG_RO_URL: "   " }), "");
  assert.equal(readReplicaConfigured({ PG_RO_URL: "   " }), false);
  assert.equal(readReplicaUrl({ PG_RO_URL: " postgres://ro@host:25434/db " }), "postgres://ro@host:25434/db");
  assert.equal(readReplicaConfigured({ PG_RO_URL: "postgres://ro@host:25434/db" }), true);
});

test("待機池的池參數：application_name 有 -ro 後綴（pg_stat_activity 可分辨）、逾時有上限", () => {
  const options = readReplicaPoolOptions({ PG_URL: "postgres://u@h/db" });
  assert.match(options.application_name, /-ro$/);
  assert.ok(options.connectionTimeoutMillis <= DEFAULT_READ_REPLICA_CONNECT_TIMEOUT_MS);
  // 可選覆寫（不設就有安全預設，不影響「一個鍵開閘」）。
  const overridden = readReplicaPoolOptions({
    PG_RO_POOL_MAX: "3", PG_RO_CONNECT_TIMEOUT_MS: "777", PG_APPLICATION_NAME: "custom",
  });
  assert.equal(overridden.max, 3);
  assert.equal(overridden.connectionTimeoutMillis, 777);
  assert.equal(overridden.application_name, `custom${READ_REPLICA_APPLICATION_NAME_SUFFIX}`);
});

// ── 2. 快照路由（離線替身）──────────────────────────────────────────────────
test("PG_RO_URL 未設 ⇒ 走原路：不建立待機池、不試待機、primary 一條連線跑完整條快照", async () => {
  const primary = fakeDriver("primary");
  let created = 0;
  const warnings = [];
  const env = { PG_URL: "postgres://u@primary:25433/db" };
  const router = createReadReplicaRouter({
    env, log: { warn: (line) => warnings.push(line), log() {} },
    createDriver: async () => { created += 1; throw new Error("未設 PG_RO_URL 時不得建立待機池"); },
  });
  const out = await withPgReadSnapshot(primary, async (snapshot) => {
    await snapshot.query("SELECT 1 AS one");
    await snapshot.query("SELECT COUNT(*) AS n FROM listings WHERE 1=1");
    return "ok";
  }, { memberReadSnapshot: true, userId: 7, env, readReplicaRouter: router });

  assert.equal(out, "ok");
  assert.equal(created, 0, "未設 PG_RO_URL ⇒ 連待機池都不建立");
  assert.equal(primary.pool.connectCalls, 1);
  assert.deepEqual(primary.client.queries, [READ_ONLY_BEGIN, ...SETTINGS, "SELECT 1 AS one",
    "SELECT COUNT(*) AS n FROM listings WHERE 1=1", "ROLLBACK"]);
  assert.equal(router.stats().replicaReads, 0);
  assert.equal(router.stats().primaryReads, 1);
  // 「走原路」的硬證據：**根本沒有試過待機**（沒有 fallback、沒有冷卻、沒有 warning）。
  assert.equal(router.stats().fallbacks, 0);
  assert.equal(router.stats().cooldownSkips, 0);
  assert.deepEqual(warnings, []);
});

test("PG_RO_URL 有值 ⇒ 整條快照在待機池上（primary 池完全沒被碰），交易是 READ ONLY", async () => {
  memberWriteRecency.clear(); // 提示表全域共用：這一條要驗的是「沒有提示時走待機」
  const primary = fakeDriver("primary");
  const replica = fakeDriver("replica");
  const env = { PG_URL: "postgres://u@primary:25433/db", PG_RO_URL: "postgres://u@standby:25434/db" };
  const router = routerFor({ env, driver: { pool: replica.pool, candidateContent: null } });

  const out = await withPgReadSnapshot(primary, async (snapshot) => {
    await snapshot.query("SELECT 1 AS one");
    return "ok";
  }, { memberReadSnapshot: true, userId: 7, env, readReplicaRouter: router });

  assert.equal(out, "ok");
  assert.equal(primary.pool.connectCalls, 0, "走待機時不得再開 primary 連線");
  assert.equal(primary.client.queries.length, 0);
  assert.deepEqual(replica.client.queries, [READ_ONLY_BEGIN, ...SETTINGS, "SELECT 1 AS one", "ROLLBACK"]);
  assert.equal(router.stats().replicaReads, 1);
  assert.equal(router.stats().fallbacks, 0);
});

test("待機拿不到連線 ⇒ 整趟退回 primary、記可搜尋的 warning、絕不混合兩個快照", async () => {
  const primary = fakeDriver("primary");
  const replicaPool = failingPool("replica");
  const warnings = [];
  const env = { PG_URL: "postgres://u@primary:25433/db", PG_RO_URL: "postgres://u@standby:25434/db" };
  const router = routerFor({ env, pool: replicaPool, log: { warn: (line) => warnings.push(line), log() {} } });

  const out = await withPgReadSnapshot(primary, async (snapshot) => {
    await snapshot.query("SELECT 1 AS one");
    await snapshot.query("SELECT 2 AS two");
    return "ok";
  }, { memberReadSnapshot: true, userId: 7, env, readReplicaRouter: router });

  assert.equal(out, "ok");
  assert.equal(replicaPool.connectCalls, 1, "先試一次待機");
  assert.equal(primary.pool.connectCalls, 1, "拿不到待機連線 ⇒ 改用 primary 的那一條");
  // 「同一條連線、同一個 snapshot」：整條快照只被**一個** client 收到 SQL。
  const clients = [primary.client, ...[]].filter((c) => c.queries.length > 0);
  assert.equal(clients.length, 1);
  assert.deepEqual(primary.client.queries, [READ_ONLY_BEGIN, ...SETTINGS, "SELECT 1 AS one", "SELECT 2 AS two", "ROLLBACK"]);
  assert.equal(warnings.length, 1, "要有一條 warning");
  assert.ok(warnings[0].includes(READ_REPLICA_FALLBACK_WARNING), `warning 必須可被 grep 到：${warnings[0]}`);
  assert.ok(!warnings[0].includes("password"), "warning 不得帶帳密");
  assert.equal(router.stats().fallbacks, 1);
  assert.equal(router.stats().replicaReads, 0);
});

test("待機失敗後冷卻期間不再嘗試（避免每個請求都先卡一次連線逾時）", async () => {
  const primary = fakeDriver("primary");
  const replicaPool = failingPool("replica");
  const env = { PG_URL: "postgres://u@primary:25433/db", PG_RO_URL: "postgres://u@standby:25434/db" };
  const router = routerFor({ env, pool: replicaPool, log: quietLog });

  for (let i = 0; i < 3; i += 1) {
    await withPgReadSnapshot(primary, async (snapshot) => { await snapshot.query(`SELECT ${i}`); },
      { memberReadSnapshot: true, userId: 7, env, readReplicaRouter: router });
  }
  assert.equal(replicaPool.connectCalls, 1, "冷卻期間只試一次");
  assert.equal(primary.pool.connectCalls, 3, "三個請求都完整地在 primary 上跑完");
  assert.equal(router.stats().fallbacks, 1);
  assert.ok(router.stats().cooldownSkips >= 1);
});

test("非會員快照（公開搜尋／診斷腳本）不受影響：不守門、不路由", async () => {
  const primary = fakeDriver("primary");
  let created = 0;
  const env = { PG_URL: "postgres://u@primary:25433/db", PG_RO_URL: "postgres://u@standby:25434/db" };
  const router = createReadReplicaRouter({
    env, log: quietLog, createDriver: async () => { created += 1; return { pool: fakePool("replica", fakeClient("replica")), candidateContent: null }; },
  });
  await withPgReadSnapshot(primary, async (snapshot) => {
    // 其他呼叫端（腳本）本來就會跑 EXPLAIN／DDL 之類的語句：守門不得套用到它們身上。
    await snapshot.query("CREATE TEMP TABLE t(i int)");
  }, { env, readReplicaRouter: router });
  assert.equal(created, 0, "沒有 memberReadSnapshot ⇒ 不得路由到待機");
  assert.equal(primary.pool.connectCalls, 1);
  assert.ok(primary.client.queries.includes("CREATE TEMP TABLE t(i int)"));
});

// ── 2b. 待機複製衝突（recovery conflict）────────────────────────────────────
test("待機複製衝突：SQLSTATE 家族判定（直接碼、cause 鏈、未知碼、深度上限）", () => {
  const direct = new Error("canceling statement due to conflict with recovery");
  direct.code = "40001";
  assert.equal(standbyConflictCode(direct), "40001");
  assert.equal(isStandbyConflictError(direct), true);
  // 待機上會遇到的同家族錯誤。
  for (const code of ["40001", "25006", "55006"]) {
    const error = new Error("x");
    error.code = code;
    assert.equal(isStandbyConflictError(error), true, `${code} 應被視為待機衝突家族`);
  }
  // list／stats 管線會包一層（cause 鏈）也要認得。
  const wrapped = new Error("listing search unavailable");
  wrapped.code = "SEARCH_UNAVAILABLE";
  wrapped.cause = direct;
  assert.equal(standbyConflictCode(wrapped), "40001");
  // 不是衝突家族的一律回空字串（不得偷偷重試）。
  for (const code of ["57014", "08006", "SEARCH_UNAVAILABLE", "", undefined]) {
    const error = new Error("x");
    if (code) error.code = code;
    assert.equal(standbyConflictCode(error), "", `${code} 不該被當成待機衝突`);
  }
  assert.equal(standbyConflictCode(null), "");
  assert.equal(standbyConflictCode({}), "");
});

test("待機複製衝突 ⇒ 整個快照退回 primary 重跑一次（丟棄待機那趟、不混合、記 warning）", async () => {
  memberWriteRecency.clear();
  const primary = fakeDriver("primary");
  const replica = fakeDriver("replica");
  failOnQuery(replica.client, (text) => text === "SELECT 1 AS one", { code: "40001" });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const env = { PG_URL: "postgres://u@primary/db", PG_RO_URL: "postgres://u@standby/db" };
  const router = routerFor({ env, driver: { pool: replica.pool, candidateContent: null } });
  try {
    const who = await withPgReadSnapshot(primary, async (snapshot) => {
      const result = await snapshot.query("SELECT 1 AS one");
      return result.rows[0].who;
    }, { memberReadSnapshot: true, userId: 7, env, readReplicaRouter: router });

    // 回傳值必須來自**重跑那一趟**（primary），不能是待機那趟的任何殘留。
    assert.equal(who, "primary");
    // 第一趟：在待機上 BEGIN → 查詢被取消 → 收尾 ROLLBACK（同一條連線、同一個快照）。
    assert.deepEqual(replica.client.queries, [READ_ONLY_BEGIN, ...SETTINGS, "SELECT 1 AS one", "ROLLBACK"]);
    // 第二趟：整條快照在 primary 的**一條**連線上重跑（不是接續待機那一趟）。
    assert.deepEqual(primary.client.queries, [READ_ONLY_BEGIN, ...SETTINGS, "SELECT 1 AS one", "ROLLBACK"]);
    assert.equal(primary.pool.connectCalls, 1);
    // 可搜尋的 warning：含 uid、sqlstate 與第一次嘗試的耗時。
    assert.equal(warnings.length, 1, `expected one conflict warning, got ${JSON.stringify(warnings)}`);
    assert.ok(warnings[0].includes(READ_REPLICA_CONFLICT_WARNING), warnings[0]);
    assert.match(warnings[0], /sqlstate=40001/);
    assert.match(warnings[0], /uid=7/);
    assert.match(warnings[0], /\d+ms/);
    assert.equal(router.stats().standbyConflicts, 1);
    assert.equal(router.stats().replicaReads, 1);
    assert.equal(router.stats().primaryReads, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("待機複製衝突被包在 cause 鏈裡（list 管線的 SEARCH_UNAVAILABLE）也要重跑", async () => {
  memberWriteRecency.clear();
  const primary = fakeDriver("primary");
  const replica = fakeDriver("replica");
  failOnQuery(replica.client, (text) => text === "SELECT 1 AS one", { code: "40001", wrap: true });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const env = { PG_URL: "postgres://u@primary/db", PG_RO_URL: "postgres://u@standby/db" };
  const router = routerFor({ env, driver: { pool: replica.pool, candidateContent: null } });
  try {
    const who = await withPgReadSnapshot(primary, async (snapshot) => {
      const result = await snapshot.query("SELECT 1 AS one");
      return result.rows[0].who;
    }, { memberReadSnapshot: true, userId: 7, env, readReplicaRouter: router });
    assert.equal(who, "primary");
    assert.equal(router.stats().standbyConflicts, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("非衝突的錯誤不得偷偷重試（該失敗就失敗，primary 池完全不碰）", async () => {
  memberWriteRecency.clear();
  const primary = fakeDriver("primary");
  const replica = fakeDriver("replica");
  failOnQuery(replica.client, (text) => text === "SELECT 1 AS one", { code: "57014", message: "canceling statement due to statement timeout" });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const env = { PG_URL: "postgres://u@primary/db", PG_RO_URL: "postgres://u@standby/db" };
  const router = routerFor({ env, driver: { pool: replica.pool, candidateContent: null } });
  try {
    let captured = null;
    await assert.rejects(
      () => withPgReadSnapshot(primary, async (snapshot) => { await snapshot.query("SELECT 1 AS one"); },
        { memberReadSnapshot: true, userId: 7, env, readReplicaRouter: router }),
      (error) => { captured = error; return true; },
    );
    assert.equal(captured.code, "57014");
    assert.equal(primary.pool.connectCalls, 0, "非衝突錯誤不得退回 primary 重跑");
    assert.deepEqual(warnings.filter((line) => line.includes("standby conflict")), []);
    assert.equal(router.stats().standbyConflicts, 0);
  } finally {
    console.warn = originalWarn;
  }
});

test("重跑時又衝突 ⇒ 原樣往外丟（不得無限重試）", async () => {
  memberWriteRecency.clear();
  const primary = fakeDriver("primary");
  const replica = fakeDriver("replica");
  failOnQuery(replica.client, (text) => text === "SELECT 1 AS one", { code: "40001" });
  failOnQuery(primary.client, (text) => text === "SELECT 1 AS one", { code: "40001" });
  const originalWarn = console.warn;
  console.warn = () => {};
  const env = { PG_URL: "postgres://u@primary/db", PG_RO_URL: "postgres://u@standby/db" };
  const router = routerFor({ env, driver: { pool: replica.pool, candidateContent: null } });
  try {
    let captured = null;
    await assert.rejects(
      () => withPgReadSnapshot(primary, async (snapshot) => { await snapshot.query("SELECT 1 AS one"); },
        { memberReadSnapshot: true, userId: 7, env, readReplicaRouter: router }),
      (error) => { captured = error; return true; },
    );
    assert.equal(captured.code, "40001");
    assert.equal(replica.pool.connectCalls, 1, "只試一次待機");
    assert.equal(primary.pool.connectCalls, 1, "只重跑一次 primary（不無限重試）");
    assert.equal(router.stats().standbyConflicts, 1);
  } finally {
    console.warn = originalWarn;
  }
});

// ── 3. 寫入守門 ────────────────────────────────────────────────────────────
test("寫入語句進入會員唯讀快照 ⇒ 應用層先擋（訊息可判讀，不是 PG 的 read-only 錯誤）", async () => {
  const primary = fakeDriver("primary");
  const env = {};
  let captured = null;
  await assert.rejects(
    () => withPgReadSnapshot(primary, async (snapshot) => {
      await snapshot.query("INSERT INTO user_listing_flags (user_id, post_id, watched) VALUES (7, 1, 1)");
    }, { memberReadSnapshot: true, userId: 7, env }),
    (error) => { captured = error; return true; },
  );
  assert.equal(captured.code, READ_ONLY_SNAPSHOT_CODE);
  assert.equal(captured.name, "ReadOnlySnapshotViolationError");
  assert.equal(isReadOnlySnapshotViolation(captured), true);
  assert.match(captured.message, /唯讀快照/);
  assert.match(captured.message, /INSERT INTO user_listing_flags/);
  assert.doesNotMatch(captured.message, /cannot execute/);
  assert.doesNotMatch(captured.message, /read-only transaction/);
  // 擋在應用層：語句根本沒有送到伺服器（否則待機／PG 會吐沒有上下文的錯）。
  assert.equal(primary.client.queries.some((sql) => /^INSERT/i.test(sql)), false);
  // 快照仍然正常收尾（ROLLBACK 有跑、連線有還）。
  assert.ok(primary.client.queries.includes("ROLLBACK"));
  assert.equal(primary.client.released, null);
});

test("守門清單：讀取與交易控制放行；寫入（含鎖定讀取）一律拒絕", () => {
  for (const sql of [
    "SELECT 1", "WITH x AS (SELECT 1) SELECT * FROM x", "VALUES (1)", "SHOW work_mem",
    "EXPLAIN SELECT 1", READ_ONLY_BEGIN, "START TRANSACTION READ ONLY", "SET LOCAL jit = off",
    "ROLLBACK", "COMMIT", "SAVEPOINT sp", "RELEASE SAVEPOINT sp",
    "DECLARE c NO SCROLL CURSOR WITHOUT HOLD FOR SELECT post_id FROM listings", "FETCH FORWARD 512 FROM c",
    "CLOSE c", "  -- 註解\nSELECT 1", "/* c */ SELECT 1",
  ]) {
    assert.doesNotThrow(() => assertSnapshotStatementAllowed(sql), `應放行：${sql}`);
  }
  for (const sql of [
    "INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t", "TRUNCATE t",
    "CREATE TABLE t(i int)", "DROP TABLE t", "ALTER TABLE t ADD c int", "COPY t FROM STDIN",
    "SELECT post_id FROM listings FOR UPDATE", "SELECT post_id FROM listings FOR NO KEY UPDATE",
    "DECLARE c NO SCROLL CURSOR FOR INSERT INTO t VALUES (1)",
  ]) {
    assert.throws(() => assertSnapshotStatementAllowed(sql), (error) => isReadOnlySnapshotViolation(error),
      `應拒絕：${sql}`);
  }
});

// ── 4. 寫後新鮮期（路由提示）───────────────────────────────────────────────
test("寫後新鮮期：剛寫過的 uid 在窗口內整趟走 primary，過期／沒寫過走待機", async () => {
  const env = { PG_RO_URL: "postgres://u@standby:25434/db", MEMBER_READ_FRESHNESS_MS: "5000" };
  let clock = 1_000_000;
  const recency = createMemberWriteRecency({ windowMs: 5000, now: () => clock });
  assert.equal(recency.isFresh(7), false, "沒寫過 ⇒ 不新鮮");
  recency.markWrite(7);
  assert.equal(recency.isFresh(7), true);
  clock += 4999;
  assert.equal(recency.isFresh(7), true, "窗口內仍新鮮");
  clock += 2;
  assert.equal(recency.isFresh(7), false, "窗口過後不再新鮮");
  assert.equal(recency.size(), 0, "過期項必須從提示表移除（否則會隨會員數長大）");
  assert.equal(recency.isFresh(0), false, "uid=0（訪客）沒有自身狀態");
  // `MEMBER_READ_FRESHNESS_MS=0` ⇒ 關掉提示（一律走待機）。
  const off = createMemberWriteRecency({ now: () => clock });
  const previous = process.env.MEMBER_READ_FRESHNESS_MS;
  process.env.MEMBER_READ_FRESHNESS_MS = "0";
  try {
    off.markWrite(7);
    assert.equal(off.isFresh(7), false);
  } finally {
    if (previous == null) delete process.env.MEMBER_READ_FRESHNESS_MS;
    else process.env.MEMBER_READ_FRESHNESS_MS = previous;
  }
  // 設了 PG_RO_URL ＋ 剛寫過的 uid ⇒ 整趟走 primary（不再碰待機池）。
  const primary = fakeDriver("primary");
  const replica = fakeDriver("replica");
  const router = routerFor({ env, driver: { pool: replica.pool, candidateContent: null } });
  memberWriteRecency.clear();
  await withPgReadSnapshot(primary, async (snapshot) => { await snapshot.query("SELECT 1"); }, {
    memberReadSnapshot: true, userId: 7, env, readReplicaRouter: router,
  });
  assert.equal(router.stats().replicaReads, 1, "沒有提示時走待機（對照組）");
  assert.equal(primary.pool.connectCalls, 0);
  // 正式路徑用的共用提示表：標記之後同一個 uid 的請求要整趟走 primary。
  markMemberWrite(7);
  try {
    const prim2 = fakeDriver("primary2");
    const replica2 = fakeDriver("replica2");
    const router2 = routerFor({ env, driver: { pool: replica2.pool, candidateContent: null } });
    await withPgReadSnapshot(prim2, async (snapshot) => { await snapshot.query("SELECT 1"); }, {
      memberReadSnapshot: true, userId: 7, env, readReplicaRouter: router2,
    });
    assert.equal(router2.stats().replicaReads, 0, "剛寫過 ⇒ 不走待機");
    assert.equal(router2.stats().primaryReads, 1);
    assert.equal(replica2.pool.connectCalls, 0);
    assert.equal(prim2.pool.connectCalls, 1);
    assert.deepEqual(prim2.client.queries[0], READ_ONLY_BEGIN, "整趟仍是同一條 READ ONLY 快照");
    // 其他人的請求不受影響（提示是 per-uid）。
    const prim3 = fakeDriver("primary3");
    const replica3 = fakeDriver("replica3");
    const router3 = routerFor({ env, driver: { pool: replica3.pool, candidateContent: null } });
    await withPgReadSnapshot(prim3, async (snapshot) => { await snapshot.query("SELECT 1"); }, {
      memberReadSnapshot: true, userId: 8, env, readReplicaRouter: router3,
    });
    assert.equal(router3.stats().replicaReads, 1, "別的 uid 照樣走待機");
    assert.equal(prim3.pool.connectCalls, 0);
  } finally {
    memberWriteRecency.clear();
  }
});

test("多節點／重啟：提示表各自獨立 ⇒ 另一台沒有提示（最壞後果只用複製延遲封頂）", () => {
  let clock = 0;
  const nodeA = createMemberWriteRecency({ windowMs: 5000, now: () => clock });
  const nodeB = createMemberWriteRecency({ windowMs: 5000, now: () => clock });
  nodeA.markWrite(42);
  assert.equal(nodeA.isFresh(42), true);
  assert.equal(nodeB.isFresh(42), false, "B 沒有看到 A 的寫入 ⇒ 會走待機（複製延遲窗口）");
  clock += 6000;
  assert.equal(nodeA.isFresh(42), false, "重啟（新實例）／過期後同樣沒有提示");
});

test("memberWriteMiddleware：只有「mutating 且成功」才記提示", async () => {
  const marked = [];
  const app = express();
  app.use((req, _res, next) => { req.fakeUid = Number(req.headers["x-uid"] || 0); next(); });
  app.use(memberWriteMiddleware({ userIdOf: (req) => req.fakeUid, onWrite: (uid) => marked.push(uid) }));
  app.post("/ok", (_req, res) => res.json({ ok: true }));
  app.post("/bad", (_req, res) => res.status(400).json({ ok: false }));
  app.get("/read", (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/ok`, { method: "POST", headers: { "x-uid": "7" } });
    await fetch(`${base}/bad`, { method: "POST", headers: { "x-uid": "7" } });
    await fetch(`${base}/read`, { headers: { "x-uid": "7" } });
    await fetch(`${base}/ok`, { method: "POST", headers: { "x-uid": "0" } });
    // `finish` 事件是非同步的：等它跑完（用一次 event loop turn）。
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(marked, [7], "只有成功的、帶 uid 的寫入會記提示");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("來源護欄：server.js 掛的是 memberWriteMiddleware，且 handler 沒有自己組提示", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /app\.use\(memberWriteMiddleware\(\{ userIdOf: \(req\) => readSession\(req\)\?\.userId \}\)\)/);
});

test("來源護欄：會員列表快照是唯一允許 PG_RO_URL 的路（listingSearchPage 帶 memberReadSnapshot）", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/listingSearchPage.js", import.meta.url), "utf8");
  assert.match(page, /withPgReadSnapshot\(pgDriver, run, \{[\s\S]*?memberReadSnapshot: true[\s\S]*?userId: Number\(args\.userId\) \|\| 0/);
  assert.match(page, /isReadOnlySnapshotViolation\(error\)\) throw error/);
  // 反過來：其他呼叫端不得偷偷開這條路（`listingSearchPage.js` 以外沒有 memberReadSnapshot）。
  for (const file of ["pgReadSnapshot.js", "listingStatsAsync.js", "publicListingSearchAsync.js", "listingSearchNodePg.js"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.equal(/memberReadSnapshot:\s*true/.test(source.replace(/\/\/[^\n]*/g, "")), false,
      `${file} 不得自己開 memberReadSnapshot`);
  }
});

// ── 5. live PG（需隔離庫；CI 的拋棄式 tracker_test 也在允許清單內）──────────
const RAW = String(process.env.PG_TEST_URL || process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2", "crawl_sandbox"]);
const DB_NAME = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB_NAME);
const liveSkip = !RAW ? "PG_TEST_URL／PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB_NAME}" 不在允許清單（正式庫一律拒絕）`
    : false;

async function liveSnapshot(run, { userId = 4242 } = {}) {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const driver = await createPostgresDriver({ connectionString: RAW });
  try {
    return await withPgReadSnapshot(driver, run, { memberReadSnapshot: true, userId });
  } finally {
    await driver.close();
  }
}

test("live PG：PG_RO_URL 有值 ⇒ 整條快照在待機池上，pg_stat_activity 看得到 5151-v3-ro", { skip: liveSkip }, async () => {
  const { resolvePostgresConfig } = await import("../src/dbDriverPostgres.js");
  const base = resolvePostgresConfig(process.env).options.application_name;
  process.env.PG_RO_URL = RAW;
  await sharedReadReplica.close();
  try {
    const seen = await liveSnapshot(async (snapshot) => {
      const app = await snapshot.query("SELECT current_setting('application_name') AS app");
      const activity = await snapshot.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1",
        [`${base}${READ_REPLICA_APPLICATION_NAME_SUFFIX}`],
      );
      return { app: app.rows[0].app, backends: activity.rows[0].n };
    });
    assert.equal(seen.app, `${base}${READ_REPLICA_APPLICATION_NAME_SUFFIX}`,
      "快照的每一句都要在待機池的連線上（application_name 有 -ro 後綴）");
    assert.ok(seen.backends >= 1, "pg_stat_activity 上要看得到待機池的後端（開閘後的第一個指標）");
  } finally {
    delete process.env.PG_RO_URL;
    await sharedReadReplica.close();
  }
});

test("live PG：PG_RO_URL 指向連不上的位址 ⇒ 整趟退回 primary（warning ＋ 同一個交易語意）", { skip: liveSkip }, async () => {
  const { resolvePostgresConfig } = await import("../src/dbDriverPostgres.js");
  const base = resolvePostgresConfig(process.env).options.application_name;
  const warnings = [];
  const originalWarn = console.warn;
  process.env.PG_RO_URL = "postgres://ro:ro@127.0.0.1:1/absent";
  process.env.PG_RO_CONNECT_TIMEOUT_MS = "300";
  await sharedReadReplica.close();
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    const app = await liveSnapshot(async (snapshot) => {
      const result = await snapshot.query("SELECT current_setting('application_name') AS app, pg_is_in_recovery() AS rec");
      return result.rows[0];
    });
    assert.equal(app.app, base, "整趟在 primary 池上（不是 -ro）");
    assert.ok(warnings.some((line) => line.includes(READ_REPLICA_FALLBACK_WARNING)),
      `必須留下可搜尋的 warning：${warnings.join(" | ")}`);
  } finally {
    console.warn = originalWarn;
    delete process.env.PG_RO_URL;
    delete process.env.PG_RO_CONNECT_TIMEOUT_MS;
    await sharedReadReplica.close();
  }
});

test("live PG：真伺服器的 SQLSTATE 與我們的衝突家族判定一致（25006 家族）", { skip: liveSkip }, async () => {
  // 待機的「與 recovery 衝突」在 PostgreSQL 是 serialization_failure(40001)，只有真的串流待機
  // 才生得出來（lab 不碰正式機 ⇒ 不重現）。這裡驗的是**真伺服器回傳的錯誤形狀**：
  // 唯讀交易裡的寫入一定是 `read_only_sql_transaction`，正是我們家族裡的另一員
  // ⇒ 證明「用 SQLSTATE 判」在真 PG 上拿得到、也對得上（不是我們自己編的字串比對）。
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const driver = await createPostgresDriver({ connectionString: RAW });
  const client = await driver.pool.connect();
  let captured = null;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await client.query("INSERT INTO user_listing_flags (user_id, post_id, watched) VALUES (-1, -1, 1)");
    } catch (error) { captured = error; }
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await driver.close();
  }
  assert.ok(captured, "唯讀交易裡的寫入必須被伺服器拒絕");
  assert.equal(captured.code, "25006", `真 PG 的 read-only 錯誤碼：${captured.code}`);
  assert.ok(STANDBY_CONFLICT_CODES.includes(captured.code));
  assert.equal(isStandbyConflictError(captured), true);
  const wrapped = new Error("listing search unavailable"); wrapped.code = "SEARCH_UNAVAILABLE"; wrapped.cause = captured;
  assert.equal(standbyConflictCode(wrapped), "25006", "被管線包一層也要認得");
});

test("live PG：真會員列表管線在 PG_RO_URL 開啟時跑得完（整條快照在 -ro 池上、寫入守門開著）", { skip: liveSkip, timeout: 240_000 }, async () => {
  const previousUrl = process.env.PG_RO_URL;
  const previousDriver = process.env.DB_DRIVER;
  const previousPgUrl = process.env.PG_URL;
  process.env.PG_RO_URL = RAW;
  process.env.PG_URL = RAW;
  process.env.DB_DRIVER = "postgres";
  const { closeSharedPgDriver } = await import("../src/pgSharedDriver.js");
  await sharedReadReplica.close();
  await closeSharedPgDriver();
  try {
    const { loadListingPage } = await import("../src/listingSearchPage.js");
    const args = {
      filter: "all", kind: "", sources: "", q: "", sort: "newest", limit: 20, offset: 0,
      districts: [], userId: 1, matchVoteUserId: 1, sameHouse: true,
    };
    const page = await loadListingPage(args, { driver: "postgres" });
    assert.ok(Array.isArray(page.listings), "真管線必須回得出 listings");
    assert.ok(page.stats && typeof page.stats === "object");
    assert.ok(sharedReadReplicaStats().replicaReads >= 1, "整條請求的快照必須在待機池上（-ro）");
    assert.equal(sharedReadReplicaStats().standbyConflicts, 0, "這台隔離庫不該有複製衝突");
    // B：走了一趟掃描時，`scan_ms` 必須是整數毫秒（述詞不共用前綴時不會有這個鍵 ⇒ 不強制存在）。
    const scanMs = page.timing?.stats_stages?.scan_ms;
    if (scanMs != null) {
      assert.equal(Number.isInteger(scanMs), true, "scan_ms 必須是整數毫秒");
      assert.ok(scanMs >= 0);
    }
    // 既有度量語意不變：stats_ms 仍是 statsPrepareMs + 計數段（只驗型別與存在）。
    assert.equal(typeof page.timing.stats_ms, "number");
    assert.equal(typeof page.timing.query_ms, "number");
  } finally {
    await sharedReadReplica.close();
    await closeSharedPgDriver();
    if (previousUrl == null) delete process.env.PG_RO_URL; else process.env.PG_RO_URL = previousUrl;
    if (previousDriver == null) delete process.env.DB_DRIVER; else process.env.DB_DRIVER = previousDriver;
    if (previousPgUrl == null) delete process.env.PG_URL; else process.env.PG_URL = previousPgUrl;
    markMemberWrite(1); // 真管線跑過寫入提示的路徑也不會壞（不是斷言，只是不要把提示表留在半路）
    memberWriteRecency.clear();
  }
});

test("live PG：寫入企圖在真連線上被應用層擋下，且同一條快照仍可繼續讀（ROLLBACK 正常）", { skip: liveSkip }, async () => {
  let captured = null;
  await assert.rejects(
    () => liveSnapshot(async (snapshot) => {
      await snapshot.query("INSERT INTO user_listing_flags (user_id, post_id, watched) VALUES (-1, -1, 1)");
      await snapshot.query("SELECT 1");
    }),
    (error) => { captured = error; return true; },
  );
  assert.equal(captured?.code, READ_ONLY_SNAPSHOT_CODE);
  // 再跑一次快照：連線池沒有被弄壞（ROLLBACK 與 release 都正常）。
  const ok = await liveSnapshot(async (snapshot) => (await snapshot.query("SELECT 1 AS ok")).rows[0].ok);
  assert.equal(Number(ok), 1);
});
