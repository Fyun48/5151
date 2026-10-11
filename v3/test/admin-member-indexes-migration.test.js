// `v3/migrations/003_admin_members_indexes.sql` 的形狀鎖（2026-10-11 後台會員頁連線逾時事故）。
//
// 為什麼要有這一條：這份 SQL 是**人工套用**的（`CONCURRENTLY` 不能在交易內跑，所以走的是
// `002_pg_reconcile_indexes.sql` 那條非交易路徑）。人工套用的檔案一旦被改壞——名字改了、
// `CONCURRENTLY` 掉了、或被包進 BEGIN/COMMIT——不會有任何離線測試變紅，而是在下一次
// 套用到熱庫時才發現（名字不一致就會多建一份同義索引）。
//
// 這裡只驗「檔案本身的形狀」：三顆索引的名字與定義必須逐字等於生產既有索引，
// 每句都必須是 `CREATE INDEX CONCURRENTLY IF NOT EXISTS`，而且不得出現交易控制語句。
// 真正在 PostgreSQL 上跑一次屬於 live 驗證（PR 描述附 `pg_indexes` 的輸出）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const SQL = readFileSync(path.join(dir, "../migrations/003_admin_members_indexes.sql"), "utf8");
// 只留可執行語句（註解段落裡有說明用的 SQL 片段，不能當成 DDL 斷言）。
const CODE = SQL.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

test("003：三顆索引的名字與定義必須與生產既有索引一致", () => {
  const expected = [
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_listed_by_user_id\s+ON listings \(listed_by_user_id\)\s+WHERE listed_by_user_id IS NOT NULL;/,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_settings_user_id\s+ON user_settings \(user_id\);/,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_lower\s+ON users \(lower\(email\)\);/,
  ];
  for (const pattern of expected) {
    assert.match(CODE, pattern, `003 必須逐字包含：${pattern}`);
  }
  // 名字對不上（多一個／少一個字）就會在熱庫上多建一份同義索引。
  for (const name of ["idx_listings_listed_by_user_id", "idx_user_settings_user_id", "idx_users_email_lower"]) {
    assert.equal(CODE.split(name).length - 1, 1, `${name} 必須恰好出現一次（且不得有別名）`);
  }
});

test("003 必須是可重複執行的非交易路徑", () => {
  // 每一句 CREATE INDEX 都要有 IF NOT EXISTS（人工套用可能重跑）。
  const creates = CODE.match(/CREATE\s+(UNIQUE\s+)?INDEX[^;]*;/g) || [];
  assert.ok(creates.length >= 3, `至少要有三句 CREATE INDEX（實際 ${creates.length}）`);
  for (const statement of creates) {
    assert.match(statement, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/i, `每一句都要 CONCURRENTLY ＋ IF NOT EXISTS：${statement.slice(0, 80)}`);
  }
  // CONCURRENTLY 不能在交易內 ⇒ 這個檔案不得出現交易控制語句。
  assert.ok(!/\bBEGIN\b/i.test(CODE), "不得出現 BEGIN（CONCURRENTLY 不能在交易內）");
  assert.ok(!/\bCOMMIT\b/i.test(CODE), "不得出現 COMMIT（CONCURRENTLY 不能在交易內）");
  assert.ok(!/single-transaction/i.test(CODE), "不得要求 --single-transaction");
  assert.ok(!/\bDROP\b/i.test(CODE), "這一份不該有 DROP（INVALID 索引的處置寫在註解裡，由人判斷）");
});

test("003 不得帶任何連線資訊或憑證", () => {
  assert.ok(!/postgres(ql)?:\/\//i.test(SQL), "不得出現連線字串");
  assert.ok(!/password|pgpassword/i.test(SQL), "不得出現密碼");
});
