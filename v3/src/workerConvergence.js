// Worker convergence (Phase 4 收尾). Bridges an existing worker's per-item
// async handler onto the shared durable queue so geo/enrich/notify/CRM/OPS/wish
// all inherit lease / retry / backoff / dead-letter / idempotency from
// jobQueue.js instead of re-implementing them per worker table.
import { enqueueJob, JOB_PRIORITY } from "./jobQueue.js";
import { runWorkerBatchAsync } from "./jobWorker.js";

export const CRM_JOB_TYPE = "crm";

// Producer: enqueue one CRM delivery item into the durable queue (idempotent
// by deliveryId). This is the convergence of crmOutbox.enqueueCrmOutbox: the
// job_queue row (not the crm_outbox table) is the durable pending-work store.
export function enqueueCrmDeliveryJob(db, {
  deliveryId,
  payload = {},
  priority = JOB_PRIORITY.ENRICHMENT,
  idempotencyKey = null,
  maxAttempts,
  now = Date.now(),
} = {}) {
  return enqueueJob(db, {
    jobType: CRM_JOB_TYPE,
    payload,
    priority,
    idempotencyKey: idempotencyKey || (deliveryId ? `crm:${deliveryId}` : null),
    maxAttempts,
    now,
  });
}

// Consumer: deliver CRM jobs through the durable queue. `deliver` is the
// existing per-item async logic (sign + POST to OPS ingest, cf.
// crmDelivery.deliverOne); throw to retry with backoff, exhaust to dead-letter.
export async function runCrmDeliveryConvergedBatch(db, {
  workerId = "crm",
  limit = 20,
  deliver = null,
} = {}) {
  return runWorkerBatchAsync({
    db,
    workerId,
    jobTypes: [CRM_JOB_TYPE],
    limit,
    handler: (job) => (deliver ? deliver(job) : undefined),
  });
}

export const ENRICH_JOB_TYPE = "enrich";

// Enrich source-specific cooldowns (mirrors listingEnrichQueue's backoff ladder).
export const ENRICH_BACKOFF_MS = Object.freeze({
  transient: [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000],
  source_limited: 12 * 60 * 60_000,
  parse_failed: 24 * 60 * 60_000,
});

export function enrichPriorityFor(via = "") {
  if (via === "click" || via === "notify" || via === "go") return JOB_PRIORITY.CLICKED;
  if (via === "watch") return JOB_PRIORITY.WATCHED;
  return JOB_PRIORITY.ENRICHMENT;
}

// Producer: enqueue one enrich job (idempotent by postId). `via` maps onto the
// shared priority scale (click > watch > normal), matching the enrich worker's
// CLICK/WATCH/NORMAL slots.
export function enqueueEnrichJob(db, {
  postId,
  via = "",
  payload = {},
  priority = null,
  now = Date.now(),
} = {}) {
  return enqueueJob(db, {
    jobType: ENRICH_JOB_TYPE,
    payload: { postId: Number(postId), ...payload },
    priority: priority ?? enrichPriorityFor(via),
    idempotencyKey: `enrich:${Number(postId)}`,
    now,
  });
}

// Consumer: process enrich jobs through the durable queue. `processEnrich` is the
// per-listing async logic (load + fetch detail + evaluate + upsert prep); throw
// an enrichRetryError to use a source-specific cooldown instead of exponential
// backoff.
export async function runEnrichConvergedBatch(db, {
  workerId = "enrich",
  limit = 6,
  processEnrich = null,
} = {}) {
  return runWorkerBatchAsync({
    db,
    workerId,
    jobTypes: [ENRICH_JOB_TYPE],
    limit,
    handler: (job) => (processEnrich ? processEnrich(job) : undefined),
  });
}

// Build a retry error carrying a source-specific retryAfterMs so failJob honors
// the enrich cooldowns (source_limited=12h, parse_failed=24h, transient ladder).
export function enrichRetryError(errorClass = "transient", attempt = 1) {
  const err = new Error(errorClass);
  if (errorClass === "source_limited") err.retryAfterMs = ENRICH_BACKOFF_MS.source_limited;
  else if (errorClass === "parse_failed") err.retryAfterMs = ENRICH_BACKOFF_MS.parse_failed;
  else err.retryAfterMs = ENRICH_BACKOFF_MS.transient[Math.min(Math.max(attempt - 1, 0), ENRICH_BACKOFF_MS.transient.length - 1)];
  return err;
}

