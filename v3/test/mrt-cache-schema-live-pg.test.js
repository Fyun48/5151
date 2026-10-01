// R1（第二輪複審）：**既有 PG 表、還沒寫過新快取**時，讀取路徑必須先升級 schema。
//
// 審閱用舊 schema 重現 `no such column: source`：升級原本只掛在寫入路徑
// （`crawlerWrites.setCachedMrtAsync()`），但 `repository/decorationData.loadMrtCacheEntries()`
// 會 SELECT 新欄位 ⇒ 「先讀」就炸。這一支用**真的 PG**建一張舊形狀的表，再走讀取路徑驗升級。
//
// ⚠️ 安全設計同 `feedback-media-live-pg.test.js`：只認 `PG_LIVE_REPRO_URL`，
// 或資料庫名在允許清單內的 `PG_TEST_URL`。
process.env.PG_TEST_URL = process.env.PG_TEST_URL || "";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const pickUrl = () => {
  const live = String(process.env.PG_LIVE_REPRO_URL || "").trim();
  if (live) return live;
  const shared = String(process.env.PG_TEST_URL || "").trim();
  if (!shared) return "";
  try {
    const db = new URL(shared).pathname.replace(/^\//, "");
    return ALLOWED_DB.has(db) ? shared : "";
  } catch {
    return "";
  }
};
const RAW = pickUrl();
const skip = RAW ? false : "沒有可用的隔離 PG（PG_LIVE_REPRO_URL，或資料庫名在允許清單內的 PG_TEST_URL）";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-mrt-schema-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

const OLD_TABLE_SQL = `CREATE TABLE mrt_cache (
  geo_key TEXT PRIMARY KEY,
  station TEXT NOT NULL,
  walk_km REAL,
  walk_min REAL,
  ride_km REAL,
  ride_min REAL,
  updated_at TEXT NOT NULL
)`;

test("R1：舊形狀的 PG mrt_cache，讀取路徑會先升級再 SELECT", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { sqliteHandle } = await import("../src/db.js");
  const { ensureMrtCacheContractForRead, ensureMrtCacheContractOnce, MRT_CACHE_PG_COLUMNS } = await import("../src/mrtCacheSchema.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  t.after(async () => { try { await pgDriver.close(); } catch { /* 已關就算了 */ } });

  const columnsOf = async () => (
    await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'mrt_cache'")
  ).map((row) => String(row.column_name));

  // 1) 建一張**升級前**的表（沒有 source／checked／walk_m／searched_m）
  await query("DROP TABLE IF EXISTS mrt_cache");
  await pgDriver.exec(OLD_TABLE_SQL);
  const before = await columnsOf();
  assert.ok(before.includes("walk_km"));
  assert.ok(!before.includes("source"), "起點必須是舊 schema（沒有 source）");

  // 2) 舊 schema 下 SELECT 新欄位會失敗 —— 這就是要防的症狀
  await assert.rejects(
    () => query("SELECT geo_key, source FROM mrt_cache LIMIT 1"),
    (e) => /column .*source.* does not exist/i.test(String(e.message)),
    "舊 schema 讀新欄位應該要失敗（否則這條測試沒有鑑別力）",
  );

  // 3) 讀取路徑的升級入口（裝飾資料的 provider 用的就是這一個）
  await ensureMrtCacheContractForRead(async (sql, params = []) => query(sql, params));
  const after = await columnsOf();
  for (const need of ["source", "checked", "walk_m", "searched_m"]) {
    assert.ok(after.includes(need), `升級後要有 ${need}`);
  }
  // 4) 升級後同一句 SELECT 要成功，而且可以寫入一筆新契約的快取
  const rows = await query("SELECT geo_key, source, checked, walk_m, searched_m FROM mrt_cache LIMIT 1");
  assert.equal(rows.length, 0, "表是空的（還沒寫過新快取）");
  await query(
    `INSERT INTO mrt_cache(geo_key, station, walk_km, walk_min, ride_km, ride_min, updated_at, source, checked, walk_m, searched_m)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    ["live-schema-probe", "士林", 0.62, 8, null, null, new Date().toISOString(), "osrm-foot:v1", 1, 620.4, 1000],
  );
  const readBack = await query("SELECT walk_m, source, checked FROM mrt_cache WHERE geo_key = $1", ["live-schema-probe"]);
  assert.equal(Number(readBack[0].walk_m), 620.4, "原始公尺（含小數）要原樣存回來");
  await query("DELETE FROM mrt_cache WHERE geo_key = $1", ["live-schema-probe"]);

  // 5) 寫入路徑的升級入口也要是幂等的（表已經升級過了再呼叫一次不會壞）
  await ensureMrtCacheContractOnce(pgDriver);
  assert.equal(MRT_CACHE_PG_COLUMNS.length, 4);
  void sqliteHandle;
});

test("R1：preloadDecorationProviderAsync 在 PG 讀取前會先升級（真的呼叫）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  t.after(async () => { try { await pgDriver.close(); } catch { /* 已關就算了 */ } });

  // 回到舊形狀，然後**透過 preloadDecorationProviderAsync 這條真實入口**驗升級。
  await query("DROP TABLE IF EXISTS mrt_cache");
  await pgDriver.exec(OLD_TABLE_SQL);
  const { preloadDecorationProviderAsync } = await import("../src/db.js");
  const exec = async (sql, params = []) => query(sql, params);
  // `settings` 是這一條路徑的必要參數（沒有它會丟 "PG decoration requires settings"）。
  // 傳最小物件即可：這一條要驗的是「升級在讀取之前發生」，不是裝飾結果。
  await preloadDecorationProviderAsync({
    exec,
    driver: "postgres",
    rows: [],
    settings: { showMrt: false, systemCrawl: () => ({ showMrt: false }) },
  });
  const columns = (await query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'mrt_cache'",
  )).map((row) => String(row.column_name));
  for (const need of ["source", "checked", "walk_m", "searched_m"]) {
    assert.ok(columns.includes(need), `preloadDecorationProviderAsync 之後要有 ${need}`);
  }
});
