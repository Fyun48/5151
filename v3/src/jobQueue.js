// Durable job queue (Phase 4). One shared queue that the existing geo/enrich/
// notification/CRM/OPS/wish workers converge onto.
//
// Storage-agnostic core: the queue state machine (lease / retry / exponential
// backoff / dead-letter / idempotency / expired-lease reclaim) is identical
// across drivers; only the "claim" primitive differs:
//   - SQLite: BEGIN IMMEDIATE write-lock transaction (single/multi-process safe in WAL).
//   - PostgreSQL: SELECT ... FOR UPDATE SKIP LOCKED (safe concurrent claim).
//
// Timestamps are epoch-millisecond integers so both drivers behave identically.

export const JOB_PRIORITY = Object.freeze({
  ON_SCREEN_LISTING: 100, // 使用者現在畫面上的 listing
  CLICKED: 90,            // 使用者剛點擊
  WATCHED: 80,            // watched / 特別關注
  NEW_LISTING: 60,        // 新 listing
  ENRICHMENT: 20,         // 一般 enrichment
  HISTORICAL_BACKFILL: 5, // historical backfill
});

export const JOB_STATE = Object.freeze({
  PENDING: "pending",
  LEASED: "leased",
  DONE: "done",
  DEAD: "dead",
});

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 10 * 60 * 1000;

export const POSTGRES_JOB_QUEUE_DDL = `
CREATE TABLE IF NOT EXISTS job_queue (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 20,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at BIGINT NOT NULL,
  leased_at BIGINT,
  lease_until BIGINT,
  lease_owner TEXT,
  idempotency_key TEXT UNIQUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_queue_claim ON job_queue(state, available_at, priority DESC, created_at ASC);
`;

export const SQLITE_JOB_QUEUE_DDL = `
CREATE TABLE IF NOT EXISTS job_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 20,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at INTEGER NOT NULL,
  leased_at INTEGER,
  lease_until INTEGER,
  lease_owner TEXT,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_queue_claim ON job_queue(state, available_at, priority DESC, created_at ASC);
`;

// The safe concurrent claim (PostgreSQL). Never claims the same row twice even
// with multiple workers (CasaOS + Synology) competing.
export const POSTGRES_CLAIM_JOBS_SQL = `
WITH claimed AS (
  SELECT id FROM job_queue
  WHERE state = 'pending' AND available_at <= $1
    AND ($2::text[] IS NULL OR job_type = ANY($2::text[]))
  ORDER BY priority DESC, created_at ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $3
)
UPDATE job_queue SET
  state = 'leased', lease_owner = $4, leased_at = $1, lease_until = $5, updated_at = $1
WHERE id IN (SELECT id FROM claimed)
RETURNING *;
`;

// Recurring scheduler: only one scheduler enqueues per recurrence key.
export const POSTGRES_TRY_ADVISORY_LOCK_SQL = "SELECT pg_try_advisory_lock($1::bigint) AS acquired";
export const POSTGRES_ADVISORY_UNLOCK_SQL = "SELECT pg_advisory_unlock($1::bigint)";

// --- Recurring scheduler mutual exclusion (one enqueuer per recurrence) ---
// SQLite has no advisory locks, so we use a small lease-based lock table with
// the same acquire/release semantics as pg_try_advisory_lock.

export const SQLITE_SCHEDULER_LOCK_DDL = `
CREATE TABLE IF NOT EXISTS scheduler_locks (
  lock_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function ensureSchedulerLockTable(db) {
  db.exec(SQLITE_SCHEDULER_LOCK_DDL);
}

export function tryAcquireSchedulerLock(db, { key, owner, leaseMs = 60_000, now = Date.now() } = {}) {
  ensureSchedulerLockTable(db);
  const until = now + leaseMs;
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT * FROM scheduler_locks WHERE lock_key = ?").get(key);
    if (existing && Number(existing.lease_until) > now) {
      db.exec("COMMIT");
      return false;
    }
    db.prepare(`
      INSERT INTO scheduler_locks (lock_key, owner, lease_until, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(lock_key) DO UPDATE SET owner = excluded.owner, lease_until = excluded.lease_until, updated_at = excluded.updated_at
    `).run(key, owner, until, now);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function releaseSchedulerLock(db, { key, owner } = {}) {
  db.prepare("DELETE FROM scheduler_locks WHERE lock_key = ? AND owner = ?").run(key, owner);
}

export function ensureJobQueueSchema(db) {
  db.exec(SQLITE_JOB_QUEUE_DDL);
}

function rowOut(row, payloadJson = false) {
  if (!row) return null;
  const out = { ...row };
  if (payloadJson && out.payload != null) {
    try { out.payload = JSON.parse(out.payload); } catch { /* leave as-is */ }
  }
  return out;
}

export function enqueueJob(db, {
  jobType,
  payload = {},
  priority = JOB_PRIORITY.ENRICHMENT,
  idempotencyKey = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = Date.now(),
  availableAt = now,
} = {}) {
  const payloadJson = JSON.stringify(payload ?? {});
  const result = db.prepare(`
    INSERT INTO job_queue
      (job_type, payload, priority, state, attempts, max_attempts, available_at,
       idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, '${JOB_STATE.PENDING}', 0, ?, ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `).run(jobType, payloadJson, priority, maxAttempts, availableAt, idempotencyKey, now, now);

  if (idempotencyKey != null && result.changes === 0) {
    return rowOut(db.prepare("SELECT * FROM job_queue WHERE idempotency_key = ?").get(idempotencyKey), true);
  }
  return rowOut(db.prepare("SELECT * FROM job_queue WHERE id = ?").get(result.lastInsertRowid), true);
}

export function claimJobs(db, {
  workerId,
  jobTypes = null,
  limit = 10,
  leaseDurationMs = DEFAULT_LEASE_MS,
  now = Date.now(),
} = {}) {
  const types = (jobTypes || []).filter(Boolean);
  const typeFilter = types.length ? `AND job_type IN (${types.map(() => "?").join(",")})` : "";
  const until = now + leaseDurationMs;
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare(`
      SELECT * FROM job_queue
      WHERE state = '${JOB_STATE.PENDING}' AND available_at <= ? ${typeFilter}
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT ?
    `).all(now, ...types, limit);
    const claimed = [];
    for (const row of rows) {
      db.prepare(`
        UPDATE job_queue SET state = '${JOB_STATE.LEASED}', lease_owner = ?, leased_at = ?,
          lease_until = ?, updated_at = ?
        WHERE id = ? AND state = '${JOB_STATE.PENDING}'
      `).run(workerId, now, until, now, row.id);
      claimed.push({ ...row, state: JOB_STATE.LEASED, lease_owner: workerId, leased_at: now, lease_until: until });
    }
    db.exec("COMMIT");
    return claimed.map((r) => rowOut(r, true));
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function completeJob(db, { jobId, workerId, now = Date.now() } = {}) {
  const result = db.prepare(`
    UPDATE job_queue SET state = '${JOB_STATE.DONE}', lease_owner = NULL, updated_at = ?
    WHERE id = ? AND state = '${JOB_STATE.LEASED}' AND lease_owner = ?
  `).run(now, jobId, workerId);
  return result.changes === 1;
}

export function failJob(db, {
  jobId,
  workerId,
  error = null,
  maxAttempts = null,
  now = Date.now(),
} = {}) {
  const row = db.prepare("SELECT * FROM job_queue WHERE id = ? AND lease_owner = ?").get(jobId, workerId);
  if (!row) return null;
  const attempts = (Number(row.attempts) || 0) + 1;
  const cap = Number(maxAttempts ?? row.max_attempts ?? DEFAULT_MAX_ATTEMPTS);
  if (attempts >= cap) {
    db.prepare(`
      UPDATE job_queue SET state = '${JOB_STATE.DEAD}', attempts = ?, lease_owner = NULL,
        lease_until = NULL, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(attempts, error ? String(error).slice(0, 2000) : null, now, jobId);
    return { id: Number(jobId), state: JOB_STATE.DEAD, attempts };
  }
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
  db.prepare(`
    UPDATE job_queue SET state = '${JOB_STATE.PENDING}', attempts = ?, lease_owner = NULL,
      leased_at = NULL, lease_until = NULL, available_at = ?, last_error = ?, updated_at = ?
    WHERE id = ?
  `).run(attempts, now + backoff, error ? String(error).slice(0, 2000) : null, now, jobId);
  return { id: Number(jobId), state: JOB_STATE.PENDING, attempts, availableAt: now + backoff };
}

export function reclaimExpiredLeases(db, { now = Date.now() } = {}) {
  const result = db.prepare(`
    UPDATE job_queue SET state = '${JOB_STATE.PENDING}', lease_owner = NULL, leased_at = NULL,
      lease_until = NULL, updated_at = ?
    WHERE state = '${JOB_STATE.LEASED}' AND lease_until < ?
  `).run(now, now);
  return result.changes;
}

