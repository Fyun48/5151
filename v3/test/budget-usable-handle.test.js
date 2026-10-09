// 升級層 D-0021 第二包：budget store「可用 handle」判準 ＋ executeWithProvider 不再因缺 handle 而 fallback。
//
// 四段：
//   1. sqliteHandleIsUsable 判準：null/undefined ⇒ false；帶 marker 的開閘 proxy ⇒ false；真 DatabaseSync ⇒ true。
//   2. 開閘 proxy（帶 marker）傳進 ensureBudgetStoreOnce ⇒ 走 PG 原生（record budgetPgDdlStatements＋setval），
//      不得出現「business SQLite is closed」。
//   3. ② executeWithProvider：PG 模式 + 無 handle 時照常走到 loadEnabled→reserve→settle（不回 fallback），
//      fake pgDriver 收到的 SQL 是 PG 原生路（不含 sqlite_master）。
//   4. 回歸：真 DatabaseSync handle 仍走鏡射（行為不變）；sqlite driver + 無 handle 的 executeWithProvider
//      fallback 照舊。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { executeWithProvider } from "../src/providers/executeWithProvider.js";
import { sqliteHandleIsUsable, DSH_NO_OPEN_MARKER } from "../src/sqliteHandle.js";

const budget = await import("../src/budgetGuard.js");
const budgetAsync = await import("../src/budgetGuardAsync.js");
const budgetPgSchema = await import("../src/budgetPgSchema.js");

// 與 db.js 的 createNoOpenSqliteProxy 同形的開閘 proxy（帶不可枚舉 marker、碰 method 就拋）。
function noOpenProxy() {
  const target = function sqliteClosed() {};
  Object.defineProperty(target, DSH_NO_OPEN_MARKER, { value: true });
  return new Proxy(target, {
    get(_target, prop) {
      if (prop === "then" || prop === "catch" || prop === "finally" || prop === "inspect") return undefined;
      if (typeof prop === "symbol") return undefined;
      return () => {
        throw new Error(`business SQLite is closed (PG_NO_SQLITE_OPEN=1, DB_DRIVER=postgres): synchronous SQLite handle access "${String(prop)}"`);
      };
    },
    apply() {
      throw new Error("business SQLite is closed (PG_NO_SQLITE_OPEN=1, DB_DRIVER=postgres): synchronous SQLite handle was invoked");
    },
  });
}

function fakePgDriver({ configRow, reservationRow, bucketRow }) {
  const exec = [];
  const queries = [];
  const txnQueries = [];
  const respond = (sql) => {
    const t = String(sql);
    if (t.includes("SELECT category FROM system_provider_configs")) return [{ category: "scraping_api" }];
    if (t.includes("FROM system_provider_configs") && t.includes("WHERE id")) return [configRow];
    if (t.includes("FROM system_provider_configs") && t.includes("WHERE category")) return [configRow];
    if (t.includes("INSERT INTO call_reservations") && t.includes("RETURNING")) return [{ id: 1 }];
    if (t.includes("FROM call_reservations") && t.includes("WHERE id")) return [reservationRow];
    if (t.includes("FROM call_reservations") && t.includes("WHERE request_id")) return [];
    if (t.includes("FROM budget_limits")) return [bucketRow];
    if (t.includes("FROM settings")) return [];
    return [];
  };
  return {
    exec: async (sql) => { exec.push(String(sql)); },
    query: async (sql, _params = []) => { queries.push(String(sql)); return { rows: respond(sql) }; },
    withTransaction: async (fn) => fn({
      query: async (sql, _params = []) => { txnQueries.push(String(sql)); return { rows: respond(sql) }; },
    }),
    _exec: exec,
    _queries: queries,
    _txnQueries: txnQueries,
  };
}

test("① sqliteHandleIsUsable：null/undefined/marker proxy 不可用，真 handle 可用", () => {
  assert.equal(sqliteHandleIsUsable(null), false);
  assert.equal(sqliteHandleIsUsable(undefined), false);
  assert.equal(sqliteHandleIsUsable(noOpenProxy()), false);

  const sqlite = new DatabaseSync(":memory:");
  try {
    assert.equal(sqliteHandleIsUsable(sqlite), true);
  } finally {
    sqlite.close();
  }
});

test("① 開閘 proxy（帶 marker）→ ensureBudgetStoreOnce 走 PG 原生，不撞 business SQLite is closed", async () => {
  const fake = fakePgDriver({
    configRow: {},
    reservationRow: { id: 1, job_state: "reserved", ceiling_minor: 0 },
    bucketRow: { id: 1, limit_minor: 0, reserved_minor: 0, settled_minor: 0 },
  });
  await budgetAsync.ensureBudgetStoreOnceForTest(fake, noOpenProxy());

  const ddl = fake._exec;
  const resync = fake._queries;
  for (const name of budgetPgSchema.BUDGET_PG_TABLE_NAMES) {
    assert.ok(
      ddl.some((sql) => sql.includes(`CREATE TABLE IF NOT EXISTS ${name}`)),
      `原生路徑應有 ${name} 的 CREATE TABLE IF NOT EXISTS`,
    );
  }
  assert.equal(
    resync.filter((sql) => sql.includes("setval") && sql.includes("pg_get_serial_sequence")).length,
    4,
    "原生路徑要對齊四張 identity 表的序號",
  );
});

test("② executeWithProvider：PG 模式 + 無 handle 走到 reserve→settle（不回 fallback），SQL 為 PG 原生", async () => {
  const configRow = {
    id: 1,
    category: "scraping_api",
    provider_code: "stub_paid",
    is_enabled: 1,
    credential_ref: null,
    price_version: "v1",
    daily_limit_minor: 20_000_000,
    monthly_limit_minor: 100_000_000,
    ceiling_minor: 1_000_000,
  };
  const reservationRow = {
    id: 1,
    request_id: "req-1",
    attempt_id: "a1",
    config_id: 1,
    price_version: "v1",
    ceiling_minor: 1_000_000,
    job_state: "reserved",
    created_at: "2026-09-11T04:00:00.000Z",
    settled_at: null,
  };
  const bucketRow = { id: 1, limit_minor: 20_000_000, reserved_minor: 0, settled_minor: 0 };
  const fake = fakePgDriver({ configRow, reservationRow, bucketRow });

  let actionCalled = false;
  let fallbackCalled = false;
  const out = await executeWithProvider({
    db: undefined,
    options: { driver: "postgres", pgDriver: fake },
    category: "scraping_api",
    now: new Date("2026-09-11T04:00:00.000Z"),
    actionWithProvider: async () => {
      actionCalled = true;
      return { value: "paid", usage: { costMinor: 1_000_000 } };
    },
    fallbackAction: async () => {
      fallbackCalled = true;
      return "free";
    },
  });

  assert.equal(out, "paid");
  assert.equal(actionCalled, true, "應走到 actionWithProvider（reserve→settle），不是缺 handle 的 fallback");
  assert.equal(fallbackCalled, false);

  // 原生 DDL 發到 pgDriver.exec（來自 budgetPgDdlStatements），不是 sqlite_master 鏡射。
  const allSql = [...fake._exec, ...fake._queries, ...fake._txnQueries].join("\n");
  assert.ok(allSql.includes("CREATE TABLE IF NOT EXISTS system_provider_configs"));
  assert.ok(!allSql.includes("sqlite_master"), "PG 原生路不得出現 sqlite_master");
  // loadEnabled 真的被呼叫到（有 system_provider_configs 的讀取，非缺 handle 短路）。
  assert.ok(
    fake._queries.some((sql) => sql.includes("FROM system_provider_configs") && sql.includes("WHERE category")),
    "應走到 budget.loadEnabled（對 system_provider_configs 的讀取）",
  );
  // 序號對齊 setval 走 query。
  assert.ok(fake._queries.some((sql) => sql.includes("setval")), "原生路徑應有 setval 序號對齊");
});

test("回歸：真 DatabaseSync handle 仍走鏡射（行為不變）", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  budget.ensureBudgetSchema(sqlite);

  const fake = fakePgDriver({
    configRow: {},
    reservationRow: { id: 1, job_state: "reserved", ceiling_minor: 0 },
    bucketRow: { id: 1, limit_minor: 0, reserved_minor: 0, settled_minor: 0 },
  });
  await budgetAsync.ensureBudgetStoreOnceForTest(fake, sqlite);
  sqlite.close();

  const ddl = fake._exec;
  const resync = fake._queries;
  // 鏡射路徑的 CREATE TABLE 不含內聯 UNIQUE（唯一索引由 BUDGET_UNIQUE_INDEXES 補）。
  assert.equal(
    ddl.filter((sql) => sql.startsWith("CREATE TABLE") && /UNIQUE\s*\(/.test(sql)).length,
    0,
    "鏡射路徑的建表不應有內聯 UNIQUE",
  );
  assert.equal(ddl.filter((sql) => sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS")).length, 3);
  assert.equal(resync.filter((sql) => sql.includes("setval")).length, 4);
});

test("回歸：sqlite driver + 無 handle 的 executeWithProvider fallback 照舊", async () => {
  let actionCalled = false;
  let fallbackCalled = false;
  const out = await executeWithProvider({
    db: undefined,
    options: { driver: "sqlite" },
    category: "scraping_api",
    actionWithProvider: async () => { actionCalled = true; return { value: "paid" }; },
    fallbackAction: async () => { fallbackCalled = true; return "free"; },
  });
  assert.equal(out, "free");
  assert.equal(fallbackCalled, true);
  assert.equal(actionCalled, false);
});
