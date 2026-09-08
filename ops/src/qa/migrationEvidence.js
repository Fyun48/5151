// Phase 11/14 共用：從 QA 已記錄的 SQL/schema 證據做決定性分類（不重跑產品碼、不用 LLM）。
// 只輸出 sql_kind / flags，不落地原始 SQL 列或資料內容。
// 未命中 regex ≠ 沒有 migration；無法可靠分析 → UNKNOWN。

export const MIGRATION_EVIDENCE_SCHEMA_VERSION = "migration-evidence-v1";

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
  "ADD_COLUMN_NULLABLE",
  "ADD_COLUMN_WITH_DEFAULT",
]);

const ADDITIVE_KIND_SET = new Set(ADDITIVE_SQL_KINDS);

const DESTRUCTIVE_SQL = /\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE[\s\S]+?\sDROP|DROP\s+COLUMN|DROP\s+DATABASE|DROP\s+INDEX)\b/i;
const DATA_SQL = /\b(UPDATE\s+\S+|INSERT\s+INTO|REPLACE\s+INTO|UPSERT)\b/i;
const CREATE_TABLE = /\bCREATE\s+TABLE\b/i;
const CREATE_UNIQUE_INDEX = /\bCREATE\s+UNIQUE\s+INDEX\b/i;
const CREATE_INDEX = /\bCREATE\s+INDEX\b/i;
const ADD_COLUMN = /\bALTER\s+TABLE\b[\s\S]*\bADD\s+(COLUMN\s+)?/i;
const RENAME_SQL = /\bRENAME\s+(TO|COLUMN)\b/i;
const UNIQUE_CONSTRAINT = /\bUNIQUE\s*\(/i;
const SQLISH = /\b(DROP|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|DELETE\s+FROM|INSERT\s+INTO|REPLACE\s+INTO|UPDATE\s+|UPSERT|PRAGMA|RENAME)\b/i;
const ANY_DDL = /\b(ALTER\s+TABLE|CREATE\s+|DROP\s+|TRUNCATE|INSERT\s+|UPDATE\s+|DELETE\s+|REPLACE\s+|RENAME)\b/i;
const RUNTIME_SCHEMA_PATH = /(^|\/)(opsDb|schema|migrat)/i;
const MIGRATION_PATH = /(^|\/)migrations?\/|\.sql$/i;

function stripSqlComment(text) {
  return String(text || "").replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
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

export function classifySqlStatement(text) {
  const sql = stripSqlComment(String(text || "").replace(/\s+/g, " "));
  if (!sql) return null;
  if (DESTRUCTIVE_SQL.test(sql)) return { kind: "DESTRUCTIVE", sql_kind: destructiveKind(sql) };
  if (DATA_SQL.test(sql)) return { kind: "DATA", sql_kind: dataKind(sql) };
  if (RENAME_SQL.test(sql)) return { kind: "UNKNOWN", sql_kind: "RENAME_OR_INCOMPATIBLE_ALTER" };
  if (CREATE_UNIQUE_INDEX.test(sql) || (CREATE_INDEX.test(sql) && /\bUNIQUE\b/i.test(sql))) {
    return { kind: "UNKNOWN", sql_kind: "CREATE_UNIQUE_INDEX" };
  }
  if (UNIQUE_CONSTRAINT.test(sql) && ADD_COLUMN.test(sql)) return { kind: "UNKNOWN", sql_kind: "ADD_UNIQUE_CONSTRAINT" };
  if (CREATE_TABLE.test(sql)) return { kind: "ADDITIVE", sql_kind: "CREATE_TABLE" };
  if (CREATE_INDEX.test(sql)) return { kind: "ADDITIVE", sql_kind: "CREATE_INDEX" };
  if (ADD_COLUMN.test(sql)) {
    if (/\bNOT\s+NULL\b/i.test(sql) && !/\bDEFAULT\b/i.test(sql)) {
      return { kind: "UNKNOWN", sql_kind: "ADD_COLUMN_NOT_NULL_NO_DEFAULT" };
    }
    if (/\bDEFAULT\b/i.test(sql)) return { kind: "ADDITIVE", sql_kind: "ADD_COLUMN_WITH_DEFAULT" };
    return { kind: "ADDITIVE", sql_kind: "ADD_COLUMN_NULLABLE" };
  }
  if (ANY_DDL.test(sql) || SQLISH.test(sql)) return { kind: "UNKNOWN", sql_kind: "UNCLASSIFIED_DDL" };
  return null;
}

export function classifySqlLine(line) {
  const statements = splitStatements(String(line || ""));
  if (statements.length > 1) {
    const hits = statements.map(classifySqlStatement).filter(Boolean);
    if (!hits.length) return SQLISH.test(line) ? { kind: "UNKNOWN", sql_kind: "UNCLASSIFIED_DDL" } : null;
    if (hits.some((h) => h.kind === "DESTRUCTIVE")) return hits.find((h) => h.kind === "DESTRUCTIVE");
    if (hits.some((h) => h.kind === "DATA")) return hits.find((h) => h.kind === "DATA");
    if (hits.some((h) => h.kind === "UNKNOWN")) return hits.find((h) => h.kind === "UNKNOWN");
    return hits[0];
  }
  return classifySqlStatement(line);
}

function splitStatements(text) {
  return String(text || "").split(";").map((s) => stripSqlComment(s)).filter(Boolean);
}

function addedLineText(row) {
  return typeof row === "string" ? row : String(row?.line || "");
}

export function classifySqlLines(lines = []) {
  const joined = (lines || []).map(addedLineText).join("\n");
  const compact = joined.replace(/\s+/g, " ");
  const classified = [];
  for (const stmt of splitStatements(joined)) {
    const hit = classifySqlStatement(stmt);
    if (hit) classified.push(hit);
  }
  if (DESTRUCTIVE_SQL.test(compact) && !classified.some((c) => c.kind === "DESTRUCTIVE")) {
    classified.push({ kind: "DESTRUCTIVE", sql_kind: destructiveKind(compact) });
  } else if (DATA_SQL.test(compact) && !classified.some((c) => c.kind === "DATA")) {
    classified.push({ kind: "DATA", sql_kind: dataKind(compact) });
  } else if (SQLISH.test(compact) && !classified.length) {
    classified.push({ kind: "UNKNOWN", sql_kind: "UNPARSED_SQL_FRAGMENT" });
  }
  const counts = { additive: 0, data: 0, destructive: 0, unknown: 0 };
  for (const c of classified) {
    if (c.kind === "ADDITIVE") counts.additive += 1;
    else if (c.kind === "DATA") counts.data += 1;
    else if (c.kind === "DESTRUCTIVE") counts.destructive += 1;
    else counts.unknown += 1;
  }
  return { classified_statements: classified.slice(0, 40), statement_counts: counts, joined, compact };
}

export function buildDatabaseMigrationEvidence({ files = [], addedLines = [] } = {}) {
  const allFiles = [...new Set((files || []).map((p) => String(p)))].slice(0, 40);
  const migrationFiles = allFiles.filter((p) => MIGRATION_PATH.test(p)).slice(0, 10);
  const { classified_statements, statement_counts, compact } = classifySqlLines((addedLines || []).map(addedLineText));
  const runtimeFiles = allFiles.filter((p) => !MIGRATION_PATH.test(p) && (RUNTIME_SCHEMA_PATH.test(p) || SQLISH.test(compact)));
  const destructive = statement_counts.destructive > 0;
  const dataRewrite = statement_counts.data > 0;
  const hasUnknown = statement_counts.unknown > 0;
  const schema = statement_counts.additive > 0 || hasUnknown || migrationFiles.length > 0 || runtimeFiles.length > 0;
  const additiveShape = !destructive && !dataRewrite && !hasUnknown && statement_counts.additive > 0
    && classified_statements.every((c) => c.kind === "ADDITIVE" && ADDITIVE_KIND_SET.has(c.sql_kind));
  const sqlishUnclassified = SQLISH.test(compact) && statement_counts.additive + statement_counts.data + statement_counts.destructive + statement_counts.unknown === 0;
  const truncatedOrUnparsed = (migrationFiles.length > 0 || runtimeFiles.length > 0) && classified_statements.length === 0;
  const analysisComplete = !sqlishUnclassified && !truncatedOrUnparsed;
  return {
    evidence_schema_version: MIGRATION_EVIDENCE_SCHEMA_VERSION,
    scan_complete: true,
    analysis_complete: analysisComplete,
    coverage: {
      files_scanned: allFiles.slice(0, 20),
      added_line_count: (addedLines || []).length,
      joined_for_multiline: true,
      statements_split: true,
      runtime_files_flagged: runtimeFiles.slice(0, 10),
    },
    files: migrationFiles,
    runtime_files: runtimeFiles.slice(0, 10),
    destructive,
    schema: schema && !destructive,
    data_rewrite: dataRewrite,
    additive_only: additiveShape,
    proven_additive: additiveShape,
    classified_statements,
    statement_counts,
  };
}

function emptyNormalized({ present, complete, version = null }) {
  return {
    files: [],
    runtime_files: [],
    destructive: false,
    schema: false,
    data_rewrite: false,
    additive_only: false,
    proven_additive: false,
    rollback_compatible: false,
    old_code_compatible: false,
    rollback_proof: null,
    old_code_compat_proof: null,
    classified_statements: [],
    statement_counts: { additive: 0, data: 0, destructive: 0, unknown: 0 },
    qa_status: null,
    qa_finding: null,
    staging_migration_status: null,
    evidence_present: present,
    evidence_complete: complete,
    evidence_schema_version: version,
    scan_complete: false,
    analysis_complete: false,
    coverage: null,
  };
}

export function normalizeMigrationEvidence(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyNormalized({ present: false, complete: false });
  }
  const files = Array.isArray(raw.files) ? raw.files.map((p) => String(p)).slice(0, 20) : [];
  const runtimeFiles = Array.isArray(raw.runtime_files) ? raw.runtime_files.map((p) => String(p)).slice(0, 20) : [];
  const classified = Array.isArray(raw.classified_statements)
    ? raw.classified_statements.map((c) => ({ kind: String(c.kind || "UNKNOWN"), sql_kind: String(c.sql_kind || "UNCLASSIFIED") })).slice(0, 40)
    : [];
  const counts = raw.statement_counts && typeof raw.statement_counts === "object"
    ? {
      additive: Number(raw.statement_counts.additive) || 0,
      data: Number(raw.statement_counts.data) || 0,
      destructive: Number(raw.statement_counts.destructive) || 0,
      unknown: Number(raw.statement_counts.unknown) || 0,
    }
    : {
      additive: classified.filter((c) => c.kind === "ADDITIVE").length,
      data: classified.filter((c) => c.kind === "DATA").length,
      destructive: classified.filter((c) => c.kind === "DESTRUCTIVE").length,
      unknown: classified.filter((c) => c.kind === "UNKNOWN").length,
    };
  const versionOk = raw.evidence_schema_version === MIGRATION_EVIDENCE_SCHEMA_VERSION;
  const scanComplete = raw.scan_complete === true;
  const analysisComplete = raw.analysis_complete === true;
  return {
    files,
    runtime_files: runtimeFiles,
    destructive: raw.destructive === true,
    schema: raw.schema === true,
    data_rewrite: raw.data_rewrite === true || raw.data_migration === true,
    additive_only: raw.additive_only === true,
    proven_additive: raw.proven_additive === true,
    rollback_compatible: false,
    old_code_compatible: false,
    rollback_proof: raw.rollback_proof && typeof raw.rollback_proof === "object" ? raw.rollback_proof : null,
    old_code_compat_proof: raw.old_code_compat_proof && typeof raw.old_code_compat_proof === "object" ? raw.old_code_compat_proof : null,
    classified_statements: classified,
    statement_counts: counts,
    qa_status: raw.qa_status ? String(raw.qa_status) : null,
    qa_finding: raw.qa_finding ? String(raw.qa_finding).slice(0, 300) : null,
    staging_migration_status: raw.staging_migration_status ? String(raw.staging_migration_status) : null,
    evidence_present: true,
    evidence_complete: versionOk && scanComplete && analysisComplete,
    evidence_schema_version: raw.evidence_schema_version ? String(raw.evidence_schema_version) : null,
    scan_complete: scanComplete,
    analysis_complete: analysisComplete,
    coverage: raw.coverage && typeof raw.coverage === "object" ? raw.coverage : null,
  };
}

export function statementsHaveAdditiveShape(ev) {
  const stmts = ev.classified_statements || [];
  if (!stmts.length) return false;
  return stmts.every((c) => c.kind === "ADDITIVE" && ADDITIVE_KIND_SET.has(c.sql_kind))
    && ev.statement_counts.destructive === 0
    && ev.statement_counts.data === 0
    && ev.statement_counts.unknown === 0
    && ev.statement_counts.additive > 0;
}
