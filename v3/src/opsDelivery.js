import { claimOutboxBatch, markOutboxSent, markOutboxFailure } from "./feedbackOutbox.js";
import { signIngestRequest } from "./opsSignature.js";

// 背景遞送 worker（Product 端）。不阻塞使用者請求路徑；由 server 以 setInterval 週期驅動。
// bounded concurrency + request timeout + 指數退避(jitter) + max_attempts + dead-letter。
// crash-safe：claim 會把項目標為 'sending'；若 worker 在 send 與 ack 之間崩潰，
// 'sending' 逾時後會被重新認領（at-least-once），Ops 以 delivery_id 冪等去重。

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_BATCH = 20;
const DEFAULT_CONCURRENCY = 4;
const INGEST_PATH = "/ops/api/ingest/feedback";
export const OPS_DELIVERY_STOP_KEY = "ops_feedback_stop";

export function isLocalDeliveryStopped(db) {
  if (!db) return false;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(OPS_DELIVERY_STOP_KEY);
    return String(row?.value || "") === "1";
  } catch {
    return false;
  }
}

export function setLocalDeliveryStopped(db, stopped) {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(OPS_DELIVERY_STOP_KEY, stopped ? "1" : "0");
  return isLocalDeliveryStopped(db);
}

export function deliveryControl(db, env = process.env) {
  const url = env.OPS_INGEST_URL || "";
  const secret = env.OPS_INGEST_SECRET || "";
  const envAllowed = env.OPS_FEEDBACK_DELIVERY === "1";
  const configured = Boolean(url && secret);
  const localStopped = isLocalDeliveryStopped(db);
  return {
    env_allowed: envAllowed,
    configured,
    local_stopped: localStopped,
    product_id: env.OPS_PRODUCT_ID || "v3",
    effective: Boolean(envAllowed && configured && !localStopped),
  };
}

// 從環境變數讀設定；未設定 URL/SECRET → 遞送停用（feature flag）。
// 本機 settings.ops_feedback_stop=1 可在不重啟、OPS 不在線時立刻停送。
export function deliveryConfigFromEnv(env = process.env) {
  const enabled = env.OPS_FEEDBACK_DELIVERY === "1";
  const url = env.OPS_INGEST_URL || "";
  const secret = env.OPS_INGEST_SECRET || "";
  return {
    enabled: Boolean(enabled && url && secret),
    url,
    secret,
    productId: env.OPS_PRODUCT_ID || "v3",
    intervalMs: Number(env.OPS_DELIVERY_INTERVAL_MS || 15000),
    timeoutMs: Number(env.OPS_DELIVERY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    batchSize: Number(env.OPS_DELIVERY_BATCH || DEFAULT_BATCH),
    concurrency: Number(env.OPS_DELIVERY_CONCURRENCY || DEFAULT_CONCURRENCY),
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

async function deliverOne(db, row, { url, secret, timeoutMs, fetchImpl, now = () => new Date(), random = Math.random }) {
  const raw = row.payload; // 送出的 body 必須與簽章時的 bytes 完全一致
  let deliveryId = row.delivery_id;
  try {
    const parsed = JSON.parse(raw);
    deliveryId = parsed.delivery_id || deliveryId;
  } catch {
    // payload 壞掉：直接視為失敗（會累積 attempts → dead）
  }
  try {
    const { headers } = signIngestRequest({ method: "POST", path: INGEST_PATH, deliveryId, rawBody: raw, secret });
    const res = await withTimeout(fetchImpl, url, { method: "POST", headers, body: raw }, timeoutMs);
    if (res.status >= 200 && res.status < 300) {
      markOutboxSent(db, row.id, { now: now() });
      return { id: row.id, result: "sent" };
    }
    const info = markOutboxFailure(db, row, `HTTP ${res.status}`, { now: now(), random });
    return { id: row.id, result: info.status, http: res.status };
  } catch (err) {
    const cls = err?.name === "AbortError" ? "timeout" : (err?.name || "error");
    const info = markOutboxFailure(db, row, cls, { now: now(), random });
    return { id: row.id, result: info.status, error: cls };
  }
}

// 以有限並發處理一批已認領項目。
async function runPool(items, concurrency, worker) {
  const results = [];
  let idx = 0;
  const runners = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (idx < items.length) {
      const cur = items[idx++];
      results.push(await worker(cur));
    }
  });
  await Promise.all(runners);
  return results;
}

// 跑一輪遞送。回傳摘要（只含計數與 id/status，不含 payload）。
export async function deliverOutboxOnce(db, {
  url,
  secret,
  now = () => new Date(),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  batchSize = DEFAULT_BATCH,
  concurrency = DEFAULT_CONCURRENCY,
  random = Math.random,
} = {}) {
  if (!url || !secret) return { claimed: 0, sent: 0, failed: 0, dead: 0, skipped: "not_configured" };
  if (typeof fetchImpl !== "function") return { claimed: 0, sent: 0, failed: 0, dead: 0, skipped: "no_fetch" };
  if (isLocalDeliveryStopped(db)) return { claimed: 0, sent: 0, failed: 0, dead: 0, skipped: "local_stopped" };
  const claimed = claimOutboxBatch(db, { limit: batchSize, now: now() });
  if (!claimed.length) return { claimed: 0, sent: 0, failed: 0, dead: 0 };
  const results = await runPool(claimed, concurrency, (row) =>
    deliverOne(db, row, { url, secret, timeoutMs, fetchImpl, now, random }));
  const summary = { claimed: claimed.length, sent: 0, failed: 0, dead: 0 };
  for (const r of results) {
    if (r.result === "sent") summary.sent += 1;
    else if (r.result === "dead") summary.dead += 1;
    else summary.failed += 1;
  }
  return summary;
}

// 由 server 呼叫：啟動週期性遞送（回傳 stop 函式）。crash/重啟後 pending 會自然被再次認領。
export function startDeliveryLoop(db, config, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  if (!config?.enabled) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return; // 不重入
    running = true;
    try {
      if (isLocalDeliveryStopped(db)) return;
      const summary = await deliverOutboxOnce(db, {
        url: config.url,
        secret: config.secret,
        timeoutMs: config.timeoutMs,
        batchSize: config.batchSize,
        concurrency: config.concurrency,
        fetchImpl,
      });
      if (summary.claimed) log("ops-delivery", summary); // 只記計數，不記 payload
    } catch (err) {
      log("ops-delivery-error", { error: err?.name || "error" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
