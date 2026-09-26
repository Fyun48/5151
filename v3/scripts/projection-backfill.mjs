// PR-B：以 PG 主列驅動的投影回填（只寫 listing_search_projection，不動 listings）。
//
// 背景：實查 PG 投影缺 86,533 筆（其中 85,002 筆未隱藏且未下架＝本應可見），
// 原因是 PG 轉換時只帶了 3 萬多列投影、舊列沒有重建。
//
// 設計（依 ChatGPT 指令文件 §PR-B）：
//  - 不從舊 SQLite 當真相；完全以 PG 的 listings 為來源。
//  - 使用與正式寫入相同的路徑 writer.syncProjection(row)，確保投影語意一致。
//  - 分批、可重跑、可中斷（每批結束即已提交）；只 INSERT/UPDATE 投影，不刪除既有列。
//  - 環境變數：BATCH（每批列數）、MAX_ROWS（本次上限，0=不限）、LOG_EVERY（每幾筆印一次）。
import { createPostgresDriver } from "/app/src/dbDriverPostgres.js";
import { createWritePath } from "/app/src/repository/writePath.js";

const drv = await createPostgresDriver({ env: process.env });
const writer = createWritePath({ driver: "postgres", pgDriver: drv });
const BATCH = Math.max(1, Number(process.env.BATCH) || 200);
const MAX_ROWS = Math.max(0, Number(process.env.MAX_ROWS) || 0);
const LOG_EVERY = Math.max(1, Number(process.env.LOG_EVERY) || 500);

const started = Date.now();
let done = 0;
let failed = 0;
const failures = [];

const countMissing = async () => Number((await drv.query(`
  SELECT COUNT(*)::int AS n FROM listings l
  WHERE NOT EXISTS (SELECT 1 FROM listing_search_projection p WHERE p.post_id = l.post_id)
`)).rows[0]?.n ?? -1);

const before = await countMissing();
console.log(JSON.stringify({ at: new Date().toISOString(), missingBefore: before, batch: BATCH, maxRows: MAX_ROWS }));

while (true) {
  if (MAX_ROWS && done + failed >= MAX_ROWS) break;
  const rows = (await drv.query(`
    SELECT l.* FROM listings l
    WHERE NOT EXISTS (SELECT 1 FROM listing_search_projection p WHERE p.post_id = l.post_id)
    ORDER BY l.post_id
    LIMIT $1
  `, [BATCH])).rows;
  if (!rows.length) break;
  for (const row of rows) {
    try {
      await writer.syncProjection(row);
      done += 1;
    } catch (error) {
      failed += 1;
      if (failures.length < 10) failures.push({ post_id: row.post_id, error: String(error?.message || error).slice(0, 160) });
    }
  }
  if (done % LOG_EVERY < BATCH) {
    console.log(JSON.stringify({ done, failed, sec: Math.round((Date.now() - started) / 1000) }));
  }
}

const after = await countMissing();
console.log(JSON.stringify({
  finished: true,
  done,
  failed,
  sec: Math.round((Date.now() - started) / 1000),
  missingBefore: before,
  missingAfter: after,
  failures,
}, null, 2));
await drv.pool.end();
