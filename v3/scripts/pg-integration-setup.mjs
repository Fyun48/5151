// CI／容器用：把 SQLite schema 鏡射到 PostgreSQL（idempotent）——astra §3.2 要求 PG job
// 必須「就緒後套正式 schema」，而不是讓測試在空庫上因 42P01 失敗或被跳過。
//
// 空 `tables` ⇒ pgSchema.userTables() ⇒ 鏡射**全部**表；`CREATE TABLE IF NOT EXISTS` 語意
// ⇒ 既有資料不會被刪改。
//
// 用法（CI 由 `npm run test:pg` 自動呼叫；容器內可用 REMOTE_DIR=/app/tmpkk 搭配 run-in-container.sh）：
//   node v3/scripts/pg-integration-setup.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { sqliteHandle } from "../src/db.js";
import { ensurePgSchema } from "../src/pgSchema.js";

const drv = await createPostgresDriver({ env: process.env });
try {
  // ⚠️ 必須 `indexes: false`：SQLite 的索引 DDL 可能含 SQLite 專用語法／函式（例如表達式索引用
  // `instr(...)`），照搬到 PG 會噴 `function instr(text, unknown) does not exist` 並讓整個 job 崩潰
  // （CI 實測 ✗）。pgSchema 的註解本來就說明「只要表時要跳過 index DDL」⇒ 這裡只鏡射表。
  const info = await ensurePgSchema(drv, sqliteHandle(), { indexes: false });
  console.log(`PG-SCHEMA ${JSON.stringify({ statements: info.statements, tables: info.tables.length, indexes: false })}`);
} finally {
  await drv.pool.end();
}
