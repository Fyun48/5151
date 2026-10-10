// 投影重新同步（repro／隔離庫）：以 listings 為來源，重算並 upsert「stored 值有差」的投影列。
// 目的：驗證 parity 殘差是否來自投影過時，並作為寫入路徑漏同步的補齊工具。
//
// 特性（相對舊版補強）：
//   - 冪等：每個 post_id 都是 upsert，重跑結果不變。
//   - 分批：`--batch N`（預設 5000）。
//   - 可中斷續跑：`--resume-from <post_id>`（只掃 post_id > 該值）；每批印 cursor 供斷點重接。
//   - 只碰有差的列：`--only-diff`（預設開）先比 stored 值，相同就不寫（省寫入、也讓「改了哪些」可觀測）。
//   - 唯讀以外的寫入都落在 listing_search_projection。
//
// 用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/projection-resync.mjs [--batch 5000] [--resume-from 0] [--no-only-diff] [--limit N]
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { computeListingProjection, listingProjectionUpsertSql, bindProjectionValues } from "../src/listingSearchProjection.js";

assertPgTargetAllowed("projection-resync", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });
const drv = await createPostgresDriver({ env: process.env });

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
const BATCH = Math.max(1, Number(arg("--batch", 5000)) || 5000);
const RESUME_FROM = Number(arg("--resume-from", 0)) || 0;
const ONLY_DIFF = !process.argv.includes("--no-only-diff");
const LIMIT = Number(arg("--limit", 0)) || 0;

const COMPARE_COLUMNS = ["district", "kind", "kind_keys", "rent", "total_monthly_cost", "area", "floor", "total_floors", "elevator", "parking", "rooftop", "low_floor", "primary_listing_id", "offline_state", "updated_at"];

function normalize(col, v) {
  if (col === "updated_at" || col === "area" || col === "lat" || col === "lng") return Number(v);
  return typeof v === "number" ? v : String(v ?? "");
}

function differs(fresh, stored) {
  for (const col of COMPARE_COLUMNS) {
    if (normalize(col, fresh[col]) !== normalize(col, stored?.[col])) return true;
  }
  return false;
}

let cursor = RESUME_FROM;
let scanned = 0;
let changed = 0;
let skippedSame = 0;
const t0 = Date.now();
const upsertSql = toPostgresSql(listingProjectionUpsertSql());

while (true) {
  const rows = (await drv.pool.query(
    `SELECT * FROM listings WHERE post_id > $1 ORDER BY post_id LIMIT $2`,
    [cursor, BATCH],
  )).rows;
  if (!rows.length) break;
  const ids = rows.map((r) => Number(r.post_id));
  const storedRows = (await drv.pool.query(
    `SELECT * FROM listing_search_projection WHERE post_id = ANY($1::bigint[])`,
    [ids],
  )).rows;
  const storedById = new Map(storedRows.map((r) => [Number(r.post_id), r]));

  const client = await drv.pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const fresh = computeListingProjection(r);
      const stored = storedById.get(Number(r.post_id));
      if (ONLY_DIFF && stored && !differs(fresh, stored)) {
        skippedSame += 1;
      } else {
        await client.query(upsertSql, bindProjectionValues(fresh));
        changed += 1;
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  scanned += rows.length;
  cursor = Number(rows[rows.length - 1].post_id);
  if (LIMIT && scanned >= LIMIT) break;
  console.log(`scanned=${scanned} changed=${changed} skippedSame=${skippedSame} cursor=${cursor} elapsed=${Date.now() - t0}ms`);
}

const elapsedMs = Date.now() - t0;
console.log(JSON.stringify({ scanned, changed, skippedSame, cursor, elapsedMs, perRowMs: scanned ? Number((elapsedMs / scanned).toFixed(3)) : 0 }));
await drv.pool.end();
