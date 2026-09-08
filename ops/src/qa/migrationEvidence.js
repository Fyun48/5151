// Phase 11/14 共用：從 QA 已記錄的 SQL/schema 證據做決定性分類（不重跑產品碼、不用 LLM）。
// 只輸出 sql_kind / flags，不落地原始 SQL 列或資料內容。
// 未命中 regex ≠ 沒有 migration；無法可靠分析 → UNKNOWN。
// 顯示裁切與決策資料分離：決策使用完整檔案清單與 statement counts。

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
const DISPLAY_FILE_LIMIT = 20;
const DISPLAY_STATEMENT_LIMIT = 40;

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
const SOURCE_PATH = /\.(js|ts|mjs|cjs|jsx|tsx)$/i;
const ORM_SIDE_EFFECT = /\b(sequelize|typeorm|prisma|knex|mikro-?orm|drizzle)\b[\s\S]{0,240}\b(sync|migrate|push|synchronize|schema\.push)\b|\.sync\s*\(\s*\{[^}]*force\s*:\s*true/i;
const DYNAMIC_SQL = /(["'`])\s*(DR|AL|CR|UP|IN|TR|DE)\s*\1\s*\+|\b(DROP|ALTER|CREATE|TRUNCATE|DELETE|INSERT|UPDATE)\b[\s\S]{0,80}\+|\.(exec|run|query|execute|raw)\s*\(\s*[A-Za-z_$]/i;
const DB_RUNTIME_API = /\b(db|database|sqlite|sql|client)\.(exec|run|prepare|query|execute|serialize)\s*\(/i;

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
  return { classified_statements: classified, statement_counts: counts, joined, compact };
}

function detectUnanalyzableRuntime(compact, files = []) {
  const reasons = [];
  if (ORM_SIDE_EFFECT.test(compact)) reasons.push("orm_schema_side_effect");
  if (DYNAMIC_SQL.test(compact)) reasons.push("dynamic_or_concatenated_sql");
  if (DB_RUNTIME_API.test(compact) && SOURCE_PATH.test(files.join("\n"))) reasons.push("runtime_db_api");
  return reasons;
}

export function buildDatabaseMigrationEvidence({ files = [], fileRecords = [], addedLines = [], scan = null } = {}) {
  const allFiles = [...new Set((files || []).map((p) => String(p)))];
  const records = Array.isArray(fileRecords) && fileRecords.length
    ? fileRecords.map((f) => ({ path: String(f.path || f), status: String(f.status || "M"), insertions: Number(f.insertions) || 0, deletions: Number(f.deletions) || 0 }))
    : allFiles.map((p) => ({ path: p, status: "M", insertions: 0, deletions: 0 }));
  const migrationFiles = allFiles.filter((p) => MIGRATION_PATH.test(p));
  const deletedOrContextMigrations = records.filter((f) => MIGRATION_PATH.test(f.path) && (f.status === "D" || (f.deletions > 0 && f.insertions === 0)));
  const { classified_statements, statement_counts, compact } = classifySqlLines((addedLines || []).map(addedLineText));
  const unanalyzableReasons = detectUnanalyzableRuntime(compact, allFiles);
  if (deletedOrContextMigrations.length) unanalyzableReasons.push("deleted_or_context_only_migration");
  if (migrationFiles.length && classified_statements.length === 0) unanalyzableReasons.push("migration_file_without_analyzable_sql");
  const runtimeFiles = allFiles.filter((p) => !MIGRATION_PATH.test(p) && (
    RUNTIME_SCHEMA_PATH.test(p)
    || (SOURCE_PATH.test(p) && unanalyzableReasons.length > 0)
  ));

  const truncatedLines = scan?.truncated === true || scan?.added_lines_truncated === true || scan?.scan_complete === false;
  const scanComplete = !truncatedLines && scan?.inferred_incomplete !== true;
  const statementsTruncated = classified_statements.length > DISPLAY_STATEMENT_LIMIT;
  const destructive = statement_counts.destructive > 0;
  const dataRewrite = statement_counts.data > 0;
  const hasUnknown = statement_counts.unknown > 0 || unanalyzableReasons.length > 0;
  const schema = statement_counts.additive > 0 || hasUnknown || migrationFiles.length > 0 || unanalyzableReasons.length > 0;
  const additiveShape = !destructive && !dataRewrite && !hasUnknown && statement_counts.additive > 0
    && classified_statements.every((c) => c.kind === "ADDITIVE" && ADDITIVE_KIND_SET.has(c.sql_kind))
    && !truncatedLines && !unanalyzableReasons.length;
  const analysisComplete = scanComplete && !unanalyzableReasons.length && !statementsTruncated
    && !(SQLISH.test(compact) && statement_counts.additive + statement_counts.data + statement_counts.destructive + statement_counts.unknown === 0);

  return {
    evidence_schema_version: MIGRATION_EVIDENCE_SCHEMA_VERSION,
    scan_complete: scanComplete,
    analysis_complete: analysisComplete,
    unanalyzable: unanalyzableReasons.length > 0 || truncatedLines,
    unanalyzable_reasons: [...new Set(unanalyzableReasons)].slice(0, 20),
    coverage: {
      files_scanned: allFiles,
      files_display: allFiles.slice(0, DISPLAY_FILE_LIMIT),
      files_total: allFiles.length,
      files_truncated: false,
      added_line_count: (addedLines || []).length,
      added_lines_truncated: !!truncatedLines,
      added_line_limit: scan?.max_lines ?? scan?.added_line_limit ?? null,
      joined_for_multiline: true,
      statements_split: true,
      classified_statements_truncated: statementsTruncated,
      classified_statement_total: classified_statements.length,
      runtime_files_flagged: runtimeFiles.filter((p) => RUNTIME_SCHEMA_PATH.test(p) || unanalyzableReasons.length).slice(0, DISPLAY_FILE_LIMIT),
      scan_base_sha: scan?.base_sha || null,
      scan_head_sha: scan?.head_sha || null,
    },
    files: migrationFiles,
    files_display: migrationFiles.slice(0, DISPLAY_FILE_LIMIT),
    runtime_files: runtimeFiles.slice(0, 80),
    destructive,
    schema: schema && !destructive,
    data_rewrite: dataRewrite,
    additive_only: additiveShape,
    proven_additive: additiveShape,
    classified_statements: classified_statements.slice(0, DISPLAY_STATEMENT_LIMIT),
    classified_statement_total: classified_statements.length,
    classified_statements_truncated: statementsTruncated,
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
    classified_statement_total: 0,
    classified_statements_truncated: false,
    statement_counts: { additive: 0, data: 0, destructive: 0, unknown: 0 },
    qa_status: null,
    qa_finding: null,
    staging_migration_status: null,
    evidence_present: present,
    evidence_complete: complete,
    evidence_schema_version: version,
    scan_complete: false,
    analysis_complete: false,
    unanalyzable: true,
    unanalyzable_reasons: present ? ["evidence_incomplete"] : ["evidence_missing"],
    coverage: null,
  };
}

function countsMatchClassified(counts, classified, total, truncated) {
  if (!counts) return false;
  const recount = { additive: 0, data: 0, destructive: 0, unknown: 0 };
  for (const c of classified) {
    if (c.kind === "ADDITIVE") recount.additive += 1;
    else if (c.kind === "DATA") recount.data += 1;
    else if (c.kind === "DESTRUCTIVE") recount.destructive += 1;
    else recount.unknown += 1;
  }
  const sum = counts.additive + counts.data + counts.destructive + counts.unknown;
  if (truncated) return Number(total) === sum && sum >= classified.length;
  return counts.additive === recount.additive
    && counts.data === recount.data
    && counts.destructive === recount.destructive
    && counts.unknown === recount.unknown
    && Number(total) === classified.length
    && sum === classified.length;
}

export function coverageIsComplete(raw) {
  const cov = raw?.coverage;
  if (!cov || typeof cov !== "object" || Array.isArray(cov)) return false;
  if (!Array.isArray(cov.files_scanned)) return false;
  if (!Number.isFinite(Number(cov.files_total))) return false;
  if (Number(cov.files_total) !== cov.files_scanned.length) return false;
  if (!Number.isFinite(Number(cov.added_line_count))) return false;
  if (cov.added_lines_truncated === true) return false;
  if (cov.files_truncated === true) return false;
  if (cov.joined_for_multiline !== true) return false;
  if (cov.statements_split !== true) return false;
  if (!Array.isArray(cov.runtime_files_flagged)) return false;
  if (cov.classified_statements_truncated === true) return false;
  return true;
}

export function normalizeMigrationEvidence(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyNormalized({ present: false, complete: false });
  }
  const files = Array.isArray(raw.files) ? raw.files.map((p) => String(p)) : [];
  const runtimeFiles = Array.isArray(raw.runtime_files) ? raw.runtime_files.map((p) => String(p)) : [];
  const classified = Array.isArray(raw.classified_statements)
    ? raw.classified_statements.map((c) => ({ kind: String(c.kind || "UNKNOWN"), sql_kind: String(c.sql_kind || "UNCLASSIFIED") }))
    : [];
  const counts = raw.statement_counts && typeof raw.statement_counts === "object"
    ? {
      additive: Number(raw.statement_counts.additive) || 0,
      data: Number(raw.statement_counts.data) || 0,
      destructive: Number(raw.statement_counts.destructive) || 0,
      unknown: Number(raw.statement_counts.unknown) || 0,
    }
    : null;
  const versionOk = raw.evidence_schema_version === MIGRATION_EVIDENCE_SCHEMA_VERSION;
  const scanComplete = raw.scan_complete === true;
  const analysisComplete = raw.analysis_complete === true;
  const truncated = raw.classified_statements_truncated === true || raw.coverage?.classified_statements_truncated === true;
  const total = raw.classified_statement_total != null ? Number(raw.classified_statement_total) : classified.length;
  const countsOk = countsMatchClassified(counts, classified, total, truncated);
  const coverageOk = coverageIsComplete(raw);
  const unanalyzable = raw.unanalyzable === true || (Array.isArray(raw.unanalyzable_reasons) && raw.unanalyzable_reasons.length > 0);
  const complete = versionOk && scanComplete && analysisComplete && coverageOk && countsOk && !unanalyzable && !truncated
    && Array.isArray(raw.files) && Array.isArray(raw.runtime_files) && Array.isArray(raw.classified_statements);
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
    classified_statements: classified.slice(0, DISPLAY_STATEMENT_LIMIT),
    classified_statement_total: total,
    classified_statements_truncated: truncated,
    statement_counts: counts || { additive: 0, data: 0, destructive: 0, unknown: 0 },
    qa_status: raw.qa_status ? String(raw.qa_status) : null,
    qa_finding: raw.qa_finding ? String(raw.qa_finding).slice(0, 300) : null,
    staging_migration_status: raw.staging_migration_status ? String(raw.staging_migration_status) : null,
    evidence_present: true,
    evidence_complete: complete,
    evidence_schema_version: raw.evidence_schema_version ? String(raw.evidence_schema_version) : null,
    scan_complete: scanComplete,
    analysis_complete: analysisComplete,
    unanalyzable,
    unanalyzable_reasons: Array.isArray(raw.unanalyzable_reasons) ? raw.unanalyzable_reasons.slice(0, 20) : [],
    coverage: raw.coverage && typeof raw.coverage === "object" ? raw.coverage : null,
  };
}

export function statementsHaveAdditiveShape(ev) {
  const stmts = ev.classified_statements || [];
  if (!stmts.length) return false;
  if (ev.unanalyzable || ev.classified_statements_truncated) return false;
  return stmts.every((c) => c.kind === "ADDITIVE" && ADDITIVE_KIND_SET.has(c.sql_kind))
    && ev.statement_counts.destructive === 0
    && ev.statement_counts.data === 0
    && ev.statement_counts.unknown === 0
    && ev.statement_counts.additive > 0;
}
