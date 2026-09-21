// SQLite schema → PostgreSQL DDL (PostgreSQL hot path / migration prep).
//
// Used by the PostgreSQL parity tests (import the exact SQLite fixture the
// SQLite path runs against) and as the reusable building block for the real
// SQLite → PostgreSQL cutover. Deliberately minimal: columns, primary keys and
// (plain) indexes. No defaults/constraints are invented — anything the SQLite
// schema does not state is not added, so a parity fixture cannot pass because
// of extra PostgreSQL-side coercion.
import { translateInsertOrIgnore } from "./sqlDialect.js";

const TYPE_MAP = new Map([
  ["INTEGER", "BIGINT"],
  ["INT", "BIGINT"],
  ["BIGINT", "BIGINT"],
  ["SMALLINT", "SMALLINT"],
  ["REAL", "DOUBLE PRECISION"],
  ["FLOAT", "DOUBLE PRECISION"],
  ["DOUBLE", "DOUBLE PRECISION"],
  ["DOUBLE PRECISION", "DOUBLE PRECISION"],
  ["NUMERIC", "NUMERIC"],
  ["DECIMAL", "NUMERIC"],
  ["TEXT", "TEXT"],
  ["VARCHAR", "TEXT"],
  ["CHAR", "TEXT"],
  ["CLOB", "TEXT"],
  ["BLOB", "BYTEA"],
  ["BOOLEAN", "BOOLEAN"],
  ["DATE", "TEXT"],
  ["DATETIME", "TEXT"],
  ["TIMESTAMP", "TEXT"],
]);

export function pgTypeFor(sqliteType) {
  const raw = String(sqliteType || "").trim().toUpperCase();
  if (!raw) return "TEXT"; // SQLite's "no affinity" column stores whatever it is given.
  return TYPE_MAP.get(raw) || "TEXT";
}

export function quoteIdent(name) {
  const text = String(name);
  return /^[a-z_][a-z0-9_]*$/.test(text) ? text : `"${text.replace(/"/g, '""')}"`;
}

export function quoteQualified(schema, name) {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
}

export function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
}

export function userTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

// SQLite keeps column defaults in PRAGMA table_info().dflt_value. Without carrying them over, a
// PostgreSQL table that a SQLite INSERT omits a column from would fail its NOT NULL constraint
// (the crawler's listings upsert relies on those defaults), so translatable defaults are copied.
// Expressions we cannot translate confidently are skipped and left to the caller.
function pgDefaultClause(sqliteDefault) {
  if (sqliteDefault == null) return "";
  const raw = String(sqliteDefault).trim();
  if (!raw || /^null$/i.test(raw)) return "";
  if (/^-?\d+(\.\d+)?$/.test(raw)) return ` DEFAULT ${raw}`;
  if (/^'(?:[^']|'')*'$/.test(raw)) return ` DEFAULT ${raw}`;
  if (/^(current_timestamp|current_date|current_time)$/i.test(raw)) return ` DEFAULT ${raw.toUpperCase()}`;
  return "";
}

export function createTableStatement(db, table, { schema = "", ifNotExists = true } = {}) {
  const columns = tableInfo(db, table);
  const pk = columns.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
  const lines = columns.map((c) => {
    const parts = [`  ${quoteIdent(c.name)} ${pgTypeFor(c.type)}`];
    if (Number(c.notnull) === 1) parts.push("NOT NULL");
    const defaultClause = pgDefaultClause(c.dflt_value);
    if (defaultClause) parts.push(defaultClause.trim());
    return parts.join(" ");
  });
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.map((c) => quoteIdent(c.name)).join(", ")})`);
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${quoteQualified(schema, table)} (\n${lines.join(",\n")}\n)`;
}

// SQLite index SQL looks like `CREATE INDEX idx ON tbl(col)`. The table has to
// be schema-qualified (and idempotent) for PostgreSQL.
export function createIndexStatements(db, table, { schema = "" } = {}) {
  const rows = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(table);
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return rows.map((row) => {
    const sql = String(row.sql).trim().replace(/;$/, "");
    const qualified = sql.replace(
      new RegExp(`(ON\\s+)(${escaped})(\\s*\\()`, "i"),
      (_m, on, _table, paren) => `${on}${quoteQualified(schema, table)}${paren}`,
    );
    return qualified.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/i, (_m, unique = "") =>
      `CREATE ${unique || ""}INDEX IF NOT EXISTS `);
  });
}

// All DDL needed to mirror a SQLite database's user objects into PostgreSQL.
export function schemaStatements(db, { schema = "", tables = [] } = {}) {
  const selected = tables.length ? tables : userTables(db);
  const statements = [];
  if (schema) statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
  for (const table of selected) {
    statements.push(createTableStatement(db, table, { schema }));
    statements.push(...createIndexStatements(db, table, { schema }));
  }
  return statements;
}

export async function ensurePgSchema(pgDriver, sqliteDb, { schema = "", tables = [], indexes = true } = {}) {
  // SQLite index SQL can use SQLite-only syntax (COLLATE NOCASE, expression
  // indexes), so callers that only need the tables can skip the index DDL.
  const statements = schemaStatements(sqliteDb, { schema, tables })
    .filter((sql) => indexes || !/^CREATE\s+(UNIQUE\s+)?INDEX/i.test(sql));
  for (const statement of statements) await pgDriver.exec(statement);
  return { statements: statements.length, tables: tables.length ? tables : userTables(sqliteDb) };
}

export function rowsForTable(db, table) {
  const columns = tableInfo(db, table).map((c) => c.name);
  const rows = db.prepare(`SELECT ${columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}`).all();
  return { columns, rows };
}

// Idempotent import (ON CONFLICT DO NOTHING) so a retry/resume never duplicates
// rows — the same guarantee sqliteToPostgres.copyTable gives the SQLite target.
export async function importTable(pgDriver, sqliteDb, table, { schema = "", batchSize = 500 } = {}) {
  const { columns, rows } = rowsForTable(sqliteDb, table);
  if (!rows.length) return 0;
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const sql = translateInsertOrIgnore(
    `INSERT OR IGNORE INTO ${quoteQualified(schema, table)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`,
  );
  let copied = 0;
  for (let start = 0; start < rows.length; start += batchSize) {
    const slice = rows.slice(start, start + batchSize);
    await pgDriver.withTransaction(async (client) => {
      for (const row of slice) {
        await client.query(sql, columns.map((c) => row[c]));
        copied += 1;
      }
    });
  }
  return copied;
}

export async function countRows(pgDriver, table, { schema = "" } = {}) {
  const res = await pgDriver.query(`SELECT COUNT(*) AS n FROM ${quoteQualified(schema, table)}`);
  return Number(res.rows[0]?.n) || 0;
}
