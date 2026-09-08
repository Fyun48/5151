// Phase 11/14 共用：從 QA 已記錄的 SQL/schema 證據做決定性分類（不重跑產品碼、不用 LLM）。
// 只輸出 sql_kind / flags，不落地原始 SQL 列或資料內容。

export const MIGRATION_CLASSIFICATIONS = Object.freeze({
  NONE: "NONE",
  ADDITIVE_BACKWARD_COMPATIBLE: "ADDITIVE_BACKWARD_COMPATIBLE",
  DATA_MIGRATION: "DATA_MIGRATION",
  DESTRUCTIVE_OR_IRREVERSIBLE: "DESTRUCTIVE_OR_IRREVERSIBLE",
  UNKNOWN_OR_UNPROVEN: "UNKNOWN_OR_UNPROVEN",
});

export const ADDITIVE_SQL_KINDS = Object.freeze([
  "CREATE_TABLE",
  "CREATE_INDEX",
  "CREATE_UNIQUE_INDEX",
  "ADD_COLUMN_NULLABLE",
  "ADD_COLUMN_WITH_DEFAULT",
]);

const ADDITIVE_KIND_SET = new Set(ADDITIVE_SQL_KINDS);

const DESTRUCTIVE_SQL = /\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE[\s\S]+?\sDROP|DROP\s+COLUMN|DROP\s+DATABASE|DROP\s+INDEX)\b/i;
const DATA_SQL = /\b(UPDATE\s+\S+|INSERT\s+INTO|REPLACE\s+INTO|UPSERT)\b/i;
const CREATE_TABLE = /\bCREATE\s+TABLE\b/i;
const CREATE_INDEX = /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i;
const ADD_COLUMN = /\bALTER\s+TABLE\b[\s\S]*\bADD\s+(COLUMN\s+)?/i;
const ANY_DDL = /\b(ALTER\s+TABLE|CREATE\s+|DROP\s+|TRUNCATE|INSERT\s+|UPDATE\s+|DELETE\s+|REPLACE\s+)\b/i;

function stripSqlComment(line) {
  return String(line || "").replace(/--.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
}

function destructiveKind(sql) {
  if (/\bDROP\s+DATABASE\b/i.test(sql)) return "DROP_DATABASE";
  if (/\bDROP\s+TABLE\b/i.test(sql)) return "DROP_TABLE";
  if (/\bTRUNCATE\b/i.test(sql)) return "TRUNCATE";
  if (/\bDELETE\s+FROM\b/i.test(sql)) return "DELETE_FROM";
  if (/\bDROP\s+COLUMN\b/i.test(sql) || /\bALTER\s+TABLE[\s\S]+?\sDROP\b/i.test(sql)) return "DROP_COLUMN";
  if (/\bDROP\s+INDEX\b/i.test(sql)) return "DROP_INDEX";
  return "DESTRUCTIVE_SQL";
}

function dataKind(sql) {
  if (/\bINSERT\s+INTO\b/i.test(sql)) return "INSERT_INTO";
  if (/\bREPLACE\s+INTO\b/i.test(sql) || /\bUPSERT\b/i.test(sql)) return "UPSERT";
  if (/\bUPDATE\s+/i.test(sql)) return "UPDATE_ROWS";
  return "DATA_REWRITE";
}

export function classifySqlLine(line) {
  const sql = stripSqlComment(line);
  if (!sql) return null;
  if (DESTRUCTIVE_SQL.test(sql)) return { kind: "DESTRUCTIVE", sql_kind: destructiveKind(sql) };
  if (DATA_SQL.test(sql)) return { kind: "DATA", sql_kind: dataKind(sql) };
  if (CREATE_TABLE.test(sql)) return { kind: "ADDITIVE", sql_kind: "CREATE_TABLE" };
  if (CREATE_INDEX.test(sql)) return { kind: "ADDITIVE", sql_kind: /\bUNIQUE\b/i.test(sql) ? "CREATE_UNIQUE_INDEX" : "CREATE_INDEX" };
  if (ADD_COLUMN.test(sql)) {
    if (/\bNOT\s+NULL\b/i.test(sql) && !/\bDEFAULT\b/i.test(sql)) {
      return { kind: "UNKNOWN", sql_kind: "ADD_COLUMN_NOT_NULL_NO_DEFAULT" };
    }
    if (/\bDEFAULT\b/i.test(sql)) return { kind: "ADDITIVE", sql_kind: "ADD_COLUMN_WITH_DEFAULT" };
    return { kind: "ADDITIVE", sql_kind: "ADD_COLUMN_NULLABLE" };
  }
  if (ANY_DDL.test(sql)) return { kind: "UNKNOWN", sql_kind: "UNCLASSIFIED_DDL" };
  return null;
}

export function classifySqlLines(lines = []) {
  const classified = [];
  for (const line of lines) {
    const hit = classifySqlLine(line);
    if (hit) classified.push(hit);
  }
  const counts = { additive: 0, data: 0, destructive: 0, unknown: 0 };
  for (const c of classified) {
    if (c.kind === "ADDITIVE") counts.additive += 1;
    else if (c.kind === "DATA") counts.data += 1;
    else if (c.kind === "DESTRUCTIVE") counts.destructive += 1;
    else counts.unknown += 1;
  }
  return { classified_statements: classified.slice(0, 40), statement_counts: counts };
}

export function buildDatabaseMigrationEvidence({ files = [], addedLines = [] } = {}) {
  const migrationFiles = [...new Set((files || []).filter((p) => /(^|\/)migrations?\/|\.sql$/i.test(p)))].slice(0, 10);
  const { classified_statements, statement_counts } = classifySqlLines((addedLines || []).map((row) => (typeof row === "string" ? row : row?.line)));
  const destructive = statement_counts.destructive > 0;
  const dataRewrite = statement_counts.data > 0;
  const hasUnknown = statement_counts.unknown > 0;
  const schema = statement_counts.additive > 0 || statement_counts.unknown > 0 || migrationFiles.length > 0;
  const provenAdditive = !destructive && !dataRewrite && !hasUnknown && statement_counts.additive > 0
    && classified_statements.every((c) => c.kind === "ADDITIVE" && ADDITIVE_KIND_SET.has(c.sql_kind));
  return {
    files: migrationFiles,
    destructive,
    schema: schema && !destructive,
    data_rewrite: dataRewrite,
    additive_only: provenAdditive,
    proven_additive: provenAdditive,
    classified_statements,
    statement_counts,
  };
}

export function normalizeMigrationEvidence(raw) {
  const ev = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const files = Array.isArray(ev.files) ? ev.files.map((p) => String(p)).slice(0, 20) : [];
  const classified = Array.isArray(ev.classified_statements)
    ? ev.classified_statements.map((c) => ({ kind: String(c.kind || "UNKNOWN"), sql_kind: String(c.sql_kind || "UNCLASSIFIED") })).slice(0, 40)
    : [];
  const counts = ev.statement_counts && typeof ev.statement_counts === "object"
    ? {
      additive: Number(ev.statement_counts.additive) || 0,
      data: Number(ev.statement_counts.data) || 0,
      destructive: Number(ev.statement_counts.destructive) || 0,
      unknown: Number(ev.statement_counts.unknown) || 0,
    }
    : {
      additive: classified.filter((c) => c.kind === "ADDITIVE").length,
      data: classified.filter((c) => c.kind === "DATA").length,
      destructive: classified.filter((c) => c.kind === "DESTRUCTIVE").length,
      unknown: classified.filter((c) => c.kind === "UNKNOWN").length,
    };
  return {
    files,
    destructive: ev.destructive === true,
    schema: ev.schema === true,
    data_rewrite: ev.data_rewrite === true || ev.data_migration === true,
    additive_only: ev.additive_only === true,
    proven_additive: ev.proven_additive === true,
    rollback_compatible: ev.rollback_compatible === true || ev.rollback_safe === true,
    old_code_compatible: ev.old_code_compatible === true,
    classified_statements: classified,
    statement_counts: counts,
    qa_status: ev.qa_status ? String(ev.qa_status) : null,
    qa_finding: ev.qa_finding ? String(ev.qa_finding).slice(0, 300) : null,
    staging_migration_status: ev.staging_migration_status ? String(ev.staging_migration_status) : null,
    evidence_present: ev.evidence_present !== false,
  };
}
