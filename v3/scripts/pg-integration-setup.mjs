// CI／容器用：把 SQLite 的 schema **與可重現的列**鏡射到 PostgreSQL —— astra §3.2 要求 PG job
// 「就緒後套正式 schema／migration，載入可重現 fixture」，而不是讓測試在空庫上因 42P01 失敗或被跳過。
//
// 步驟：
//   1. importStore(indexes:false)：鏡射全部表 ＋ 批次匯入列 ＋ **重設 identity 序號**（匯入的 id
//      否則會與之後產生的 id 衝突）。`indexes:false` 是必要的 ✗：SQLite 的索引 DDL 可能含
//      SQLite 專用函式（例如表達式索引用 `instr(...)`），照搬到 PG 會噴
//      `function instr(text, unknown) does not exist` 並讓整個 job 崩潰（CI 實測踩過）。
//   2. 再逐句建立 PG 能接受的索引（**唯一索引很重要**：upsert／ON CONFLICT 需要它）；
//      含 SQLite 專用函式／語法者明確記錄並跳過，其餘任何失敗都直接拋錯（缺 schema 必須失敗）。
//
// 用法：CI 由 `npm run test:pg` 自動呼叫：
//   node v3/scripts/pg-integration-setup.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { sqliteHandle } from "../src/db.js";
import { createIndexStatements, importStore } from "../src/pgSchema.js";

// SQLite 專用的函式／語法：這些索引在 PG 上不可能成立，明確跳過並記錄。
const SQLITE_ONLY = /instr\s*\(|julianday\s*\(|strftime\s*\(|datetime\s*\(|date\s*\(|COLLATE\s+NOCASE|GLOB\b|printf\s*\(/i;

const drv = await createPostgresDriver({ env: process.env });
const db = sqliteHandle();
try {
  const result = await importStore(drv, db, { indexes: false });
  console.log(`PG-SCHEMA ${JSON.stringify({
    statements: result.statements,
    tables: result.tables.length,
    rows: result.copied,
    sequences: result.sequences.length,
  })}`);

  let created = 0;
  const skippedTables = new Set();
  for (const table of result.tables) {
    for (const statement of createIndexStatements(db, table)) {
      if (SQLITE_ONLY.test(statement)) {
        skippedTables.add(table);
        continue;
      }
      await drv.exec(statement);
      created += 1;
    }
  }
  console.log(`PG-INDEXES ${JSON.stringify({ created, skippedTables: [...skippedTables].sort() })}`);
} finally {
  await drv.close();
}

