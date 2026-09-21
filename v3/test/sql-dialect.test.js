import { test } from "node:test";
import assert from "node:assert/strict";
import { translateSqliteToPg, toPostgresSql, translateInsertOrIgnore } from "../src/sqlDialect.js";

test("placeholders are renumbered in order", () => {
  const { text, placeholders } = translateSqliteToPg("SELECT a FROM t WHERE x = ? AND y = ?");
  assert.equal(text, "SELECT a FROM t WHERE x = $1 AND y = $2");
  assert.equal(placeholders, 2);
});

test("placeholders inside string literals and comments are left alone", () => {
  const sql = "SELECT '?' AS q -- ? comment\n/* ? block */ , \"col?\" FROM t WHERE a = ?";
  const { text, placeholders } = translateSqliteToPg(sql);
  assert.equal(placeholders, 1);
  assert.ok(text.includes("SELECT '?' AS q"));
  assert.ok(text.includes("-- ? comment"));
  assert.ok(text.includes("/* ? block */"));
  assert.ok(text.includes(`"col?"`));
  assert.ok(text.endsWith("WHERE a = $1"));
});

test("escaped quotes do not end the literal early", () => {
  const { text, placeholders } = translateSqliteToPg("SELECT 'it''s ?' AS s WHERE x = ?");
  assert.equal(placeholders, 1);
  assert.ok(text.includes("'it''s ?'"));
  assert.ok(!text.includes("$1 AS s"));
});

test("IFNULL becomes COALESCE but literals keep their text", () => {
  const { text } = translateSqliteToPg("SELECT IFNULL(offline, 0) AS o, 'IFNULL(?' AS literal FROM t");
  assert.ok(text.includes("SELECT COALESCE(offline, 0) AS o"));
  assert.ok(text.includes("'IFNULL(?'"));
});

test("datetime('now') and GROUP_CONCAT translate to their PostgreSQL forms", () => {
  assert.equal(toPostgresSql("SELECT datetime('now') AS now"), "SELECT now() AS now");
  assert.match(toPostgresSql("SELECT GROUP_CONCAT(name) FROM t"), /string_agg\(name\)/);
});

test("the real SQL-first page statement translates without changing its shape", () => {
  const sqliteSql = `SELECT p.post_id, p.updated_at, p.rent, p.total_monthly_cost FROM listing_search_projection p
    WHERE p.post_id IN (SELECT post_id FROM listings WHERE IFNULL(offline, 0) = 0)
    AND p.district IN (?, ?)
    AND (-p.updated_at, p.post_id) > (?, ?)
    ORDER BY p.updated_at DESC, p.post_id ASC
    LIMIT ?`;
  const { text, placeholders } = translateSqliteToPg(sqliteSql);
  assert.equal(placeholders, 5);
  assert.ok(text.includes("COALESCE(offline, 0) = 0"));
  assert.ok(text.includes("(-p.updated_at, p.post_id) > ($3, $4)"));
  assert.ok(text.includes("LIMIT $5"));
  assert.ok(!text.includes("?"));
});

test("instr() maps to PostgreSQL strpos() (same argument order, 1-based)", () => {
  const sql = "SELECT substr(source_key, 1, instr(COALESCE(source_key, '') || '|', '|') - 1) FROM listings WHERE post_id = ?";
  const { text, placeholders } = translateSqliteToPg(sql);
  assert.equal(placeholders, 1);
  assert.ok(text.includes("instr(") === false || !/\binstr\s*\(/.test(text), "instr must be rewritten");
  assert.match(text, /strpos\(COALESCE\(source_key, ''\) \|\| '\|', '\|'\)/);
  assert.ok(text.endsWith("WHERE post_id = $1"));
});

test("INSERT OR IGNORE gains ON CONFLICT DO NOTHING once", () => {
  const once = translateInsertOrIgnore("INSERT OR IGNORE INTO t (a) VALUES (?)");
  assert.equal(once, "INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING");
  assert.equal(translateInsertOrIgnore(once), once);
  assert.equal(translateInsertOrIgnore("INSERT INTO t (a) VALUES (?)"), "INSERT INTO t (a) VALUES (?)");
});
