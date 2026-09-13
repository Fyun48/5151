/** 後台管理操作紀錄：append-only 表，避免 settings JSON 併發讀改寫丟紀錄。
 *  單筆 INSERT，不讀改寫整包；超過 500 筆刪最舊。不記密碼／secret。 */

import { db } from "./db.js";

const LEGACY_SETTING_KEY = "adminAuditLog";
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

export function ensureAdminAuditSchema(conn = db) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor_id INTEGER NOT NULL DEFAULT 0,
      actor_email TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      before_json TEXT,
      after_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at DESC);
  `);
  migrateLegacyAuditJson(conn);
}

function migrateLegacyAuditJson(conn) {
  const row = conn.prepare("SELECT value FROM settings WHERE key = ?").get(LEGACY_SETTING_KEY);
  if (!row?.value) return;
  let parsed;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    conn.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_SETTING_KEY);
    return;
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    conn.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_SETTING_KEY);
    return;
  }
  const existing = Number(conn.prepare("SELECT COUNT(*) AS n FROM admin_audit").get()?.n) || 0;
  if (existing === 0) {
    const insert = conn.prepare(
      `INSERT INTO admin_audit(at, actor_id, actor_email, action, target, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = conn.transaction((rows) => {
      for (const item of [...rows].reverse()) {
        insert.run(
          String(item.at || new Date().toISOString()),
          Number(item.actorId) || 0,
          String(item.actorEmail || "").slice(0, 200),
          String(item.action || "").slice(0, 80),
          String(item.target || "").slice(0, 240),
          item.before == null ? null : JSON.stringify(item.before),
          item.after == null ? null : JSON.stringify(item.after),
        );
      }
    });
    tx(parsed);
  }
  conn.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_SETTING_KEY);
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

export function listAdminAudit({ limit = 80 } = {}) {
  ensureAdminAuditSchema();
  const cap = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 80));
  return db.prepare(
    `SELECT at, actor_id, actor_email, action, target, before_json, after_json
     FROM admin_audit ORDER BY id DESC LIMIT ?`,
  ).all(cap).map(rowToEntry);
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
  ensureAdminAuditSchema();
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
  ensureAdminAuditSchema();
  const row = db.prepare(
    `SELECT at, actor_id, actor_email, action, target, before_json, after_json
     FROM admin_audit WHERE action = ? ORDER BY id DESC LIMIT 1`,
  ).get(String(action || ""));
  return row ? rowToEntry(row) : null;
}

export { MAX_ENTRIES as ADMIN_AUDIT_MAX_ENTRIES };
