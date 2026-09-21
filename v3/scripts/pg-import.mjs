// SQLite snapshot -> PostgreSQL import for the cutover.
//
//   SNAP_DB=/snap/v3-snap.db PG_URL=postgres://... node v3/scripts/pg-import.mjs
//
// The snapshot is the `VACUUM INTO` copy of the live SQLite store (see
// docs/runbooks/postgres-cutover-bootstrap.md). This tool mirrors every user table's schema and
// then copies its rows with the batched importer in src/pgSchema.js, so the freeze window can be
// sized from real numbers instead of a guess: one line per table (rows + ms) and a total.
//
// Environment:
//   SNAP_DB        SQLite snapshot path                                    [required]
//   PG_URL         connection string (PGHOST/... also work)               [required]
//   IMPORT_SCHEMA  target schema (default: public)
//   TABLES         comma-separated allow list   (default: every user table)
//   SKIP_TABLES    comma-separated deny list
//   SKIP_ROWS      tables to create empty (schema only, useful for caches)
//   INDEXES        "1" also creates the SQLite-derived indexes
//   BATCH_SIZE     rows per statement (default 500)
//   MULTI_ROW      "0" for the legacy per-row path (diagnostics)
//   DRY_RUN        "1" prints the plan without writing
import { DatabaseSync } from "node:sqlite";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { ensurePgSchema, importTable, userTables } from "../src/pgSchema.js";

const env = process.env;
const snapshot = String(env.SNAP_DB || "").trim();
if (!snapshot) {
  console.error("SNAP_DB is required (path to the SQLite snapshot)");
  process.exit(2);
}
const schema = String(env.IMPORT_SCHEMA || "public").trim();
const batchSize = Number(env.BATCH_SIZE) || 500;
const chunkRows = Number(env.CHUNK_ROWS) || 2000;
const multiRow = env.MULTI_ROW !== "0";
const dryRun = env.DRY_RUN === "1";
const list = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);

const sqliteDb = new DatabaseSync(snapshot, { readOnly: true });
const skipTables = new Set(list(env.SKIP_TABLES));
const onlyTables = new Set(list(env.TABLES));
const skipRows = new Set(list(env.SKIP_ROWS));
const tables = userTables(sqliteDb).filter((table) => (
  !skipTables.has(table) && (!onlyTables.size || onlyTables.has(table))
));

console.log(`snapshot : ${snapshot}`);
console.log(`schema   : ${schema}${schema === "public" ? " (default)" : ""}`);
console.log(`tables   : ${tables.length}${onlyTables.size ? ` (allow list: ${[...onlyTables].join(",")})` : ""}`);
console.log(`mode     : ${multiRow ? `multi-row (batch ${batchSize}, chunk ${chunkRows})` : "per-row (legacy)"}${dryRun ? ", DRY RUN" : ""}`);

if (dryRun) {
  for (const table of tables) {
    const columns = sqliteDb.prepare(`PRAGMA table_info(${table})`).all().length;
    const rows = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    console.log(`  ${table}: ${rows} rows, ${columns} columns${skipRows.has(table) ? " (schema only)" : ""}`);
  }
  sqliteDb.close();
  process.exit(0);
}

const pgDriver = await createPostgresDriver({});
let copied = 0;
const started = Date.now();
try {
  const mirrored = await ensurePgSchema(pgDriver, sqliteDb, {
    schema, tables, indexes: env.INDEXES === "1",
  });
  console.log(`schema mirrored: ${mirrored.statements} statements`);
  for (const table of tables) {
    const tableStarted = Date.now();
    const rows = skipRows.has(table)
      ? 0
      : await importTable(pgDriver, sqliteDb, table, { schema, batchSize, multiRow, chunkRows });
    copied += rows;
    console.log(`  ${table}: ${rows} rows in ${Date.now() - tableStarted} ms`);
  }
  console.log(`imported ${copied} rows in ${Date.now() - started} ms (schema included)`);
} finally {
  await pgDriver.close();
  sqliteDb.close();
}

