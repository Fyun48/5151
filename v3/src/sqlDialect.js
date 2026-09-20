// SQLite → PostgreSQL SQL translation (PostgreSQL hot path).
//
// Domain code builds SQLite-flavoured SQL (`?` placeholders, IFNULL,
// datetime('now')). The PostgreSQL adapter translates that text at execution
// time instead of keeping a second hand-written copy of every statement: two
// copies drift apart, and the parity test
// (`v3/test/listings-pg-parity.test.js`) depends on both drivers running the
// SAME statement text.
//
// The translator is string-aware: placeholders and function names inside string
// literals, quoted identifiers, bracket identifiers or comments are never
// rewritten, so a literal such as 'IFNULL(?' survives untouched.

// Expression-level rewrites. Applied only to code (non-literal) chunks.
const EXPRESSION_REWRITES = [
  { pattern: /\bIFNULL\s*\(/g, replacement: "COALESCE(" },
  { pattern: /\bGROUP_CONCAT\s*\(/g, replacement: "string_agg(" },
  // instr(haystack, needle) and strpos(haystack, needle) agree on argument order
  // and on being 1-based with 0 for "not found", so the rewrite is exact.
  // (substr/replace/trim/|| have identical semantics in both engines.)
  { pattern: /\binstr\s*\(/g, replacement: "strpos(" },
];

// `datetime('now')` is the one rewrite that spans a string literal, so it cannot
// be handled by the code-chunk regexps; the scanner collapses it explicitly (see
// the literal branch in translateSqliteToPg).
const DATETIME_NOW_HEAD = /datetime\s*\(\s*$/i;

const INSERT_OR_IGNORE = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i;

function readQuoted(text, start, quote) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === quote) {
      // '' / "" / `` inside a quoted run is an escaped quote, not the end.
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

function applyRewrites(chunk) {
  let out = chunk;
  for (const { pattern, replacement } of EXPRESSION_REWRITES) out = out.replace(pattern, replacement);
  return out;
}

// Converts `?` placeholders to `$1..$n` (outside literals/comments) and rewrites
// the SQLite-only expressions above. Returns { text, placeholders }.
export function translateSqliteToPg(sql) {
  const text = String(sql ?? "");
  let out = "";
  let code = "";
  let placeholders = 0;
  let i = 0;
  const flush = () => {
    if (!code) return;
    const rewritten = applyRewrites(code).replace(/\?/g, () => `$${++placeholders}`);
    out += rewritten;
    code = "";
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = readQuoted(text, i, ch);
      const literal = text.slice(i, end);
      // `datetime('now')` spans a literal → collapse head + literal + `)` to now().
      if (ch === "'" && DATETIME_NOW_HEAD.test(code) && /^'now'$/i.test(literal) && text[end] === ")") {
        code = code.replace(DATETIME_NOW_HEAD, "") + "now()";
        i = end + 1;
        continue;
      }
      flush();
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      const end = close === -1 ? text.length : close + 1;
      flush();
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      const end = nl === -1 ? text.length : nl;
      flush();
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      flush();
      out += text.slice(i, end);
      i = end;
      continue;
    }
    code += ch;
    i += 1;
  }
  flush();
  return { text: out, placeholders };
}

// Convenience wrapper when only the text is needed.
export function toPostgresSql(sql) {
  return translateSqliteToPg(sql).text;
}

// `INSERT OR IGNORE INTO x ...` has no PostgreSQL equivalent keyword; the
// conflict handling moves to the end of the statement. Kept separate from
// translateSqliteToPg so the search path stays a pure expression rewrite.
export function translateInsertOrIgnore(sql) {
  const text = String(sql ?? "");
  if (!INSERT_OR_IGNORE.test(text)) return text;
  const stripped = text.replace(INSERT_OR_IGNORE, "INSERT INTO ");
  return /\bON\s+CONFLICT\b/i.test(stripped) ? stripped : `${stripped.trimEnd()} ON CONFLICT DO NOTHING`;
}

// `INSERT OR REPLACE` → `INSERT ... ON CONFLICT (conflictTarget) DO UPDATE` is
// deliberately NOT implemented: the semantics differ (a REPLACE deletes the old
// row, losing columns the caller did not supply). Callers must write the
// PostgreSQL upsert explicitly.
