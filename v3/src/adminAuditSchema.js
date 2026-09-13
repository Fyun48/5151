/** admin_audit 表與舊 settings JSON 遷移。不 import db，避免與 db.js 循環。 */

export const ADMIN_AUDIT_LEGACY_KEY = "adminAuditLog";

export function ensureAdminAuditTable(conn) {
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
}

function runImmediate(conn, fn) {
  conn.exec("BEGIN IMMEDIATE");
  try {
    fn();
    conn.exec("COMMIT");
  } catch (error) {
    try {
      conn.exec("ROLLBACK");
    } catch {
      // already rolled back or not in a transaction
    }
    throw error;
  }
}

export function migrateLegacyAdminAudit(conn) {
  ensureAdminAuditTable(conn);
  let row;
  try {
    row = conn.prepare("SELECT value FROM settings WHERE key = ?").get(ADMIN_AUDIT_LEGACY_KEY);
  } catch {
    return { migrated: 0 };
  }
  if (!row?.value) return { migrated: 0 };
  let parsed;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    conn.prepare("DELETE FROM settings WHERE key = ?").run(ADMIN_AUDIT_LEGACY_KEY);
    return { migrated: 0 };
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    conn.prepare("DELETE FROM settings WHERE key = ?").run(ADMIN_AUDIT_LEGACY_KEY);
    return { migrated: 0 };
  }
  const existing = Number(conn.prepare("SELECT COUNT(*) AS n FROM admin_audit").get()?.n) || 0;
  if (existing > 0) {
    conn.prepare("DELETE FROM settings WHERE key = ?").run(ADMIN_AUDIT_LEGACY_KEY);
    return { migrated: 0 };
  }
  const insert = conn.prepare(
    `INSERT INTO admin_audit(at, actor_id, actor_email, action, target, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  runImmediate(conn, () => {
    for (const item of [...parsed].reverse()) {
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
    conn.prepare("DELETE FROM settings WHERE key = ?").run(ADMIN_AUDIT_LEGACY_KEY);
  });
  return { migrated: parsed.length };
}
