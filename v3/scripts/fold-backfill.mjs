// 同屋源折疊 fold_* 欄回填腳本（冪等、分批、可續跑、只寫有差的列）。
// 只連隔離庫／正式庫由呼叫者以 PG_URL 指定；本腳本用 assertPgTargetAllowed 把關
// （正式庫只准由 Owner 在發版流程中改用「唯讀以外」的連線跑；預設只放行隔離庫）。
//
// 用法：
//   PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-backfill.mjs [batchSize] [budgetMs] [fromPostId]
//
// 邏輯：
//   1. 冪等 ALTER：ADD COLUMN IF NOT EXISTS fold_rent_num / fold_refresh_kind /
//      fold_refresh_rel_ms / fold_refresh_abs_ms。
//   2. 依 post_id 升序分批讀「fold 輸入欄 + 現存 fold_* 值」，用 computeFoldColumns 重算，
//      **只對重算值與現值不同的列發 UPDATE**（冪等：重跑不寫任何列）。
//   3. 每批一個交易，失敗整批回滾；`fromPostId` 是續跑水位（中斷後可從上次 cursor 繼續）。
//   4. 每批 log 進度 + 耗時；跑完印總計（總列數、掃過、實際寫入、未變、耗時、每列 ms）。
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { bindFoldColumnValues, computeFoldColumns, foldColumnsUpdateSql } from "../src/match.js";

assertPgTargetAllowed("fold-backfill", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const drv = await createPostgresDriver({ env: process.env });
const batchSize = Math.max(1, Math.min(Number(process.argv[2]) || 3000, 20000));
const budgetMs = Number(process.argv[3]) || 0;
const fromPostId = Number(process.argv[4]) || 0;

const DDL = [
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_rent_num double precision",
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_refresh_kind smallint",
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_refresh_rel_ms bigint",
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_refresh_abs_ms bigint",
];

for (const sql of DDL) await drv.pool.query(sql);
console.log("DDL ensured:", DDL.length, "columns");

const COLS = "post_id, price, price_num, extra_fee, extra_fees, extra_fee_text, tags, refresh_time, last_seen_at, fold_rent_num, fold_refresh_kind, fold_refresh_rel_ms, fold_refresh_abs_ms";
const UPDATE_SQL = toPostgresSql(foldColumnsUpdateSql());

const total = Number((await drv.pool.query("SELECT count(*) AS n FROM listings")).rows[0].n);
console.log(`listings total=${total} fromPostId=${fromPostId} batchSize=${batchSize}`);

// pg 可能把 bigint / double precision 回傳成字串，統一轉數字再比；null 保持 null。
const num = (v) => (v == null ? null : Number(v));
function foldDiffers(row, f) {
  return num(row.fold_rent_num) !== num(f.fold_rent_num)
    || num(row.fold_refresh_kind) !== num(f.fold_refresh_kind)
    || num(row.fold_refresh_rel_ms) !== num(f.fold_refresh_rel_ms)
    || num(row.fold_refresh_abs_ms) !== num(f.fold_refresh_abs_ms);
}

let cursor = fromPostId;
let scanned = 0;
let written = 0;
let unchanged = 0;
let failed = 0;
const startedAt = Date.now();
let budgetUsed = false;

while (true) {
  const batchStarted = Date.now();
  const rows = (await drv.pool.query(
    `SELECT ${COLS} FROM listings WHERE post_id > $1 ORDER BY post_id LIMIT ${batchSize}`,
    [cursor],
  )).rows;
  if (!rows.length) break;
  scanned += rows.length;
  cursor = Math.max(cursor, Number(rows[rows.length - 1].post_id));

  const diffs = [];
  for (const r of rows) {
    const f = computeFoldColumns(r);
    if (foldDiffers(r, f)) diffs.push({ f, postId: Number(r.post_id) });
  }
  unchanged += rows.length - diffs.length;

  if (diffs.length) {
    const client = await drv.pool.connect();
    try {
      await client.query("BEGIN");
      for (const d of diffs) {
        await client.query(UPDATE_SQL, bindFoldColumnValues(d.f, d.postId));
      }
      await client.query("COMMIT");
      written += diffs.length;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      failed += diffs.length;
      console.error(`batch failed (${diffs.length} diffs):`, e?.message || e);
    } finally {
      client.release();
    }
  }

  const ms = Date.now() - batchStarted;
  const elapsed = Date.now() - startedAt;
  console.log(`batch scanned=${rows.length} changed=${diffs.length} written=${written} unchanged=${unchanged} cursor=${cursor} elapsed=${elapsed}ms batch_ms=${ms}`);
  if (budgetMs > 0 && elapsed >= budgetMs) { budgetUsed = true; console.log(`budget ${budgetMs}ms reached, stopping (resumable; next run fromPostId=${cursor})`); break; }
}

const elapsed = Date.now() - startedAt;
const perRowMs = scanned ? (elapsed / scanned).toFixed(3) : "0";
console.log(JSON.stringify({
  total,
  fromPostId,
  scanned,
  written,
  unchanged,
  failed,
  budgetUsed,
  cursor,
  elapsedMs: elapsed,
  perRowMs,
  writtenPerSec: elapsed ? Math.round((written / elapsed) * 1000) : 0,
}, null, 2));

await drv.pool.end();
