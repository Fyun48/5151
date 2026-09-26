// 授權的維護性寫入：對指定表跑 `ANALYZE`（**只更新統計，不動資料**）。
//
// 用途（astra §4.2）：唯讀檢查發現 `user_listing_flags` **完全沒有統計**（0 列、last_autoanalyze = null ✗）
// ⇒ planner 只能吃預設選擇率 ⇒ 選了 `Nested Loop` ＋ `Join Filter`（估計 577 vs 實際 6,647 ✗）。
// 跑 ANALYZE 後再取一次計畫對照，判斷是否改走 hash anti join ✓。
//
// 用法（容器內）：
//   REMOTE_DIR=/app/tmpkk TABLES=user_listing_flags node pg-analyze-table.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";

const TABLES = (process.env.TABLES || "user_listing_flags")
  .split(",").map((t) => t.trim()).filter(Boolean);

const drv = await createPostgresDriver({ env: process.env });
try {
  for (const table of TABLES) {
    // 只允許識別字（不接受任意 SQL 片段）⇒ 這支腳本不可能被當成通用寫入工具 ✗。
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`拒絕非識別字表名：${table}`);
    const started = Date.now();
    await drv.query(`ANALYZE ${table}`);
    console.log(`PG-ANALYZE ${JSON.stringify({ table, ms: Date.now() - started })}`);
  }
  const rows = (await drv.query(
    `SELECT relname, n_live_tup, last_analyze, last_autoanalyze
       FROM pg_stat_user_tables WHERE relname = ANY($1::text[]) ORDER BY relname`,
    [TABLES],
  )).rows;
  console.log(`PG-ANALYZE-AFTER ${JSON.stringify(rows)}`);
} finally {
  await drv.close();
}
