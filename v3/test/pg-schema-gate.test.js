// 開閘大批 G（sqlite-exit batch G）單測：`ensurePgSchema` 的中心修法。
//
// 對應的驗收（Owner 指定）：
//   * 開閘（帶 DSH_NO_OPEN_MARKER 的 proxy）下 `ensurePgSchema` 與三條 5 分鐘 tick 入口
//     **零** `db.prepare`／`db.exec`（同步 SQLite handle 完全不碰）。
//   * PG 端有實際查詢發生（`pgTableExists`／`pgTableInfo` → information_schema）。
//   * 失敗不被吞：PG 端缺表時直接拋錯（而不是靜默回傳空鏡射）。
//   * 未開閘（真實 sqlite handle）逐字回歸：鏡射路徑行為不變。
//
// 為什麼三條 tick 入口要用子行程：`ensureRentalNotifyWorkerOnce()`／`ensureOfferStoreOnce()`
// 內部 hardcode `sqliteHandle()`（來自 db.js），要讓它回傳「開閘拋錯 proxy」只能靠
// DB_DRIVER=postgres＋PG_NO_SQLITE_OPEN=1 在乾淨 process 裡各自 import（同 pg-no-sqlite-open.test.js）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pgSchema = await import("../src/pgSchema.js");
const sqliteHandleMod = await import("../src/sqliteHandle.js");

function closedProxy() {
  const target = {
    prepare() { throw new Error("business SQLite is closed (proxy) prepare"); },
    exec() { throw new Error("business SQLite is closed (proxy) exec"); },
  };
  Object.defineProperty(target, sqliteHandleMod.DSH_NO_OPEN_MARKER, { value: true });
  return target;
}

function fakePgDriver(rows = [{ name: "id", type: "bigint", is_nullable: "NO", column_default: null }]) {
  const exec = [];
  const query = [];
  return {
    exec: async (sql) => { exec.push(String(sql)); },
    query: async (sql, _params = []) => { query.push(String(sql)); return { rows }; },
    _exec: exec,
    _query: query,
  };
}

test("開閘 proxy → ensurePgSchema 走 PG 原生 information_schema，不碰 sqlite prepare/exec", async () => {
  const fake = fakePgDriver();
  const proxy = closedProxy();
  const result = await pgSchema.ensurePgSchema(fake, proxy, { tables: ["rental_notify_events", "rental_notify_deliveries"] });
  assert.deepEqual(result.tables, ["rental_notify_events", "rental_notify_deliveries"], "回傳請求的表");
  assert.equal(result.statements, 0, "開閘路徑不產生 SQLite 鏡射 DDL");
  const sql = fake._query.join("\n");
  assert.ok(sql.includes("information_schema.tables"), "pgTableExists 應查 information_schema.tables");
  assert.ok(sql.includes("information_schema.columns"), "pgTableInfo 應查 information_schema.columns");
  assert.ok(!sql.includes("sqlite_master"), "不得出現 sqlite_master");
  assert.ok(!sql.includes("PRAGMA"), "不得出現 PRAGMA");
  assert.equal(fake._exec.length, 0, "開閘路徑不應送出 SQLite 鏡射 DDL（CREATE TABLE）");
});

test("開閘 proxy → 缺表時 ensurePgSchema 直接拋錯（失敗不被吞）", async () => {
  const fake = fakePgDriver([]); // pgTableExists → 0 列（表不存在）
  const proxy = closedProxy();
  await assert.rejects(
    () => pgSchema.ensurePgSchema(fake, proxy, { tables: ["nope"] }),
    /PostgreSQL 缺少資料表 nope/,
    "PG 端缺表必須拋錯",
  );
  assert.ok(fake._query.some((sql) => sql.includes("information_schema.tables")), "存在性檢查有實際查 PG");
});

test("未開閘（真實 sqlite handle）→ 鏡射路徑逐字回歸，仍讀 SQLite schema", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE demand_posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL)");
  const fake = fakePgDriver();
  const result = await pgSchema.ensurePgSchema(fake, sqlite, { tables: ["demand_posts"] });
  assert.equal(result.tables[0], "demand_posts");
  assert.ok(fake._exec.some((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS demand_posts")), "鏡射路徑仍建表");
  assert.equal(fake._query.length, 0, "未開閘路徑不查 information_schema");
  sqlite.close();
});

// ── 三條 5 分鐘 tick 入口（子行程，開閘下注入 fake pgDriver）───────────────────────────

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const PROBE = `
const { writeFileSync } = await import("node:fs");
const flags = {
  wish: {
    lifecycle_enabled: true,
    offer_enabled: true,
    notifications_enabled: true,
    owner_matching_enabled: false,
    digest_enabled: false,
    outbound_mail_enabled: false,
    outbound_push_enabled: false,
  },
};
function fakePgDriver() {
  const queries = [];
  const execs = [];
  const answer = (sql) => {
    queries.push(String(sql));
    // information_schema（pgTableExists/pgTableInfo）回一列＝表存在且有欄位；其餘業務查詢回空。
    if (String(sql).includes("information_schema")) {
      return { rows: [{ name: "id", type: "bigint", is_nullable: "NO", column_default: null }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query: async (sql, _p = []) => answer(sql) };
  const driver = {
    query: async (sql, _p = []) => answer(sql),
    exec: async (sql) => { execs.push(String(sql)); },
    withTransaction: async (fn) => fn(client),
  };
  return { driver, queries, execs };
}
const lifecycle = await import("./src/wishLifecycleAsync.js");
const offers = await import("./src/wishOffersAsync.js");
const notify = await import("./src/rentalNotifyWorkerAsync.js");

async function runOne(name) {
  const fake = fakePgDriver();
  const opts = { driver: "postgres", pgDriver: fake.driver, strict: true };
  try {
    let r;
    if (name === "wish-lifecycle") r = await lifecycle.runWishLifecycleTickAsync(new Date(), { flags }, opts);
    else if (name === "wish-offer-expiry") r = await offers.runWishOfferExpiryTickAsync(new Date(), { flags }, opts);
    else r = await notify.runRentalNotifyTickAsync(new Date(), { flags }, opts);
    return { ok: true, queries: fake.queries, execs: fake.execs, skipped: r?.skipped };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), queries: fake.queries, execs: fake.execs };
  }
}
const results = {};
for (const name of ["wish-lifecycle", "wish-offer-expiry", "rental-notify"]) {
  results[name] = await runOne(name);
}
writeFileSync(process.env.RESULT_FILE, JSON.stringify(results));
`;

function probeTick(env) {
  const dataDir = mkdtempSync(join(tmpdir(), "pgschema-"));
  const resultFile = join(dataDir, "result.json");
  const childEnv = {
    ...process.env,
    DB_DRIVER: "postgres",
    PG_NO_SQLITE_OPEN: "1",
    PG_SQLITE_FALLBACK: "strict",
    DATA_DIR: dataDir,
    RESULT_FILE: resultFile,
    ...env,
  };
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE], {
      cwd: repoRoot,
      env: childEnv,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (r.status !== 0) {
      return { error: `child exited ${r.status}: ${String(r.stderr).slice(0, 800)}` };
    }
    return JSON.parse(readFileSync(resultFile, "utf8"));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("開閘下三條 tick 入口都不回「business SQLite is closed」且都有查 information_schema", () => {
  const out = probeTick({});
  assert.equal(out.error, undefined, `子行程不該失敗：${out.error}`);
  for (const name of ["wish-lifecycle", "wish-offer-expiry", "rental-notify"]) {
    const r = out[name];
    assert.ok(r, `${name} 應有結果`);
    assert.ok(r.ok, `${name} 不該拋錯：${r.error}`);
    assert.doesNotMatch(String(r.error || ""), /business SQLite is closed/, `${name} 不該碰同步 SQLite`);
    const sql = (r.queries || []).join("\n");
    assert.ok(
      sql.includes("information_schema.tables") || sql.includes("information_schema.columns"),
      `${name} 應經由 pgTableExists/pgTableInfo 查 information_schema`,
    );
  }
});
