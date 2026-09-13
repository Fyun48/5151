/** 後台管理操作紀錄：append-only 表，避免 settings JSON 併發讀改寫丟紀錄。
 *  單筆 INSERT，不讀改寫整包；超過 500 筆刪最舊。不記密碼／secret。
 *  legacy JSON 遷移只在 startup（db.js）執行，GET 路徑不寫入。 */

import { db } from "./db.js";
import { ensureAdminAuditTable } from "./adminAuditSchema.js";

const MAX_ENTRIES = 500;
const SECRET_RE = /password|passwd|secret|api[_-]?key|smtpPass|clientSecret|token|authorization/i;

export function redactAuditValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 400) return `${value.slice(0, 400)}…`;
    return value;
  }
  if (typeof value !== "object" || depth > 3) return String(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactAuditValue(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_RE.test(key) ? (item ? "[redacted]" : "") : redactAuditValue(item, depth + 1);
  }
  return out;
}

function rowToEntry(row) {
  const parse = (text) => {
    if (text == null || text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return {
    at: row.at,
    actorId: Number(row.actor_id) || 0,
    actorEmail: row.actor_email || "",
    action: row.action || "",
    target: row.target || "",
    before: parse(row.before_json),
    after: parse(row.after_json),
  };
}

function readAuditRows(sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function readAuditRow(sql, ...params) {
  try {
    return db.prepare(sql).get(...params) || null;
  } catch {
    return null;
  }
}

export function listAdminAudit({ limit = 80 } = {}) {
  const cap = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 80));
  return readAuditRows(
    `SELECT at, actor_id, actor_email, action, target, before_json, after_json
     FROM admin_audit ORDER BY id DESC LIMIT ?`,
    cap,
  ).map(rowToEntry);
}

export function appendAdminAudit({
  actorId = 0,
  actorEmail = "",
  action = "",
  target = "",
  before = null,
  after = null,
  now = new Date(),
} = {}) {
  ensureAdminAuditTable(db);
  const entry = {
    at: (now instanceof Date ? now : new Date(now)).toISOString(),
    actorId: Number(actorId) || 0,
    actorEmail: String(actorEmail || "").trim().slice(0, 200),
    action: String(action || "").trim().slice(0, 80),
    target: String(target || "").trim().slice(0, 240),
    before: redactAuditValue(before),
    after: redactAuditValue(after),
  };
  db.prepare(
    `INSERT INTO admin_audit(at, actor_id, actor_email, action, target, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.at,
    entry.actorId,
    entry.actorEmail,
    entry.action,
    entry.target,
    entry.before == null ? null : JSON.stringify(entry.before),
    entry.after == null ? null : JSON.stringify(entry.after),
  );
  const extra = db.prepare(
    `SELECT id FROM admin_audit ORDER BY id DESC LIMIT -1 OFFSET ?`,
  ).get(MAX_ENTRIES);
  if (extra?.id) {
    db.prepare("DELETE FROM admin_audit WHERE id <= ?").run(extra.id);
  }
  return entry;
}

export function lastAuditAction(action) {
  const row = readAuditRow(
    `SELECT at, actor_id, actor_email, action, target, before_json, after_json
     FROM admin_audit WHERE action = ? ORDER BY id DESC LIMIT 1`,
    String(action || ""),
  );
  return row ? rowToEntry(row) : null;
}

export { MAX_ENTRIES as ADMIN_AUDIT_MAX_ENTRIES };
