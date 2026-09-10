import { signIngestRequest } from "./opsSignature.js";
import {
  claimCrmOutboxBatch,
  markCrmOutboxSent,
  markCrmOutboxFailure,
  crmOutboxStats,
} from "./crmOutbox.js";

export const OPS_CRM_STOP_KEY = "ops_crm_stop";
const INGEST_PATH = "/ops/api/ingest/crm";
const DEFAULT_TIMEOUT_MS = 8000;

export function isLocalCrmSyncStopped(db) {
  try {
    return String(db.prepare("SELECT value FROM settings WHERE key=?").get(OPS_CRM_STOP_KEY)?.value || "") === "1";
  } catch {
    return false;
  }
}

export function setLocalCrmSyncStopped(db, stopped) {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(OPS_CRM_STOP_KEY, stopped ? "1" : "0");
  return crmDeliveryControl(db);
}

export function crmDeliveryControl(db, env = process.env) {
  const url = env.OPS_INGEST_URL || "";
  const secret = env.OPS_INGEST_SECRET || "";
  const envAllowed = env.OPS_CRM_DELIVERY === "1";
  const configured = Boolean(url && secret);
  const localStopped = isLocalCrmSyncStopped(db);
  return {
    env_allowed: envAllowed,
    configured,
    local_stopped: localStopped,
    product_id: env.OPS_PRODUCT_ID || "v3",
    effective: Boolean(envAllowed && configured && !localStopped),
    outbox: crmOutboxStats(db),
    note: "回饋複製授權不自動包含 CRM 同步。",
  };
}

async function withTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function deliverOne(db, row, { url, secret, timeoutMs, fetchImpl, now }) {
  const raw = row.payload;
  let deliveryId = row.delivery_id;
  try {
    deliveryId = JSON.parse(raw).delivery_id || deliveryId;
  } catch { /* keep */ }
  try {
    const { headers } = signIngestRequest({ method: "POST", path: INGEST_PATH, deliveryId, rawBody: raw, secret });
    const res = await withTimeout(fetchImpl, url, { method: "POST", headers, body: raw }, timeoutMs);
    if (res.status >= 200 && res.status < 300) {
      markCrmOutboxSent(db, row.id, { now: now() });
      return { id: row.id, result: "sent" };
    }
    const info = markCrmOutboxFailure(db, row, `HTTP ${res.status}`, { now: now() });
    return { id: row.id, result: info.status };
  } catch (err) {
    const cls = err?.name === "AbortError" ? "timeout" : (err?.name || "error");
    const info = markCrmOutboxFailure(db, row, cls, { now: now() });
    return { id: row.id, result: info.status };
  }
}

export async function deliverCrmOutboxOnce(db, {
  url,
  secret,
  now = () => new Date(),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  batchSize = 20,
} = {}) {
  if (!url || !secret) return { claimed: 0, sent: 0, failed: 0, dead: 0, skipped: "not_configured" };
  if (isLocalCrmSyncStopped(db)) return { claimed: 0, sent: 0, failed: 0, dead: 0, skipped: "local_stopped" };
  const claimed = claimCrmOutboxBatch(db, { limit: batchSize, now: now() });
  const summary = { claimed: claimed.length, sent: 0, failed: 0, dead: 0 };
  for (const row of claimed) {
    const r = await deliverOne(db, row, { url, secret, timeoutMs, fetchImpl, now });
    if (r.result === "sent") summary.sent += 1;
    else if (r.result === "dead") summary.dead += 1;
    else summary.failed += 1;
  }
  return summary;
}

export function startCrmDeliveryLoop(db, env = process.env, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  if (env.OPS_CRM_DELIVERY !== "1" || !env.OPS_INGEST_URL || !env.OPS_INGEST_SECRET) return () => {};
  let running = false;
  const tick = async () => {
    if (running || isLocalCrmSyncStopped(db)) return;
    running = true;
    try {
      const summary = await deliverCrmOutboxOnce(db, {
        url: env.OPS_INGEST_URL,
        secret: env.OPS_INGEST_SECRET,
        fetchImpl,
      });
      if (summary.claimed) log("ops-crm-delivery", summary);
    } catch (err) {
      log("ops-crm-delivery-error", { error: err?.name || "error" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, Number(env.OPS_CRM_DELIVERY_INTERVAL_MS || 20000));
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
