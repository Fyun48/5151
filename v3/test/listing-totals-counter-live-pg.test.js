// `dbTotal` 精準計數器的 **live PG** 驗證：真表、真交易、真 COUNT。
//
// 為什麼一定要 live：這個計數器的正確性全部依賴「同一句 `INSERT ... ON CONFLICT DO UPDATE
// RETURNING (xmax = 0)` 在同一個交易裡回報它到底是新增還是更新」以及「`total = total + $1`
// 的 UPSERT 不會靜默掉列」——這兩件事只有真的 PostgreSQL 能證明，假 driver 只會證明我自己的假設。
//
// 驗的六件事（對應 Owner 的設計要求）：
//   1. 同交易維護：`upsertListingRow()` 新增列 ⇒ `+1`；同一列再 upsert（更新）⇒ `0`；
//      fixture 列（`fixture_namespace` 非空）⇒ 產品桶 `0`。
//   2. 對帳：真 COUNT 覆蓋計數器，值必須與 `COUNT(*)` 逐位相同。
//   3. 繞過收口點的寫入：直接 `INSERT` 10 列（不經過收口點）⇒ 偵測器要求對帳 ⇒ 對帳後回真值，
//      並留下 `drift_count` 證據。
//   4. fail-safe：`LISTING_TOTALS_COUNTER=0`、表被 `DROP`、列不可用 ⇒ 讀取端一律回 `null`
//      （呼叫端會走真 COUNT，所以**讀取路徑永遠回正確數字**）。
//   5. 冪等：重複 `ensureListingTotalsReady()`／重複對帳不會把計數器歸零或重複累加。
//   6. 回退：`DROP TABLE` 一句就回到現行行為；之後下一次對帳會自癒重建。
//
// ⚠️ 安全設計照抄 `data-revision-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個可能指向
// 正式庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名必須在允許清單內。
// （本檔內出現 `PG_TEST_URL` 這個字串是為了讓 `run-pg-integration.sh` 的收檔
//   `grep -rl PG_TEST_URL` 把這支收進 PG 整合測試——那是既有慣例，不是真的讀它。）
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "prb-listing-totals-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

const schema = await import("../src/listingTotalsPgSchema.js");
const counter = await import("../src/listingTotalsPgCounter.js");
const { createWritePath } = await import("../src/repository/writePath.js");

const POST = 9_910_001;
const BULK = 10;
const ISOLATION = { sql: schema.DEFAULT_LISTING_TOTALS_PREDICATE, params: [] };

// ── 自我隔離（2026-10-12 修正）──────────────────────────────────────────────
// 這一支原本在**共用靶**（`repro`／`tracker_test`）上 `DROP TABLE listing_totals_counter`：
// 跑一次測試就會把別人的靶打掉（而且跑完還留一張被 DROP 掉的表）。
// 現在照抄 `v3/test/write-path-parity.test.js` 的既有形狀：**自建 schema** ＋
// `poolOptions.options = -c search_path=<schema>,public`，收尾 `DROP SCHEMA … CASCADE`。
//   • 計數器表（`listing_totals_counter`）完全落在自己的 schema ⇒ DROP 掉的是自己的東西；
//   • `listings` 沿用 `public`（**不鏡射、不重建**）：一來不必複製 18 萬列，二來
//     `listingTotalsScanDue()` 的偵測器是 `pg_stat_user_tables WHERE relname='listings'`
//     （沒有 schema 條件）——多一張同名表就會讓它讀到另一張、把「繞過收口點的寫入」判成沒發生。
// **不對共用庫的任何既有物件做 DROP／TRUNCATE／ALTER。**
//
// ⚠️ 自癒路徑（`defaultPrimaryDriver()`）走 `PG_URL` ⇒ 這裡也把它指到同一個 search_path，
// 否則測試會去打共用庫的 `public`（那正是要避免的事）。
const SCHEMA = `sw1_listing_totals_${process.pid}`;
const withSearchPath = (url, name) => {
  const u = new URL(url);
  u.searchParams.set("options", `-c search_path=${name},public`);
  return u.toString();
};
process.env.PG_URL = withSearchPath(RAW, SCHEMA);

let pgDriver = null;
let adminDriver = null;

after(async () => {
  if (pgDriver) await pgDriver.close().catch(() => {});
  if (adminDriver) {
    try { await adminDriver.exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } catch { /* 已經收掉 */ }
    await adminDriver.close().catch(() => {});
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function connect() {
  if (pgDriver) return pgDriver;
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  adminDriver = await createPostgresDriver({ connectionString: RAW });
  const who = (await adminDriver.query("SELECT current_database() AS db, current_schema() AS schema")).rows[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");
  await adminDriver.exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await adminDriver.exec(`CREATE SCHEMA ${SCHEMA}`);
  pgDriver = await createPostgresDriver({ connectionString: RAW, poolOptions: { options: `-c search_path=${SCHEMA},public` } });
  const where = (await pgDriver.query("SELECT current_schema() AS schema")).rows[0];
  assert.equal(where.schema, SCHEMA, "這一支的所有連線都必須落在自己的 schema（不動共用物件）");
  // 計數器表由模組自己的 DDL 建（`search_path` 讓它落在本 schema）。
  for (const statement of schema.listingTotalsDdlStatements()) await pgDriver.exec(statement);
  const columns = (await pgDriver.query(
    "SELECT 1 AS present FROM information_schema.columns WHERE table_name = 'listings' AND column_name = 'fixture_namespace' LIMIT 1",
  )).rows;
  assert.equal(columns.length, 1, "listings 必須有 fixture_namespace（否則桶的定義不成立）");
  return pgDriver;
}

const execRows = (sql, params = []) => pgDriver.query(sql, params).then((res) => res.rows);
const trueCount = async () => Number((await pgDriver.query(
  `SELECT COUNT(*) AS n FROM listings WHERE ${ISOLATION.sql}`, ISOLATION.params,
)).rows[0].n);

/**
 * **同一個快照**裡同時讀「計數器」與「真 COUNT」——這是本包最強的不變式：
 * 計數器與 `listings` 的寫入在同一個交易 ⇒ 任何一個快照看到的兩者要嘛都含、要嘛都不含
 * ⇒ 兩者必須**逐位相等**，而且這個斷言**不受並行寫入影響**（正式站爬蟲一直在寫）。
 * 反之，若「先讀計數器、之後才 COUNT」，兩者差 1–2 是並行寫入的正常量增（不是 bug）。
 */
async function snapshotPair() {
  const res = await pgDriver.query(
    `SELECT (SELECT total FROM ${schema.LISTING_TOTALS_TABLE} WHERE bucket_key = '${schema.DEFAULT_LISTING_TOTALS_BUCKET}') AS counter,
            (SELECT COUNT(*) FROM listings WHERE ${ISOLATION.sql}) AS truth`,
  );
  const row = res.rows[0];
  return { counter: Number(row.counter), truth: Number(row.truth) };
}

/** 走**真正的寫入收口點**（`writePath.upsertListingRow`）＋計數器維護。 */
async function upsertListingRow(fields) {
  return pgDriver.withTransaction(async (client) => {
    const txDriver = { query: (sql, params = []) => client.query(sql, params), exec: (sql) => client.query(sql) };
    const writer = createWritePath({ driver: "postgres", pgDriver: txDriver });
    return writer.upsertListingRow(fields);
  });
}

const STAMP = "2026-10-12T00:00:00.000Z";
const baseListing = (overrides = {}) => ({
  post_id: POST, source_key: "p10-live", search_key: "https://p10.test", title: "p10 計數器 live",
  url: "https://p10.test/1", price: "1萬", price_num: 10000, extra_fee: 0,
  first_seen_at: STAMP, last_seen_at: STAMP, last_event: "new",
  ...overrides,
});

test("live PG：同交易維護 ＋ 對帳 ＋ 繞過偵測 ＋ fail-safe ＋ 回退", { skip }, async (t) => {
  await connect();
  await pgDriver.query("DELETE FROM listings WHERE post_id >= $1 AND post_id < $2", [POST, POST + BULK + 1]);
  await pgDriver.query(`DROP TABLE IF EXISTS ${schema.LISTING_TOTALS_TABLE}`);
  counter.resetListingTotalsForTests();

  await t.test("① 對帳建立桶並以真 COUNT 覆蓋（第一次不算 drift）", async () => {
    const report = await counter.reconcileListingTotalsOnce({ pgDriver });
    // CI 的整合庫可能是**空的**（`listings` 0 列）⇒ 這裡只要求「是一個合法的精準值」，
    // 真正的不變式是下面的「同一個快照內逐位相等」。
    assert.ok(Number.isFinite(report.value) && report.value >= 0);
    assert.equal(report.drift, 0, "第一次建立桶不算 drift");
    const snap = await snapshotPair();
    assert.equal(snap.counter, snap.truth, "同一個快照內，計數器必須逐位等於真 COUNT");
    assert.equal(await counter.readListingTotalsForStats({ exec: execRows, isolation: ISOLATION }), report.value);
  });

  await t.test("② 新增一列（收口點）⇒ +1；再 upsert 同一列 ⇒ 不變", async () => {
    const before = await trueCount();
    await upsertListingRow(baseListing());
    assert.ok(await trueCount() >= before + 1, "新增列一定要落地（並行寫入只會更多）");
    let snap = await snapshotPair();
    assert.equal(snap.counter, snap.truth, "同一個快照內，計數器必須逐位等於真 COUNT");
    const afterInsert = await trueCount();
    await upsertListingRow(baseListing({ title: "更新標題" }));
    assert.equal(await trueCount(), afterInsert, "更新不得改變列數");
    snap = await snapshotPair();
    assert.equal(snap.counter, snap.truth, "純更新（不跨 fixture 邊界）不得加減計數器");
  });

  await t.test("③ fixture 列：移進 fixture 之後，產品桶以對帳覆蓋回真值", async () => {
    await pgDriver.query("UPDATE listings SET fixture_namespace = 'stage1-fix:live' WHERE post_id = $1", [POST]);
    const real = await trueCount();
    const fromCounter = await counter.readListingTotalsForStats({ exec: execRows, isolation: ISOLATION });
    assert.ok(fromCounter == null || fromCounter >= real, "計數器最多只能是偏高的舊值，不可以低於真值");
    // 站上沒有任何程式路徑會改 `fixture_namespace`（只有測試／Stage-1 工具），
    // 所以這條 UPDATE 造成的偏差由**有界對帳**覆蓋——這裡直接證明覆蓋後逐位相同。
    await counter.reconcileListingTotalsOnce({ pgDriver });
    const snapAfter = await snapshotPair();
    assert.equal(snapAfter.counter, snapAfter.truth, "對帳後同一個快照內必須逐位相等");
    await pgDriver.query("UPDATE listings SET fixture_namespace = NULL WHERE post_id = $1", [POST]);
    await counter.reconcileListingTotalsOnce({ pgDriver });
    const snapBack = await snapshotPair();
    assert.equal(snapBack.counter, snapBack.truth);
  });

  await t.test("④ 繞過收口點的批次寫入 ⇒ 偵測器觸發對帳（不是當門檻）", async () => {
    // 先對帳一次把統計基線定下來（`pg_stat_user_tables` 的計數是累計值）。
    await counter.reconcileListingTotalsOnce({ pgDriver });
    const baseline = await trueCount();
    await pgDriver.query(
      `INSERT INTO listings (post_id, source_key, search_key, title, url, first_seen_at, last_seen_at)
       SELECT $1 + g, 'p10-live-bypass', '', 'bypass', '', $2, $2 FROM generate_series(1, $3) g`,
      [POST, STAMP, BULK],
    );
    await pgDriver.query("SELECT pg_stat_force_next_flush()");
    const due = await counter.listingTotalsScanDue({ pgDriver });
    assert.equal(due.due, true, `偵測器應該要求對帳，實際 ${JSON.stringify(due)}`);
    const stale = await counter.readListingTotalsForStats({ exec: execRows, isolation: ISOLATION });
    assert.ok(stale == null || stale === baseline,
      `繞過收口點的列不會被計數器自動算到（實際 ${stale}／基線 ${baseline}）`);
    const report = await counter.reconcileListingTotalsOnce({ pgDriver });
    assert.ok(report.value >= baseline + BULK, "對帳要以真 COUNT 覆蓋（並行寫入只會更多）");
    assert.equal(report.drift, 1, "真值與計數器不一致時要留下 drift 證據");
    const snapBypass = await snapshotPair();
    assert.equal(snapBypass.counter, snapBypass.truth);
    const row = (await pgDriver.query(
      `SELECT drift_count FROM ${schema.LISTING_TOTALS_TABLE} WHERE bucket_key = $1`, [schema.DEFAULT_LISTING_TOTALS_BUCKET],
    )).rows[0];
    assert.ok(Number(row.drift_count) >= 1);
  });

  await t.test("⑤ fail-safe：開關關掉／表不存在／列不可用 ⇒ 一律回 null（呼叫端走真 COUNT）", async () => {
    process.env.LISTING_TOTALS_COUNTER = "0";
    try {
      assert.equal(await counter.readListingTotalsForStats({ exec: execRows, isolation: ISOLATION }), null);
    } finally {
      delete process.env.LISTING_TOTALS_COUNTER;
    }
    // 不支持（也不該支持）的述詞：不是預設桶 ⇒ 回 null。
    assert.equal(await counter.readListingTotalsForStats({ exec: execRows, isolation: { sql: "1=1", params: [] } }), null);
    // 回退：一句 DROP TABLE 就能回到現行行為。
    assert.equal(await counter.reconcileListingTotalsOnce({ pgDriver }).then((r) => r.value), await trueCount());
    await pgDriver.query(`DROP TABLE IF EXISTS ${schema.LISTING_TOTALS_TABLE}`);
    counter.forgetListingTotalsEnsured(pgDriver);
    assert.equal(await counter.readListingTotalsForStats({ exec: execRows, isolation: ISOLATION }), null,
      "表被 DROP 之後讀取端必須回 null（不得拿殘值）");
    // 自癒：下一次對帳把表與桶重建回來，值仍與真 COUNT 相同。
    const healed = await counter.reconcileListingTotalsOnce({ pgDriver });
    assert.equal(healed.value, await trueCount());
    assert.equal(await counter.readListingTotalsForStats({ exec: execRows, isolation: ISOLATION }), healed.value);
  });

  await t.test("⑥ 冪等：重複 ensure／重複對帳不會把計數器歸零或重複累加", async () => {
    const value = await counter.reconcileListingTotalsOnce({ pgDriver });
    await counter.ensureListingTotalsReady(pgDriver, {
      bucketKey: schema.DEFAULT_LISTING_TOTALS_BUCKET, predicateSql: schema.DEFAULT_LISTING_TOTALS_PREDICATE,
    });
    await counter.ensureListingTotalsReady(pgDriver, {
      bucketKey: schema.DEFAULT_LISTING_TOTALS_BUCKET, predicateSql: schema.DEFAULT_LISTING_TOTALS_PREDICATE,
    });
    const again = await counter.reconcileListingTotalsOnce({ pgDriver });
    assert.ok(Math.abs(again.value - value.value) <= 2, `重複對帳不得重複累加（${again.value} vs ${value.value}）`);
    const snapIdem = await snapshotPair();
    assert.equal(snapIdem.counter, snapIdem.truth);
  });

  await t.test("⑦ 清理：測試列與計數器列都不留", async () => {
    await pgDriver.query("DELETE FROM listings WHERE post_id >= $1 AND post_id < $2", [POST, POST + BULK + 1]);
    await counter.reconcileListingTotalsOnce({ pgDriver });
    const snapClean = await snapshotPair();
    assert.equal(snapClean.counter, snapClean.truth);
  });
});

test("live PG：計數器讀取走的是呼叫端給的執行器（同一條快照），且不發真 COUNT", { skip }, async () => {
  if (!pgDriver) await connect();
  counter.resetListingTotalsForTests();
  counter.resetListingTotalsPresenceForTests();
  await counter.ensureListingTotalsReady(pgDriver, {
    bucketKey: schema.DEFAULT_LISTING_TOTALS_BUCKET, predicateSql: schema.DEFAULT_LISTING_TOTALS_PREDICATE,
  });
  await counter.reconcileListingTotalsOnce({ pgDriver });

  // 用**一條連線 ＋ 一個交易**跑（＝`withPgReadSnapshot()` 在正式路徑上的形狀），
  // 這樣才真的走到 SAVEPOINT 保護那條分支。
  const client = await pgDriver.pool.connect();
  const sent = [];
  const exec = async (sql, params = []) => {
    sent.push(String(sql).replace(/\s+/g, " "));
    return client.query(sql, params).then((res) => res.rows);
  };
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const value = await counter.readListingTotalsForStats({ exec, isolation: ISOLATION });
    const snap = await client.query(
      `SELECT (SELECT total FROM ${schema.LISTING_TOTALS_TABLE} WHERE bucket_key = '${schema.DEFAULT_LISTING_TOTALS_BUCKET}') AS counter,
              (SELECT COUNT(*) FROM listings WHERE ${ISOLATION.sql}) AS truth`,
    );
    assert.equal(value, Number(snap.rows[0].counter), "讀到的值必須就是計數器的值");
    assert.equal(Number(snap.rows[0].counter), Number(snap.rows[0].truth), "同一個快照內必須逐位相等");
    assert.equal(sent.filter((sql) => /COUNT\(\*\) AS n FROM listings WHERE/.test(sql)).length, 0,
      "計數器可用時不得再打全表 COUNT");
    const data = sent.filter((sql) => !/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql));
    assert.ok(data.length >= 1 && data.length <= 2,
      `熱路徑的資料查詢只能有 1–2 條（表存在探測行程內快取 60 秒），實際 ${JSON.stringify(sent)}`);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

test("live PG：計數器讀取失敗不得毒化呼叫端的交易（頁面不可因此 500）", { skip }, async () => {
  if (!pgDriver) await connect();
  counter.resetListingTotalsForTests();
  // 先讓「表存在」的探測結果是 true（模擬表在請求中途被 DROP 掉的情形）。
  counter.resetListingTotalsPresenceForTests();
  await counter.ensureListingTotalsReady(pgDriver, {
    bucketKey: schema.DEFAULT_LISTING_TOTALS_BUCKET, predicateSql: schema.DEFAULT_LISTING_TOTALS_PREDICATE,
  });
  assert.ok(Number.isFinite(await counter.readListingTotalsForStats({ exec: execRows, isolation: ISOLATION })),
    "確保表存在後，讀取必須回一個數字（不可以是 null）");

  const client = await pgDriver.pool.connect();
  const exec = async (sql, params = []) => client.query(sql, params).then((res) => res.rows);
  try {
    await client.query("BEGIN");
    await client.query(`DROP TABLE ${schema.LISTING_TOTALS_TABLE}`);
    // 探測快取仍是「存在」⇒ 這裡會直接查計數器並失敗；SAVEPOINT 必須把失敗關在裡面。
    const value = await counter.readListingTotalsForStats({ exec, isolation: ISOLATION });
    assert.equal(value, null, "讀不到計數器時必須回 null（呼叫端走真 COUNT）");
    const still = await client.query("SELECT 1 AS ok");
    assert.equal(Number(still.rows[0].ok), 1, "呼叫端的交易必須還活著（否則整頁 500）");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  // 自癒：下一次對帳把表與桶重建回來。
  counter.forgetListingTotalsEnsured(pgDriver);
  counter.resetListingTotalsPresenceForTests();
  const healed = await counter.reconcileListingTotalsOnce({ pgDriver });
  assert.ok(Number.isFinite(healed.value) && healed.value >= 0);
  const snap = await snapshotPair();
  assert.equal(snap.counter, snap.truth);
});

/**
 * **#734 指紋缺陷的自癒（live PG）**：正式庫實測的形狀是「列存在、`usable=1`、`total` 正確、
 * 但 `predicate_sql` 是空字串」⇒ 讀取端述詞比對永遠不合 ⇒ 每個請求退回一次全表 COUNT
 * （單請求窗口 Δcalls=1／Δms=173–465）。這裡造出同一個形狀，走**讀取路徑**（
 * `readListingTotalsForStats`，也就是 `loadInputs` 呼叫的那一支）讓它自癒，並驗證：
 *   ① 修復前：`db_total_source=unusable`、回 `null`（呼叫端退回真 COUNT，數字正確只是慢）；
 *   ② 讀取路徑觸發修復後：列上的指紋變成正式述詞；
 *   ③ 之後的同一個讀取：`db_total_source=counter`、值＝同一個快照裡的真 COUNT；
 *   ④ 冪等：再修一次 rowCount=0（不重複寫）。
 *
 * ⚠️ 這一支只認 `PG_LIVE_REPRO_URL`（不吃 `PG_TEST_URL`；本機那個可能指向正式庫），
 * 允許清單與上面那一支共用。`PG_TEST_URL` 這個字串是給 `run-pg-integration.sh` 的收檔用的。
 */
test("live PG：空指紋自癒（讀取路徑觸發）⇒ 之後不再退回全表 COUNT", { skip }, async () => {
  await connect();
  await pgDriver.query("DELETE FROM listings WHERE post_id >= $1 AND post_id < $2", [POST, POST + BULK + 1]);
  await pgDriver.query(`DROP TABLE IF EXISTS ${schema.LISTING_TOTALS_TABLE}`);
  counter.resetListingTotalsForTests();
  counter.forgetListingTotalsEnsured(pgDriver);
  counter.resetListingTotalsPresenceForTests();

  // 造出正式庫的形狀：`predicate_sql=''`（寫入端的 delta UPSERT 就是這樣建列的）。
  await counter.ensureListingTotalsReady(pgDriver, { bucketKey: schema.DEFAULT_LISTING_TOTALS_BUCKET, predicateSql: "" });
  await pgDriver.query(
    `UPDATE ${schema.LISTING_TOTALS_TABLE} SET usable = 1, total = (SELECT COUNT(*) FROM listings WHERE ${ISOLATION.sql})
      WHERE bucket_key = $1`,
    [schema.DEFAULT_LISTING_TOTALS_BUCKET],
  );
  const seeded = (await pgDriver.query(
    `SELECT predicate_sql, usable FROM ${schema.LISTING_TOTALS_TABLE} WHERE bucket_key = $1`, [schema.DEFAULT_LISTING_TOTALS_BUCKET],
  )).rows[0];
  assert.equal(seeded.predicate_sql, "", "前置條件：列的指紋必須是空字串（#734 的形狀）");

  // ① 修復前的讀取：不可用、退回真 COUNT。診斷欄位要誠實說出「unusable」。
  const beforeDiag = {};
  const beforeValue = await counter.readListingTotalsForStats({ exec: execRows, isolation: ISOLATION, onDiagnostics: beforeDiag });
  assert.equal(beforeValue, null, "空指紋不得被當成可用值");
  assert.equal(beforeDiag.db_total_source, "unusable");

  // ② 讀取路徑已經把修復排進 primary（fire-and-forget）；等它落地。
  await counter.awaitListingTotalsPredicateRepair();
  const repaired = (await pgDriver.query(
    `SELECT predicate_sql FROM ${schema.LISTING_TOTALS_TABLE} WHERE bucket_key = $1`, [schema.DEFAULT_LISTING_TOTALS_BUCKET],
  )).rows[0];
  assert.equal(
    schema.normalizeListingTotalsPredicate(repaired.predicate_sql),
    schema.normalizeListingTotalsPredicate(schema.DEFAULT_LISTING_TOTALS_PREDICATE),
    "指紋必須被就地改寫成正式述詞",
  );

  // ③ 修復後：同一個讀取來源變成計數器，且值＝同一個快照裡的真 COUNT。
  await counter.reconcileListingTotalsOnce({ pgDriver, force: true });
  const afterDiag = {};
  const afterValue = await counter.readListingTotalsForStats({ exec: execRows, isolation: ISOLATION, onDiagnostics: afterDiag });
  const snap = await snapshotPair();
  assert.equal(afterDiag.db_total_source, "counter", "修復後不得再退回真 COUNT");
  assert.equal(afterValue, snap.counter, "計數器值必須是同一個快照裡的桶值");
  assert.equal(snap.counter, snap.truth, "同一個快照內，計數器必須逐位等於真 COUNT");

  // ④ 冪等：第二次修復不寫任何一列。
  const again = await counter.repairListingTotalsPredicateNow({ pgDriver });
  assert.equal(again.repaired, false);
  assert.equal(again.rows, 0);

  await pgDriver.query(`DROP TABLE IF EXISTS ${schema.LISTING_TOTALS_TABLE}`);
});

/**
 * **修復只補指紋，不宣告對帳成功（live PG）**。
 *
 * `usable=0` 的語意是「上一次真 COUNT 對帳失敗」（見同檔的對帳合約）：指紋修復只該讓列
 * 「認得出是哪一條述詞」，**不可以**順手把 `usable` 設回 1 —— 那會抹掉失敗訊號、讓讀取端吃
 * 一個可能過期的 `total`（違反「資料精準優先」）。所以這裡造一列 `usable=0 ∧ predicate_sql=''`：
 *   ① 修一次 ⇒ `predicate_sql` 變成正式述詞，但 `usable` **仍是 0**；
 *   ② 讀取端照樣不可用（快路徑關著，等下一次成功對帳才開）；
 *   ③ 再修一次 ⇒ `rowCount=0`（冪等）。
 */
test("live PG：usable=0 ∧ 空指紋 ⇒ 只補指紋、usable 仍為 0（不宣告對帳成功）", { skip }, async () => {
  await connect();
  await pgDriver.query("DELETE FROM listings WHERE post_id >= $1 AND post_id < $2", [POST, POST + BULK + 1]);
  await pgDriver.query(`DROP TABLE IF EXISTS ${schema.LISTING_TOTALS_TABLE}`);
  counter.resetListingTotalsForTests();
  counter.forgetListingTotalsEnsured(pgDriver);
  counter.resetListingTotalsPresenceForTests();

  await counter.ensureListingTotalsReady(pgDriver, { bucketKey: schema.DEFAULT_LISTING_TOTALS_BUCKET, predicateSql: "" });
  await pgDriver.query(
    `UPDATE ${schema.LISTING_TOTALS_TABLE} SET usable = 0, total = 0 WHERE bucket_key = $1`,
    [schema.DEFAULT_LISTING_TOTALS_BUCKET],
  );

  const first = await counter.repairListingTotalsPredicateNow({ pgDriver });
  assert.equal(first.repaired, true, "指紋必須被修好");
  assert.equal(first.rows, 1);
  const row = (await pgDriver.query(
    `SELECT predicate_sql, usable FROM ${schema.LISTING_TOTALS_TABLE} WHERE bucket_key = $1`, [schema.DEFAULT_LISTING_TOTALS_BUCKET],
  )).rows[0];
  assert.equal(
    schema.normalizeListingTotalsPredicate(row.predicate_sql),
    schema.normalizeListingTotalsPredicate(schema.DEFAULT_LISTING_TOTALS_PREDICATE),
    "predicate_sql 必須被改寫成正式述詞",
  );
  assert.equal(Number(row.usable), 0, "修指紋不得宣告對帳成功（usable 必須仍是 0）");

  // ② 讀取端仍然不可用：快路徑關著，等下一次成功對帳。
  const diag = {};
  const value = await counter.readListingTotalsForStats({ exec: execRows, isolation: ISOLATION, onDiagnostics: diag });
  assert.equal(value, null);
  assert.equal(diag.db_total_source, "unusable");

  // ③ 冪等：第二次不寫任何一列。
  const again = await counter.repairListingTotalsPredicateNow({ pgDriver });
  assert.equal(again.repaired, false);
  assert.equal(again.rows, 0);

  // ④ 成功對帳之後才由對帳把 usable 打開。
  await counter.reconcileListingTotalsOnce({ pgDriver, force: true });
  const usableDiag = {};
  const usableValue = await counter.readListingTotalsForStats({ exec: execRows, isolation: ISOLATION, onDiagnostics: usableDiag });
  assert.equal(usableDiag.db_total_source, "counter");
  assert.equal(usableValue, await trueCount());

  await pgDriver.query(`DROP TABLE IF EXISTS ${schema.LISTING_TOTALS_TABLE}`);
});
