// 2.3b 第一段 parity：listing enrich 的讀取與後台統計在兩個 driver 上一致。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-enrich-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the file locked */
  }
});

const app = await import("../src/db.js");
const enrich = await import("../src/listingEnrichQueue.js");
const enrichAsync = await import("../src/listingEnrichQueueAsync.js");

const db = app.sqliteHandle();
enrich.ensureListingPrepSchema(db);

// PostgreSQL exec 的離線替身：$n → ?，讀取走 all()，其餘走 run()。
function shim(sql, params = []) {
  const text = String(sql).replace(/\$(\d+)/g, "?");
  const st = db.prepare(text);
  const isRead = /^\s*(select|with)/i.test(text) || /returning/i.test(text);
  if (isRead) return st.all(...params);
  st.run(...params);
  return [];
}
const pgOptions = { driver: "postgres", exec: shim, strict: true };

test("sqlite 模式：async 入口與同步函式輸出完全相同", async () => {
  assert.deepEqual(await enrichAsync.listingPrepAdminStatsAsync(db, { driver: "sqlite" }), enrich.listingPrepAdminStats(db));
  assert.deepEqual(await enrichAsync.summarizeEnrichMetricsAsync(db, { driver: "sqlite" }), enrich.summarizeEnrichMetrics(db));
  assert.deepEqual(await enrichAsync.getListingPrepAsync(db, 999999, { driver: "sqlite" }), enrich.getListingPrep(db, 999999));
});

test("postgres 路徑（離線 exec）給出與 sqlite 相同的統計", async () => {
  const viaPg = await enrichAsync.listingPrepAdminStatsAsync(db, pgOptions);
  const viaSqlite = enrich.listingPrepAdminStats(db);
  assert.deepEqual(viaPg, viaSqlite);
  assert.equal(typeof viaPg.pendingPrep, "number");
  assert.equal(typeof viaPg.metrics.samples, "number");
  assert.deepEqual(Object.keys(viaPg).sort(), ["errors", "lastSuccessAt", "metrics", "oldestWaitAt", "pendingPrep", "readyPrep", "runningJobs", "waitingJobs"]);
  assert.deepEqual(Object.keys(viaPg.metrics).sort(), ["byOutcome", "samples", "stages"]);
});

test("live：影子站上的後台統計可以真的跑完（0 skip 由 PG_TEST_URL 決定）", async (t) => {
  const url = process.env.PG_TEST_URL;
  if (!url) {
    t.skip("PG_TEST_URL is not set (live listing enrich stats)");
    return;
  }
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { ensurePgSchema } = await import("../src/pgSchema.js");
  const driver = await createPostgresDriver({ connectionString: url });
  try {
    await ensurePgSchema(driver, db, { tables: enrichAsync.listingEnrichAsyncContext().LISTING_ENRICH_TABLES });
    const stats = await enrichAsync.listingPrepAdminStatsAsync(db, { driver: "postgres", pgDriver: driver, strict: true });
    assert.equal(typeof stats.pendingPrep, "number");
    assert.equal(typeof stats.metrics.samples, "number");
    assert.deepEqual(Object.keys(stats.errors).length >= 0, true);
  } finally {
    await driver.close();
  }
});

