/** 5168 補抓／複查工作佇列：重啟可接續、逾期可回收、點擊合併、分批寫回。 */

import {
  classifyAddress,
  evaluateHpPrep,
  FIELD_NOT_FETCHED,
  FIELD_NOT_PROVIDED,
  FIELD_PARSE_FAILED,
  hasListingIdentity,
  HP_PREP_SOURCE,
  isHousepriceListing,
  mergeHpListingFields,
  PREP_PARSE_FAILED,
  PREP_PENDING,
  PREP_READY,
  PREP_SOURCE_LIMITED,
} from "./listingPrep.js";
import { enrichHpListingFromDetail, fetchHpDetailInspected, HP_SOURCE } from "./houseprice.js";
import { PROBE_ALIVE, PROBE_GONE, PROBE_INCONCLUSIVE } from "./probeOutcomes.js";
// 2.3b 第二段：寫入路徑的 SQL 文字集中在 repository builder（SQLite 與 PostgreSQL 共用同一份文字）。
import * as enrichRepo from "./repository/listingEnrich.js";

const CLICK_PRIORITY = 100;
const WATCH_PRIORITY = 60;
const AGED_PRIORITY = 20;
const NORMAL_PRIORITY = 10;
const LEASE_MS = 3 * 60_000;
const STATUS_COOLDOWN_MS = 60_000;
const ENRICH_COOLDOWN_MS = 20_000;
const TRANSIENT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const SOURCE_LIMITED_BACKOFF_MS = 12 * 60 * 60_000;
const PARSE_FAIL_BACKOFF_MS = 24 * 60 * 60_000;
const CLAIMABLE_STATUSES = ["queued", "failed", "source_limited", "parse_failed"];
const SOURCE_PAUSE_CLASSES = ["transient", "source_limited"];

export function ensureListingPrepSchema(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS listing_prep (
      post_id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      display_ready INTEGER NOT NULL DEFAULT 0,
      prep_status TEXT NOT NULL DEFAULT 'pending',
      detail_status TEXT NOT NULL DEFAULT 'not_fetched',
      address_status TEXT NOT NULL DEFAULT 'not_fetched',
      floor_status TEXT NOT NULL DEFAULT 'not_fetched',
      facility_status TEXT NOT NULL DEFAULT 'not_fetched',
      facility_basis TEXT NOT NULL DEFAULT '',
      geo_precision TEXT NOT NULL DEFAULT 'unknown',
      location_label TEXT NOT NULL DEFAULT '',
      missing_fields TEXT NOT NULL DEFAULT '[]',
      withhold_reason TEXT NOT NULL DEFAULT '',
      source_limited_reason TEXT NOT NULL DEFAULT '',
      checked_at TEXT,
      ready_at TEXT,
      first_ready_notified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS listing_enrich_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL UNIQUE,
      source TEXT NOT NULL,
      job_kind TEXT NOT NULL DEFAULT 'enrich',
      status TEXT NOT NULL DEFAULT 'queued',
      missing_fields TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 10,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      request_seq INTEGER NOT NULL DEFAULT 0,
      run_seq INTEGER NOT NULL DEFAULT 0,
      requested_via TEXT NOT NULL DEFAULT 'scheduler',
      last_attempt_at TEXT,
      last_success_at TEXT,
      next_retry_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      last_error_class TEXT NOT NULL DEFAULT '',
      lease_until TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      timings TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_enrich_jobs_claim
      ON listing_enrich_jobs(status, next_retry_at, priority, created_at);
    CREATE TABLE IF NOT EXISTS listing_enrich_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      job_id INTEGER,
      queued_ms INTEGER,
      start_ms INTEGER,
      fetch_ms INTEGER,
      parse_ms INTEGER,
      locate_ms INTEGER,
      route_ms INTEGER,
      ready_ms INTEGER,
      first_ready_ms INTEGER,
      attempt_wait_ms INTEGER,
      outcome TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(conn, "listing_enrich_jobs", "last_queued_at", "TEXT");
  ensureColumn(conn, "listing_enrich_metrics", "first_ready_ms", "INTEGER");
  ensureColumn(conn, "listing_enrich_metrics", "attempt_wait_ms", "INTEGER");
  ensureColumn(conn, "listing_enrich_metrics", "outcome", "TEXT NOT NULL DEFAULT ''");
}

function ensureColumn(conn, table, name, ddl) {
  const cols = conn.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!cols.includes(name)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

function nowIso() {
  return new Date().toISOString();
}

function metricNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function jobStillOwnsRun(conn, job) {
  if (!job?.id) return false;
  const q = enrichRepo.enrichJobRunSeqQuery(job.id);
  const latest = conn.prepare(q.sql).get(...q.params);
  return jobRunOwns(latest, job);
}

// 擁有權判斷本身（sync 與 async 共用）：run_seq 被推進或 request_seq 被別人推進都算失去擁有權。
export function jobRunOwns(latest, job) {
  if (!job?.id) return false;
  if (!latest) return false;
  if (Number(latest.run_seq) !== Number(job.run_seq)) return false;
  if (Number(latest.request_seq) > Number(job.request_seq ?? job.run_seq)) return false;
  return true;
}

function sourceBackoffActive(job, now = Date.now()) {
  const retryAt = Date.parse(job?.next_retry_at || "") || 0;
  if (!retryAt || retryAt <= now) return false;
  return SOURCE_PAUSE_CLASSES.includes(String(job?.last_error_class || ""));
}

function parseJson(raw, fallback) {
  try {
    return JSON.parse(raw || "");
  } catch {
    return fallback;
  }
}

// --- 2.3b 第二段：寫入路徑的 driver-aware 分派 -----------------------------
// helpers.enrichQueue 由呼叫端提供（listingEnrichQueueAsync.js 的 listingEnrichQueueFacade()）。
// 沒有它時走本檔原本的同步函式，所以 SQLite-only 呼叫端與既有測試一行都不用改。
function enrichQueueOf(helpers) {
  return helpers?.enrichQueue || null;
}

function queueFinish(queue, conn, job, patch) {
  return queue ? queue.finish(conn, job, patch) : finishJob(conn, job, patch);
}

function queueMetric(queue, conn, job, timings) {
  return queue ? queue.metric(conn, job, timings) : recordEnrichMetric(conn, job, timings);
}

function queueOwnsRun(queue, conn, job) {
  return queue ? queue.ownsRun(conn, job) : jobStillOwnsRun(conn, job);
}

function queueGetPrep(queue, conn, postId) {
  return queue ? queue.getPrep(conn, postId) : getListingPrep(conn, postId);
}

function queuePrepChecked(queue, conn, args) {
  return queue ? queue.prepChecked(conn, args) : prepCheckedUpdate(conn, args);
}

function queueSeed(queue, conn, opts) {
  return queue ? queue.seed(conn, opts) : seedHousepriceEnrichJobs(conn, opts);
}

function queueClaim(queue, conn, opts) {
  return queue ? queue.claim(conn, opts) : claimEnrichJobs(conn, opts);
}

// 全檔唯一直接寫 listing_prep 的手寫 UPDATE（processOneEnrichJob 的 PROBE_INCONCLUSIVE 分支）。
function prepCheckedUpdate(conn, { postId, reason, now = Date.now() } = {}) {
  const q = enrichRepo.prepCheckedUpdateQuery({ stamp: new Date(now).toISOString(), reason, postId });
  conn.prepare(q.sql).run(...q.params);
}

// The listing_prep row is owned by this module (schema + statement together), so its text lives
// here and is shared by the SQLite writer and the driver-aware writer the enrich worker uses when
// the deployment is on PostgreSQL.
export const LISTING_PREP_UPSERT_SQL = `
    INSERT INTO listing_prep(
      post_id, source, display_ready, prep_status, detail_status, address_status,
      floor_status, facility_status, facility_basis, geo_precision, location_label,
      missing_fields, withhold_reason, source_limited_reason, checked_at, ready_at, first_ready_notified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      source = excluded.source,
      display_ready = excluded.display_ready,
      prep_status = excluded.prep_status,
      detail_status = excluded.detail_status,
      address_status = excluded.address_status,
      floor_status = excluded.floor_status,
      facility_status = excluded.facility_status,
      facility_basis = excluded.facility_basis,
      geo_precision = excluded.geo_precision,
      location_label = excluded.location_label,
      missing_fields = excluded.missing_fields,
      withhold_reason = excluded.withhold_reason,
      source_limited_reason = excluded.source_limited_reason,
      checked_at = excluded.checked_at,
      ready_at = COALESCE(listing_prep.ready_at, excluded.ready_at),
      first_ready_notified = listing_prep.first_ready_notified
  `;

// The values one prep write contains. `ready_at` keeps its first value, which is what the
// becomingReady / firstReadyAt answer is derived from.
export function listingPrepPlan(existing, postId, evalResult, { stamp = nowIso() } = {}) {
  const becomingReady = Boolean(evalResult.displayReady) && !existing?.ready_at;
  return {
    sql: LISTING_PREP_UPSERT_SQL,
    params: [
      postId,
      HP_PREP_SOURCE,
      evalResult.displayReady ? 1 : 0,
      evalResult.status,
      evalResult.detailRecognized ? "fetched" : (evalResult.status === PREP_PARSE_FAILED ? "parse_failed" : "pending"),
      evalResult.address.usable ? (evalResult.address.sourceLimited ? "approx" : "usable") : "pending",
      evalResult.floor.status,
      evalResult.facility.status,
      evalResult.facility.basis || "",
      evalResult.geoPrecision,
      evalResult.locationLabel,
      JSON.stringify(evalResult.missing),
      evalResult.withholdReason || "",
      evalResult.sourceLimitedReason || "",
      stamp,
      evalResult.displayReady ? stamp : null,
      0,
    ],
    becomingReady,
    firstReadyAt: becomingReady ? stamp : existing?.ready_at || "",
  };
}

export function upsertListingPrep(conn, postId, listing, evalResult) {
  const existing = conn.prepare("SELECT ready_at, first_ready_notified FROM listing_prep WHERE post_id = ?").get(postId);
  const plan = listingPrepPlan(existing, postId, evalResult);
  conn.prepare(plan.sql).run(...plan.params);
  return { becomingReady: plan.becomingReady, firstReadyAt: plan.firstReadyAt };
}

// The PostgreSQL twin of upsertListingPrep(): same statement, same decision, the caller's exec
// (crawlerWrites.upsertListingPrepAsync supplies the pool).
export async function upsertListingPrepAsync(exec, { postId, listing, evalResult } = {}) {
  const rows = await exec("SELECT ready_at, first_ready_notified FROM listing_prep WHERE post_id = ?", [postId]);
  const existing = (rows || [])[0] || null;
  const plan = listingPrepPlan(existing, postId, evalResult);
  await exec(plan.sql, plan.params);
  return { becomingReady: plan.becomingReady, firstReadyAt: plan.firstReadyAt };
}

// The prep row is written through the bundle when it has a driver-aware writer (PostgreSQL), and
// through the handled connection otherwise - same statement either way (listingPrepPlan).
function prepWrite(helpers, conn, postId, listing, evalResult) {
  if (typeof helpers?.upsertListingPrepAsync === "function") {
    return helpers.upsertListingPrepAsync(postId, listing, evalResult);
  }
  return upsertListingPrep(conn, postId, listing, evalResult);
}

export function getListingPrep(conn, postId) {
  return conn.prepare("SELECT * FROM listing_prep WHERE post_id = ?").get(postId) || null;
}

// via → 預設優先權（sync 與 async 共用）。
export function enqueuePriority(via, priority) {
  if (Number.isFinite(Number(priority))) return Number(priority);
  return via === "click" || via === "notify" || via === "go"
    ? CLICK_PRIORITY
    : via === "watch"
      ? WATCH_PRIORITY
      : NORMAL_PRIORITY;
}

// enqueueListingEnrich() 的判斷部分（sync 與 async 共用）：既有列 → 提高優先權／重排，
// 沒有列 → 插一筆。回傳 repository 的 { sql, params }，呼叫端只負責執行。
export function enqueueEnrichPlan(existing, { postId, prio, via, missing = [], now = Date.now() } = {}) {
  const stamp = new Date(now).toISOString();
  if (existing) {
    const nextPriority = Math.max(Number(existing.priority) || 0, prio);
    const bumpSeq = via === "click" || via === "notify" || via === "go";
    const running = existing.status === "running";
    const retryBlocked = Boolean(existing.next_retry_at && Date.parse(existing.next_retry_at) > now);
    const keepBackoff = sourceBackoffActive(existing, now) || retryBlocked;
    const requeue = !running && !keepBackoff && (
      bumpSeq
      || (CLAIMABLE_STATUSES.includes(existing.status) && !retryBlocked)
    );
    const setQueuedAt = requeue && existing.status !== "queued";
    return enrichRepo.enrichJobBumpQuery({
      nextPriority,
      via,
      prio,
      prevPriority: Number(existing.priority) || 0,
      requestSeqStep: running ? 0 : (bumpSeq ? 1 : 0),
      missingJson: JSON.stringify(missing.length ? missing : parseJson(existing.missing_fields, [])),
      requeue,
      keepBackoff: keepBackoff || running,
      setQueuedAt,
      stamp,
      postId,
    });
  }
  const insert = enrichRepo.enrichJobInsertQuery();
  return { sql: insert.sql, params: [postId, HP_SOURCE, JSON.stringify(missing), prio, via, stamp, stamp] };
}

// 入列資格：只有房價（houseprice）的物件會進補抓佇列（sync 與 async 共用）。
export function enrichEnqueueEligible(listing) {
  return Boolean(listing?.post_id && isHousepriceListing(listing));
}

export function enqueueListingEnrich(conn, listing, {
  via = "scheduler",
  priority,
  missing = [],
  now = Date.now(),
} = {}) {
  if (!enrichEnqueueEligible(listing)) return null;
  const postId = Number(listing.post_id);
  const prio = enqueuePriority(via, priority);
  const jobQuery = enrichRepo.enrichJobByPostIdQuery(postId);
  const existing = conn.prepare(jobQuery.sql).get(...jobQuery.params);
  const plan = enqueueEnrichPlan(existing, { postId, prio, via, missing, now });
  conn.prepare(plan.sql).run(...plan.params);
  return conn.prepare(jobQuery.sql).get(...jobQuery.params);
}

export function reclaimStaleEnrichJobs(conn, now = Date.now()) {
  const cut = new Date(now).toISOString();
  const q = enrichRepo.reclaimStaleEnrichJobsQuery(cut);
  const info = conn.prepare(q.sql).run(...q.params);
  return Number(info.changes) || 0;
}

function claimOne(conn, { minPriority = 0, maxPriority = 1000, order = "priority" } = {}, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  const lease = new Date(now + LEASE_MS).toISOString();
  const candidates = enrichRepo.claimCandidatesQuery({ minPriority, maxPriority, stamp, order });
  const row = conn.prepare(candidates.sql).get(...candidates.params);
  if (!row) return null;
  const leaseQuery = enrichRepo.leaseEnrichJobQuery({ stamp, leaseUntil: lease, id: row.id });
  const info = conn.prepare(leaseQuery.sql).run(...leaseQuery.params);
  if (!info.changes) return null;
  const byId = enrichRepo.enrichJobByIdQuery(row.id);
  return conn.prepare(byId.sql).get(...byId.params);
}

// 名額分配（sync 與 async 兩條路徑共用；名額與排序必須一樣，parity 才對得起來）。
// slots < 0 代表「剩下的名額」，由呼叫端用 cap - 已搶到筆數 代入。
export function claimTakePlan(cap) {
  return [
    { opts: { minPriority: CLICK_PRIORITY, order: "priority" }, slots: Math.max(1, Math.ceil(cap / 2)) },
    { opts: { maxPriority: CLICK_PRIORITY - 1, order: "oldest" }, slots: Math.max(1, Math.floor(cap / 4)) },
    { opts: { maxPriority: WATCH_PRIORITY, order: "fair" }, slots: -1 },
  ];
}

export function claimEnrichJobs(conn, { limit = 6 } = {}, now = Date.now()) {
  reclaimStaleEnrichJobs(conn, now);
  const cap = Math.max(1, Math.min(Number(limit) || 6, 12));
  const claimed = [];
  const seen = new Set();
  const take = (opts, n) => {
    for (let i = 0; i < n; i += 1) {
      const row = claimOne(conn, opts, now);
      if (!row || seen.has(row.id)) break;
      seen.add(row.id);
      claimed.push(row);
    }
  };
  for (const step of claimTakePlan(cap)) {
    take(step.opts, step.slots < 0 ? cap - claimed.length : step.slots);
  }
  return claimed;
}

function backoffMs(errorClass, attempt) {
  if (errorClass === "source_limited") return SOURCE_LIMITED_BACKOFF_MS;
  if (errorClass === "parse_failed") return PARSE_FAIL_BACKOFF_MS;
  const idx = Math.min(Math.max(attempt - 1, 0), TRANSIENT_BACKOFF_MS.length - 1);
  return TRANSIENT_BACKOFF_MS[idx];
}

// finishJob() 的判斷部分（sync 與 async 共用）。leaked 狀態一律以「最新列的 run_seq／request_seq」
// 決定：run_seq 被別人推進 → stale；request_seq 被推進 → superseded（退回 queued）。
export function finishEnrichPlan(job, {
  status,
  error = "",
  errorClass = "",
  missing = [],
  timings = {},
  retryAfterMs = 0,
} = {}, latest, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  const waitMs = Math.max(backoffMs(errorClass || "transient", Number(job.attempt_count) || 1), Number(retryAfterMs) || 0);
  const retry = status === "succeeded" ? null : new Date(now + waitMs).toISOString();
  if (latest && Number(latest.run_seq) !== Number(job.run_seq)) {
    return { stale: true };
  }
  const superseded = latest && Number(latest.request_seq) > Number(job.request_seq ?? job.run_seq);
  const finalStatus = superseded ? "queued" : status;
  const retryAt = finalStatus === "succeeded" || finalStatus === "queued"
    ? null
    : retry;
  const query = enrichRepo.finishEnrichJobQuery({
    finalStatus,
    error: superseded ? "superseded" : error,
    errorClass: superseded ? "" : errorClass,
    missingJson: JSON.stringify(missing),
    stamp,
    retryAt,
    timingsJson: JSON.stringify(timings),
    jobId: job.id,
    runSeq: job.run_seq,
  });
  return { stale: false, superseded: Boolean(superseded), status: finalStatus, retryAt, sql: query.sql, params: query.params };
}

function finishJob(conn, job, patch = {}, now = Date.now()) {
  const latestQuery = enrichRepo.enrichJobRunSeqQuery(job.id);
  const latest = conn.prepare(latestQuery.sql).get(...latestQuery.params);
  const plan = finishEnrichPlan(job, patch, latest, now);
  if (plan.stale) return { stale: true };
  conn.prepare(plan.sql).run(...plan.params);
  return { stale: false, superseded: plan.superseded, status: plan.status };
}

// recordEnrichMetric() 的值組裝（sync 與 async 共用）。
export function enrichMetricPlan(job, timings = {}, now = Date.now()) {
  const query = enrichRepo.enrichMetricInsertQuery();
  return {
    sql: query.sql,
    params: [
      job.post_id,
      job.id,
      metricNumber(timings.queued_ms),
      metricNumber(timings.start_ms),
      metricNumber(timings.fetch_ms),
      metricNumber(timings.parse_ms),
      metricNumber(timings.locate_ms),
      metricNumber(timings.route_ms),
      metricNumber(timings.ready_ms),
      metricNumber(timings.first_ready_ms),
      metricNumber(timings.attempt_wait_ms ?? timings.queued_ms),
      timings.outcome || "",
      new Date(now).toISOString(),
    ],
  };
}

export function recordEnrichMetric(conn, job, timings = {}, now = Date.now()) {
  const plan = enrichMetricPlan(job, timings, now);
  conn.prepare(plan.sql).run(...plan.params);
}

function percentile(list, p) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function stageSummary(rows, key) {
  const vals = rows.map((row) => metricNumber(row[key])).filter((n) => n != null);
  return { n: vals.length, p50: percentile(vals, 50), p95: percentile(vals, 95) };
}

export function summarizeEnrichMetrics(conn) {
  const rows = conn.prepare(`
    SELECT queued_ms, start_ms, fetch_ms, parse_ms, locate_ms, route_ms, ready_ms,
           first_ready_ms, attempt_wait_ms, outcome
      FROM listing_enrich_metrics
     ORDER BY id DESC
     LIMIT 500
  `).all();
  const stages = ["queued_ms", "start_ms", "fetch_ms", "parse_ms", "locate_ms", "route_ms", "ready_ms", "first_ready_ms", "attempt_wait_ms"];
  const out = { samples: rows.length, stages: {}, byOutcome: {} };
  for (const key of stages) {
    out.stages[key] = stageSummary(rows, key);
  }
  for (const outcome of ["succeeded", "failed", "waiting"]) {
    const subset = rows.filter((row) => String(row.outcome || "") === outcome);
    out.byOutcome[outcome] = { samples: subset.length, stages: {} };
    for (const key of stages) {
      out.byOutcome[outcome].stages[key] = stageSummary(subset, key);
    }
  }
  return out;
}

export function listingPrepAdminStats(conn) {
  const pending = conn.prepare("SELECT COUNT(*) AS n FROM listing_prep WHERE display_ready = 0 AND source = 'houseprice'").get()?.n || 0;
  const ready = conn.prepare("SELECT COUNT(*) AS n FROM listing_prep WHERE display_ready = 1 AND source = 'houseprice'").get()?.n || 0;
  const jobs = conn.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('queued', 'failed', 'source_limited', 'parse_failed') THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      MIN(CASE WHEN status IN ('queued', 'failed', 'running', 'source_limited', 'parse_failed') THEN created_at END) AS oldest,
      MAX(last_success_at) AS last_success
    FROM listing_enrich_jobs
  `).get() || {};
  const errors = conn.prepare(`
    SELECT last_error_class AS reason, COUNT(*) AS n
      FROM listing_enrich_jobs
     WHERE last_error_class != ''
     GROUP BY last_error_class
     ORDER BY n DESC
     LIMIT 8
  `).all();
  return {
    pendingPrep: Number(pending) || 0,
    readyPrep: Number(ready) || 0,
    waitingJobs: Number(jobs.waiting) || 0,
    runningJobs: Number(jobs.running) || 0,
    oldestWaitAt: jobs.oldest || "",
    lastSuccessAt: jobs.last_success || "",
    errors,
    metrics: summarizeEnrichMetrics(conn),
  };
}

export function seedHousepriceEnrichJobs(conn, { limit = 80, isEnabled = () => true } = {}) {
  if (!isEnabled("houseprice")) return 0;
  const rows = conn.prepare(`
    SELECT l.post_id, l.source, l.source_id, l.url, l.title, l.price_num, l.address, l.floor_name, l.lat, l.lng, l.tags
      FROM listings l
      LEFT JOIN listing_prep p ON p.post_id = l.post_id
     WHERE l.source = 'houseprice'
       AND IFNULL(l.offline, 0) = 0
       AND (p.post_id IS NULL OR p.display_ready = 0)
     ORDER BY IFNULL(p.checked_at, l.first_seen_at) ASC, l.post_id ASC
     LIMIT ?
  `).all(Math.max(1, Number(limit) || 80));
  let n = 0;
  for (const row of rows) {
    enqueueListingEnrich(conn, row, { via: "scheduler", missing: evaluateHpPrep(row, { fetched: false }).missing });
    n += 1;
  }
  return n;
}

export function listingWriteIsFresh(job, listing) {
  if (!listing) return false;
  const baseSeq = Number(job?.listing_seq ?? 0);
  const nowSeq = Number(listing.content_seq ?? 0);
  return !(Number.isFinite(baseSeq) && Number.isFinite(nowSeq) && nowSeq > baseSeq);
}

function syncJobListingSeq(job, listing) {
  if (job && listing && listing.content_seq != null) {
    job.listing_seq = Number(listing.content_seq || 0);
  }
}

// The enrich worker reads and writes the row it is patching. With DB_DRIVER=postgres those have to
// come from/go to PostgreSQL (watcher's listingEnrichHelpers() exposes the ...Async variants backed
// by crawlerReads.js / crawlerWrites.js), so they are awaited here. A helper bundle that only has
// the synchronous functions keeps working unchanged (SQLite-only callers, tests).
function runHelper(helpers, name, ...args) {
  const asyncName = `${name}Async`;
  if (typeof helpers?.[asyncName] === "function") return helpers[asyncName](...args);
  return helpers?.[name]?.(...args);
}

async function loadListingForRun(helpers, postId) {
  return runHelper(helpers, "loadListing", postId);
}

async function refreshFreshListing(conn, helpers, job) {
  if (job && !(await queueOwnsRun(enrichQueueOf(helpers), conn, job))) return null;
  const listing = await loadListingForRun(helpers, job.post_id);
  if (!listingWriteIsFresh(job, listing)) return null;
  return listing;
}

export async function applyHpListingPatch(conn, helpers, current, next, { locationChanged = false, job = null } = {}) {
  if (job && !(await queueOwnsRun(enrichQueueOf(helpers), conn, job))) {
    return { applied: false, stale: true };
  }
  const latest = (await loadListingForRun(helpers, current.post_id)) || current;
  if (job && !listingWriteIsFresh(job, latest)) {
    return { applied: false, stale: true };
  }
  // The patch write goes through the driver-aware helper when the bundle has one, so a PostgreSQL
  // deployment stores the 5168 fields in the store the site reads.
  await runHelper(helpers, "persistHpListingFields", current.post_id, next, {
    locationChanged,
    previous: current,
    listing: latest,
  });
  syncJobListingSeq(job, (await loadListingForRun(helpers, current.post_id)) || next);
  return { applied: true, stale: false };
}
export async function processOneEnrichJob(conn, helpers, job, {
  fetchDetail = fetchHpDetailInspected,
} = {}) {
  const t0 = Date.now();
  // 2.3b 第二段：寫入走 driver-aware 分派。helpers 有 enrichQueue 時（PostgreSQL 佈署）
  // 走 listingEnrichQueueAsync.js 的非同步版本；沒有時就是本檔原本的同步函式，
  // SQLite 模式的行為完全不變。下面三個區域變數刻意同名，讓呼叫端不必判斷 driver。
  const enrichQueue = enrichQueueOf(helpers);
  const finishJob = (c, j, patch) => queueFinish(enrichQueue, c, j, patch);
  const getListingPrep = (c, postId) => queueGetPrep(enrichQueue, c, postId);
  const recordEnrichMetric = (c, j, timings) => queueMetric(enrichQueue, c, j, timings);
  const listing = await loadListingForRun(helpers, job.post_id);
  if (!listing) {
    await finishJob(conn, job, { status: "failed", error: "listing_missing", errorClass: "parse_failed" });
    return { skipped: true };
  }
  job.listing_seq = Number(listing.content_seq || 0);
  if (helpers.isSourceEnabled && !helpers.isSourceEnabled("houseprice")) {
    await finishJob(conn, job, { status: "failed", error: "source_disabled", errorClass: "source_limited" });
    return { skipped: true };
  }
  const attemptWaitMs = Math.max(0, t0 - (Date.parse(job.last_queued_at || job.started_at || job.created_at || "") || t0));
  const queuedMs = attemptWaitMs;
  const startMs = Math.max(0, t0 - (Date.parse(job.started_at || job.last_attempt_at || "") || t0));
  const fetchStarted = Date.now();
  let inspected;
  try {
    inspected = await fetchDetail(listing.source_id || listing.url);
  } catch (error) {
    const message = String(error?.message || error || "fetch_failed");
    await finishJob(conn, job, { status: "failed", error: message.slice(0, 240), errorClass: "transient" });
    return { outcome: PROBE_INCONCLUSIVE, errorClass: "transient" };
  }
  const fetchMs = metricNumber(inspected.fetch_ms) ?? Math.max(0, Date.now() - fetchStarted);
  const parseMs = metricNumber(inspected.parse_ms);
  const staleWrite = async () => {
    await finishJob(conn, job, { status: "queued", error: "stale_write", errorClass: "" });
    return { stale: true };
  };
  if (!(await refreshFreshListing(conn, helpers, job))) {
    if (!jobStillOwnsRun(conn, job)) {
      await finishJob(conn, job, { status: "queued", error: "superseded", errorClass: "" });
      return { superseded: true, stale: true };
    }
    return staleWrite();
  }
  const timingBase = { queued_ms: queuedMs, start_ms: startMs, fetch_ms: fetchMs, parse_ms: parseMs, attempt_wait_ms: attemptWaitMs };
  if (inspected.outcome === PROBE_GONE) {
    if (!(await refreshFreshListing(conn, helpers, job))) return staleWrite();
    await runHelper(helpers, "markGone", listing.post_id);
    syncJobListingSeq(job, await loadListingForRun(helpers, job.post_id));
    if (!(await refreshFreshListing(conn, helpers, job))) return staleWrite();
    await finishJob(conn, job, { status: "succeeded", timings: { ...timingBase, outcome: "succeeded" } });
    const goneRow = (await loadListingForRun(helpers, job.post_id)) || { ...listing, offline: 1 };
    if (!(await refreshFreshListing(conn, helpers, job))) return staleWrite();
    helpers.onListingUpdated?.(goneRow, { outcome: PROBE_GONE, displayReady: false });
    return { outcome: PROBE_GONE };
  }
  if (inspected.outcome === PROBE_INCONCLUSIVE) {
    if (!(await refreshFreshListing(conn, helpers, job))) return staleWrite();
    const existingPrep = await getListingPrep(conn, listing.post_id);
    if (!existingPrep || Number(existingPrep.display_ready) !== 1) {
      const evalPending = evaluateHpPrep(listing, { fetched: false });
      await prepWrite(helpers, conn, listing.post_id, listing, evalPending);
      await finishJob(conn, job, {
        status: "failed",
        error: inspected.reason || "inconclusive",
        errorClass: inspected.errorClass || "transient",
        missing: evalPending.missing,
        timings: { ...timingBase, outcome: "failed" },
        retryAfterMs: inspected.retryAfterMs,
      });
    } else {
      await queuePrepChecked(enrichQueue, conn, { postId: listing.post_id, reason: inspected.reason || "inconclusive" });
      await finishJob(conn, job, {
        status: "failed",
        error: inspected.reason || "inconclusive",
        errorClass: inspected.errorClass || "transient",
        missing: parseJson(existingPrep.missing_fields, []),
        timings: { ...timingBase, outcome: "failed" },
        retryAfterMs: inspected.retryAfterMs,
      });
    }
    await recordEnrichMetric(conn, job, { ...timingBase, outcome: "failed" });
    return { outcome: PROBE_INCONCLUSIVE };
  }
  if (!(await refreshFreshListing(conn, helpers, job))) return staleWrite();
  await runHelper(helpers, "markAlive", listing.post_id);
  syncJobListingSeq(job, await loadListingForRun(helpers, job.post_id));
  const locateStarted = Date.now();
  const enriched = enrichHpListingFromDetail(listing, inspected.detail, { allowFieldFill: true, replaceBetterGeo: true });
  if (inspected.facilityAbsent === true) {
    const keptTags = (() => {
      try {
        return JSON.parse(enriched.tags || "[]").filter((tag) => {
          const label = String(tag || "").trim();
          return label && !/冷氣|冰箱|洗衣機|烘衣|電視|網路|家具|家俱|陽台|瓦斯|床|衣櫃|沙發|無設備/.test(label);
        });
      } catch {
        return [];
      }
    })();
    enriched.tags = JSON.stringify(keptTags);
    enriched.has_natural_gas = 0;
    enriched.has_balcony = 0;
    enriched.furnish_items = [];
    enriched.facility_replace = true;
  } else if (
    inspected.facilityPartial !== true
    && (inspected.facilityEvidence?.replace === true || inspected.facilityBlock === true)
  ) {
    if (inspected.facilityEvidence?.replace === true) {
      enriched.facility_replace = true;
      if (inspected.facilityEvidence.tags != null) enriched.tags = inspected.facilityEvidence.tags;
      if (inspected.facilityEvidence.has_natural_gas != null) enriched.has_natural_gas = inspected.facilityEvidence.has_natural_gas;
      if (inspected.facilityEvidence.has_balcony != null) enriched.has_balcony = inspected.facilityEvidence.has_balcony;
      if (inspected.facilityEvidence.furnish_items != null) enriched.furnish_items = inspected.facilityEvidence.furnish_items;
    } else {
      enriched.facility_replace = true;
    }
  }
  const merged = mergeHpListingFields(listing, enriched, { allowCorrection: true });
  const patched = await applyHpListingPatch(conn, helpers, listing, merged.listing, {
    locationChanged: merged.locationChanged,
    job,
  });
  const locateMs = Date.now() - locateStarted;
  if (patched.stale) {
    await finishJob(conn, job, { status: "queued", error: "stale_write", errorClass: "" });
    return { stale: true };
  }
  if (!jobStillOwnsRun(conn, job)) {
    await finishJob(conn, job, { status: "queued", error: "stale_write", errorClass: "" });
    return { stale: true };
  }
  if (merged.locationChanged) await runHelper(helpers, "invalidateLocation", listing, merged.listing);
  const stored = (await loadListingForRun(helpers, job.post_id)) || merged.listing;
  if (!(await refreshFreshListing(conn, helpers, job))) return staleWrite();
  const existingPrep = await getListingPrep(conn, listing.post_id);
  const evalResult = evaluateHpPrep(stored, {
    fetched: true,
    parseFailed: false,
    detailRecognized: true,
    alreadyReady: Number(existingPrep?.display_ready) === 1,
    facilityBlock: inspected.facilityBlock === true,
    facilityAbsent: inspected.facilityAbsent === true,
    facilityPartial: inspected.facilityPartial === true,
    buildingOnly: inspected.buildingOnly === true,
  });
  const readyInfo = await prepWrite(helpers, conn, listing.post_id, stored, evalResult);
  if (readyInfo.becomingReady) await helpers.onFirstReady?.(stored, readyInfo);
  const firstQueuedAt = Date.parse(job.created_at || "") || t0;
  const firstReadyMs = readyInfo.becomingReady ? Math.max(0, Date.now() - firstQueuedAt) : null;
  const timings = {
    ...timingBase,
    locate_ms: locateMs,
    route_ms: null,
    ready_ms: firstReadyMs,
    first_ready_ms: firstReadyMs,
    outcome: evalResult.displayReady ? "succeeded" : "failed",
  };
  await recordEnrichMetric(conn, job, timings);
  const jobStatus = evalResult.displayReady && evalResult.status === PREP_READY
    ? "succeeded"
    : evalResult.status === PREP_PARSE_FAILED
      ? "parse_failed"
      : evalResult.status === PREP_SOURCE_LIMITED
        ? "source_limited"
        : "failed";
  await finishJob(conn, job, {
    status: jobStatus === "failed" && evalResult.missing.length ? "failed" : jobStatus,
    error: evalResult.withholdReason || "",
    errorClass: jobStatus === "succeeded" ? "" : (jobStatus === "parse_failed" ? "parse_failed" : (jobStatus === "source_limited" ? "source_limited" : "transient")),
    missing: evalResult.missing,
    timings,
  });
  if (!(await refreshFreshListing(conn, helpers, job))) return staleWrite();
  helpers.onListingUpdated?.(stored, {
    outcome: PROBE_ALIVE,
    displayReady: evalResult.displayReady,
    becomingReady: readyInfo.becomingReady,
  });
  return { outcome: PROBE_ALIVE, evalResult, merged };
}

export async function processListingEnrichBatch(conn, helpers, { limit = 6 } = {}) {
  const queue = enrichQueueOf(helpers);
  await queueSeed(queue, conn, { limit: 40, isEnabled: helpers.isSourceEnabled || (() => true) });
  const jobs = await queueClaim(queue, conn, { limit });
  const results = [];
  for (const job of jobs) {
    try {
      results.push(await processOneEnrichJob(conn, helpers, job));
    } catch (error) {
      await queueFinish(queue, conn, job, { status: "failed", error: String(error.message || error).slice(0, 240), errorClass: "transient" });
      results.push({ error: String(error.message || error) });
    }
  }
  let updated = 0;
  let located = 0;
  for (const row of results) {
    if (row?.merged || row?.evalResult) updated += 1;
    if (row?.evalResult?.address?.usable) located += 1;
  }
  return { attempted: jobs.length, processed: jobs.length, updated, located, results };
}

// 供 listingEnrichQueueAsync.js 的 SQLite 分支直接沿用（行為必須與 sync 完全一致）。
export { finishJob as finishEnrichJobSync, prepCheckedUpdate as prepCheckedUpdateSync };
// 租約長度也給 async 分支用（同一個值，不要各寫一份）。
export const CLAIM_LEASE_MS = LEASE_MS;

export function statusCheckIsFresh(listing, now = Date.now()) {
  const lastStatus = Date.parse(listing?.last_checked_at || "") || 0;
  return Boolean(lastStatus && now - lastStatus < STATUS_COOLDOWN_MS);
}

export function enrichCooldownActive(job) {
  const last = Date.parse(job?.last_attempt_at || "") || 0;
  return last && Date.now() - last < ENRICH_COOLDOWN_MS && job?.status === "running";
}

// requestClickRefresh() 的判斷部分（sync 與 async 共用）：回傳要不要入列，以及入列的 plan。
export function requestClickPlan(prep, existing, listing, via = "click", now = Date.now()) {
  const missing = parseJson(prep?.missing_fields, []) || evaluateHpPrep(listing, { fetched: Boolean(prep) }).missing;
  const sourcePaused = sourceBackoffActive(existing, now);
  const statusCooldown = (Date.parse(listing.last_checked_at || "") || 0) > now - STATUS_COOLDOWN_MS;
  const recentlySucceeded = existing?.status === "succeeded"
    && (Date.parse(existing.last_success_at || "") || 0) > now - STATUS_COOLDOWN_MS
    && !missing.length;
  const enqueue = recentlySucceeded && !sourcePaused
    ? null
    : enqueueEnrichPlan(existing, { postId: Number(listing.post_id) || 0, prio: CLICK_PRIORITY, via, missing, now });
  return { missing, sourcePaused, statusCooldown, recentlySucceeded, enqueue };
}

// 回傳值的組裝（sync 與 async 共用）。
export function clickRefreshResult(decision, job) {
  const runnableNow = !decision.recentlySucceeded && !decision.sourcePaused && job
    && (job.status === "queued" || job.status === "failed")
    && (!job.next_retry_at || Date.parse(job.next_retry_at) <= Date.now());
  return {
    queued: Boolean(runnableNow),
    merged: true,
    jobId: job?.id || 0,
    requestSeq: job?.request_seq || 0,
    statusCooldown: decision.statusCooldown,
    sourcePaused: decision.sourcePaused,
    missingFields: decision.missing,
    wakeWorker: Boolean(runnableNow),
  };
}

export function requestClickRefresh(conn, listing, via = "click", now = Date.now()) {
  if (!enrichEnqueueEligible(listing)) return { queued: false };
  const jobQuery = enrichRepo.enrichJobByPostIdQuery(listing.post_id);
  const prep = getListingPrep(conn, listing.post_id);
  const existing = conn.prepare(jobQuery.sql).get(...jobQuery.params);
  const decision = requestClickPlan(prep, existing, listing, via, now);
  let job = existing;
  if (decision.enqueue) {
    conn.prepare(decision.enqueue.sql).run(...decision.enqueue.params);
    job = conn.prepare(jobQuery.sql).get(...jobQuery.params);
  }
  return clickRefreshResult(decision, job);
}

let enrichWorker = null;
let enrichWake = false;

export function wakeListingEnrichWorker(runBatch) {
  enrichWake = true;
  if (enrichWorker) return enrichWorker;
  enrichWorker = Promise.resolve()
    .then(async () => {
      try {
        while (enrichWake) {
          enrichWake = false;
          await runBatch();
        }
      } finally {
        const again = enrichWake;
        enrichWorker = null;
        if (again) wakeListingEnrichWorker(runBatch);
      }
    });
  return enrichWorker;
}

export function resetListingEnrichWorkerForTests() {
  enrichWorker = null;
  enrichWake = false;
}

export {
  CLICK_PRIORITY,
  WATCH_PRIORITY,
  CLAIMABLE_STATUSES,
  FIELD_NOT_FETCHED,
  FIELD_NOT_PROVIDED,
  FIELD_PARSE_FAILED,
  PREP_PENDING,
  PREP_READY,
  hasListingIdentity,
  classifyAddress,
};
