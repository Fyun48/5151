// 唯讀：檢查 PG 統計新鮮度（astra §4.2「統計估計偏差」）。
//
// 為什麼：逐節點歸因顯示 flags 反連接以 **Nested Loop** 逐候選列執行（6,907 loops ✗），
// 而計畫的估計列數與實際差很大（§11：估計 577 vs 實際 6,647 ✗）。若 `last_analyze` 很舊或
// `n_mod_since_analyze` 很大，修法是**跑 ANALYZE**（走既有發布權限 ✓），而不是亂加索引 ✗。
//
// 用法：REMOTE_DIR=/app/tmpkk bash v3/scripts/run-in-container.sh v3/scripts/pg-stats-check.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";

const drv = await createPostgresDriver({ env: process.env });
try {
  const tables = ["listings", "user_listing_flags", "listing_prep", "crawl_covers", "settings", "listing_group_members"];
  const rows = (await drv.query(
    `SELECT relname, n_live_tup, n_mod_since_analyze, last_analyze, last_autoanalyze
       FROM pg_stat_user_tables
      WHERE relname = ANY($1::text[])
      ORDER BY relname`,
    [tables],
  )).rows;
  console.log(`PG-STATS ${JSON.stringify(rows)}`);
  const missing = tables.filter((t) => !rows.some((r) => r.relname === t));
  if (missing.length) console.log(`PG-STATS-MISSING ${JSON.stringify(missing)}`);
} finally {
  await drv.close();
}
