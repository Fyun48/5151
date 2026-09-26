// F3（PR-B）：PG 投影的 kind_keys 定向回填（只更新這一個新欄位）。
//
// 為什麼不沿用 writer.syncProjection()：容器內 /app 跑的是「已部署」版本，還沒有 kind_keys 的程式碼，
// 用它回填會少寫這個欄位。因此本腳本自帶新程式碼（複製到 /tmp/kk，不動 /app），只 UPDATE 新欄位。
//
// 安全性：
//  - 先在 PG 確保欄位存在（與正式遷移同一句、idempotent）。
//  - 單趟掃描 + post_id 高水位；可中斷、可重跑（重跑只補還沒填的列）。
//  - 只寫 listing_search_projection.kind_keys，不動其他欄位、不刪列。
//  - 成功判準：kind_keys = '' 的列數應降為 0（合法的空集合會存成 ","，不會是空字串）。
//
// 用法（容器內）：cd /tmp/kk && node --input-type=module < kind-keys-backfill.mjs
//   環境變數：BATCH（每批列數，預設 500）、MAX_ROWS（本次上限，0=不限）、LOG_EVERY（每幾筆印一次）
import { createPostgresDriver } from "/app/src/dbDriverPostgres.js";
import { listingKindKeys } from "./src/floors.js";

const drv = await createPostgresDriver({ env: process.env });
const BATCH = Math.max(1, Number(process.env.BATCH) || 500);
const MAX_ROWS = Math.max(0, Number(process.env.MAX_ROWS) || 0);
const LOG_EVERY = Math.max(1, Number(process.env.LOG_EVERY) || 2000);
const started = Date.now();

await drv.query(`ALTER TABLE listing_search_projection ADD COLUMN IF NOT EXISTS kind_keys TEXT NOT NULL DEFAULT ''`);

const emptyCount = async () => Number((await drv.query(
  `SELECT COUNT(*)::int AS n FROM listing_search_projection WHERE kind_keys = ''`,
)).rows[0]?.n ?? -1);

const before = await emptyCount();
console.log(JSON.stringify({ at: new Date().toISOString(), emptyBefore: before, batch: BATCH, maxRows: MAX_ROWS }));

let scanned = 0;
let updated = 0;
let failed = 0;
let last = 0;
const failures = [];

while (true) {
  if (MAX_ROWS && scanned >= MAX_ROWS) break;
  const rows = (await drv.query(`
    SELECT l.* FROM listings l
    LEFT JOIN listing_search_projection p ON p.post_id = l.post_id
    WHERE l.post_id > $1 AND (p.kind_keys = '' OR p.post_id IS NULL)
    ORDER BY l.post_id
    LIMIT $2
  `, [last, BATCH])).rows;
  if (!rows.length) break;
  last = Number(rows[rows.length - 1].post_id) || 0;
  scanned += rows.length;
  for (const row of rows) {
    try {
      const keys = listingKindKeys(row);
      await drv.query(`
        INSERT INTO listing_search_projection (post_id, kind_keys) VALUES ($1, $2)
        ON CONFLICT (post_id) DO UPDATE SET kind_keys = excluded.kind_keys
      `, [row.post_id, keys]);
      updated += 1;
    } catch (error) {
      failed += 1;
      if (failures.length < 10) failures.push({ post_id: row.post_id, error: String(error?.message || error).slice(0, 160) });
    }
  }
  console.log(JSON.stringify({ scanned, updated, failed, last, sec: Math.round((Date.now() - started) / 1000) }));
  if (rows.length < BATCH) break;
}

const after = await emptyCount();
const withKeys = Number((await drv.query(
  `SELECT COUNT(*)::int AS n FROM listing_search_projection WHERE kind_keys <> ''`,
)).rows[0]?.n ?? -1);
console.log(JSON.stringify({
  finished: true,
  scanned,
  updated,
  failed,
  sec: Math.round((Date.now() - started) / 1000),
  emptyBefore: before,
  emptyAfter: after,
  withKeys,
  failures,
}, null, 2));
await drv.pool.end();
