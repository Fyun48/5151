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
      created_at TEXT NOT NULL
    );
  `);
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(raw, fallback) {
  try {
    return JSON.parse(raw || "");
  } catch {
    return fallback;
  }
}

export function upsertListingPrep(conn, postId, listing, evalResult) {
  const stamp = nowIso();
  const existing = conn.prepare("SELECT ready_at, first_ready_notified FROM listing_prep WHERE post_id = ?").get(postId);
  const becomingReady = evalResult.displayReady && !existing?.ready_at;
  conn.prepare(`
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
  `).run(
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
  );
  return { becomingReady, firstReadyAt: becomingReady ? stamp : existing?.ready_at || "" };
}

export function getListingPrep(conn, postId) {
  return conn.prepare("SELECT * FROM listing_prep WHERE post_id = ?").get(postId) || null;
}

export function enqueueListingEnrich(conn, listing, {
  via = "scheduler",
  priority,
  missing = [],
} = {}) {
  if (!listing?.post_id || !isHousepriceListing(listing)) return null;
  const postId = Number(listing.post_id);
  const stamp = nowIso();
  const prio = Number.isFinite(Number(priority))
    ? Number(priority)
    : via === "click" || via === "notify" || via === "go"
      ? CLICK_PRIORITY
      : via === "watch"
        ? WATCH_PRIORITY
        : NORMAL_PRIORITY;
  const existing = conn.prepare("SELECT * FROM listing_enrich_jobs WHERE post_id = ?").get(postId);
  if (existing) {
    const nextPriority = Math.max(Number(existing.priority) || 0, prio);
    const bumpSeq = via === "click" || via === "notify" || via === "go";
    conn.prepare(`
      UPDATE listing_enrich_jobs
         SET priority = ?,
             requested_via = CASE WHEN ? >= ? THEN ? ELSE requested_via END,
             request_seq = request_seq + ?,
             missing_fields = ?,
             status = CASE
               WHEN status IN ('succeeded', 'source_limited', 'parse_failed') AND ? THEN 'queued'
               WHEN status IN ('failed') THEN 'queued'
               ELSE status
             END,
             next_retry_at = CASE
               WHEN status IN ('succeeded', 'source_limited', 'parse_failed', 'failed') AND ? THEN NULL
               ELSE next_retry_at
             END
       WHERE post_id = ?
    `).run(
      nextPriority,
      prio,
      Number(existing.priority) || 0,
      via,
      bumpSeq ? 1 : 0,
      JSON.stringify(missing.length ? missing : parseJson(existing.missing_fields, [])),
      bumpSeq ? 1 : 0,
      bumpSeq ? 1 : 0,
      postId,
    );
    return conn.prepare("SELECT * FROM listing_enrich_jobs WHERE post_id = ?").get(postId);
  }
  conn.prepare(`
    INSERT INTO listing_enrich_jobs(
      post_id, source, job_kind, status, missing_fields, priority, requested_via, created_at
    ) VALUES (?, ?, 'enrich', 'queued', ?, ?, ?, ?)
  `).run(postId, HP_SOURCE, JSON.stringify(missing), prio, via, stamp);
  return conn.prepare("SELECT * FROM listing_enrich_jobs WHERE post_id = ?").get(postId);
}

export function reclaimStaleEnrichJobs(conn, now = Date.now()) {
  const cut = new Date(now).toISOString();
  const info = conn.prepare(`
    UPDATE listing_enrich_jobs
       SET status = 'queued', lease_until = NULL
     WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?
  `).run(cut);
  return Number(info.changes) || 0;
}

function claimOne(conn, { minPriority = 0, maxPriority = 1000, order = "priority" } = {}) {
  const stamp = nowIso();
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  const orderSql = order === "oldest"
    ? "created_at ASC, post_id ASC"
    : order === "fair"
      ? "IFNULL(last_attempt_at, created_at) ASC, post_id ASC"
      : "priority DESC, IFNULL(next_retry_at, created_at) ASC, post_id ASC";
  const row = conn.prepare(`
    SELECT * FROM listing_enrich_jobs
     WHERE status IN ('queued', 'failed')
       AND priority >= ? AND priority <= ?
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY ${orderSql}
     LIMIT 1
  `).get(minPriority, maxPriority, stamp);
  if (!row) return null;
  const info = conn.prepare(`
    UPDATE listing_enrich_jobs
       SET status = 'running',
           started_at = ?,
           last_attempt_at = ?,
           attempt_count = attempt_count + 1,
           run_seq = request_seq,
           lease_until = ?
     WHERE id = ? AND status IN ('queued', 'failed')
  `).run(stamp, stamp, lease, row.id);
  if (!info.changes) return null;
  return conn.prepare("SELECT * FROM listing_enrich_jobs WHERE id = ?").get(row.id);
}

export function claimEnrichJobs(conn, { limit = 6 } = {}) {
  reclaimStaleEnrichJobs(conn);
  const cap = Math.max(1, Math.min(Number(limit) || 6, 12));
  const clickSlots = Math.max(1, Math.ceil(cap / 2));
  const agedSlots = Math.max(1, Math.floor(cap / 4));
  const claimed = [];
  const seen = new Set();
  const take = (opts, n) => {
    for (let i = 0; i < n; i += 1) {
      const row = claimOne(conn, opts);
      if (!row || seen.has(row.id)) break;
      seen.add(row.id);
      claimed.push(row);
    }
  };
  take({ minPriority: CLICK_PRIORITY, order: "priority" }, clickSlots);
  take({ maxPriority: CLICK_PRIORITY - 1, order: "oldest" }, agedSlots);
  take({ maxPriority: WATCH_PRIORITY, order: "fair" }, cap - claimed.length);
  return claimed;
}

function backoffMs(errorClass, attempt) {
  if (errorClass === "source_limited") return SOURCE_LIMITED_BACKOFF_MS;
  if (errorClass === "parse_failed") return PARSE_FAIL_BACKOFF_MS;
  const idx = Math.min(Math.max(attempt - 1, 0), TRANSIENT_BACKOFF_MS.length - 1);
  return TRANSIENT_BACKOFF_MS[idx];
}

function finishJob(conn, job, {
  status,
  error = "",
  errorClass = "",
  missing = [],
  timings = {},
}) {
  const stamp = nowIso();
  const retry = status === "succeeded" ? null : new Date(Date.now() + backoffMs(errorClass || "transient", Number(job.attempt_count) || 1)).toISOString();
  const latest = conn.prepare("SELECT request_seq, run_seq FROM listing_enrich_jobs WHERE id = ?").get(job.id);
  const superseded = latest && Number(latest.request_seq) > Number(job.run_seq);
  const finalStatus = superseded ? "queued" : status;
  const retryAt = finalStatus === "succeeded" || finalStatus === "queued"
    ? null
    : retry;
  conn.prepare(`
    UPDATE listing_enrich_jobs
       SET status = ?,
           last_error = ?,
           last_error_class = ?,
           missing_fields = ?,
           last_success_at = CASE WHEN ? = 'succeeded' THEN ? ELSE last_success_at END,
           next_retry_at = ?,
           lease_until = NULL,
           timings = ?
     WHERE id = ? AND run_seq = ?
  `).run(
    finalStatus,
    superseded ? "superseded" : error,
    superseded ? "" : errorClass,
    JSON.stringify(missing),
    finalStatus,
    stamp,
    retryAt,
    JSON.stringify(timings),
    job.id,
    job.run_seq,
  );
}

export function recordEnrichMetric(conn, job, timings = {}) {
  conn.prepare(`
    INSERT INTO listing_enrich_metrics(
      post_id, job_id, queued_ms, start_ms, fetch_ms, parse_ms, locate_ms, route_ms, ready_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.post_id,
    job.id,
    timings.queued_ms ?? null,
    timings.start_ms ?? null,
    timings.fetch_ms ?? null,
    timings.parse_ms ?? null,
    timings.locate_ms ?? null,
    timings.route_ms ?? null,
    timings.ready_ms ?? null,
    nowIso(),
  );
}

export function summarizeEnrichMetrics(conn) {
  const rows = conn.prepare(`
    SELECT queued_ms, start_ms, fetch_ms, parse_ms, locate_ms, route_ms, ready_ms
      FROM listing_enrich_metrics
     ORDER BY id DESC
     LIMIT 500
  `).all();
  const stages = ["queued_ms", "start_ms", "fetch_ms", "parse_ms", "locate_ms", "route_ms", "ready_ms"];
  const pct = (list, p) => {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  };
  const out = { samples: rows.length, stages: {} };
  for (const key of stages) {
    const vals = rows.map((row) => Number(row[key])).filter((n) => Number.isFinite(n));
    out.stages[key] = { n: vals.length, p50: pct(vals, 50), p95: pct(vals, 95) };
  }
  return out;
}

export function listingPrepAdminStats(conn) {
  const pending = conn.prepare("SELECT COUNT(*) AS n FROM listing_prep WHERE display_ready = 0 AND source = 'houseprice'").get()?.n || 0;
  const ready = conn.prepare("SELECT COUNT(*) AS n FROM listing_prep WHERE display_ready = 1 AND source = 'houseprice'").get()?.n || 0;
  const jobs = conn.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('queued', 'failed') THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      MIN(CASE WHEN status IN ('queued', 'failed', 'running') THEN created_at END) AS oldest,
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

export function applyHpListingPatch(conn, helpers, current, next, { locationChanged = false } = {}) {
  const stale = conn.prepare("SELECT request_seq, run_seq FROM listing_enrich_jobs WHERE post_id = ?").get(current.post_id);
  if (stale && Number(stale.run_seq) < Number(stale.request_seq)) {
    return { applied: false, stale: true };
  }
  helpers.persistHpListingFields(current.post_id, next, { locationChanged, previous: current });
  return { applied: true, stale: false };
}

export async function processOneEnrichJob(conn, helpers, job, {
  fetchDetail = fetchHpDetailInspected,
} = {}) {
  const t0 = Date.now();
  const listing = helpers.loadListing(job.post_id);
  if (!listing) {
    finishJob(conn, job, { status: "failed", error: "listing_missing", errorClass: "parse_failed" });
    return { skipped: true };
  }
  if (helpers.isSourceEnabled && !helpers.isSourceEnabled("houseprice")) {
    finishJob(conn, job, { status: "failed", error: "source_disabled", errorClass: "source_limited" });
    return { skipped: true };
  }
  const queuedMs = Math.max(0, t0 - (Date.parse(job.created_at || "") || t0));
  const startMs = Math.max(0, t0 - (Date.parse(job.started_at || job.last_attempt_at || "") || t0));
  const fetchStarted = Date.now();
  let inspected;
  try {
    inspected = await fetchDetail(listing.source_id || listing.url);
  } catch (error) {
    const message = String(error?.message || error || "fetch_failed");
    finishJob(conn, job, { status: "failed", error: message.slice(0, 240), errorClass: "transient" });
    return { outcome: PROBE_INCONCLUSIVE, errorClass: "transient" };
  }
  const fetchMs = Date.now() - fetchStarted;
  const parseMs = Number(inspected.parse_ms) || 0;
  const currentSeq = conn.prepare("SELECT request_seq, run_seq FROM listing_enrich_jobs WHERE id = ?").get(job.id);
  if (currentSeq && Number(currentSeq.request_seq) > Number(job.run_seq)) {
    finishJob(conn, job, { status: "queued", error: "superseded", errorClass: "" });
    return { superseded: true };
  }
  if (inspected.outcome === PROBE_GONE) {
    helpers.markGone(listing.post_id);
    finishJob(conn, job, { status: "succeeded", timings: { queued_ms: queuedMs, start_ms: startMs, fetch_ms: fetchMs, parse_ms: parseMs } });
    return { outcome: PROBE_GONE };
  }
  if (inspected.outcome === PROBE_INCONCLUSIVE) {
    const evalPending = evaluateHpPrep(listing, { fetched: false });
    upsertListingPrep(conn, listing.post_id, listing, evalPending);
    finishJob(conn, job, {
      status: "failed",
      error: inspected.reason || "inconclusive",
      errorClass: inspected.errorClass || "transient",
      missing: evalPending.missing,
      timings: { queued_ms: queuedMs, start_ms: startMs, fetch_ms: fetchMs, parse_ms: parseMs },
    });
    return { outcome: PROBE_INCONCLUSIVE };
  }
  helpers.markAlive(listing.post_id);
  const locateStarted = Date.now();
  const enriched = enrichHpListingFromDetail(listing, inspected.detail, { allowFieldFill: true, replaceBetterGeo: true });
  const merged = mergeHpListingFields(listing, enriched, { allowCorrection: true });
  const patched = applyHpListingPatch(conn, helpers, listing, merged.listing, { locationChanged: merged.locationChanged });
  const locateMs = Date.now() - locateStarted;
  if (patched.stale) {
    finishJob(conn, job, { status: "queued", error: "stale_write", errorClass: "" });
    return { stale: true };
  }
  if (merged.locationChanged) helpers.invalidateLocation(listing, merged.listing);
  const stored = helpers.loadListing(job.post_id) || merged.listing;
  const evalResult = evaluateHpPrep(stored, {
    fetched: true,
    parseFailed: false,
    detailRecognized: true,
    facilityBlock: inspected.facilityBlock === true,
    facilityAbsent: inspected.facilityAbsent === true,
    buildingOnly: inspected.buildingOnly === true,
  });
  const readyInfo = upsertListingPrep(conn, listing.post_id, stored, evalResult);
  if (readyInfo.becomingReady) helpers.onFirstReady?.(stored, readyInfo);
  const readyMs = Date.now() - t0;
  const timings = {
    queued_ms: queuedMs,
    start_ms: startMs,
    fetch_ms: fetchMs,
    parse_ms: parseMs,
    locate_ms: locateMs,
    route_ms: null,
    ready_ms: evalResult.displayReady ? readyMs : null,
  };
  recordEnrichMetric(conn, job, timings);
  const jobStatus = evalResult.displayReady
    ? "succeeded"
    : evalResult.status === PREP_PARSE_FAILED
      ? "parse_failed"
      : evalResult.status === PREP_SOURCE_LIMITED
        ? "source_limited"
        : "failed";
  finishJob(conn, job, {
    status: jobStatus === "failed" && evalResult.missing.length ? "failed" : jobStatus,
    error: evalResult.withholdReason || "",
    errorClass: jobStatus === "succeeded" ? "" : (jobStatus === "parse_failed" ? "parse_failed" : (jobStatus === "source_limited" ? "source_limited" : "transient")),
    missing: evalResult.missing,
    timings,
  });
  return { outcome: PROBE_ALIVE, evalResult, merged };
}

export async function processListingEnrichBatch(conn, helpers, { limit = 6 } = {}) {
  seedHousepriceEnrichJobs(conn, { limit: 40, isEnabled: helpers.isSourceEnabled || (() => true) });
  const jobs = claimEnrichJobs(conn, { limit });
  const results = [];
  for (const job of jobs) {
    try {
      results.push(await processOneEnrichJob(conn, helpers, job));
    } catch (error) {
      finishJob(conn, job, { status: "failed", error: String(error.message || error).slice(0, 240), errorClass: "transient" });
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

export function statusCheckIsFresh(listing, now = Date.now()) {
  const lastStatus = Date.parse(listing?.last_checked_at || "") || 0;
  return Boolean(lastStatus && now - lastStatus < STATUS_COOLDOWN_MS);
}

export function enrichCooldownActive(job) {
  const last = Date.parse(job?.last_attempt_at || "") || 0;
  return last && Date.now() - last < ENRICH_COOLDOWN_MS && job?.status === "running";
}

export function requestClickRefresh(conn, listing, via = "click") {
  if (!listing?.post_id || !isHousepriceListing(listing)) return { queued: false };
  const prep = getListingPrep(conn, listing.post_id);
  const missing = parseJson(prep?.missing_fields, []) || evaluateHpPrep(listing, { fetched: Boolean(prep) }).missing;
  const job = enqueueListingEnrich(conn, listing, { via, priority: CLICK_PRIORITY, missing });
  return {
    queued: true,
    jobId: job?.id || 0,
    merged: true,
    requestSeq: job?.request_seq || 0,
    statusCooldown: (Date.parse(listing.last_checked_at || "") || 0) > Date.now() - STATUS_COOLDOWN_MS,
  };
}

export {
  CLICK_PRIORITY,
  WATCH_PRIORITY,
  FIELD_NOT_FETCHED,
  FIELD_NOT_PROVIDED,
  FIELD_PARSE_FAILED,
  PREP_PENDING,
  PREP_READY,
  hasListingIdentity,
  classifyAddress,
};
