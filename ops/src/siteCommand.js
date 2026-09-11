import { randomBytes, randomUUID } from "node:crypto";
import { signIngestRequest } from "./ingestSignature.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { getProduct, publicProduct } from "./products.js";

export const APPLY_PATH = "/api/ops/commands/apply";
export const COMMAND_KINDS = Object.freeze(["feedback.patch_handling", "crm.add_note"]);
export const JOB_STATES = Object.freeze(["pending", "sending", "sent", "failed", "dead"]);
export const APPLY_STATES = Object.freeze(["unknown", "applied", "rejected", "conflict"]);

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function parseCaps(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function ensureSiteCommandSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_command_credential (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      secret TEXT NOT NULL,
      cred_state TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_command_cred_product ON product_command_credential(product_id, cred_state);
    CREATE TABLE IF NOT EXISTS site_command_job (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      command_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      job_state TEXT NOT NULL,
      apply_state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      site_result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT,
      UNIQUE(product_id, idempotency_key),
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_site_command_product ON site_command_job(product_id, id);
  `);
}

export function productAllowsRemoteCs(product) {
  if (!product) return false;
  const raw = product.subscription?.capabilities ?? product.capabilities;
  const caps = typeof raw === "string" ? parseCaps(raw) : (raw || {});
  const pStatus = product.status;
  const sStatus = product.subscription_status || product.subscription?.status;
  return Boolean(caps.remote_cs) && pStatus === "active" && (sStatus === "connected" || sStatus === "connecting");
}

export function getActiveCommandSecret(db, productId) {
  ensureSiteCommandSchema(db);
  const row = db.prepare(`
    SELECT secret FROM product_command_credential
     WHERE product_id=? AND cred_state='active'
     ORDER BY id DESC LIMIT 1
  `).get(productId);
  return row?.secret || "";
}

export function issueCommandCredential(db, { productId, now = new Date(), secret = "" } = {}) {
  ensureSiteCommandSchema(db);
  const ts = iso(now);
  const material = secret || randomBytes(24).toString("hex");
  const current = db.prepare(`
    SELECT generation FROM product_command_credential WHERE product_id=? ORDER BY id DESC LIMIT 1
  `).get(productId);
  const generation = Number(current?.generation || 0) + 1;
  db.prepare(`
    UPDATE product_command_credential SET cred_state='revoked', revoked_at=?
     WHERE product_id=? AND cred_state='active'
  `).run(ts, productId);
  db.prepare(`
    INSERT INTO product_command_credential(product_id, generation, secret, cred_state, created_at)
    VALUES (?, ?, ?, 'active', ?)
  `).run(productId, generation, material, ts);
  return { secret: material, generation };
}

export function ensureCommandCredential(db, productId, { now = new Date() } = {}) {
  const existing = getActiveCommandSecret(db, productId);
  if (existing) return { secret: existing, created: false };
  return { ...issueCommandCredential(db, { productId, now }), created: true };
}

export function revokeCommandCredentials(db, productId, { now = new Date() } = {}) {
  ensureSiteCommandSchema(db);
  db.prepare(`
    UPDATE product_command_credential SET cred_state='revoked', revoked_at=?
     WHERE product_id=? AND cred_state='active'
  `).run(iso(now), productId);
}

export function remoteCsDeliveryControl(env = process.env) {
  const url = env.V3_OPS_COMMAND_APPLY_URL || "";
  const envAllowed = env.OPS_REMOTE_CS_DELIVERY === "1";
  return {
    env_allowed: envAllowed,
    configured: Boolean(url),
    apply_url: url,
    effective: Boolean(envAllowed && url),
  };
}

export function publicCommandJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    product_id: row.product_id,
    command_id: row.command_id,
    idempotency_key: row.idempotency_key,
    command_kind: row.command_kind,
    payload: row.payload_json ? JSON.parse(row.payload_json) : {},
    job_state: row.job_state,
    apply_state: row.apply_state,
    attempts: Number(row.attempts || 0),
    last_error: row.last_error || "",
    site_result: row.site_result_json ? JSON.parse(row.site_result_json) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    applied_at: row.applied_at,
  };
}

export function listSiteCommands(db, { productId = "", limit = 40 } = {}) {
  ensureSiteCommandSchema(db);
  const lim = Math.min(200, Math.max(1, Number(limit) || 40));
  const rows = productId
    ? db.prepare("SELECT * FROM site_command_job WHERE product_id=? ORDER BY id DESC LIMIT ?").all(productId, lim)
    : db.prepare("SELECT * FROM site_command_job ORDER BY id DESC LIMIT ?").all(lim);
  return rows.map(publicCommandJob);
}

export function enqueueSiteCommand(db, input = {}, { actor = "owner", now = new Date() } = {}) {
  ensureSiteCommandSchema(db);
  const product = getProduct(db, input.product_id || input.productId);
  if (!product) throw httpError("找不到產品", 404);
  if (!productAllowsRemoteCs(product)) {
    throw httpError("遠端客服未授權或訂閱未連線。本站尚未套用。", 403);
  }
  const kind = String(input.command_kind || "").trim();
  if (!COMMAND_KINDS.includes(kind)) throw httpError("不支援的命令種類", 400);
  const idem = String(input.idempotency_key || "").trim();
  if (!idem || idem.length > 200) throw httpError("需要去重鍵", 400);
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const existing = db.prepare("SELECT * FROM site_command_job WHERE product_id=? AND idempotency_key=?").get(product.id, idem);
  if (existing) return { job: publicCommandJob(existing), duplicate: true };

  const commandId = String(input.command_id || randomUUID());
  const ts = iso(now);
  const res = db.prepare(`
    INSERT INTO site_command_job(
      product_id, command_id, idempotency_key, command_kind, payload_json,
      job_state, apply_state, attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 'unknown', 0, ?, ?)
  `).run(product.id, commandId, idem, kind, JSON.stringify(payload), ts, ts);
  appendAuditRow(db, {
    actor,
    action: "site_command.enqueued",
    entityType: "site_command_job",
    entityId: String(res.lastInsertRowid),
    data: { product_id: product.id, command_kind: kind, command_id: commandId },
    now,
  });
  const job = publicCommandJob(db.prepare("SELECT * FROM site_command_job WHERE id=?").get(Number(res.lastInsertRowid)));
  return { job, duplicate: false };
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

export async function deliverSiteCommand(db, commandId, {
  fetchImpl = fetch,
  applyUrl = "",
  secret = "",
  timeoutMs = 8000,
  now = new Date(),
} = {}) {
  ensureSiteCommandSchema(db);
  const row = db.prepare("SELECT * FROM site_command_job WHERE command_id=?").get(commandId);
  if (!row) throw httpError("找不到命令", 404);
  const product = getProduct(db, row.product_id);
  if (!productAllowsRemoteCs(product)) {
    const ts = iso(now);
    db.prepare("UPDATE site_command_job SET job_state='failed', apply_state='unknown', last_error=?, updated_at=? WHERE command_id=?")
      .run("capability_off", ts, commandId);
    return publicCommandJob(db.prepare("SELECT * FROM site_command_job WHERE command_id=?").get(commandId));
  }
  const url = applyUrl || remoteCsDeliveryControl().apply_url;
  const key = secret || getActiveCommandSecret(db, row.product_id);
  if (!url || !key) {
    const ts = iso(now);
    db.prepare("UPDATE site_command_job SET job_state='pending', apply_state='unknown', last_error=?, updated_at=? WHERE command_id=?")
      .run("delivery_off", ts, commandId);
    return publicCommandJob(db.prepare("SELECT * FROM site_command_job WHERE command_id=?").get(commandId));
  }

  const sendingAt = iso(now);
  db.prepare("UPDATE site_command_job SET job_state='sending', attempts=attempts+1, updated_at=? WHERE command_id=?")
    .run(sendingAt, commandId);
  const raw = JSON.stringify({
    command_id: row.command_id,
    idempotency_key: row.idempotency_key,
    command_kind: row.command_kind,
    product_id: row.product_id,
    payload: JSON.parse(row.payload_json || "{}"),
  });
  const signed = signIngestRequest({
    method: "POST",
    path: APPLY_PATH,
    deliveryId: row.command_id,
    rawBody: raw,
    secret: key,
    now,
  });

  try {
    const res = await withTimeout(fetchImpl, url, { method: "POST", headers: signed.headers, body: raw }, timeoutMs);
    const body = await res.json().catch(() => ({}));
    const applyState = body.apply_state === "applied" ? "applied"
      : body.apply_state === "rejected" ? "rejected"
        : "unknown";
    const jobState = applyState === "applied" ? "sent" : (res.ok ? "failed" : "failed");
    const ts = iso(now);
    db.prepare(`
      UPDATE site_command_job
         SET job_state=?, apply_state=?, last_error=?, site_result_json=?, updated_at=?, applied_at=?
       WHERE command_id=?
    `).run(
      jobState,
      applyState,
      applyState === "applied" ? "" : String(body.reason || `http_${res.status}`).slice(0, 200),
      JSON.stringify(body),
      ts,
      applyState === "applied" ? ts : null,
      commandId,
    );
    return publicCommandJob(db.prepare("SELECT * FROM site_command_job WHERE command_id=?").get(commandId));
  } catch (err) {
    const ts = iso(now);
    db.prepare(`
      UPDATE site_command_job
         SET job_state='failed', apply_state='unknown', last_error=?, updated_at=?
       WHERE command_id=?
    `).run(String(err.message || "unreachable").slice(0, 200), ts, commandId);
    return publicCommandJob(db.prepare("SELECT * FROM site_command_job WHERE command_id=?").get(commandId));
  }
}

export async function enqueueAndMaybeDeliver(db, input, {
  actor = "owner",
  now = new Date(),
  fetchImpl = fetch,
  applyUrl,
  secret,
  env = process.env,
} = {}) {
  const enqueued = enqueueSiteCommand(db, input, { actor, now });
  const delivery = remoteCsDeliveryControl(env);
  if (!delivery.effective && !applyUrl) {
    return {
      ...enqueued,
      delivered: false,
      reason: "delivery_off",
      product: publicProduct(getProduct(db, enqueued.job.product_id)),
    };
  }
  const job = await deliverSiteCommand(db, enqueued.job.command_id, {
    fetchImpl,
    applyUrl: applyUrl || delivery.apply_url,
    secret,
    now,
  });
  return {
    job,
    duplicate: enqueued.duplicate,
    delivered: job.apply_state === "applied",
    reason: job.apply_state === "applied" ? "" : (job.last_error || "not_applied"),
    product: publicProduct(getProduct(db, job.product_id)),
  };
}
