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

