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

// ---------------------------------------------------------------------------
// 2.3b 第二段：寫入路徑（enqueue／claim／reclaim／finish／metric）parity
//
// 這一段刻意比「步驟紀錄」：同一串操作在兩個 driver 上跑完後，把每一步的結果與最後的
// 資料列狀態寫成字串，兩邊必須一模一樣。
//
// ⚠️ 寫入路徑的離線替身要看「有沒有生效」，所以 exec 必須回 { rows, rowCount }。
//    只回陣列的 shim（第一段用的那個）會被當成 rowCount 0 → claim 永遠搶不到。
//    information_schema.columns 是 PG 的目錄檢視，離線用 SQLite 的 pragma_table_info 回答。
// ---------------------------------------------------------------------------

function shimCounted(sql, params = []) {
  const text = String(sql).replace(/\$(\d+)/g, "?");
  if (/information_schema\.columns/i.test(text)) {
    return { rows: db.prepare("SELECT name AS column_name FROM pragma_table_info(?)").all(...params), rowCount: 0 };
  }
  const statement = db.prepare(text);
  if (/^\s*(select|with)/i.test(text) || /returning/i.test(text)) {
    const rows = statement.all(...params);
    return { rows, rowCount: rows.length };
  }
  const info = statement.run(...params);
  return { rows: [], rowCount: Number(info.changes) || 0 };
}
const pgWriteOptions = { driver: "postgres", exec: shimCounted, strict: true };

const WRITE_POST = 981001;
const WRITE_LISTING = { post_id: WRITE_POST, source: "houseprice", title: "寫入路徑 parity" };
const WRITE_NOW = 1_700_000_000_000;

function resetWriteFixture() {
  db.prepare("DELETE FROM listing_enrich_jobs").run();
  db.prepare("DELETE FROM listing_enrich_metrics").run();
  db.prepare("DELETE FROM listing_prep").run();
}

// 兩條 driver 走同一串步驟：入列 → 搶單 → 回收逾時租約 → 收尾 → 記 metrics。
async function driveWritePath(call) {
  resetWriteFixture();
  const steps = [];
  const job = await call.enqueue(WRITE_LISTING, { via: "scheduler", now: WRITE_NOW });
  steps.push(`enqueue:${job ? `${job.status}/${job.priority}/${job.request_seq}` : "null"}`);
  const claimed = await call.claim({ limit: 3 });
  steps.push(`claim:${claimed.length}:${claimed.map((row) => `${row.status}/${row.run_seq}/${row.attempt_count}`).join(",")}`);
  const first = claimed[0];
  if (!first) return steps;
  steps.push(`reclaim:${await call.reclaim(Date.now() + 10 * 60_000)}`);
  const done = await call.finish(first, { status: "succeeded", timings: { outcome: "succeeded" } });
  steps.push(`finish:${done.stale}/${done.superseded}/${done.status}`);
  await call.metric(first, { queued_ms: 5, attempt_wait_ms: 5, outcome: "succeeded" });
  const row = db.prepare("SELECT status, attempt_count, next_retry_at, lease_until FROM listing_enrich_jobs WHERE post_id = ?").get(WRITE_POST);
  steps.push(`row:${row.status}/${row.attempt_count}/${row.next_retry_at === null}/${row.lease_until === null}`);
  const metrics = db.prepare("SELECT COUNT(*) AS n, MIN(outcome) AS outcome FROM listing_enrich_metrics").get();
  steps.push(`metrics:${metrics.n}/${metrics.outcome}`);
  return steps;
}

// sqlite 分支（正式站預設）：async 入口必須與同步函式等價。
const sqliteCall = {
  enqueue: (listing, args) => enrichAsync.enqueueListingEnrichAsync(db, listing, args, { driver: "sqlite" }),
  claim: (args) => enrichAsync.claimEnrichJobsAsync(db, args, { driver: "sqlite" }),
  reclaim: (now) => enrichAsync.reclaimStaleEnrichJobsAsync(db, now, { driver: "sqlite" }),
  finish: (job, patch) => enrichAsync.finishEnrichJobAsync(db, job, patch, { driver: "sqlite" }),
  metric: (job, timings) => enrichAsync.recordEnrichMetricAsync(db, job, timings, { driver: "sqlite" }),
};

// postgres 分支（離線：exec 替身跑同一份 SQL 文字）。
const pgCall = {
  enqueue: (listing, args) => enrichAsync.enqueueListingEnrichAsync(db, listing, args, pgWriteOptions),
  claim: (args) => enrichAsync.claimEnrichJobsAsync(db, args, pgWriteOptions),
  reclaim: (now) => enrichAsync.reclaimStaleEnrichJobsAsync(db, now, pgWriteOptions),
  finish: (job, patch) => enrichAsync.finishEnrichJobAsync(db, job, patch, pgWriteOptions),
  metric: (job, timings) => enrichAsync.recordEnrichMetricAsync(db, job, timings, pgWriteOptions),
};

test("寫入路徑：sqlite 模式 async 入口與同步函式做出同一件事", async () => {
  const viaAsync = await driveWritePath(sqliteCall);
  const viaSync = await driveWritePath({
    enqueue: async (listing, args) => enrich.enqueueListingEnrich(db, listing, args),
    claim: async (args) => enrich.claimEnrichJobs(db, args),
    reclaim: async (now) => enrich.reclaimStaleEnrichJobs(db, now),
    finish: async (job, patch) => enrich.finishEnrichJobSync(db, job, patch),
    metric: async (job, timings) => enrich.recordEnrichMetric(db, job, timings),
  });
  assert.deepEqual(viaAsync, viaSync);
  assert.equal(viaAsync[0], "enqueue:queued/10/0");
  assert.equal(viaAsync[1], "claim:1:running/1/1");
});

test("寫入路徑：postgres 路徑（離線 exec）與 sqlite 路徑的步驟紀錄完全相同", async () => {
  const viaPg = await driveWritePath(pgCall);
  const viaSqlite = await driveWritePath(sqliteCall);
  assert.deepEqual(viaPg, viaSqlite);
  assert.equal(viaPg[2], "reclaim:1", "逾時租約要被回收");
  assert.equal(viaPg[3], "finish:false/false/succeeded");
  assert.equal(viaPg[5], "metrics:1/succeeded");
});

test("寫入路徑：PG 路徑的列數判斷用 rowCount（拿不到 rowCount 就不算搶到）", async () => {
  resetWriteFixture();
  await enrichAsync.enqueueListingEnrichAsync(db, WRITE_LISTING, { via: "scheduler" }, pgWriteOptions);
  // 只回陣列、沒有 rowCount 的 exec：claim 必須回報「沒搶到」，不可以回一筆假的成功。
  const rowsOnly = { driver: "postgres", exec: async (sql, params = []) => shimCounted(sql, params).rows, strict: true };
  const claimed = await enrichAsync.claimEnrichJobsAsync(db, { limit: 3 }, rowsOnly);
  assert.deepEqual(claimed, [], "拿不到 rowCount 時不可宣稱搶到工作");
  // 註：這個替身仍然會把 UPDATE 送出去（語句先執行才拿得到結果），所以這裡檢查的是
  // 「回報」而不是「有沒有寫入」。真 PG 一定有 rowCount，正式路徑不會出現這個落差。
});

// ---------------------------------------------------------------------------
// 2.3b 第三段：種子查詢（seedHousepriceEnrichJobs 的候選 SELECT）
//
// 這條 SELECT 原本讀本機 SQLite；PG 模式下會拿到空的清單（或以本機資料產生錯誤的工作）。
// 這裡比對「兩條 driver 挑出同一批候選、產生同一批工作」。
// ---------------------------------------------------------------------------

const SEED_READY_POST = 981201;
const SEED_PENDING_POST = 981202;
const SEED_STAMP = "2026-09-01T00:00:00.000Z";

function seedListingsFixture() {
  const insert = db.prepare(`INSERT OR REPLACE INTO listings(
      post_id, source, source_id, source_key, title, url, price_num, address, floor_name,
      lat, lng, tags, offline, first_seen_at, last_seen_at
    ) VALUES (?, 'houseprice', ?, ?, ?, ?, 18000, ?, ?, 25.03, 121.56, '[]', 0, ?, ?)`);
  insert.run(SEED_READY_POST, "seed-ready", "hp-seed-ready", "已 ready 的物件", "https://example.test/ready", "台北市中正區", "3F", SEED_STAMP, SEED_STAMP);
  insert.run(SEED_PENDING_POST, "seed-pending", "hp-seed-pending", "還沒 ready 的物件", "https://example.test/pending", "台北市大安區", "5F", "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
  // 已 ready 的那筆要有 prep 列（display_ready = 1）才會被種子查詢排除。
  db.prepare("INSERT OR REPLACE INTO listing_prep(post_id, source, display_ready, prep_status) VALUES (?, 'houseprice', 1, 'ready')")
    .run(SEED_READY_POST);
}

function resetSeedFixture() {
  resetWriteFixture();
  seedListingsFixture();
}

// 種子候選是從 `listings` 挑的，所以 live 測試要真的把 fixture 的 listings 刪掉，
// 才能斷言「sqlite 分支不該有候選」（resetWriteFixture 只清 jobs／metrics／prep）。
function clearSeedListings() {
  db.prepare("DELETE FROM listings WHERE post_id IN (?, ?)").run(SEED_READY_POST, SEED_PENDING_POST);
}

test("種子查詢：sqlite 與 postgres 路徑挑出同一批候選並產生同一批工作", async () => {
  resetSeedFixture();
  const viaSqlite = await enrichAsync.seedHousepriceEnrichJobsAsync(db, { limit: 10 }, { driver: "sqlite" });
  const sqliteJobs = db.prepare("SELECT post_id, status, priority, requested_via, missing_fields FROM listing_enrich_jobs ORDER BY post_id").all();
  db.prepare("DELETE FROM listing_enrich_jobs").run();
  const viaPg = await enrichAsync.seedHousepriceEnrichJobsAsync(db, { limit: 10 }, pgWriteOptions);
  const pgJobs = db.prepare("SELECT post_id, status, priority, requested_via, missing_fields FROM listing_enrich_jobs ORDER BY post_id").all();
  assert.equal(viaSqlite, 1, "只有還沒 ready 的那筆要被挑到");
  assert.equal(viaPg, viaSqlite);
  assert.deepEqual(pgJobs, sqliteJobs);
  assert.equal(pgJobs[0].post_id, SEED_PENDING_POST);
  assert.equal(pgJobs[0].status, "queued");
  // 同步版也要給同一個答案（三條路徑共用同一份 SQL 與同一份 missing 推導）。
  db.prepare("DELETE FROM listing_enrich_jobs").run();
  assert.equal(enrich.seedHousepriceEnrichJobs(db, { limit: 10 }), 1);
  assert.deepEqual(
    db.prepare("SELECT post_id, status, priority, requested_via, missing_fields FROM listing_enrich_jobs ORDER BY post_id").all(),
    pgJobs,
  );
});

test("種子查詢：來源停用時不播種（sync 與 async 一致）", async () => {
  resetSeedFixture();
  const off = { isEnabled: () => false };
  assert.equal(enrich.seedHousepriceEnrichJobs(db, { limit: 10, ...off }), 0);
  assert.equal(await enrichAsync.seedHousepriceEnrichJobsAsync(db, { limit: 10, ...off }, { driver: "sqlite" }), 0);
  assert.equal(await enrichAsync.seedHousepriceEnrichJobsAsync(db, { limit: 10, ...off }, pgWriteOptions), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM listing_enrich_jobs").get().n, 0);
});

// ---------------------------------------------------------------------------
// 第二段的 live 驗證（PG_TEST_URL）：真的在影子站的 PostgreSQL 上跑一輪寫入。
// ---------------------------------------------------------------------------

test("live：PostgreSQL 的寫入路徑可以排入、搶到、收尾、記 metrics 與回收", async (t) => {
  const url = process.env.PG_TEST_URL;
  if (!url) {
    t.skip("PG_TEST_URL is not set (live listing enrich writes)");
    return;
  }
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const driver = await createPostgresDriver({ connectionString: url });
  const options = { driver: "postgres", pgDriver: driver, strict: true, sqliteHandle: db };
  const postId = 990000 + (Date.now() % 9000);
  let borrowed = [];
  try {
    const schema = await enrichAsync.ensureListingPrepSchemaAsync(db, options);
    assert.equal(schema.driver, "postgres", "PG 模式要走 information_schema 的欄位探測");
    await driver.query("DELETE FROM listing_enrich_jobs WHERE post_id = $1", [postId]);
    // 影子站是匯入進來、帶有殘留工作的資料庫，搶單是「優先權高者先、其次最舊者先」，
    // 所以測試用一個正式站不會出現的高優先權（正式站只有 10／20／60／100），保證搶到的是這一筆。
    const job = await enrichAsync.enqueueListingEnrichAsync(db, { post_id: postId, source: "houseprice" }, { via: "scheduler", priority: 999 }, options);
    assert.ok(job, "要能真的排入 PG");
    assert.equal(job.status, "queued");
    const claimed = await enrichAsync.claimEnrichJobsAsync(db, { limit: 8 }, options);
    const mine = claimed.find((row) => Number(row.post_id) === postId);
    borrowed = claimed.filter((row) => Number(row.post_id) !== postId).map((row) => row.id);
    assert.ok(mine, "剛排入的工作要搶到");
    assert.equal(mine.status, "running");
    assert.equal(Number(mine.attempt_count), 1);
    const done = await enrichAsync.finishEnrichJobAsync(db, mine, { status: "succeeded", timings: { outcome: "succeeded" } }, options);
    assert.deepEqual(done, { stale: false, superseded: false, status: "succeeded" });
    await enrichAsync.recordEnrichMetricAsync(db, mine, { queued_ms: 3, attempt_wait_ms: 3, outcome: "succeeded" }, options);
    const metrics = await driver.query("SELECT COUNT(*)::int AS n FROM listing_enrich_metrics WHERE post_id = $1", [postId]);
    assert.equal(Number(metrics.rows[0].n), 1, "metrics 要真的寫進 PG");
    const reclaimed = await enrichAsync.reclaimStaleEnrichJobsAsync(db, Date.now(), options);
    assert.equal(typeof reclaimed, "number", "回收筆數要是數字（PG 用 rowCount）");
    assert.equal(await enrichAsync.jobStillOwnsRunAsync(db, { ...mine, run_seq: -1 }, options), false, "run_seq 不符時不可宣稱擁有這輪執行");
    assert.equal(await enrichAsync.jobStillOwnsRunAsync(db, mine, options), true, "run_seq 相符時才擁有這輪執行");
  } finally {
    try {
      await driver.query("DELETE FROM listing_enrich_jobs WHERE post_id = $1", [postId]);
      await driver.query("DELETE FROM listing_enrich_metrics WHERE post_id = $1", [postId]);
      // 搶單是批次動作，可能會順手把影子站上其他殘留工作標成 running；
      // 這裡把它們放回 queued，不要留下副作用（租約到期也會被回收，但不要靠那個）。
      if (borrowed.length) {
        await driver.query("UPDATE listing_enrich_jobs SET status = 'queued', lease_until = NULL WHERE id = ANY($1::bigint[])", [borrowed]);
      }
    } catch {
      /* 清不掉不影響上面的斷言 */
    }
    await driver.close();
  }
});

// 同契約的 **CI fixture 版**（astra 2026-09-25 裁決 §3）。
//
// 為什麼不能用下面那支 `PG_SHADOW_URL` 測試來覆蓋 ✗：它斷言「PG 分支挑得到候選」✓，
// 而 CI 的拋棄式 PG **是空的** ✗ ⇒ 硬改用 `PG_TEST_URL` 會直接失敗（seed 0 筆 ✗）。
//
// 本測試改為**自己建 fixture 候選** ✓ ⇒ 不需要影子站 ✓，也不假裝 PG 有正式資料 ✓：
//   • 以 `PG_TEST_URL` 為 gate ✓（CI 既有拋棄式 PG ✓，由 run-pg-integration.sh 收斂 ✓）
//   • 在 PG 插一筆符合 seed 條件的 listings（`source='houseprice'`、`offline=0`、
//     且**沒有** `listing_prep` 列 ✓）—— 只帶 5 個無 DEFAULT 的 NOT NULL 欄 ＋ offline ✓
//     （其餘靠 schema DEFAULT ✓；欄位清單以 `db.js` 的 DDL 實查為準 ✓）
//   • 斷言 seed > 0 ✓（PG 分支挑到剛建的候選 ✓）
//   • 斷言**本機 SQLite 的 `listing_enrich_jobs` 仍為 0** ✓（PG 模式不得寫本機 SQLite ✓）
//   • 結束自行清理 ✓
test("live：種子查詢在 PG（CI fixture 自建候選）挑得到，且不寫本機 SQLite", async (t) => {
  const url = process.env.PG_TEST_URL;
  if (!url) {
    t.skip("PG_TEST_URL is not set（本測試為 PG job 的 fixture 版；不需要影子站 ✓）");
    return;
  }
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const driver = await createPostgresDriver({ connectionString: url });
  const options = { driver: "postgres", pgDriver: driver, strict: true, sqliteHandle: db };
  const FIXTURE_ID = 900000001;
  const iso = new Date().toISOString();
  try {
    resetWriteFixture();
    clearSeedListings();
    // 在本機 SQLite 建**不可用**的對照：PG 模式下它不該被讀、也不該被寫 ✓
    assert.equal(
      await enrichAsync.seedHousepriceEnrichJobsAsync(db, { limit: 2 }, { driver: "sqlite" }),
      0,
      "本機 fixture 沒有任何 listings，sqlite 分支不該有候選",
    );

    // 自己建 fixture 候選到 PG ✓（5 個無 DEFAULT 的 NOT NULL 欄 ＋ offline ✓）
    await driver.query(
      `INSERT INTO listings (post_id, source, source_key, title, url, first_seen_at, last_seen_at, offline)
       VALUES ($1, 'houseprice', $2, $3, $4, $5, $6, 0)
       ON CONFLICT (post_id) DO NOTHING`,
      [FIXTURE_ID, `fixture|${FIXTURE_ID}`, "fixture 標題", `https://example.test/${FIXTURE_ID}`, iso, iso],
    );

    const seeded = await enrichAsync.seedHousepriceEnrichJobsAsync(db, { limit: 2 }, options);
    assert.ok(seeded > 0, "PG 分支必須挑到剛建的 fixture 候選");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM listing_enrich_jobs").get().n,
      0,
      "PG 模式不可寫到本機 SQLite",
    );
  } finally {
    // 自行清理 ✓（工作列先刪，再刪候選 ✓）
    await driver.query("DELETE FROM listing_enrich_jobs WHERE post_id = $1", [FIXTURE_ID]).catch(() => {});
    await driver.query("DELETE FROM listings WHERE post_id = $1", [FIXTURE_ID]).catch(() => {});
    await driver.close();
  }
});

// 種子查詢的 live 驗證：影子站（＝正式站資料的匯入）有候選，本機 SQLite fixture 沒有，
// 所以要能明確分辨「讀的是哪一個 store」。跑完把自己新增的工作刪掉。
test("live：種子查詢讀的是 PostgreSQL，不是本機 SQLite", async (t) => {
  // 這個測試**本質上需要「影子站」**（＝正式站資料的匯入）：它斷言 PG 分支挑得到候選 ✗，
  // 而 CI 的拋棄式 PG 是空的 ⇒ 不能用 PG_TEST_URL 假裝有影子站 ✗。
  // 依 astra §3.4「必要測試不得 skip」：此測試**不是** PR-B 的必要 gate，故以專屬 PG_SHADOW_URL
  // 明確 gate（理由寫在使用者可見的 skip 訊息與 CI 文件中）。
  const url = process.env.PG_SHADOW_URL;
  if (!url) {
    t.skip("PG_SHADOW_URL is not set（需要匯入正式站資料的影子站；不屬於 CI 必要 gate）");
    return;
  }
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const driver = await createPostgresDriver({ connectionString: url });
  const options = { driver: "postgres", pgDriver: driver, strict: true, sqliteHandle: db };
  const startedAt = new Date().toISOString();
  try {
    resetWriteFixture();
    clearSeedListings();
    assert.equal(
      await enrichAsync.seedHousepriceEnrichJobsAsync(db, { limit: 2 }, { driver: "sqlite" }),
      0,
      "本機 fixture 沒有任何 listings，sqlite 分支不該有候選",
    );
    const seeded = await enrichAsync.seedHousepriceEnrichJobsAsync(db, { limit: 2 }, options);
    assert.ok(seeded > 0, "影子站有候選（正式站資料的匯入），PG 分支要被挑到");
    // 本機 SQLite 不可留下任何工作（PG 模式的讀與寫都必須落在 PG）。
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM listing_enrich_jobs").get().n, 0, "PG 模式不可寫到本機 SQLite");
    // 用同一組候選條件自己查一次，當作獨立對照：每一筆候選在 PG 都要有對應的工作列。
    // （影子站上那幾筆可能本來就有工作列，所以種子是「更新」不是「新增」——不能用 created_at 找。）
    const candidates = await driver.query(
      `SELECT l.post_id FROM listings l
         LEFT JOIN listing_prep p ON p.post_id = l.post_id
        WHERE l.source = 'houseprice'
          AND COALESCE(l.offline, 0) = 0
          AND (p.post_id IS NULL OR p.display_ready = 0)
        ORDER BY COALESCE(p.checked_at, l.first_seen_at) ASC, l.post_id ASC
        LIMIT 2`,
    );
    assert.equal(candidates.rows.length, seeded, "挑到幾筆候選就該回報幾筆");
    const jobs = await driver.query(
      "SELECT post_id FROM listing_enrich_jobs WHERE post_id = ANY($1::bigint[])",
      [candidates.rows.map((row) => Number(row.post_id))],
    );
    assert.equal(jobs.rows.length, seeded, "每一筆候選在 PG 都要有對應的工作列");
  } finally {
    try {
      await driver.query("DELETE FROM listing_enrich_jobs WHERE requested_via = 'scheduler' AND created_at >= $1", [startedAt]);
    } catch {
      /* 清不掉不影響上面的斷言 */
    }
    await driver.close();
  }
});

