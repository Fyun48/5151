// listingEnrichQueue 的 PostgreSQL 側（2.3b 第一段：讀取與後台統計）。語句與 listingEnrichQueue.js 逐字相同。
export const LISTING_ENRICH_TABLES = ["listing_prep", "listing_enrich_jobs", "listing_enrich_metrics"];

export function listingPrepRowQuery(postId) {
  return { sql: "SELECT * FROM listing_prep WHERE post_id = ?", params: [Number(postId) || 0] };
}

export function prepPendingCountQuery() {
  return { sql: "SELECT COUNT(*) AS n FROM listing_prep WHERE display_ready = 0 AND source = 'houseprice'", params: [] };
}

export function prepReadyCountQuery() {
  return { sql: "SELECT COUNT(*) AS n FROM listing_prep WHERE display_ready = 1 AND source = 'houseprice'", params: [] };
}

// listingPrepAdminStats() 的 jobs 彙總（SUM(CASE …) 在 PG 回 numeric 字串，取用時再轉數字）。
export function enrichJobsSummaryQuery() {
  return {
    sql: `SELECT
      SUM(CASE WHEN status IN ('queued', 'failed', 'source_limited', 'parse_failed') THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      MIN(CASE WHEN status IN ('queued', 'failed', 'running', 'source_limited', 'parse_failed') THEN created_at END) AS oldest,
      MAX(last_success_at) AS last_success
    FROM listing_enrich_jobs`,
    params: [],
  };
}

export function enrichErrorBreakdownQuery() {
  return {
    sql: `SELECT last_error_class AS reason, COUNT(*) AS n
      FROM listing_enrich_jobs
     WHERE last_error_class != ''
     GROUP BY last_error_class
     ORDER BY n DESC
     LIMIT 8`,
    params: [],
  };
}

export function enrichMetricsRowsQuery() {
  return {
    sql: `SELECT queued_ms, start_ms, fetch_ms, parse_ms, locate_ms, route_ms, ready_ms,
           first_ready_ms, attempt_wait_ms, outcome
      FROM listing_enrich_metrics
     ORDER BY id DESC
     LIMIT 500`,
    params: [],
  };
}

export async function readPrepRow(exec, postId) {
  const q = listingPrepRowQuery(postId);
  return ((await exec(q.sql, q.params)) || [])[0] || null;
}

export async function readMetricsRows(exec) {
  const q = enrichMetricsRowsQuery();
  return (await exec(q.sql, q.params)) || [];
}

// ---------------------------------------------------------------------------
// 2.3b 第二段：寫入路徑的語句
//
// SQL 文字集中在這裡；「要不要 requeue、下一個 priority 是多少、這次算不算
// superseded」這類判斷留在 listingEnrichQueue.js 的 plan 函式。兩邊共用同一份
// 文字與同一份判斷，SQLite 與 PostgreSQL 才 parity 得起來。
// ---------------------------------------------------------------------------

// 補欄位用的遷移清單。SQLite 端由 ensureColumn 用 PRAGMA 探測；
// PostgreSQL 端改用 information_schema.columns（見 listingEnrichQueueAsync.js）。
export const LISTING_ENRICH_COLUMN_MIGRATIONS = [
  { table: "listing_enrich_jobs", name: "last_queued_at", ddl: "TEXT" },
  { table: "listing_enrich_metrics", name: "first_ready_ms", ddl: "INTEGER" },
  { table: "listing_enrich_metrics", name: "attempt_wait_ms", ddl: "INTEGER" },
  { table: "listing_enrich_metrics", name: "outcome", ddl: "TEXT NOT NULL DEFAULT ''" },
];

// 候選排序：三個字串與 claimOne() 的 order 參數一一對應。
export const ENRICH_CLAIM_ORDER_SQL = {
  oldest: "created_at ASC, post_id ASC",
  fair: "IFNULL(last_attempt_at, created_at) ASC, post_id ASC",
  priority: "priority DESC, IFNULL(next_retry_at, created_at) ASC, post_id ASC",
};

export function claimOrderSql(order) {
  return ENRICH_CLAIM_ORDER_SQL[order] || ENRICH_CLAIM_ORDER_SQL.priority;
}

// enqueueListingEnrich()：先看有沒有既有列。
export function enrichJobByPostIdQuery(postId) {
  return { sql: "SELECT * FROM listing_enrich_jobs WHERE post_id = ?", params: [Number(postId) || 0] };
}

export function enrichJobRunSeqQuery(id) {
  return { sql: "SELECT request_seq, run_seq FROM listing_enrich_jobs WHERE id = ?", params: [Number(id) || 0] };
}

export function enrichJobBumpQuery({
  nextPriority,
  via,
  prio,
  prevPriority,
  requestSeqStep,
  missingJson,
  requeue,
  keepBackoff,
  setQueuedAt,
  stamp,
  postId,
}) {
  return {
    sql: `UPDATE listing_enrich_jobs
       SET priority = ?,
           requested_via = CASE WHEN ? >= ? THEN ? ELSE requested_via END,
           request_seq = request_seq + ?,
           missing_fields = ?,
           status = CASE
             WHEN ? THEN 'queued'
             ELSE status
           END,
           next_retry_at = CASE
             WHEN ? THEN next_retry_at
             WHEN ? THEN NULL
             ELSE next_retry_at
           END,
           last_queued_at = CASE WHEN ? THEN ? ELSE last_queued_at END
     WHERE post_id = ?`,
    params: [
      nextPriority,
      prio,
      prevPriority,
      via,
      requestSeqStep,
      missingJson,
      requeue ? 1 : 0,
      keepBackoff ? 1 : 0,
      requeue ? 1 : 0,
      setQueuedAt ? 1 : 0,
      stamp,
      Number(postId) || 0,
    ],
  };
}

// reclaimStaleEnrichJobs()：兩邊都要看受影響列數（PG 是 rowCount）。
export function reclaimStaleEnrichJobsQuery(cut) {
  return {
    sql: `UPDATE listing_enrich_jobs
       SET status = 'queued',
           lease_until = NULL,
           last_queued_at = ?
     WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`,
    params: [cut, cut],
  };
}

export function claimCandidatesQuery({ minPriority = 0, maxPriority = 1000, stamp, order = "priority" } = {}) {
  return {
    sql: `SELECT * FROM listing_enrich_jobs
     WHERE status IN ('queued', 'failed', 'source_limited', 'parse_failed')
       AND priority >= ? AND priority <= ?
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY ${claimOrderSql(order)}
     LIMIT 1`,
    params: [Number(minPriority) || 0, Number(maxPriority) || 0, stamp],
  };
}

export function leaseEnrichJobQuery({ stamp, leaseUntil, id }) {
  return {
    sql: `UPDATE listing_enrich_jobs
       SET status = 'running',
           started_at = ?,
           last_attempt_at = ?,
           attempt_count = attempt_count + 1,
           run_seq = IFNULL(run_seq, 0) + 1,
           lease_until = ?
     WHERE id = ? AND status IN ('queued', 'failed', 'source_limited', 'parse_failed')`,
    params: [stamp, stamp, leaseUntil, Number(id) || 0],
  };
}

export function enrichJobByIdQuery(id) {
  return { sql: "SELECT * FROM listing_enrich_jobs WHERE id = ?", params: [Number(id) || 0] };
}

export function enrichJobInsertQuery() {
  return {
    sql: `INSERT INTO listing_enrich_jobs(
        post_id, source, job_kind, status, missing_fields, priority, requested_via, created_at, last_queued_at
      ) VALUES (?, ?, 'enrich', 'queued', ?, ?, ?, ?, ?)`,
  };
}

// finishJob()：收尾寫入（樂觀鎖 WHERE id AND run_seq）。
export function finishEnrichJobQuery({
  finalStatus,
  error,
  errorClass,
  missingJson,
  stamp,
  retryAt,
  timingsJson,
  jobId,
  runSeq,
}) {
  return {
    sql: `UPDATE listing_enrich_jobs
       SET status = ?,
           last_error = ?,
           last_error_class = ?,
           missing_fields = ?,
           last_success_at = CASE WHEN ? = 'succeeded' THEN ? ELSE last_success_at END,
           next_retry_at = ?,
           lease_until = NULL,
           timings = ?
     WHERE id = ? AND run_seq = ?`,
    params: [
      finalStatus,
      error,
      errorClass,
      missingJson,
      finalStatus,
      stamp,
      retryAt,
      timingsJson,
      Number(jobId) || 0,
      Number(runSeq) || 0,
    ],
  };
}

export function enrichMetricInsertQuery() {
  return {
    sql: `INSERT INTO listing_enrich_metrics(
        post_id, job_id, queued_ms, start_ms, fetch_ms, parse_ms, locate_ms, route_ms, ready_ms,
        first_ready_ms, attempt_wait_ms, outcome, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  };
}

// processOneEnrichJob() 的 PROBE_INCONCLUSIVE 分支：全檔唯一直接寫 listing_prep 的手寫 UPDATE。
export function prepCheckedUpdateQuery({ stamp, reason, postId }) {
  return {
    sql: `UPDATE listing_prep
       SET checked_at = ?,
           withhold_reason = ?
     WHERE post_id = ?`,
    params: [stamp, reason, Number(postId) || 0],
  };
}

// PostgreSQL 沒有 PRAGMA table_info()，欄位探測改走 information_schema.columns。
export function columnProbeQuery(table) {
  return {
    sql: "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
    params: [String(table)],
  };
}

export function addColumnQuery(table, name, ddl) {
  return { sql: `ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`, params: [] };
}

