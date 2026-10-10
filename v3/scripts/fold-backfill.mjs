// 同屋源折疊 fold_* 欄回填腳本（可中斷、可續跑、冪等、分批、含進度 log）。
// 只連隔離庫／正式庫由呼叫者以 PG_URL 指定；本腳本用 assertPgTargetAllowed 把關
// （正式庫只准由 Owner 在發版流程中改用「唯讀以外」的連線跑；預設只放行隔離庫）。
//
// 用法：
//   PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-backfill.mjs [batchSize] [budgetMs]
//
// 邏輯：
//   1. 冪等 ALTER：ADD COLUMN IF NOT EXISTS fold_rent_num / fold_refresh_kind /
//      fold_refresh_rel_ms / fold_refresh_abs_ms。
//   2. 以「fold_refresh_kind IS NULL」當「尚未回填」標記（回填後必為 0/1/2，永不 NULL）。
//   3. 每批讀 batchSize 列、用 computeFoldColumns 算、UPDATE；單批一個交易，失敗整批回滾
//      （下一輪會再看到同一批，天然續跑）。
//   4. 每批 log 進度 + 耗時；跑完印總計（總列數、回填數、耗時、平均每列 ms）。
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { computeFoldColumns } from "../src/match.js";

assertPgTargetAllowed("fold-backfill", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const drv = await createPostgresDriver({ env: process.env });
const batchSize = Math.max(1, Math.min(Number(process.argv[2]) || 3000, 20000));
const budgetMs = Number(process.argv[3]) || 0;

const DDL = [
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_rent_num double precision",
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_refresh_kind smallint",
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_refresh_rel_ms bigint",
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_refresh_abs_ms bigint",
];

for (const sql of DDL) await drv.pool.query(sql);
console.log("DDL ensured:", DDL.length, "columns");

const COLS = "post_id, price, price_num, extra_fee, extra_fees, extra_fee_text, tags, refresh_time, last_seen_at";
const UPDATE_SQL = toPostgresSql(
  "UPDATE listings SET fold_rent_num = ?, fold_refresh_kind = ?, fold_refresh_rel_ms = ?, fold_refresh_abs_ms = ? WHERE post_id = ?",
);

const totalRow = await drv.pool.query("SELECT count(*) AS n FROM listings");
const pendingRow = await drv.pool.query("SELECT count(*) AS n FROM listings WHERE fold_refresh_kind IS NULL");
const total = Number(totalRow.rows[0].n);
let pending = Number(pendingRow.rows[0].n);
console.log(`listings total=${total} pending(fold_refresh_kind IS NULL)=${pending}`);

let backfilled = 0;
let failed = 0;
const startedAt = Date.now();
let budgetUsed = false;

while (pending > 0) {
  const batchStarted = Date.now();
  const rows = (await drv.pool.query(
    `SELECT ${COLS} FROM listings WHERE fold_refresh_kind IS NULL ORDER BY post_id LIMIT ${batchSize}`,
  )).rows;
  if (!rows.length) break;

  const client = await drv.pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const f = computeFoldColumns(r);
      await client.query(UPDATE_SQL, [f.fold_rent_num, f.fold_refresh_kind, f.fold_refresh_rel_ms, f.fold_refresh_abs_ms, Number(r.post_id)]);
    }
    await client.query("COMMIT");
    backfilled += rows.length;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    failed += rows.length;
    console.error(`batch failed (${rows.length} rows):`, e?.message || e);
  } finally {
    client.release();
  }

  pending -= rows.length;
  const ms = Date.now() - batchStarted;
  const elapsed = Date.now() - startedAt;
  console.log(`batch backfilled=${rows.length} remaining=${pending} elapsed=${elapsed}ms batch_ms=${ms} rate=${(backfilled / elapsed * 1000).toFixed(0)}rows/s`);
  if (budgetMs > 0 && elapsed >= budgetMs) { budgetUsed = true; console.log(`budget ${budgetMs}ms reached, stopping (resumable)`); break; }
}

const elapsed = Date.now() - startedAt;
const finalPending = Number((await drv.pool.query("SELECT count(*) AS n FROM listings WHERE fold_refresh_kind IS NULL")).rows[0].n);
const perRowMs = backfilled ? (elapsed / backfilled).toFixed(2) : "0";
console.log(JSON.stringify({
  total,
  backfilled,
  failed,
  remainingPending: finalPending,
  budgetUsed,
  elapsedMs: elapsed,
  perRowMs,
  extrapolated182954ms: backfilled ? Math.round(elapsed / backfilled * 182954) : null,
}, null, 2));

await drv.pool.end();
