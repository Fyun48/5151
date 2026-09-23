// crm_outbox 的 PostgreSQL 側（2.2c）。語句文字與 crmOutbox.js 逐字相同。
//
// 三個 SQLite 專屬的地方在這裡處理掉：
//   1. INSERT ... RETURNING 不需要（這張表用不到 lastInsertRowid）。
//   2. 搶工作用 res.changes 判斷 → PG 要用 rowCount（由 crmOutboxAsync 的 exec 提供）。
//   3. LIMIT 直接沿用（PG 支援）。
export const CRM_OUTBOX_TABLE = "crm_outbox";
export const CRM_OUTBOX_MAX_ATTEMPTS = 8;
export const CRM_OUTBOX_STALE_MS = 2 * 60 * 1000;

export function outboxInsertQuery() {
  return {
    sql: `INSERT INTO crm_outbox(delivery_id, idempotency_key, contact_id, payload, status, attempts, max_attempts, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  };
}

// crmOutbox.js claimCrmOutboxBatch() 的候選查詢（排序與條件逐字相同）。
export function outboxClaimCandidatesQuery(nowIso, staleBefore, limit) {
  return {
    sql: `SELECT * FROM crm_outbox
     WHERE (status IN ('pending','failed') AND next_attempt_at <= ?)
        OR (status = 'sending' AND (claimed_at IS NULL OR claimed_at <= ?))
     ORDER BY id ASC LIMIT ?`,
    params: [nowIso, staleBefore, Math.max(1, Math.min(Number(limit) || 20, 200))],
  };
}

export function outboxReclaimStaleQuery(nowIso, staleBefore, id) {
  return {
    sql: "UPDATE crm_outbox SET claimed_at=? WHERE id=? AND status='sending' AND (claimed_at IS NULL OR claimed_at <= ?)",
    params: [nowIso, Number(id) || 0, staleBefore],
  };
}

export function outboxClaimPendingQuery(nowIso, status, id) {
  return {
    sql: "UPDATE crm_outbox SET status='sending', claimed_at=? WHERE id=? AND status=?",
    params: [nowIso, Number(id) || 0, status],
  };
}

export function outboxSentQuery(stamp, id) {
  return {
    sql: "UPDATE crm_outbox SET status='sent', sent_at=?, last_error=NULL WHERE id=?",
    params: [stamp, Number(id) || 0],
  };
}

export function outboxDeadQuery(attempts, err, id) {
  return {
    sql: "UPDATE crm_outbox SET status='dead', attempts=?, last_error=? WHERE id=?",
    params: [Number(attempts) || 0, err, Number(id) || 0],
  };
}

export function outboxFailedQuery(attempts, next, err, id) {
  return {
    sql: "UPDATE crm_outbox SET status='failed', attempts=?, next_attempt_at=?, last_error=? WHERE id=?",
    params: [Number(attempts) || 0, next, err, Number(id) || 0],
  };
}

export function outboxStatsQuery() {
  return { sql: "SELECT status, COUNT(*) AS n FROM crm_outbox GROUP BY status", params: [] };
}


export function outboxSettingsStopQuery() {
  return { sql: "SELECT value FROM settings WHERE key = ?", params: ["ops_crm_stop"] };
}
