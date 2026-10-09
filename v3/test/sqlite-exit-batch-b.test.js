// 開閘大批 B（sqlite-exit batch B）單測：PG 原生 schema／結構讀取不再需要 SQLite。
//
// 對應的驗收：
//   * pgSchema 不再需要 SQLite 也能取得結構（fake pgDriver 記錄 SQL，斷言不含 sqlite_master）
//   * demand／wish-rooms 的 ensureDemandStoreOnce 開閘走 PG 原生 DDL（不碰 SQLite handle）
//   * sponsor_entitlement（migration v11）開閘走 PG 原生 DDL（不碰 SQLite handle）
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const pgSchema = await import("../src/pgSchema.js");
const demandAsync = await import("../src/demandAsync.js");
const demandPgSchema = await import("../src/demandPgSchema.js");
const sponsorAsync = await import("../src/sponsorEntitlementAsync.js");
const sponsorPgSchema = await import("../src/sponsorEntitlementPgSchema.js");

function fakePgDriver() {
  const exec = [];
  const query = [];
  return {
    exec: async (sql) => { exec.push(String(sql)); },
    query: async (sql, _params = []) => { query.push(String(sql)); return { rows: [] }; },
    _exec: exec,
    _query: query,
  };
}

test("pgTableInfo／pgTableExists 走 information_schema，不碰 sqlite_master", async () => {
  const fake = fakePgDriver();
  await pgSchema.pgTableExists(fake, "demand_posts");
  await pgSchema.pgTableInfo(fake, "demand_posts");
  const sql = [...fake._query].join("\n");
  assert.ok(sql.includes("information_schema.tables"), "pgTableExists 應查 information_schema.tables");
  assert.ok(sql.includes("information_schema.columns"), "pgTableInfo 應查 information_schema.columns");
  assert.ok(!sql.includes("sqlite_master"), "不該出現 sqlite_master");
});

test("ensureDemandStoreOnce 開閘（無可用 sqlite handle）走 PG 原生 DDL，不含 sqlite_master", async () => {
  const fake = fakePgDriver();
  await demandAsync.ensureDemandStoreOnce(fake, null);
  const ddl = fake._exec;
  // 三張表都要 CREATE TABLE IF NOT EXISTS。
  for (const name of demandPgSchema.DEMAND_PG_TABLE_NAMES) {
    assert.ok(
      ddl.some((sql) => sql.includes(`CREATE TABLE IF NOT EXISTS ${name}`)),
      `應有 ${name} 的 CREATE TABLE IF NOT EXISTS`,
    );
  }
  // 部分唯一索引（同一人只能有一則 open）與部分索引都要補。
  assert.ok(ddl.some((sql) => sql.includes("idx_demand_one_open") && sql.includes("WHERE status = 'open'")));
  assert.ok(ddl.some((sql) => sql.includes("idx_demand_public_token") && sql.includes("WHERE public_token IS NOT NULL")));
  // 建表來源是資料驅動的 DDL，不是 SQLite 鏡射。
  assert.ok(!ddl.join("\n").includes("sqlite_master"), "原生路徑不該讀 sqlite_master");
  assert.ok(!ddl.join("\n").includes("PRAGMA"), "原生路徑不該有 PRAGMA");
});

test("ensureDemandStoreOnce 有可用 sqlite handle 時仍走鏡射路徑（行為不變）", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const t of ["demand_posts", "demand_replies", "demand_reports"]) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL)`);
  }
  const fake = fakePgDriver();
  await demandAsync.ensureDemandStoreOnce(fake, sqlite);
  // 鏡射路徑會由 SQLite 的 schema 建 CREATE TABLE（表名打頭），不會有 demandPgSchema 的 identity 型別。
  assert.ok(fake._exec.some((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS demand_posts")), "鏡射路徑仍建表");
  sqlite.close();
});

test("sponsor_entitlement（v11）開閘走 PG 原生 DDL：三表＋唯一約束，不含 sqlite_master", async () => {
  const fake = fakePgDriver();
  await sponsorAsync.ensureSponsorEntitlementStoreForTest(fake, null);
  const ddl = fake._exec;
  for (const name of sponsorPgSchema.SPONSOR_ENTITLEMENT_PG_TABLE_NAMES) {
    assert.ok(
      ddl.some((sql) => sql.includes(`CREATE TABLE IF NOT EXISTS ${name}`)),
      `應有 ${name} 的 CREATE TABLE IF NOT EXISTS`,
    );
  }
  // code 與 support_transaction_id 的 UNIQUE：內聯 UNIQUE(...) ＋ 唯一索引後盾。
  const create = ddl.filter((sql) => sql.startsWith("CREATE TABLE"));
  assert.ok(create.some((sql) => sql.includes("UNIQUE (\"code\")") || sql.includes("UNIQUE (code)")), "member_support_code 要有 code UNIQUE");
  assert.ok(ddl.filter((sql) => sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS")).length >= 2, "兩個唯一索引後盾");
  assert.ok(!ddl.join("\n").includes("sqlite_master"), "原生路徑不該讀 sqlite_master");
  assert.ok(!ddl.join("\n").includes("PRAGMA"), "原生路徑不該有 PRAGMA");
});
