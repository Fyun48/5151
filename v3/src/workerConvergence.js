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
