// Data revision change-log (Phase 11). Lets a Web node (or SSE client) that
// reconnects catch up by asking "what changed since revision N?" without
// replaying the whole dataset. Pair with deltaEvents + eventBus: a change bumps
// the revision and publishes a delta hint; the DB change-log is the durable
// source of truth the client re-reads on reconnect.

export const DATA_REVISION_DDL = `
CREATE TABLE IF NOT EXISTS data_revision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_data_revision_id ON data_revision(id);
`;

export function ensureDataRevisionTable(db) {
  db.exec(DATA_REVISION_DDL);
}

export function currentRevision(db) {
  ensureDataRevisionTable(db);
  const row = db.prepare("SELECT MAX(id) AS n FROM data_revision").get();
  return Number(row?.n) || 0;
}

export function bumpRevision(db, { entityType, entityId = null, eventType, now = Date.now() } = {}) {
  ensureDataRevisionTable(db);
  const result = db.prepare(
    "INSERT INTO data_revision (entity_type, entity_id, event_type, created_at) VALUES (?, ?, ?, ?)",
  ).run(entityType, entityId == null ? null : Number(entityId), eventType, now);
  return Number(result.lastInsertRowid);
}

export function changesSince(db, revision, { limit = 500 } = {}) {
  ensureDataRevisionTable(db);
  const cap = Math.max(1, Math.min(Number(limit) || 500, 5000));
  return db.prepare(
    "SELECT id, entity_type, entity_id, event_type, created_at FROM data_revision WHERE id > ? ORDER BY id ASC LIMIT ?",
  ).all(Number(revision) || 0, cap);
}
